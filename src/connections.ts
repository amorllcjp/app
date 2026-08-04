/**
 * 外部サービスとの接続と同期。
 *
 * 守ること:
 *   - アクセストークンは暗号化して保存する。平文をDBにも画面にもログにも出さない（FR-002）
 *   - 取り込むのは利用者が選んだ対象だけ（FR-003）
 *   - 取得時刻を必ず残す。「最新」と言わない（FR-005）
 *   - 外部で消えた資料は索引から外す（FR-010）
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type { Sql } from './db.ts';
import { newId, audit } from './db.ts';
import { config } from './config.ts';
import { addDocument, deleteDocument, getPack, workspacePlan, LimitError } from './packs.ts';
import * as notion from './connectors/notion.ts';

// --- トークンの暗号化 ---

function key(): Buffer {
  if (!config.sessionSecret) throw new Error('SESSION_SECRET が未設定です');
  // 用途を混ぜないよう、セッション署名とは別のソルトで鍵を分ける
  return scryptSync(config.sessionSecret, 'context-bridge/token-encryption', 32);
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}

export function decryptToken(stored: string): string {
  const [ivB64, tagB64, ctB64] = stored.split('.');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('保存されたトークンの形式が不正です');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  d.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]).toString('utf8');
}

// --- 接続 ---

export interface Connection {
  id: string;
  workspace_id: string;
  provider: string;
  workspace_name: string | null;
  status: string;
  created_at: string;
  last_verified_at: string | null;
}

export async function saveConnection(
  db: Sql,
  workspaceId: string,
  actor: string,
  input: { provider: string; token: string; externalAccountId?: string | null; workspaceName?: string | null },
): Promise<string> {
  // 同じ provider の古い接続は失効させる。トークンが2本生きている状態を作らない。
  await db.query("update connections set status = 'replaced' where workspace_id = $1 and provider = $2 and status = 'active'", [
    workspaceId,
    input.provider,
  ]);
  const id = newId('conn');
  await db.query(
    `insert into connections (id, workspace_id, provider, external_account_id, workspace_name, token_ref, last_verified_at)
     values ($1,$2,$3,$4,$5,$6, now())`,
    [id, workspaceId, input.provider, input.externalAccountId ?? null, input.workspaceName ?? null, encryptToken(input.token)],
  );
  await audit(db, workspaceId, actor, 'connection.created', id, { provider: input.provider });
  return id;
}

export async function activeConnection(db: Sql, workspaceId: string, provider: string): Promise<Connection | null> {
  const { rows } = await db.query<Connection>(
    `select id, workspace_id, provider, workspace_name, status,
            created_at::text, last_verified_at::text
       from connections
      where workspace_id = $1 and provider = $2 and status = 'active'
      order by created_at desc limit 1`,
    [workspaceId, provider],
  );
  return rows[0] ?? null;
}

async function tokenOf(db: Sql, connectionId: string, workspaceId: string): Promise<string> {
  const { rows } = await db.query<{ token_ref: string }>(
    'select token_ref from connections where id = $1 and workspace_id = $2',
    [connectionId, workspaceId],
  );
  if (!rows[0]) throw new Error('接続が見つかりません');
  return decryptToken(rows[0].token_ref);
}

export async function disconnect(db: Sql, workspaceId: string, actor: string, connectionId: string): Promise<void> {
  /*
   * 解除時に、その接続経由で入れた資料も消す。
   * トークンだけ消して中身を残すと、利用者は「解除したのにデータが残っている」状態になる。
   */
  const { rows } = await db.query<{ document_id: string | null }>(
    'select document_id from source_selections where connection_id = $1 and workspace_id = $2',
    [connectionId, workspaceId],
  );
  for (const r of rows) {
    if (r.document_id) await deleteDocument(db, workspaceId, actor, r.document_id).catch(() => {});
  }
  await db.query('delete from connections where id = $1 and workspace_id = $2', [connectionId, workspaceId]);
  await audit(db, workspaceId, actor, 'connection.deleted', connectionId, { documents: rows.length });
}

// --- 同期 ---

export interface SyncResult {
  status: 'completed' | 'partial' | 'failed';
  added: number;
  updated: number;
  removed: number;
  failed: number;
  error?: string;
}

/**
 * Notion の同期。
 *
 * 1. 連携が許可されているページを列挙する
 * 2. 未取得または更新されたページだけ本文を取りに行く
 * 3. Notion 側から消えた／共有解除されたページを索引から外す
 *
 * 差分を見るのは往復回数とレート制限のため。全ページ毎回取りに行くと、
 * ページ数が増えたときに現実的な時間で終わらない。
 */
