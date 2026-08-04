/**
 * PostgreSQL 接続とスキーマ。
 *
 * 本番: Neon（Vercel から接続）。ローカルとテスト: PGlite（Postgres の WASM ビルド）。
 * どちらも本物の Postgres なので、テストとの差分が生まれない。モックは使わない。
 *
 * 日本語検索に拡張は不要。bigram を自前で展開して tsvector に入れる（search.ts 参照）。
 */
import { config } from './config.ts';

/** driver の違いを吸収する最小の面。pg / @neondatabase/serverless / PGlite が同じ形を持つ。 */
export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

let instance: Sql | null = null;

/** Vercel / 本番など、PGlite にフォールバックしてはいけない環境か。 */
export function isManagedRuntime(): boolean {
  return Boolean(process.env.VERCEL) || process.env.NODE_ENV === 'production';
}

export async function sql(): Promise<Sql> {
  if (instance) return instance;
  if (config.databaseUrl) {
    instance = await neonPool(config.databaseUrl);
    return instance;
  }
  /*
   * PGlite はローカル開発とテストのためのもの。サーバーレス関数の中で WASM の
   * Postgres を起動しようとすると落ちるうえ、仮に起動できてもリクエストごとに
   * 消えるため、本番で黙ってフォールバックしてはいけない。
   * 原因が読めないクラッシュになる代わりに、ここで明示的に落とす。
   */
  if (isManagedRuntime()) {
    throw new Error(
      'DATABASE_URL が設定されていません。' +
        'Vercel のプロジェクト設定で、対象の環境（Production / Preview）に ' +
        'Neon の pooled 接続文字列を設定し、再デプロイしてください。',
    );
  }
  instance = await pglite(config.pgliteDir);
  return instance;
}

async function neonPool(url: string): Promise<Sql> {
  const { Pool, neonConfig } = await import('@neondatabase/serverless');
  const ws = await import('ws').catch(() => null);
  // トランザクションは WebSocket 経由になる。サーバーレスでは Node の ws を渡す必要がある。
  if (ws) neonConfig.webSocketConstructor = ws.default;
  const pool = new Pool({ connectionString: url });
  return { query: (text, params) => pool.query(text, params) as never };
}

async function pglite(dir: string | undefined): Promise<Sql> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create(dir ? { dataDir: dir } : undefined);
  return { query: (text, params) => db.query(text, params) as never };
}

/** テスト用。毎回まっさらな Postgres をメモリ上に作る。 */
export async function openTestDb(): Promise<Sql> {
  const db = await pglite(undefined);
  await migrate(db);
  return db;
}

/**
 * マイグレーション。すべて IF NOT EXISTS なので、複数プロセスから同時に走っても壊れない。
 * Vercel では cold start ごとに走らせず、`npm run migrate` で一度だけ実行する。
 */
