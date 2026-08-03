/**
 * SQLite スキーマと接続。
 *
 * PostgreSQL + pgvector + pg_bigm + ジョブキューを使わない理由は
 * docs/adr/ADR-0003-削除した要件.md を参照。
 * 日本語検索は search.ts の bigram 索引で行うため、拡張は不要。
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.ts';

export type DB = Database.Database;

let instance: DB | null = null;

export function db(): DB {
  if (instance) return instance;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  instance = new Database(config.dbPath);
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');
  migrate(instance);
  return instance;
}

/** テスト用。ファイルを作らずインメモリで動かす。 */
export function openMemoryDb(): DB {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  migrate(d);
  return d;
}

export function migrate(d: DB): void {
  d.exec(`
    create table if not exists users (
      id            text primary key,
      email         text not null unique,
      password_hash text not null,
      created_at    text not null
    );

    create table if not exists workspaces (
      id                     text primary key,
      owner_user_id          text not null references users(id) on delete cascade,
      name                   text not null,
      plan                   text not null default 'free',
      plan_status            text not null default 'active',
      stripe_customer_id     text,
      stripe_subscription_id text,
      current_period_end     text,
      created_at             text not null
    );
    create index if not exists idx_ws_owner on workspaces(owner_user_id);
    create index if not exists idx_ws_customer on workspaces(stripe_customer_id);

    create table if not exists sessions (
      id           text primary key,
      user_id      text not null references users(id) on delete cascade,
      created_at   text not null,
      expires_at   text not null
    );

    -- MCPクライアントが使うトークン。平文は保存せず、ハッシュのみ持つ。
    create table if not exists mcp_tokens (
      id           text primary key,
      workspace_id text not null references workspaces(id) on delete cascade,
      token_hash   text not null unique,
      prefix       text not null,
      created_at   text not null,
      last_used_at text,
      revoked_at   text
    );
    create index if not exists idx_tok_ws on mcp_tokens(workspace_id);

    create table if not exists packs (
      id             text primary key,
      workspace_id   text not null references workspaces(id) on delete cascade,
      name           text not null,
      project        text,
      status         text not null default 'active',
      retention_days integer,
      created_at     text not null,
      updated_at     text not null
    );
    create index if not exists idx_pack_ws on packs(workspace_id);

    -- 取り込んだ原文。出典と時刻は必須（要件書 FR-007）。
    create table if not exists documents (
      id                text primary key,
      pack_id           text not null references packs(id) on delete cascade,
      workspace_id      text not null references workspaces(id) on delete cascade,
      title             text not null,
      source_url        text,
      -- 'markdown'（ユーザー取り込み） | 'user_saved'（context_save 由来）
      origin            text not null,
      body              text not null,
      content_hash      text not null,
      source_updated_at text,
      fetched_at        text not null,
      created_at        text not null,
      deleted_at        text
    );
    create index if not exists idx_doc_pack on documents(pack_id);
    create index if not exists idx_doc_ws on documents(workspace_id);

    create table if not exists chunks (
      id           integer primary key autoincrement,
      document_id  text not null references documents(id) on delete cascade,
      pack_id      text not null references packs(id) on delete cascade,
      workspace_id text not null references workspaces(id) on delete cascade,
      ord          integer not null,
      text         text not null
    );
    create index if not exists idx_chunk_doc on chunks(document_id);
    create index if not exists idx_chunk_pack on chunks(pack_id);

    -- bigram 索引。rowid = chunks.id で対応づける。
    create virtual table if not exists chunk_index using fts5(grams);

    create table if not exists audit_events (
      id           integer primary key autoincrement,
      workspace_id text not null,
      actor        text not null,
      event_type   text not null,
      target_ref   text,
      meta         text,
      created_at   text not null
    );
    create index if not exists idx_audit_ws on audit_events(workspace_id, created_at);

    -- 課金の上限判定に使う。period は 'YYYY-MM'。
    create table if not exists usage_counters (
      workspace_id text not null,
      period       text not null,
      searches     integer not null default 0,
      primary key (workspace_id, period)
    );
  `);
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
 * 監査ログ。要件書 FR-012。
 * 本文・トークン・検索語そのものは書かない。件数や長さなど、再現に不要な情報に留める。
 */
export function audit(
  d: DB,
  workspaceId: string,
  actor: string,
  eventType: string,
  targetRef?: string | null,
  meta?: Record<string, unknown>,
): void {
  d.prepare(
    'insert into audit_events (workspace_id, actor, event_type, target_ref, meta, created_at) values (?,?,?,?,?,?)',
  ).run(workspaceId, actor, eventType, targetRef ?? null, meta ? JSON.stringify(meta) : null, nowIso());
}
