/**
 * 日本語検索（PostgreSQL 版）。
 *
 * 方式は SQLite 版と同じ二段構え。根拠は docs/adr/ADR-0002-技術判断.md。
 *
 *   1. 本文を2文字の重なりグラム（bigram）に展開し tsvector('simple') に入れる
 *   2. クエリも展開し AND（&）で候補を引く（GIN索引が効く）
 *   3. 正規化済み本文にクエリ文字列そのものが含まれるか再チェックする（偽陽性の除去）
 *
 * 'simple' 設定は空白で区切るだけなので、こちらが作った bigram がそのまま lexeme になる。
 * pg_bigm も PGroonga も pgvector も要らない。Neon の標準構成で動く。
 *
 * 3 が無いと「東京」「京都」を含むが「東京都」とは書かれていない文書が誤ってヒットする。
 */
import type { Sql } from './db.ts';
import { SEARCH_LIMITS } from './config.ts';

/** NFKC + 小文字化。全角英数と半角、大文字小文字の揺れを吸収する。 */
export function normalize(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

/**
 * 索引・検索の両方で使うグラム展開。
 * - 2文字の重なりグラム（空白をまたぐものは捨てる）
 * - ASCII 語はそのまま語としても入れる（"stripe" 等の完全一致を効かせる）
 * - 1文字だけのクエリはその1文字を入れる
 */
export function grams(s: string): string[] {
  const t = normalize(s).replace(/\s+/g, ' ');
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    if (!/\s/.test(g)) out.add(g);
  }
  for (const w of t.match(/[a-z0-9_.-]{2,}/g) ?? []) out.add(w);
  const trimmed = t.trim();
  if (trimmed.length === 1) out.add(trimmed);
  return [...out];
}

