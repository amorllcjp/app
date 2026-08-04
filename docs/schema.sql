create table if not exists users (
     id text primary key,
     email text not null unique,
     password_hash text not null,
     created_at timestamptz not null default now()
   );

create table if not exists workspaces (
     id text primary key,
     owner_user_id text not null references users(id) on delete cascade,
     name text not null,
     plan text not null default 'free',
     plan_status text not null default 'active',
     stripe_customer_id text,
     stripe_subscription_id text,
     current_period_end timestamptz,
     created_at timestamptz not null default now()
   );

create index if not exists idx_ws_owner on workspaces(owner_user_id);

create index if not exists idx_ws_customer on workspaces(stripe_customer_id);

create table if not exists sessions (
     id text primary key,
     user_id text not null references users(id) on delete cascade,
     created_at timestamptz not null default now(),
     expires_at timestamptz not null
   );

create index if not exists idx_sess_user on sessions(user_id);

create table if not exists mcp_tokens (
     id text primary key,
     workspace_id text not null references workspaces(id) on delete cascade,
     token_hash text not null unique,
     prefix text not null,
     created_at timestamptz not null default now(),
     last_used_at timestamptz,
     revoked_at timestamptz
   );

create index if not exists idx_tok_ws on mcp_tokens(workspace_id);

create table if not exists packs (
     id text primary key,
     workspace_id text not null references workspaces(id) on delete cascade,
     name text not null,
     project text,
     status text not null default 'active',
     retention_days integer,
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now()
   );

create index if not exists idx_pack_ws on packs(workspace_id);

create table if not exists documents (
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
   );

create index if not exists idx_doc_pack on documents(pack_id);

create index if not exists idx_doc_ws on documents(workspace_id);

create table if not exists chunks (
     id bigserial primary key,
     document_id text not null references documents(id) on delete cascade,
     pack_id text not null references packs(id) on delete cascade,
     workspace_id text not null references workspaces(id) on delete cascade,
     ord integer not null,
     text text not null,
     norm_text text not null,
     grams tsvector not null
   );

create index if not exists idx_chunk_doc on chunks(document_id);

create index if not exists idx_chunk_grams on chunks using gin(grams);

create index if not exists idx_chunk_ws on chunks(workspace_id);

create table if not exists audit_events (
     id bigserial primary key,
     workspace_id text not null,
     actor text not null,
     event_type text not null,
     target_ref text,
     meta jsonb,
     created_at timestamptz not null default now()
   );

create index if not exists idx_audit_ws on audit_events(workspace_id, created_at desc);

create table if not exists usage_counters (
     workspace_id text not null,
     period text not null,
     searches integer not null default 0,
     primary key (workspace_id, period)
   );
