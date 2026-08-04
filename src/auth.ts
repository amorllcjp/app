/**
 * 認証。
 *
 * Web: メール + パスワード（scrypt）→ 署名付きセッションCookie。
 * MCP: ワークスペース単位の Bearer トークン。平文は発行時に一度だけ表示し、以後はハッシュのみ保持。
 *
 * 要件書 §7.1 は OAuth/PKCE を求めているが、MVPでは Bearer に単純化した。
 * 意図的な逸脱であり、docs/adr/ADR-0002-技術判断.md に理由と返済条件を記録している。
 */
import { randomBytes, scryptSync, timingSafeEqual, createHmac, createHash } from 'node:crypto';
import type { Sql } from './db.ts';
import { newId, audit } from './db.ts';
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

export async function createAccount(db: Sql, email: string, password: string): Promise<Account> {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) throw new Error('メールアドレスの形式が正しくありません');
  if (password.length < 10) throw new Error('パスワードは10文字以上にしてください');
  const { rows: exists } = await db.query('select id from users where email = $1', [normalized]);
  if (exists.length) throw new Error('このメールアドレスは登録済みです');

  const userId = newId('usr');
  const workspaceId = newId('ws');
  const workspaceName = `${normalized.split('@')[0]} のワークスペース`;

  await db.query('insert into users (id, email, password_hash) values ($1,$2,$3)', [
    userId,
    normalized,
    hashPassword(password),
  ]);
  // 要件書 FR-001: 1アカウント = 1個人ワークスペース。
  await db.query('insert into workspaces (id, owner_user_id, name, plan) values ($1,$2,$3,$4)', [
    workspaceId,
    userId,
    workspaceName,
    'free',
  ]);
  await audit(db, workspaceId, userId, 'account.created');
  return { userId, email: normalized, workspaceId, workspaceName, plan: 'free', planStatus: 'active' };
}

export async function login(db: Sql, email: string, password: string): Promise<Account | null> {
  const { rows } = await db.query<{ id: string; password_hash: string }>(
    'select id, password_hash from users where email = $1',
    [email.trim().toLowerCase()],
  );
  const row = rows[0];
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  return accountForUser(db, row.id);
}

export async function accountForUser(db: Sql, userId: string): Promise<Account | null> {
  const { rows } = await db.query<Account>(
    `select u.id as "userId", u.email, w.id as "workspaceId", w.name as "workspaceName",
            w.plan, w.plan_status as "planStatus"
       from users u join workspaces w on w.owner_user_id = u.id
      where u.id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

// --- セッション ---

export async function createSession(db: Sql, userId: string): Promise<string> {
  const id = newId('sess');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  await db.query('insert into sessions (id, user_id, expires_at) values ($1,$2,$3)', [id, userId, expires]);
  return sign(id);
}

export async function readSession(db: Sql, signed: string | undefined): Promise<Account | null> {
  if (!signed) return null;
  const id = unsign(signed);
  if (!id) return null;
  const { rows } = await db.query<{ user_id: string }>(
    'select user_id from sessions where id = $1 and expires_at > now()',
    [id],
  );
  return rows[0] ? accountForUser(db, rows[0].user_id) : null;
}

export async function destroySession(db: Sql, signed: string | undefined): Promise<void> {
  if (!signed) return;
  const id = unsign(signed);
  if (id) await db.query('delete from sessions where id = $1', [id]);
}

function secret(): string {
  if (!config.sessionSecret) throw new Error('SESSION_SECRET が未設定です');
  return config.sessionSecret;
}

function sign(value: string): string {
  return `${value}.${createHmac('sha256', secret()).update(value).digest('base64url')}`;
}

function unsign(signed: string): string | null {
  const idx = signed.lastIndexOf('.');
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const a = Buffer.from(signed.slice(idx + 1));
  const b = Buffer.from(createHmac('sha256', secret()).update(value).digest('base64url'));
  return a.length === b.length && timingSafeEqual(a, b) ? value : null;
}

// --- MCPトークン ---

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 発行。戻り値の平文はこの一度しか手に入らない。既存のトークンは即時失効する。 */
export async function issueMcpToken(db: Sql, workspaceId: string, actor: string): Promise<string> {
  await db.query('update mcp_tokens set revoked_at = now() where workspace_id = $1 and revoked_at is null', [
    workspaceId,
  ]);
  const token = `cbk_${randomBytes(24).toString('base64url')}`;
  await db.query('insert into mcp_tokens (id, workspace_id, token_hash, prefix) values ($1,$2,$3,$4)', [
    newId('tok'),
    workspaceId,
    hashToken(token),
    token.slice(0, 12),
  ]);
  await audit(db, workspaceId, actor, 'mcp_token.issued');
  return token;
}

export interface McpPrincipal {
  workspaceId: string;
  plan: string;
  planStatus: string;
}

/** Authorization ヘッダから principal を解決する。失敗時は null。 */
export async function authenticateMcp(db: Sql, authorization: string | null | undefined): Promise<McpPrincipal | null> {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!m || !m[1]) return null;
  const { rows } = await db.query<{ id: string; workspaceId: string; plan: string; planStatus: string }>(
    `select t.id, w.id as "workspaceId", w.plan, w.plan_status as "planStatus"
       from mcp_tokens t join workspaces w on w.id = t.workspace_id
      where t.token_hash = $1 and t.revoked_at is null`,
    [hashToken(m[1].trim())],
  );
  const row = rows[0];
  if (!row) return null;
  await db.query('update mcp_tokens set last_used_at = now() where id = $1', [row.id]);
  return { workspaceId: row.workspaceId, plan: row.plan, planStatus: row.planStatus };
}