const STATEMENTS: string[] = [
  `create table if not exists users (
     id text primary key,
     email text not null unique,
     password_hash text not null,
     created_at timestamptz not null default now()
   )`,
  `create table if not exists workspaces (
     id text primary key,
     owner_user_id text not null references users(id) on delete cascade,
     name text not null,
     plan text not null default 'free',
     plan_status text not null default 'active',
     stripe_customer_id text,
     stripe_subscription_id text,
     current_period_end timestamptz,
     created_at timestamptz not null default now()
   )`,
  `create index if not exists idx_ws_owner on workspaces(owner_user_id)`,
  `create index if not exists idx_ws_customer on workspaces(stripe_customer_id)`,

  `create table if not exists sessions (
     id text primary key,
     user_id text not null references users(id) on delete cascade,
     created_at timestamptz not null default now(),
     expires_at timestamptz not null
   )`,
  `create index if not exists idx_sess_user on sessions(user_id)`,

  // 平文のトークンは保存しない。ハッシュのみ。
  `create table if not exists mcp_tokens (
     id text primary key,
     workspace_id text not null references workspaces(id) on delete cascade,
     token_hash text not null unique,
     prefix text not null,
     created_at timestamptz not null default now(),
     last_used_at timestamptz,
     revoked_at timestamptz
   )`,
  `create index if not exists idx_tok_ws on mcp_tokens(workspace_id)`,

  `create table if not exists packs (
     id text primary key,
     workspace_id text not null references workspaces(id) on delete cascade,
     name text not null,
     project text,
     status text not null default 'active',
     retention_days integer,
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now()
   )`,
  `create index if not exists idx_pack_ws on packs(workspace_id)`,

  `create table if not exists documents (
     id text primary key,
     pack_id text not null references packs(id) on delete cascade,
     workspace_id text not null references workspaces(id) on delete cascade,
     title text not null,
     source_url text,
     origin text not null,
     body text not null,
     content_hash text not null,
     source_updated_at timestamptz,
     fetched_at timestamptz not null default now(),
     created_at timestamptz not null default now(),
     deleted_at timestamptz
   )`,
  `create index if not exists idx_doc_pack on documents(pack_id)`,
  `create index if not exists idx_doc_ws on documents(workspace_id)`,

  /*
   * SQLite 版では索引を別テーブル（FTS5 仮想テーブル）に置いていたため、
   * チャンクを消して索引を消し忘れると削除済みの内容が検索に残る危険があった。
   * Postgres では tsvector を同じ行に持てるので、その種のバグが構造的に消える。
   */
  `create table if not exists chunks (
     id bigserial primary key,
     document_id text not null references documents(id) on delete cascade,
     pack_id text not null references packs(id) on delete cascade,
     workspace_id text not null references workspaces(id) on delete cascade,
     ord integer not null,
     text text not null,
     norm_text text not null,
     grams tsvector not null
   )`,
  `create index if not exists idx_chunk_doc on chunks(document_id)`,
  `create index if not exists idx_chunk_grams on chunks using gin(grams)`,
  `create index if not exists idx_chunk_ws on chunks(workspace_id)`,

  `create table if not exists audit_events (
     id bigserial primary key,
     workspace_id text not null,
     actor text not null,
     event_type text not null,
     target_ref text,
     meta jsonb,
     created_at timestamptz not null default now()
   )`,
  `create index if not exists idx_audit_ws on audit_events(workspace_id, created_at desc)`,

  /*
   * 外部サービスとの接続。トークンは暗号化して token_ref に入れる。
   * 平文をそのまま置かない（要件書 FR-002）。
   */
  `create table if not exists connections (
     id text primary key,
     workspace_id text not null references workspaces(id) on delete cascade,
     provider text not null,
     external_account_id text,
     workspace_name text,
     granted_scopes text,
     status text not null default 'active',
     token_ref text not null,
     created_at timestamptz not null default now(),
     last_verified_at timestamptz
   )`,
  `create index if not exists idx_conn_ws on connections(workspace_id)`,

  /*
   * 取り込み対象。Notion では「利用者が共有を許可したページ」が1行になる。
   * 勝手にワークスペース全体を読まないことを、この表で担保する（FR-003）。
   */
  `create table if not exists source_selections (
     id text primary key,
     connection_id text not null references connections(id) on delete cascade,
     workspace_id text not null references workspaces(id) on delete cascade,
     pack_id text not null references packs(id) on delete cascade,
     provider_object_id text not null,
     title text,
     source_url text,
     enabled boolean not null default true,
     external_updated_at timestamptz,
     last_synced_at timestamptz,
     document_id text,
     created_at timestamptz not null default now()
   )`,
  `create index if not exists idx_sel_conn on source_selections(connection_id)`,
  `create unique index if not exists idx_sel_object on source_selections(connection_id, provider_object_id)`,

  /*
   * 同期の実行記録。v1 は 4状態だけ（実行中 / 完了 / 一部失敗 / 失敗）。
   * 要件書 FR-005 の6状態は、必要になってから増やす（ADR-0003）。
   */
  `create table if not exists sync_runs (
     id text primary key,
     connection_id text not null references connections(id) on delete cascade,
     workspace_id text not null references workspaces(id) on delete cascade,
     status text not null,
     added integer not null default 0,
     updated integer not null default 0,
     removed integer not null default 0,
     failed integer not null default 0,
     error text,
     started_at timestamptz not null default now(),
     finished_at timestamptz
   )`,
  `create index if not exists idx_run_conn on sync_runs(connection_id, started_at desc)`,

  `create table if not exists usage_counters (
     workspace_id text not null,
     period text not null,
     searches integer not null default 0,
     primary key (workspace_id, period)
   )`,
];

export async function migrate(db: Sql): Promise<void> {
  for (const stmt of STATEMENTS) {
    await db.query(stmt);
  }
}

/**
 * 同じ定義を SQL として出力する。ローカル環境が無い場合に
 * Neon の SQL Editor へ貼って初期化できるようにするため。
 */
export function schemaSql(): string {
  return STATEMENTS.map((s) => `${s.trim()};`).join('\n\n');
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function currentPeriod(at: Date = new Date()): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${Buffer.from(bytes).toString('base64url')}`;
}

/**
 * 監査ログ（要件書 FR-012）。
 * 本文・トークン・検索語そのものは記録しない。件数や長さなど、再現に不要な情報に留める。
 */
export async function audit(
  db: Sql,
  workspaceId: string,
  actor: string,
  eventType: string,
  targetRef?: string | null,
  meta?: Record<string, unknown>,
): Promise<void> {
  await db.query(
    'insert into audit_events (workspace_id, actor, event_type, target_ref, meta) values ($1,$2,$3,$4,$5)',
    [workspaceId, actor, eventType, targetRef ?? null, meta ? JSON.stringify(meta) : null],
  );
}
