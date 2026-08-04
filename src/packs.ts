/**
 * Context Pack の中心。取り込み、検索結果への出典付与、保存、エクスポート、上限判定。
 *
 * ここが守る不変条件:
 *   - 出典（Pack名・タイトル・取得時刻・由来）を持たない検索結果は返さない（要件書 FR-007）
 *   - AIの推測を自動保存しない。context_save は confirm=true を要求する（FR-008）
 *   - すべての読み書きに workspace_id を条件として入れる（§7.6）
 */
import type { Sql } from './db.ts';
import { newId, nowIso, audit, currentPeriod } from './db.ts';
import { reindexDocument, search, iso, type SearchHit } from './search.ts';
import { planOf, type Plan } from './config.ts';
import { createHash } from 'node:crypto';

export class LimitError extends Error {
  limit: string;
  plan: Plan;
  constructor(message: string, limit: string, plan: Plan) {
    super(message);
    this.name = 'LimitError';
    this.limit = limit;
    this.plan = plan;
  }
}

export interface Pack {
  id: string;
  workspace_id: string;
  name: string;
  project: string | null;
  status: string;
  retention_days: number | null;
  created_at: string;
  updated_at: string;
}

export async function workspacePlan(db: Sql, workspaceId: string): Promise<Plan> {
  const { rows } = await db.query<{ plan: string; plan_status: string }>(
    'select plan, plan_status from workspaces where id = $1',
    [workspaceId],
  );
  const row = rows[0];
  // 支払い失敗などで停止中なら free の上限に落とす。データは消さない。
  if (!row || row.plan_status !== 'active') return planOf('free');
  return planOf(row.plan);
}

export async function listPacks(db: Sql, workspaceId: string): Promise<Pack[]> {
  const { rows } = await db.query<Pack>(
    `select id, workspace_id, name, project, status, retention_days,
            created_at::text, updated_at::text
       from packs where workspace_id = $1 order by created_at desc`,
    [workspaceId],
  );
  return rows;
}

export async function getPack(db: Sql, workspaceId: string, packId: string): Promise<Pack | null> {
  const { rows } = await db.query<Pack>(
    `select id, workspace_id, name, project, status, retention_days,
            created_at::text, updated_at::text
       from packs where id = $1 and workspace_id = $2`,
    [packId, workspaceId],
  );
  return rows[0] ?? null;
}

export async function createPack(
  db: Sql,
  workspaceId: string,
  actor: string,
  input: { name: string; project?: string; retentionDays?: number | null },
): Promise<Pack> {
  const plan = await workspacePlan(db, workspaceId);
  const { rows } = await db.query<{ n: string }>('select count(*)::text as n from packs where workspace_id = $1', [
    workspaceId,
  ]);
  if (Number(rows[0]?.n ?? 0) >= plan.limits.packs) {
    throw new LimitError(`${plan.label}プランで作成できるPackは${plan.limits.packs}個までです。`, 'packs', plan);
  }
  const name = input.name.trim();
  if (!name) throw new Error('Pack名を入力してください');

  const id = newId('pack');
  await db.query('insert into packs (id, workspace_id, name, project, retention_days) values ($1,$2,$3,$4,$5)', [
    id,
    workspaceId,
    name,
    input.project?.trim() || null,
    input.retentionDays ?? null,
  ]);
  await audit(db, workspaceId, actor, 'pack.created', id);
  return (await getPack(db, workspaceId, id))!;
}

export async function setPackStatus(
  db: Sql,
  workspaceId: string,
  actor: string,
  packId: string,
  status: 'active' | 'disabled',
): Promise<void> {
  const { rows } = await db.query(
    'update packs set status = $1, updated_at = now() where id = $2 and workspace_id = $3 returning id',
    [status, packId, workspaceId],
  );
  if (!rows.length) throw new Error('Packが見つかりません');
  await audit(db, workspaceId, actor, `pack.${status}`, packId);
}

