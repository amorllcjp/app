/**
 * HTTP サーバー。Hono（Web標準の Request/Response）を使うのは、
 * MCP SDK v2 のハンドラが Web標準の fetch 形式だからで、変換層を作らずに済むため。
 */
import { Hono, type Context } from 'hono';
import { serve } from '@hono/node-server';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { db, audit, nowIso } from './db.ts';
import { config, planOf } from './config.ts';
import {
  createAccount,
  login,
  createSession,
  readSession,
  destroySession,
  issueMcpToken,
  type Account,
} from './auth.ts';
import {
  listPacks,
  createPack,
  getPack,
  deletePack,
  addDocument,
  deleteDocument,
  listDocuments,
  exportPackMarkdown,
  searchWithEvidence,
  searchesUsed,
  workspacePlan,
  LimitError,
} from './packs.ts';
import { createCheckoutSession, createPortalSession, handleWebhook, billingConfigured } from './billing.ts';
import { mcpHandler } from './mcp.ts';
import * as V from './views.ts';

const d = db();
const app = new Hono();

const COOKIE = 'cb_session';

function currentAccount(c: Context): Account | null {
  return readSession(d, getCookie(c, COOKIE));
}

function html(c: Context, body: string, account: Account | null, title: string, status = 200) {
  return c.html(
    V.layout({ title, account: account ? { email: account.email, plan: account.plan } : null, body }),
    status as 200,
  );
}

// --- MCP エンドポイント ---
// 認証は mcpHandler の中で Bearer トークンから解決する。Cookie は見ない。
const handleMcp = mcpHandler(d);
app.all('/mcp', (c) => handleMcp(c.req.raw));

// --- Stripe Webhook ---
// 署名検証のため生のボディが必要。他のミドルウェアでパースしない。
app.post('/billing/webhook', async (c) => {
  try {
    const raw = await c.req.text();
    await handleWebhook(d, raw, c.req.header('stripe-signature') ?? null);
    return c.json({ received: true });
  } catch (e) {
    console.error('webhook error:', (e as Error).message);
    return c.json({ error: (e as Error).message }, 400);
  }
});

// --- 公開ページ ---
app.get('/', (c) => html(c, V.landing(), currentAccount(c), 'AIに毎回同じ説明をするのをやめる'));

app.get('/pricing', (c) => {
  const account = currentAccount(c);
  return html(c, V.pricing(account?.plan, c.req.query('canceled') === '1'), account, '料金');
});

app.get('/healthz', (c) => c.json({ ok: true, at: nowIso() }));

app.get('/legal/:kind', (c) => {
  const kind = c.req.param('kind');
  if (kind !== 'tokushoho' && kind !== 'privacy' && kind !== 'terms') return c.notFound();
  const titles = { tokushoho: '特定商取引法に基づく表記', privacy: 'プライバシーポリシー', terms: '利用規約' };
  return html(c, V.legalPage(kind), currentAccount(c), titles[kind]);
});

// --- 認証 ---
app.get('/signup', (c) => (currentAccount(c) ? c.redirect('/app') : html(c, V.authPage('signup'), null, '無料で始める')));
app.get('/login', (c) => (currentAccount(c) ? c.redirect('/app') : html(c, V.authPage('login'), null, 'ログイン')));

app.post('/signup', async (c) => {
  const f = await c.req.parseBody();
  try {
    const account = createAccount(d, String(f.email ?? ''), String(f.password ?? ''));
    setSession(c, createSession(d, account.userId));
    return c.redirect('/app');
  } catch (e) {
    return html(c, V.authPage('signup', (e as Error).message), null, '無料で始める', 400);
  }
});

app.post('/login', async (c) => {
  const f = await c.req.parseBody();
  const account = login(d, String(f.email ?? ''), String(f.password ?? ''));
  if (!account) return html(c, V.authPage('login', 'メールアドレスまたはパスワードが違います'), null, 'ログイン', 401);
  setSession(c, createSession(d, account.userId));
  return c.redirect('/app');
});

app.post('/logout', (c) => {
  destroySession(d, getCookie(c, COOKIE));
  deleteCookie(c, COOKIE, { path: '/' });
  return c.redirect('/');
});