export async function syncNotion(
  db: Sql,
  workspaceId: string,
  actor: string,
  opts: { connectionId: string; packId: string; fetcher?: notion.Fetcher },
): Promise<SyncResult> {
  const f = opts.fetcher ?? fetch;
  const runId = newId('run');
  await db.query(
    "insert into sync_runs (id, connection_id, workspace_id, status) values ($1,$2,$3,'running')",
    [runId, opts.connectionId, workspaceId],
  );

  const finish = async (r: SyncResult) => {
    await db.query(
      `update sync_runs set status=$1, added=$2, updated=$3, removed=$4, failed=$5, error=$6, finished_at=now()
        where id=$7`,
      [r.status, r.added, r.updated, r.removed, r.failed, r.error ?? null, runId],
    );
    await audit(db, workspaceId, actor, 'sync.finished', opts.connectionId, {
      status: r.status,
      added: r.added,
      updated: r.updated,
      removed: r.removed,
      failed: r.failed,
    });
    return r;
  };

  const pack = await getPack(db, workspaceId, opts.packId);
  if (!pack) return finish({ status: 'failed', added: 0, updated: 0, removed: 0, failed: 0, error: 'Packが見つかりません' });

  let pages: notion.NotionPage[];
  try {
    const token = await tokenOf(db, opts.connectionId, workspaceId);
    pages = await notion.listPages(token, f);
  } catch (e) {
    if (e instanceof notion.NotionAuthError) {
      await db.query("update connections set status = 'revoked' where id = $1", [opts.connectionId]);
    }
    return finish({ status: 'failed', added: 0, updated: 0, removed: 0, failed: 0, error: (e as Error).message });
  }

  const token = await tokenOf(db, opts.connectionId, workspaceId);
  const { rows: existing } = await db.query<{
    id: string;
    provider_object_id: string;
    external_updated_at: string | null;
    document_id: string | null;
  }>(
    `select id, provider_object_id, external_updated_at::text, document_id
       from source_selections where connection_id = $1 and workspace_id = $2`,
    [opts.connectionId, workspaceId],
  );
  const bySource = new Map(existing.map((r) => [r.provider_object_id, r]));

  const plan = await workspacePlan(db, workspaceId);
  let added = 0;
  let updated = 0;
  let failed = 0;
  let error: string | undefined;

  for (const page of pages) {
    const prev = bySource.get(page.id);
    const unchanged =
      prev?.document_id &&
      prev.external_updated_at &&
      page.lastEditedTime &&
      new Date(prev.external_updated_at).getTime() === new Date(page.lastEditedTime).getTime();
    if (unchanged) continue;

    try {
      const body = await notion.fetchPageMarkdown(token, page.id, f);
      if (!body.trim()) continue; // 空のページは入れない

      // 更新なら古い方を消してから入れ直す。索引がチャンク行と同居しているので取り残しが出ない。
      if (prev?.document_id) await deleteDocument(db, workspaceId, actor, prev.document_id).catch(() => {});

      const docId = await addDocument(db, workspaceId, actor, opts.packId, {
        title: page.title,
        body,
        sourceUrl: page.url,
        sourceUpdatedAt: page.lastEditedTime,
      });

      if (prev) {
        await db.query(
          'update source_selections set title=$1, source_url=$2, external_updated_at=$3, last_synced_at=now(), document_id=$4 where id=$5',
          [page.title, page.url, page.lastEditedTime, docId, prev.id],
        );
        updated++;
      } else {
        await db.query(
          `insert into source_selections
             (id, connection_id, workspace_id, pack_id, provider_object_id, title, source_url, external_updated_at, last_synced_at, document_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8, now(), $9)`,
          [newId('sel'), opts.connectionId, workspaceId, opts.packId, page.id, page.title, page.url, page.lastEditedTime, docId],
        );
        added++;
      }
    } catch (e) {
      failed++;
      if (e instanceof LimitError) {
        // 上限に当たったらそこで止める。残りを試しても同じ結果にしかならない。
        error = `${e.message}（${plan.label}プランの上限）`;
        break;
      }
      if (e instanceof notion.NotionAuthError) {
        await db.query("update connections set status = 'revoked' where id = $1", [opts.connectionId]);
        error = e.message;
        break;
      }
      error ??= (e as Error).message;
    }
  }

  // Notion 側から消えた／共有解除されたものを外す
  const live = new Set(pages.map((p) => p.id));
  let removed = 0;
  for (const row of existing) {
    if (live.has(row.provider_object_id)) continue;
    if (row.document_id) await deleteDocument(db, workspaceId, actor, row.document_id).catch(() => {});
    await db.query('delete from source_selections where id = $1', [row.id]);
    removed++;
  }

  return finish({
    status: failed > 0 ? (added + updated > 0 ? 'partial' : 'failed') : 'completed',
    added,
    updated,
    removed,
    failed,
    error,
  });
}

export interface SyncStatus {
  connection: Connection | null;
  pages: number;
  lastRun: {
    status: string;
    added: number;
    updated: number;
    removed: number;
    failed: number;
    error: string | null;
    finished_at: string | null;
  } | null;
}

export async function syncStatus(db: Sql, workspaceId: string, provider = 'notion'): Promise<SyncStatus> {
  const connection = await activeConnection(db, workspaceId, provider);
  if (!connection) return { connection: null, pages: 0, lastRun: null };
  const { rows: cnt } = await db.query<{ n: string }>(
    'select count(*)::text as n from source_selections where connection_id = $1',
    [connection.id],
  );
  const { rows: run } = await db.query<SyncStatus['lastRun'] & object>(
    `select status, added, updated, removed, failed, error, finished_at::text
       from sync_runs where connection_id = $1 order by started_at desc limit 1`,
    [connection.id],
  );
  return { connection, pages: Number(cnt[0]?.n ?? 0), lastRun: run[0] ?? null };
}
