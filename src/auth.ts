/**
 * 認証。
 *
 * Web: メール + パスワード（scrypt）→ 署名付きセッションCookie。
 * MCP: ワークスペース単位の Bearer トークン。平文は発行時に一度だけ表示し、以後はハッシュのみ保持。
 *
 * 要件書 §7.1 は OAuth/PKCE を求めているが、MVPでは Bearer に単純化した。
 * 意図的な逸脱であり、docs/adr/ADR-0002-MCP認証.md に理由と返済条件を記録している。
 */
import { randomBytes, scryptSync, timingSafeEqual, createHmac, createHash } from 'node:crypto';
import type { DB } from './db.ts';
import { newId, nowIso, audit } from './db.ts';
import { config } from './config.ts';

const SESSION_DAYS = 30;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface Account {
  userId: string;
  email: string;
  workspaceId: string;
  workspaceName: string;
  plan: string;
  planStatus: string;
}

export function createAccount(d: DB, email: string, password: string): Account {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) throw new Error('メールアドレスの形式が正しくありません');
  if (password.length < 10) throw new Error('パスワードは10文字以上にしてください');
  const exists = d.prepare('select id from users where email = ?').get(normalized);
  if (exists) throw new Error('このメールアドレスは登録済みです');

  const userId = newId('usr');
  const workspaceId = newId('ws');
  const at = nowIso();
  d.prepare('insert into users (id, email, password_hash, created_at) values (?,?,?,?)').run(
    userId,
    normalized,
    hashPassword(password),
    at,
  );
  // 要件書 FR-001: 1アカウント = 1個人ワークスペース。
  d.prepare('insert into workspaces (id, owner_user_id, name, plan, created_at) values (?,?,?,?,?)').run(
    workspaceId,
    userId,
    `${normalized.split('@')[0]} のワークスペース`,
    'free',
    at,
  );
  audit(d, workspaceId, userId, 'account.created');
  return {
    userId,
    email: normalized,
    workspaceId,
    workspaceName: `${normalized.split('@')[0]} のワークスペース`,
    plan: 'free',
    planStatus: 'active',
  };
}

export function login(d: DB, email: string, password: string): Account | null {
  const row = d.prepare('select id, email, password_hash from users where email = ?').get(email.trim().toLowerCase()) as
    | { id: string; email: string; password_hash: string }
    | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  return accountForUser(d, row.id);
}

export function accountForUser(d: DB, userId: string): Account | null {
  const row = d
    .prepare(
      `select u.id as userId, u.email, w.id as workspaceId, w.name as workspaceName, w.plan, w.plan_status as planStatus
         from users u join workspaces w on w.owner_user_id = u.id
        where u.id = ?`,
    )
    .get(userId) as Account | undefined;
  return row ?? null;
}

// --- セッション ---

export function createSession(d: DB, userId: string): string {
  const id = newId('sess');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  d.prepare('insert into sessions (id, user_id, created_at, expires_at) values (?,?,?,?)').run(
    id,
    userId,
    nowIso(),
    expires,
  );
  return sign(id);
}

export function readSession(d: DB, signed: string | undefined): Account | null {
  if (!signed) return null;
  const id = unsign(signed);
  if (!id) return null;
  const row = d.prepare('select user_id, expires_at from sessions where id = ?').get(id) as
    | { user_id: string; expires_at: string }
    | undefined;
  if (!row || new Date(row.expires_at) < new Date()) return null;
  return accountForUser(d, row.user_id);
}

export function destroySession(d: DB, signed: string | undefined): void {
  if (!signed) return;
  const id = unsign(signed);
  if (id) d.prepare('delete from sessions where id = ?').run(id);
}

function secret(): string {
  if (!config.sessionSecret) throw new Error('SESSION_SECRET が未設定です');
  return config.sessionSecret;
}

function sign(value: string): string {
  const mac = createHmac('sha256', secret()).update(value).digest('base64url');
  return `${value}.${mac}`;
}

function unsign(signed: string): string | null {
  const idx = signed.lastIndexOf('.');
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const mac = signed.slice(idx + 1);
  const expected = createHmac('sha256', secret()).update(value).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? value : null;
}

// --- MCPトークン ---

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 発行。戻り値の平文はこの一度しか手に入らない。 */
export function issueMcpToken(d: DB, workspaceId: string, actor: string): string {
  d.prepare('update mcp_tokens set revoked_at = ? where workspace_id = ? and revoked_at is null').run(
    nowIso(),
    workspaceId,
  );
  const token = `cbk_${randomBytes(24).toString('base64url')}`;
  d.prepare('insert into mcp_tokens (id, workspace_id, token_hash, prefix, created_at) values (?,?,?,?,?)').run(
    newId('tok'),
    workspaceId,
    hashToken(token),
    token.slice(0, 12),
    nowIso(),
  );
  audit(d, workspaceId, actor, 'mcp_token.issued');
  return token;
}

export interface McpPrincipal {
  workspaceId: string;
  plan: string;
  planStatus: string;
}

/** Authorization ヘッダから principal を解決する。失敗時は null。 */
export function authenticateMcp(d: DB, authorization: string | null | undefined): McpPrincipal | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!m || !m[1]) return null;
  const row = d
    .prepare(
      `select t.id, w.id as workspaceId, w.plan, w.plan_status as planStatus
         from mcp_tokens t join workspaces w on w.id = t.workspace_id
        where t.token_hash = ? and t.revoked_at is null`,
    )
    .get(hashToken(m[1].trim())) as { id: string; workspaceId: string; plan: string; planStatus: string } | undefined;
  if (!row) return null;
  d.prepare('update mcp_tokens set last_used_at = ? where id = ?').run(nowIso(), row.id);
  return { workspaceId: row.workspaceId, plan: row.plan, planStatus: row.planStatus };
}