export async function deletePack(db: Sql, workspaceId: string, actor: string, packId: string): Promise<void> {
  // chunks / documents は外部キーの on delete cascade で落ちる。tsvector は同じ行なので取り残しが出ない。
  const { rows } = await db.query('delete from packs where id = $1 and workspace_id = $2 returning id', [
    packId,
    workspaceId,
  ]);
  if (!rows.length) throw new Error('Packが見つかりません');
  await audit(db, workspaceId, actor, 'pack.deleted', packId);
}

export interface DocInput {
  title: string;
  body: string;
  sourceUrl?: string | null;
  sourceUpdatedAt?: string | null;
  origin?: 'markdown' | 'user_saved';
}

export async function addDocument(
  db: Sql,
  workspaceId: string,
  actor: string,
  packId: string,
  input: DocInput,
): Promise<string> {
  const pack = await getPack(db, workspaceId, packId);
  if (!pack) throw new Error('Packが見つかりません');

  const plan = await workspacePlan(db, workspaceId);
  const { rows } = await db.query<{ n: string }>(
    'select count(*)::text as n from documents where workspace_id = $1 and deleted_at is null',
    [workspaceId],
  );
  if (Number(rows[0]?.n ?? 0) >= plan.limits.documentsPerWorkspace) {
    throw new LimitError(
      `${plan.label}プランで保存できるドキュメントは${plan.limits.documentsPerWorkspace}件までです。`,
      'documents',
      plan,
    );
  }
  const body = input.body.trim();
  if (!body) throw new Error('本文が空です');
  if (body.length > plan.limits.documentChars) {
    throw new LimitError(
      `${plan.label}プランの1ドキュメントの上限は${plan.limits.documentChars.toLocaleString()}文字です（入力は${body.length.toLocaleString()}文字）。`,
      'documentChars',
      plan,
    );
  }

  const id = newId('doc');
  await db.query(
    `insert into documents (id, pack_id, workspace_id, title, source_url, origin, body, content_hash, source_updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      packId,
      workspaceId,
      input.title.trim() || '(無題)',
      input.sourceUrl?.trim() || null,
      input.origin ?? 'markdown',
      body,
      createHash('sha256').update(body).digest('hex'),
      input.sourceUpdatedAt ?? null,
    ],
  );
  const chunks = await reindexDocument(db, { id, packId, workspaceId, body });
  await db.query('update packs set updated_at = now() where id = $1', [packId]);
  await audit(db, workspaceId, actor, 'document.added', id, { chunks, chars: body.length });
  return id;
}

export async function deleteDocument(db: Sql, workspaceId: string, actor: string, documentId: string): Promise<void> {
  const { rows } = await db.query('delete from documents where id = $1 and workspace_id = $2 returning id', [
    documentId,
    workspaceId,
  ]);
  if (!rows.length) throw new Error('ドキュメントが見つかりません');
  await audit(db, workspaceId, actor, 'document.deleted', documentId);
}

export interface DocRow {
  id: string;
  title: string;
  source_url: string | null;
  origin: string;
  fetched_at: string;
  chars: number;
}

export async function listDocuments(db: Sql, workspaceId: string, packId: string): Promise<DocRow[]> {
  const { rows } = await db.query<DocRow & { chars: string }>(
    `select id, title, source_url, origin, fetched_at::text, length(body)::text as chars
       from documents where pack_id = $1 and workspace_id = $2 and deleted_at is null
      order by created_at desc`,
    [packId, workspaceId],
  );
  return rows.map((r) => ({ ...r, chars: Number(r.chars) }));
}

// --- 利用量（課金の上限判定） ---

export async function searchesUsed(db: Sql, workspaceId: string): Promise<number> {
  const { rows } = await db.query<{ searches: number }>(
    'select searches from usage_counters where workspace_id = $1 and period = $2',
    [workspaceId, currentPeriod()],
  );
  return Number(rows[0]?.searches ?? 0);
}

async function bumpSearches(db: Sql, workspaceId: string): Promise<void> {
  await db.query(
    `insert into usage_counters (workspace_id, period, searches) values ($1,$2,1)
     on conflict (workspace_id, period) do update set searches = usage_counters.searches + 1`,
    [workspaceId, currentPeriod()],
  );
}

/**
 * 出典付き検索結果。
 * 要件書 FR-007 の項目をすべて持つ。1つでも欠ける結果は返さない。
 */
export interface Evidence {
  chunk_id: string;
  document_id: string;
  pack_id: string;
  pack_name: string;
  title: string;
  /** 原文抜粋。生成は一切しない。 */
  excerpt: string;
  source_url: string | null;
  /** 'markdown' = ユーザーが取り込んだ原文 / 'user_saved' = ユーザーが確認して保存した記述 */
  provenance: string;
  source_updated_at: string | null;
  fetched_at: string;
}

export interface SearchOutcome {
  results: Evidence[];
  used: number;
  limit: number;
  /** 上限に達している場合、課金導線のメッセージを入れる。 */
  limitReached: boolean;
}

export async function searchWithEvidence(
  db: Sql,
  workspaceId: string,
  actor: string,
  opts: { query: string; packIds?: string[]; limit?: number },
): Promise<SearchOutcome> {
  const plan = await workspacePlan(db, workspaceId);
  const used = await searchesUsed(db, workspaceId);
  if (used >= plan.limits.searchesPerMonth) {
    return { results: [], used, limit: plan.limits.searchesPerMonth, limitReached: true };
  }

  // packIds が指定された場合も、必ず自ワークスペースのものに絞り直す。
  let packIds = opts.packIds;
  if (packIds && packIds.length) {
    const { rows } = await db.query<{ id: string }>('select id from packs where workspace_id = $1 and id = any($2)', [
      workspaceId,
      packIds,
    ]);
    packIds = rows.map((p) => p.id);
    if (packIds.length === 0) {
      await bumpSearches(db, workspaceId);
      return { results: [], used: used + 1, limit: plan.limits.searchesPerMonth, limitReached: false };
    }
  }

  const hits = await search(db, { workspaceId, query: opts.query, packIds, limit: opts.limit });
  await bumpSearches(db, workspaceId);
  await audit(db, workspaceId, actor, 'search', null, { hits: hits.length, queryChars: opts.query.length });

  return { results: hits.map(toEvidence), used: used + 1, limit: plan.limits.searchesPerMonth, limitReached: false };
}

function toEvidence(h: SearchHit): Evidence {
  return {
    chunk_id: h.chunkId,
    document_id: h.documentId,
    pack_id: h.packId,
    pack_name: h.packName,
    title: h.title,
    excerpt: h.snippet,
    source_url: h.sourceUrl,
    provenance: h.origin,
    source_updated_at: h.sourceUpdatedAt,
    fetched_at: h.fetchedAt,
  };
}

/** 根拠の再取得。チャンク全文を返す（要件書 FR-006 context_get_evidence）。 */
export async function getEvidence(
  db: Sql,
  workspaceId: string,
  chunkId: string,
): Promise<(Evidence & { full_text: string }) | null> {
  if (!/^\d+$/.test(String(chunkId))) return null;
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
      where c.id = $1 and c.workspace_id = $2 and d.deleted_at is null`,
    [chunkId, workspaceId],
  );
  const r = rows[0];
  if (!r) return null;
  await audit(db, workspaceId, 'mcp', 'evidence.read', String(chunkId));
  return {
    chunk_id: r.chunkid,
    document_id: r.documentid,
    pack_id: r.packid,
    pack_name: r.packname,
    title: r.title,
    excerpt: r.chunktext,
    source_url: r.sourceurl,
    provenance: r.origin,
    source_updated_at: iso(r.sourceupdatedat),
    fetched_at: iso(r.fetchedat) ?? '',
    full_text: r.chunktext,
  };
}

