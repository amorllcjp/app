/**
 * Context Pack の中心。取り込み、検索結果への出典付与、保存、エクスポート、上限判定。
 *
 * ここが守る不変条件:
 *   - 出典（Pack名・タイトル・取得時刻・由来）を持たない検索結果は返さない（要件書 FR-007）
 *   - AIの推測を自動保存しない。context_save は confirm=true を要求する（FR-008）
 *   - すべての読み書きに workspace_id を条件として入れる（§7.6）
 */
import type { DB } from './db.ts';
import { newId, nowIso, audit, currentPeriod } from './db.ts';
import { reindexDocument, dropDocumentIndex, search, type SearchHit } from './search.ts';
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

export function workspacePlan(d: DB, workspaceId: string): Plan {
  const row = d.prepare('select plan, plan_status from workspaces where id = ?').get(workspaceId) as
    | { plan: string; plan_status: string }
    | undefined;
  // 支払い失敗などで停止中なら free の上限に落とす。データは消さない。
  if (!row || row.plan_status !== 'active') return planOf('free');
  return planOf(row.plan);
}

export function listPacks(d: DB, workspaceId: string): Pack[] {
  return d
    .prepare('select * from packs where workspace_id = ? order by created_at desc')
    .all(workspaceId) as Pack[];
}

export function getPack(d: DB, workspaceId: string, packId: string): Pack | null {
  return (d.prepare('select * from packs where id = ? and workspace_id = ?').get(packId, workspaceId) as Pack) ?? null;
}

export function createPack(
  d: DB,
  workspaceId: string,
  actor: string,
  input: { name: string; project?: string; retentionDays?: number | null },
): Pack {
  const plan = workspacePlan(d, workspaceId);
  const count = (d.prepare('select count(*) as n from packs where workspace_id = ?').get(workspaceId) as { n: number })
    .n;
  if (count >= plan.limits.packs) {
    throw new LimitError(
      `${plan.label}プランで作成できるPackは${plan.limits.packs}個までです。`,
      'packs',
      plan,
    );
  }
  const name = input.name.trim();
  if (!name) throw new Error('Pack名を入力してください');

  const at = nowIso();
  const pack: Pack = {
    id: newId('pack'),
    workspace_id: workspaceId,
    name,
    project: input.project?.trim() || null,
    status: 'active',
    retention_days: input.retentionDays ?? null,
    created_at: at,
    updated_at: at,
  };
  d.prepare(
    `insert into packs (id, workspace_id, name, project, status, retention_days, created_at, updated_at)
     values (@id, @workspace_id, @name, @project, @status, @retention_days, @created_at, @updated_at)`,
  ).run(pack);
  audit(d, workspaceId, actor, 'pack.created', pack.id);
  return pack;
}

export function setPackStatus(d: DB, workspaceId: string, actor: string, packId: string, status: 'active' | 'disabled'): void {
  const r = d
    .prepare('update packs set status = ?, updated_at = ? where id = ? and workspace_id = ?')
    .run(status, nowIso(), packId, workspaceId);
  if (r.changes === 0) throw new Error('Packが見つかりません');
  audit(d, workspaceId, actor, `pack.${status}`, packId);
}

export function deletePack(d: DB, workspaceId: string, actor: string, packId: string): void {
  const docs = d.prepare('select id from documents where pack_id = ? and workspace_id = ?').all(packId, workspaceId) as
    | Array<{ id: string }>;
  for (const doc of docs) dropDocumentIndex(d, doc.id);
  const r = d.prepare('delete from packs where id = ? and workspace_id = ?').run(packId, workspaceId);
  if (r.changes === 0) throw new Error('Packが見つかりません');
  audit(d, workspaceId, actor, 'pack.deleted', packId, { documents: docs.length });
}

export interface DocInput {
  title: string;
  body: string;
  sourceUrl?: string | null;
  sourceUpdatedAt?: string | null;
  origin?: 'markdown' | 'user_saved';
}