function setSession(c: Context, value: string) {
  setCookie(c, COOKIE, value, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.baseUrl.startsWith('https://'),
    maxAge: 30 * 86_400,
  });
}

// --- ここから先は要ログイン ---
app.use('/app/*', async (c, next) => {
  if (!currentAccount(c)) return c.redirect('/login');
  await next();
});
app.use('/billing/checkout', async (c, next) => {
  if (!currentAccount(c)) return c.redirect('/login');
  await next();
});
app.use('/billing/portal', async (c, next) => {
  if (!currentAccount(c)) return c.redirect('/login');
  await next();
});

app.get('/app', (c) => {
  const account = currentAccount(c)!;
  return html(c, renderDashboard(account, { upgraded: c.req.query('upgraded') === '1' }), account, 'ダッシュボード');
});

function renderDashboard(
  account: Account,
  extra: { freshToken?: string | null; notice?: string | null; error?: string | null; upgraded?: boolean } = {},
): string {
  const ws = account.workspaceId;
  const plan = workspacePlan(d, ws);
  const packs = listPacks(d, ws).map((p) => ({
    id: p.id,
    name: p.name,
    project: p.project,
    status: p.status,
    updated_at: p.updated_at,
    docs: (d.prepare('select count(*) as n from documents where pack_id = ? and deleted_at is null').get(p.id) as {
      n: number;
    }).n,
  }));
  const docs = (
    d.prepare('select count(*) as n from documents where workspace_id = ? and deleted_at is null').get(ws) as {
      n: number;
    }
  ).n;
  const tok = d
    .prepare('select prefix from mcp_tokens where workspace_id = ? and revoked_at is null order by created_at desc')
    .get(ws) as { prefix: string } | undefined;

  return V.dashboard({
    account: { email: account.email, plan: account.plan, workspaceName: account.workspaceName },
    packs,
    plan,
    usage: {
      searches: searchesUsed(d, ws),
      searchLimit: plan.limits.searchesPerMonth,
      docs,
      docLimit: plan.limits.documentsPerWorkspace,
      packLimit: plan.limits.packs,
    },
    tokenPrefix: tok?.prefix ?? null,
    ...extra,
  });
}

app.post('/app/token', (c) => {
  const account = currentAccount(c)!;
  const token = issueMcpToken(d, account.workspaceId, account.userId);
  return html(c, renderDashboard(account, { freshToken: token }), account, 'ダッシュボード');
});

app.get('/app/connect', (c) => {
  const account = currentAccount(c)!;
  const tok = d
    .prepare('select prefix from mcp_tokens where workspace_id = ? and revoked_at is null order by created_at desc')
    .get(account.workspaceId) as { prefix: string } | undefined;
  return html(c, V.connectPage(tok?.prefix ?? null), account, '接続方法');
});

app.post('/app/packs', async (c) => {
  const account = currentAccount(c)!;
  const f = await c.req.parseBody();
  try {
    createPack(d, account.workspaceId, account.userId, {
      name: String(f.name ?? ''),
      project: String(f.project ?? ''),
    });
    return c.redirect('/app');
  } catch (e) {
    return html(c, renderDashboard(account, { error: (e as Error).message }), account, 'ダッシュボード', 400);
  }
});

app.get('/app/packs/:id', (c) => {
  const account = currentAccount(c)!;
  const pack = getPack(d, account.workspaceId, c.req.param('id'));
  if (!pack) return c.notFound();
  const q = c.req.query('q');
  let results = null;
  if (q && q.trim()) {
    results = searchWithEvidence(d, account.workspaceId, account.userId, { query: q, packIds: [pack.id] }).results;
  }
  return html(
    c,
    V.packPage({ pack, docs: listDocuments(d, account.workspaceId, pack.id), results, query: q }),
    account,
    pack.name,
  );
});