/**
 * ユーザーが確認した内容を保存する。
 * confirm が true でなければ保存しない。AIの判断だけでは書き込ませない（要件書 FR-008）。
 */
export async function saveContext(
  db: Sql,
  workspaceId: string,
  actor: string,
  input: { packId: string; title: string; content: string; confirm: boolean; reason?: string },
): Promise<{ saved: boolean; documentId?: string; message: string }> {
  if (!input.confirm) {
    return {
      saved: false,
      message:
        '保存していません。この内容をPackへ保存してよいか、利用者に確認してください。確認が取れた場合のみ confirm=true で再度呼び出してください。',
    };
  }
  const id = await addDocument(db, workspaceId, actor, input.packId, {
    title: input.title,
    body: input.content,
    origin: 'user_saved',
  });
  await audit(db, workspaceId, actor, 'context.saved', id, { reason: input.reason ? 'provided' : 'none' });
  return { saved: true, documentId: id, message: 'Packへ保存しました（由来: ユーザー保存）。' };
}

/** PackをMarkdownで出力する。MCP非対応AI向けのフォールバック（要件書 FR-009）。 */
export async function exportPackMarkdown(db: Sql, workspaceId: string, packId: string): Promise<string> {
  const pack = await getPack(db, workspaceId, packId);
  if (!pack) throw new Error('Packが見つかりません');
  const { rows: docs } = await db.query<{
    title: string;
    source_url: string | null;
    origin: string;
    body: string;
    source_updated_at: string | null;
    fetched_at: string;
  }>(
    `select title, source_url, origin, body, source_updated_at::text, fetched_at::text
       from documents where pack_id = $1 and workspace_id = $2 and deleted_at is null order by created_at`,
    [packId, workspaceId],
  );

  const out: string[] = [
    `# Context Pack: ${pack.name}`,
    '',
    `- Pack ID: \`${pack.id}\``,
    ...(pack.project ? [`- 対象: ${pack.project}`] : []),
    `- 出力日時: ${nowIso()}`,
    `- 収録ドキュメント: ${docs.length}件`,
    '',
    '> この内容は利用者が明示的に取り込んだ資料です。取得時刻を確認し、最新であることが必要な情報は',
    '> 元の資料で裏取りしてください。自動同期は行っていません。',
    '',
    '---',
    '',
  ];
  for (const doc of docs) {
    out.push(`## ${doc.title}`, '');
    out.push(`- 由来: ${doc.origin === 'user_saved' ? 'ユーザー保存' : '取り込み原文'}`);
    if (doc.source_url) out.push(`- 出典: ${doc.source_url}`);
    if (doc.source_updated_at) out.push(`- 元資料の更新: ${doc.source_updated_at}`);
    out.push(`- 取得時刻: ${doc.fetched_at}`, '', doc.body, '', '---', '');
  }
  await audit(db, workspaceId, 'user', 'pack.exported', packId, { documents: docs.length });
  return out.join('\n');
}