export function addDocument(d: DB, workspaceId: string, actor: string, packId: string, input: DocInput): string {
  const pack = getPack(d, workspaceId, packId);
  if (!pack) throw new Error('Packが見つかりません');

  const plan = workspacePlan(d, workspaceId);
  const count = (
    d.prepare('select count(*) as n from documents where workspace_id = ? and deleted_at is null').get(workspaceId) as {
      n: number;
    }
  ).n;
  if (count >= plan.limits.documentsPerWorkspace) {
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
  const at = nowIso();
  d.prepare(
    `insert into documents
       (id, pack_id, workspace_id, title, source_url, origin, body, content_hash, source_updated_at, fetched_at, created_at)
     values (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    packId,
    workspaceId,
    input.title.trim() || '(無題)',
    input.sourceUrl?.trim() || null,
    input.origin ?? 'markdown',
    body,
    createHash('sha256').update(body).digest('hex'),
    input.sourceUpdatedAt ?? null,
    at,
    at,
  );
  const chunks = reindexDocument(d, { id, packId, workspaceId, body });
  d.prepare('update packs set updated_at = ? where id = ?').run(at, packId);
  audit(d, workspaceId, actor, 'document.added', id, { chunks, chars: body.length });
  return id;
}

export function deleteDocument(d: DB, workspaceId: string, actor: string, documentId: string): void {
  const row = d.prepare('select id from documents where id = ? and workspace_id = ?').get(documentId, workspaceId);
  if (!row) throw new Error('ドキュメントが見つかりません');
  dropDocumentIndex(d, documentId);
  d.prepare('delete from documents where id = ? and workspace_id = ?').run(documentId, workspaceId);
  audit(d, workspaceId, actor, 'document.deleted', documentId);
}

export function listDocuments(d: DB, workspaceId: string, packId: string) {
  return d
    .prepare(
      `select id, title, source_url, origin, fetched_at, length(body) as chars
         from documents where pack_id = ? and workspace_id = ? and deleted_at is null
        order by created_at desc`,
    )
    .all(packId, workspaceId) as Array<{
    id: string;
    title: string;
    source_url: string | null;
    origin: string;
    fetched_at: string;
    chars: number;
  }>;
}

// --- 利用量（課金の上限判定） ---

export function searchesUsed(d: DB, workspaceId: string): number {
  const row = d
    .prepare('select searches from usage_counters where workspace_id = ? and period = ?')
    .get(workspaceId, currentPeriod()) as { searches: number } | undefined;
  return row?.searches ?? 0;
}

function bumpSearches(d: DB, workspaceId: string): void {
  d.prepare(
    `insert into usage_counters (workspace_id, period, searches) values (?,?,1)
     on conflict(workspace_id, period) do update set searches = searches + 1`,
  ).run(workspaceId, currentPeriod());
}

/**
 * 出典付き検索結果。
 * 要件書 FR-007 の項目をすべて持つ。1つでも欠ける結果は返さない。
 */
export interface Evidence {
  chunk_id: number;
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

export function searchWithEvidence(
  d: DB,
  workspaceId: string,
  actor: string,
  opts: { query: string; packIds?: string[]; limit?: number },
): SearchOutcome {
  const plan = workspacePlan(d, workspaceId);
  const used = searchesUsed(d, workspaceId);
  if (used >= plan.limits.searchesPerMonth) {
    return { results: [], used, limit: plan.limits.searchesPerMonth, limitReached: true };
  }

  // packIds が指定された場合も、必ず自ワークスペースのものに絞り直す。
  let packIds = opts.packIds;
  if (packIds && packIds.length) {
    const owned = d
      .prepare(`select id from packs where workspace_id = ? and id in (${packIds.map(() => '?').join(',')})`)
      .all(workspaceId, ...packIds) as Array<{ id: string }>;
    packIds = owned.map((p) => p.id);
    if (packIds.length === 0) {
      bumpSearches(d, workspaceId);
      return { results: [], used: used + 1, limit: plan.limits.searchesPerMonth, limitReached: false };
    }
  }

  const hits = search(d, { workspaceId, query: opts.query, packIds, limit: opts.limit });
  bumpSearches(d, workspaceId);
  audit(d, workspaceId, actor, 'search', null, { hits: hits.length, queryChars: opts.query.length });

  return {
    results: hits.map(toEvidence),
    used: used + 1,
    limit: plan.limits.searchesPerMonth,
    limitReached: false,
  };
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
export function getEvidence(d: DB, workspaceId: string, chunkId: number): (Evidence & { full_text: string }) | null {
  const row = d
    .prepare(
      `select c.id as chunkId, c.text as chunkText, c.document_id as documentId, c.pack_id as packId,
              p.name as packName, doc.title, doc.source_url as sourceUrl, doc.origin,
              doc.source_updated_at as sourceUpdatedAt, doc.fetched_at as fetchedAt
         from chunks c
         join documents doc on doc.id = c.document_id
         join packs p on p.id = c.pack_id
        where c.id = ? and c.workspace_id = ? and doc.deleted_at is null`,
    )
    .get(chunkId, workspaceId) as (Omit<SearchHit, 'snippet'> & { chunkText: string }) | undefined;
  if (!row) return null;
  audit(d, workspaceId, 'mcp', 'evidence.read', String(chunkId));
  return { ...toEvidence({ ...row, snippet: row.chunkText }), full_text: row.chunkText };
}

/**
 * ユーザーが確認した内容を保存する。
 * confirm が true でなければ保存しない。AIの判断だけでは書き込ませない（要件書 FR-008）。
 */
export function saveContext(
  d: DB,
  workspaceId: string,
  actor: string,
  input: { packId: string; title: string; content: string; confirm: boolean; reason?: string },
): { saved: boolean; documentId?: string; message: string } {
  if (!input.confirm) {
    return {
      saved: false,
      message:
        '保存していません。この内容をPackへ保存してよいか、利用者に確認してください。確認が取れた場合のみ confirm=true で再度呼び出してください。',
    };
  }
  const id = addDocument(d, workspaceId, actor, input.packId, {
    title: input.title,
    body: input.content,
    origin: 'user_saved',
  });
  audit(d, workspaceId, actor, 'context.saved', id, { reason: input.reason ? 'provided' : 'none' });
  return { saved: true, documentId: id, message: 'Packへ保存しました（由来: ユーザー保存）。' };
}

/** PackをMarkdownで出力する。MCP非対応AI向けのフォールバック（要件書 FR-009）。 */
export function exportPackMarkdown(d: DB, workspaceId: string, packId: string): string {
  const pack = getPack(d, workspaceId, packId);
  if (!pack) throw new Error('Packが見つかりません');
  const docs = d
    .prepare(
      `select title, source_url, origin, body, source_updated_at, fetched_at
         from documents where pack_id = ? and workspace_id = ? and deleted_at is null order by created_at`,
    )
    .all(packId, workspaceId) as Array<{
    title: string;
    source_url: string | null;
    origin: string;
    body: string;
    source_updated_at: string | null;
    fetched_at: string;
  }>;

  const out: string[] = [
    `# Context Pack: ${pack.name}`,
    '',
    `- Pack ID: \`${pack.id}\``,
    pack.project ? `- 対象: ${pack.project}` : '',
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
  audit(d, workspaceId, 'user', 'pack.exported', packId, { documents: docs.length });
  return out.filter((l) => l !== '').join('\n').replace(/\n---\n/g, '\n\n---\n\n');
}

export function packStatus(d: DB, workspaceId: string, packId?: string) {
  const packs = packId ? [getPack(d, workspaceId, packId)].filter(Boolean as unknown as (p: Pack | null) => p is Pack) : listPacks(d, workspaceId);
  const plan = workspacePlan(d, workspaceId);
  return {
    plan: plan.id,
    searches_used_this_month: searchesUsed(d, workspaceId),
    searches_limit_this_month: plan.limits.searchesPerMonth,
    packs: packs.map((p) => {
      const stat = d
        .prepare(
          `select count(*) as docs, max(fetched_at) as newest, min(fetched_at) as oldest
             from documents where pack_id = ? and deleted_at is null`,
        )
        .get(p.id) as { docs: number; newest: string | null; oldest: string | null };
      return {
        pack_id: p.id,
        name: p.name,
        project: p.project,
        status: p.status,
        documents: stat.docs,
        newest_fetched_at: stat.newest,
        oldest_fetched_at: stat.oldest,
        // 自動同期は実装していない。鮮度について誤解を与えないよう明示する（要件書 F-14）。
        sync: 'manual_import_only',
        note: '自動同期は行っていません。表示している時刻は利用者が取り込んだ時点のものです。',
      };
    }),
  };
}