app.post('/app/packs/:id/documents', async (c) => {
  const account = currentAccount(c)!;
  const pack = getPack(d, account.workspaceId, c.req.param('id'));
  if (!pack) return c.notFound();
  const f = await c.req.parseBody();
  try {
    addDocument(d, account.workspaceId, account.userId, pack.id, {
      title: String(f.title ?? ''),
      body: String(f.body ?? ''),
      sourceUrl: String(f.source_url ?? '') || null,
    });
    return c.redirect(`/app/packs/${pack.id}`);
  } catch (e) {
    const msg =
      e instanceof LimitError ? `${e.message} プランを変更すると上限を引き上げられます。` : (e as Error).message;
    return html(
      c,
      V.packPage({ pack, docs: listDocuments(d, account.workspaceId, pack.id), error: msg }),
      account,
      pack.name,
      400,
    );
  }
});

app.post('/app/documents/:id/delete', (c) => {
  const account = currentAccount(c)!;
  const docId = c.req.param('id');
  const row = d.prepare('select pack_id from documents where id = ? and workspace_id = ?').get(docId, account.workspaceId) as
    | { pack_id: string }
    | undefined;
  if (!row) return c.notFound();
  deleteDocument(d, account.workspaceId, account.userId, docId);
  return c.redirect(`/app/packs/${row.pack_id}`);
});

app.post('/app/packs/:id/delete', (c) => {
  const account = currentAccount(c)!;
  deletePack(d, account.workspaceId, account.userId, c.req.param('id'));
  return c.redirect('/app');
});

app.get('/app/packs/:id/export', (c) => {
  const account = currentAccount(c)!;
  try {
    const md = exportPackMarkdown(d, account.workspaceId, c.req.param('id'));
    return new Response(md, {
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="context-pack-${c.req.param('id')}.md"`,
      },
    });
  } catch {
    return c.notFound();
  }
});

app.get('/app/danger', (c) => html(c, V.dangerPage(), currentAccount(c), 'データの削除'));

app.post('/app/danger', async (c) => {
  const account = currentAccount(c)!;
  const f = await c.req.parseBody();
  if (String(f.confirm ?? '').trim() !== '削除します') {
    return html(c, V.dangerPage(), account, 'データの削除', 400);
  }
  audit(d, account.workspaceId, account.userId, 'account.deleted');
  // 外部キーの on delete cascade で Pack・資料・チャンクまで落ちる。索引は別テーブルなので明示的に消す。
  const chunkIds = d.prepare('select id from chunks where workspace_id = ?').all(account.workspaceId) as Array<{
    id: number;
  }>;
  const delIdx = d.prepare('delete from chunk_index where rowid = ?');
  for (const ch of chunkIds) delIdx.run(ch.id);
  d.prepare('delete from audit_events where workspace_id = ?').run(account.workspaceId);
  d.prepare('delete from usage_counters where workspace_id = ?').run(account.workspaceId);
  d.prepare('delete from users where id = ?').run(account.userId);
  deleteCookie(c, COOKIE, { path: '/' });
  return c.redirect('/');
});

// --- 課金導線 ---
app.post('/billing/checkout', async (c) => {
  const account = currentAccount(c)!;
  if (!billingConfigured()) {
    return html(
      c,
      renderDashboard(account, { error: '決済がまだ設定されていません（STRIPE_SECRET_KEY / STRIPE_PRO_PRICE_ID）。' }),
      account,
      'ダッシュボード',
      503,
    );
  }
  try {
    return c.redirect(await createCheckoutSession(d, account.workspaceId, account.email), 303);
  } catch (e) {
    return html(c, renderDashboard(account, { error: (e as Error).message }), account, 'ダッシュボード', 500);
  }
});

app.post('/billing/portal', async (c) => {
  const account = currentAccount(c)!;
  try {
    return c.redirect(await createPortalSession(d, account.workspaceId), 303);
  } catch (e) {
    return html(c, renderDashboard(account, { error: (e as Error).message }), account, 'ダッシュボード', 400);
  }
});

// --- 起動 ---
if (!config.sessionSecret) {
  console.error('起動できません: SESSION_SECRET が未設定です。');
  console.error('  例: SESSION_SECRET=$(openssl rand -base64 32) npm start');
  process.exit(1);
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Context Bridge  http://localhost:${info.port}`);
  console.log(`  MCP           ${config.baseUrl}/mcp`);
  console.log(`  決済設定      ${billingConfigured() ? '有効' : '未設定（Freeプランのみ動作）'}`);
});

export { app };