/** tsquery のリテラルにする。引用符内なので & | ! ( ) は演算子として解釈されない。 */
function lexeme(g: string): string {
  return `'${g.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/** 索引用の tsvector 入力文字列。 */
export function indexPayload(text: string): string {
  return grams(text).join(' ');
}

/** クエリ用の tsquery 文字列。グラムが無ければ null。 */
export function toTsQuery(query: string): string | null {
  const gs = grams(query);
  return gs.length ? gs.map(lexeme).join(' & ') : null;
}

/**
 * 本文をチャンクに割る。段落優先、長すぎる段落は文字数で分割。
 * チャンクは「根拠として引用する単位」なので、小さすぎると文脈が失われる。
 */
export function chunkText(body: string, maxChars = 800): string[] {
  const paras = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  let buf = '';
  for (const p of paras) {
    if (p.length > maxChars) {
      if (buf) {
        out.push(buf);
        buf = '';
      }
      for (let i = 0; i < p.length; i += maxChars) out.push(p.slice(i, i + maxChars));
      continue;
    }
    if ((buf + '\n\n' + p).length > maxChars) {
      out.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf) out.push(buf);
  return out.length ? out : [body.trim()].filter(Boolean);
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  packId: string;
  packName: string;
  title: string;
  sourceUrl: string | null;
  origin: string;
  snippet: string;
  chunkText: string;
  sourceUpdatedAt: string | null;
  fetchedAt: string;
}

/**
 * Pack 内を検索する。
 *
 * workspace_id は必ず SQL の条件に入れる。呼び出し側の絞り込みに頼らない
 * （要件書 §12.2-3・§7.6: 別ワークスペースのIDを渡しても取得できないこと）。
 */
export async function search(
  db: Sql,
  opts: { workspaceId: string; query: string; packIds?: string[]; limit?: number },
): Promise<SearchHit[]> {
  const q = opts.query.trim();
  if (!q) return [];
  const tsq = toTsQuery(q);
  if (!tsq) return [];
  const limit = Math.min(opts.limit ?? SEARCH_LIMITS.maxResults, SEARCH_LIMITS.maxResults);

  const params: unknown[] = [tsq, opts.workspaceId, normalize(q)];
  let packFilter = '';
  if (opts.packIds && opts.packIds.length > 0) {
    packFilter = ` and c.pack_id = any($${params.length + 1})`;
    params.push(opts.packIds);
  }
  params.push(limit);

  const { rows } = await db.query<{
    chunkid: string;
    chunktext: string;
    documentid: string;
    packid: string;
    packname: string;
    title: string;
    sourceurl: string | null;
    origin: string;
    sourceupdatedat: Date | string | null;
    fetchedat: Date | string;
  }>(
    `select c.id::text as chunkid, c.text as chunktext, c.document_id as documentid, c.pack_id as packid,
            p.name as packname, d.title, d.source_url as sourceurl, d.origin,
            d.source_updated_at as sourceupdatedat, d.fetched_at as fetchedat
       from chunks c
       join documents d on d.id = c.document_id
       join packs p on p.id = c.pack_id
      where c.grams @@ to_tsquery('simple', $1)
        and c.workspace_id = $2
        and position($3 in c.norm_text) > 0
        and d.deleted_at is null
        and p.status = 'active'
        ${packFilter}
      order by ts_rank(c.grams, to_tsquery('simple', $1)) desc, c.id
      limit $${params.length}`,
    params,
  );

  return rows.map((r) => ({
    chunkId: r.chunkid,
    documentId: r.documentid,
    packId: r.packid,
    packName: r.packname,
    title: r.title,
    sourceUrl: r.sourceurl,
    origin: r.origin,
    chunkText: r.chunktext,
    snippet: makeSnippet(r.chunktext, q),
    sourceUpdatedAt: iso(r.sourceupdatedat),
    fetchedAt: iso(r.fetchedat) ?? '',
  }));
}

export function iso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/**
 * 一致箇所を中心に抜粋する。抜粋は必ず原文の一部であり、生成しない。
 *
 * 位置は原文で直接探すことを優先する。NFKC 正規化は文字数を変えることがあり
 * （半角濁点カナなど）、正規化後の位置を原文に当てるとずれるため。
 * どちらでも見つからない場合は先頭を返す。抜粋が原文の部分文字列であることは常に保つ。
 */
function makeSnippet(text: string, query: string): string {
  const span = SEARCH_LIMITS.snippetChars;
  if (text.length <= span) return text;

  const at = matchIndex(text, query);
  // 一致箇所を窓の中央に置く。前だけ長く見せても、読み手は目的の記述に辿り着けない。
  const ideal = at - Math.floor((span - query.length) / 2);
  const start = Math.max(0, Math.min(ideal, text.length - span));
  const end = start + span;
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/**
 * 原文中の一致位置。原文で直接探すことを優先する。
 * NFKC 正規化は文字数を変えることがあり（半角濁点カナなど）、
 * 正規化後の位置を原文に当てるとずれるため。
 */
export function matchIndex(text: string, query: string): number {
  const direct = text.toLowerCase().indexOf(query.toLowerCase());
  if (direct >= 0) return direct;
  const viaNorm = normalize(text).indexOf(normalize(query));
  return viaNorm >= 0 && normalize(text).length === text.length ? viaNorm : 0;
}

/**
 * ドキュメントをチャンクに割って索引を張り直す。
 * chunks 行に tsvector を同居させているので、行を消せば索引も消える。
 */
export async function reindexDocument(
  db: Sql,
  doc: { id: string; packId: string; workspaceId: string; body: string },
): Promise<number> {
  await db.query('delete from chunks where document_id = $1', [doc.id]);
  const parts = chunkText(doc.body);
  if (parts.length === 0) return 0;

  // 1文で全チャンクを入れる。サーバーレスでは往復回数がそのまま遅延になる。
  const values: string[] = [];
  const params: unknown[] = [];
  parts.forEach((text, i) => {
    const b = params.length;
    values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},to_tsvector('simple',$${b + 7}))`);
    params.push(doc.id, doc.packId, doc.workspaceId, i, text, normalize(text), indexPayload(text));
  });
  await db.query(
    `insert into chunks (document_id, pack_id, workspace_id, ord, text, norm_text, grams) values ${values.join(',')}`,
    params,
  );
  return parts.length;
}