export async function packStatus(db: Sql, workspaceId: string, packId?: string) {
  const packs = packId ? [await getPack(db, workspaceId, packId)].filter((p): p is Pack => p !== null) : await listPacks(db, workspaceId);
  const plan = await workspacePlan(db, workspaceId);
  const out = [];
  for (const p of packs) {
    const { rows } = await db.query<{ docs: string; newest: string | null; oldest: string | null }>(
      `select count(*)::text as docs, max(fetched_at)::text as newest, min(fetched_at)::text as oldest
         from documents where pack_id = $1 and deleted_at is null`,
      [p.id],
    );
    const stat = rows[0]!;
    out.push({
      pack_id: p.id,
      name: p.name,
      project: p.project,
      status: p.status,
      documents: Number(stat.docs),
      newest_fetched_at: stat.newest,
      oldest_fetched_at: stat.oldest,
      // 自動同期は実装していない。鮮度について誤解を与えないよう明示する（要件書 F-14）。
      sync: 'manual_import_only',
      note: '自動同期は行っていません。表示している時刻は利用者が取り込んだ時点のものです。',
    });
  }
  return {
    plan: plan.id,
    searches_used_this_month: await searchesUsed(db, workspaceId),
    searches_limit_this_month: plan.limits.searchesPerMonth,
    packs: out,
  };
}
