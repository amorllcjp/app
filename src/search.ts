/**
 * 日本語検索。
 *
 * PostgreSQL の to_tsvector は日本語を語分割できず、SQLite FTS5 の trigram トークナイザは
 * 2文字クエリ（「単価」「田中」など）を取りこぼす。実測で確認済み。
 * そこで pg_bigm と同じ方式を自前で組む。
 *
 *   1. 本文を2文字の重なりグラム（bigram）に展開し FTS5 に入れる
 *   2. クエリも bigram に展開し AND で引く（索引段階）
 *   3. ヒットした本文に対して、クエリ文字列そのものを含むか再チェックする（偽陽性の除去）
 *
 * 3 が無いと「bigram は全部あるが連続していない」文書が混ざる。
 */
import type { DB } from './db.ts';
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

/** FTS5 のクエリ文字列に安全に埋め込む。 */
function quote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** 本文を索引用の文字列にする。 */
export function indexPayload(text: string): string {
  return grams(text).map(quote).join(' ');
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
  chunkId: number;
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
 * workspaceId は必ず SQL の条件に入れる。呼び出し側の絞り込みに頼らない
 * （要件書 §12.2-3・§7.6: 別ワークスペースのIDを渡しても取得できないこと）。
 */
export function search(
  d: DB,
  opts: { workspaceId: string; query: string; packIds?: string[]; limit?: number },
): SearchHit[] {
  const q = opts.query.trim();
  if (!q) return [];
  const limit = Math.min(opts.limit ?? SEARCH_LIMITS.maxResults, SEARCH_LIMITS.maxResults);

  const gs = grams(q);
  if (gs.length === 0) return [];
  const match = gs.map(quote).join(' AND ');

  const params: unknown[] = [match, opts.workspaceId];
  let packFilter = '';
  if (opts.packIds && opts.packIds.length > 0) {
    packFilter = ` and c.pack_id in (${opts.packIds.map(() => '?').join(',')})`;
    params.push(...opts.packIds);
  }

  // 索引で候補を広めに取り、再チェックで絞る。取りこぼしを防ぐため limit の数倍を引く。
  const rows = d
    .prepare(
      `select c.id as chunkId, c.text as chunkText, c.document_id as documentId, c.pack_id as packId,
              p.name as packName, doc.title, doc.source_url as sourceUrl, doc.origin,
              doc.source_updated_at as sourceUpdatedAt, doc.fetched_at as fetchedAt
         from chunk_index i
         join chunks c    on c.id = i.rowid
         join documents doc on doc.id = c.document_id
         join packs p     on p.id = c.pack_id
        where i.grams match ?
          and c.workspace_id = ?
          and doc.deleted_at is null
          and p.status = 'active'
          ${packFilter}
        order by rank
        limit ?`,
    )
    .all(...params, limit * 8) as Array<Omit<SearchHit, 'snippet'>>;

  const needle = normalize(q);
  const hits: SearchHit[] = [];
  for (const r of rows) {
    const hay = normalize(r.chunkText);
    const at = hay.indexOf(needle);
    if (at < 0) continue; // 偽陽性を除去
    hits.push({ ...r, snippet: makeSnippet(r.chunkText, at, needle.length) });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** 一致箇所を中心に抜粋する。抜粋は必ず原文の一部であり、生成しない。 */
function makeSnippet(text: string, at: number, len: number): string {
  const span = SEARCH_LIMITS.snippetChars;
  const start = Math.max(0, at - Math.floor((span - len) / 2));
  const end = Math.min(text.length, start + span);
  const body = text.slice(start, end);
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

/** ドキュメントをチャンク化して索引に入れる。既存チャンクは入れ替える。 */
export function reindexDocument(
  d: DB,
  doc: { id: string; packId: string; workspaceId: string; body: string },
): number {
  const old = d.prepare('select id from chunks where document_id = ?').all(doc.id) as Array<{ id: number }>;
  const delIdx = d.prepare('delete from chunk_index where rowid = ?');
  for (const o of old) delIdx.run(o.id);
  d.prepare('delete from chunks where document_id = ?').run(doc.id);

  const insChunk = d.prepare(
    'insert into chunks (document_id, pack_id, workspace_id, ord, text) values (?,?,?,?,?)',
  );
  const insIdx = d.prepare('insert into chunk_index (rowid, grams) values (?,?)');
  const parts = chunkText(doc.body);
  parts.forEach((text, i) => {
    const r = insChunk.run(doc.id, doc.packId, doc.workspaceId, i, text);
    insIdx.run(r.lastInsertRowid as number, indexPayload(text));
  });
  return parts.length;
}

/** ドキュメント削除時に索引も落とす。索引だけ残ると削除済みの内容が検索に出る。 */
export function dropDocumentIndex(d: DB, documentId: string): void {
  const old = d.prepare('select id from chunks where document_id = ?').all(documentId) as Array<{ id: number }>;
  const delIdx = d.prepare('delete from chunk_index where rowid = ?');
  for (const o of old) delIdx.run(o.id);
  d.prepare('delete from chunks where document_id = ?').run(documentId);
}
