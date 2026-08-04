/**
 * ルーティング。実行環境に依存しない Hono アプリ。
 *
 * ローカルは src/server.ts、Vercel は api/index.ts から使う。
 * どちらも @hono/node-server の getRequestListener を通す。
 *
 * このファイル自体も default export を持つ（末尾を参照）。Vercel が
 * api/index.ts ではなくこのファイルを直接エントリポイントとして読み込む場合があるため。
 */
import { Hono, type Context } from 'hono';
import { getRequestListener } from '@hono/node-server';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { sql, audit, nowIso, type Sql } from './db.ts';
import { config } from './config.ts';
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

const COOKIE = 'cb_session';
export const app = new Hono();

/*
 * 設定不足でハンドラが例外を投げると、Vercel では FUNCTION_INVOCATION_FAILED の
 * 白い画面になり、原因が一切分からない。ここで受け止めて、何をすればよいか出す。
 */
app.onError((err, c) => {
  console.error('unhandled error:', err.stack ?? err.message);
  const detail = err.message.includes('DATABASE_URL') || err.message.includes('SESSION_SECRET');
  return c.html(
    V.layout({
      title: '設定が未完了です',
      account: null,
      body: `<h1>サーバー設定が未完了です</h1>
        ${detail ? `<div class="err">${V.esc(err.message)}</div>` : '<div class="err">処理中にエラーが発生しました。</div>'}
        <p class="small muted">切り分けには <a href="/healthz">/healthz</a> を確認してください。
        設定項目の一覧が返ります（接続文字列そのものは表示しません）。</p>`,
    }),
    500,
  );
});

async function account(c: Context): Promise<Account | null> {
  return readSession(await sql(), getCookie(c, COOKIE));
}

function html(c: Context, body: string, acc: Account | null, title: string, status = 200) {
  return c.html(
    V.layout({ title, account: acc ? { email: acc.email, plan: acc.plan } : null, body }),
    status as 200,
  );
}

function setSession(c: Context, value: string) {
  setCookie(c, COOKIE, value, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.baseUrl.startsWith('https://'),
    maxAge: 30 * 86_400,
  });
}

// --- MCP ---
// 認証は Bearer トークンから解決する。Cookie は見ない。
let mcp: ((r: Request) => Promise<Response>) | null = null;
app.all('/mcp', async (c) => {
  const db = await sql();
  mcp ??= mcpHandler(db);
  return mcp(c.req.raw);
});

// --- Stripe Webhook ---
// 署名検証のため生のボディが必要。他のミドルウェアでパースしない。
app.post('/billing/webhook', async (c) => {
  try {
    await handleWebhook(await sql(), await c.req.text(), c.req.header('stripe-signature') ?? null);
    return c.json({ received: true });
  } catch (e) {
    console.error('webhook error:', (e as Error).message);
    return c.json({ error: (e as Error).message }, 400);
  }
});

// --- 公開ページ ---
app.get('/', async (c) => html(c, V.landing(), await account(c), 'AIに毎回同じ説明をするのをやめる'));

app.get('/pricing', async (c) => {
  const acc = await account(c);
  return html(c, V.pricing(acc?.plan, c.req.query('canceled') === '1'), acc, '料金');
});

/**
 * 死活確認。デプロイ直後の切り分けに使うので、失敗時に「何が足りないか」まで返す。
 * 接続文字列そのものは絶対に出さない。
 */
app.get('/healthz', async (c) => {
  const env = {
    database_url_set: Boolean(config.databaseUrl),
    database_url_pooled: config.databaseUrl.includes('-pooler'),
    session_secret_set: Boolean(config.sessionSecret),
    base_url: config.baseUrl,
    billing_configured: billingConfigured(),
  };
  try {
    const { rows } = await (await sql()).query<{ n: string }>(
      "select count(*)::text as n from information_schema.tables where table_name = 'packs'",
    );
    const migrated = Number(rows[0]?.n ?? 0) > 0;
    return c.json({ ok: migrated, migrated, env, at: nowIso() }, migrated ? 200 : 503);
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message, env, at: nowIso() }, 503);
  }
});

app.get('/legal/:kind', async (c) => {
  const kind = c.req.param('kind');
  if (kind !== 'tokushoho' && kind !== 'privacy' && kind !== 'terms') return c.notFound();
  const titles = { tokushoho: '特定商取引法に基づく表記', privacy: 'プライバシーポリシー', terms: '利用規約' };
  return html(c, V.legalPage(kind), await account(c), titles[kind]);
});

// --- 認証 ---
app.get('/signup', async (c) =>
  (await account(c)) ? c.redirect('/app') : html(c, V.authPage('signup'), null, '無料で始める'),
);
app.get('/login', async (c) => ((await account(c)) ? c.redirect('/app') : html(c, V.authPage('login'), null, 'ログイン')));

app.post('/signup', async (c) => {
  const f = await c.req.parseBody();
  try {
    const db = await sql();
    const acc = await createAccount(db, String(f.email ?? ''), String(f.password ?? ''));
    setSession(c, await createSession(db, acc.userId));
    return c.redirect('/app');
  } catch (e) {
    return html(c, V.authPage('signup', (e as Error).message), null, '無料で始める', 400);
  }
});

app.post('/login', async (c) => {
  const f = await c.req.parseBody();
  const db = await sql();
  const acc = await login(db, String(f.email ?? ''), String(f.password ?? ''));
  if (!acc) return html(c, V.authPage('login', 'メールアドレスまたはパスワードが違います'), null, 'ログイン', 401);
  setSession(c, await createSession(db, acc.userId));
  return c.redirect('/app');
});

app.post('/logout', async (c) => {
  await destroySession(await sql(), getCookie(c, COOKIE));
  deleteCookie(c, COOKIE, { path: '/' });
  return c.redirect('/');
});

// --- 要ログイン ---
for (const path of ['/app/*', '/app', '/billing/checkout', '/billing/portal']) {
  app.use(path, async (c, next) => {
    if (!(await account(c))) return c.redirect('/login');
    await next();
  });
}

async function renderDashboard(
  db: Sql,
  acc: Account,
  extra: { freshToken?: string | null; notice?: string | null; error?: string | null; upgraded?: boolean } = {},
): Promise<string> {
  const ws = acc.workspaceId;
  const plan = await workspacePlan(db, ws);
  const packs = [];
  for (const p of await listPacks(db, ws)) {
    const { rows } = await db.query<{ n: string }>(
      'select count(*)::text as n from documents where pack_id = $1 and deleted_at is null',
      [p.id],
    );
    packs.push({
      id: p.id,
      name: p.name,
      project: p.project,
      status: p.status,
      updated_at: p.updated_at,
      docs: Number(rows[0]?.n ?? 0),
    });
  }
  const { rows: docRows } = await db.query<{ n: string }>(
    'select count(*)::text as n from documents where workspace_id = $1 and deleted_at is null',
    [ws],
  );
  const { rows: tokRows } = await db.query<{ prefix: string }>(
    'select prefix from mcp_tokens where workspace_id = $1 and revoked_at is null order by created_at desc limit 1',
    [ws],
  );

  return V.dashboard({
    account: { email: acc.email, plan: acc.plan, workspaceName: acc.workspaceName },
    packs,
    plan,
    usage: {
      searches: await searchesUsed(db, ws),
      searchLimit: plan.limits.searchesPerMonth,
      docs: Number(docRows[0]?.n ?? 0),
      docLimit: plan.limits.documentsPerWorkspace,
      packLimit: plan.limits.packs,
    },
    tokenPrefix: tokRows[0]?.prefix ?? null,
    ...extra,
  });
}

app.get('/app', async (c) => {
  const acc = (await account(c))!;
  const db = await sql();
  return html(c, await renderDashboard(db, acc, { upgraded: c.req.query('upgraded') === '1' }), acc, 'ダッシュボード');
});

app.post('/app/token', async (c) => {
  const acc = (await account(c))!;
  const db = await sql();
  const token = await issueMcpToken(db, acc.workspaceId, acc.userId);
  return html(c, await renderDashboard(db, acc, { freshToken: token }), acc, 'ダッシュボード');
});

app.get('/app/connect', async (c) => {
  const acc = (await account(c))!;
  const { rows } = await (await sql()).query<{ prefix: string }>(
    'select prefix from mcp_tokens where workspace_id = $1 and revoked_at is null order by created_at desc limit 1',
    [acc.workspaceId],
  );
  return html(c, V.connectPage(rows[0]?.prefix ?? null), acc, '接続方法');
});

app.post('/app/packs', async (c) => {
  const acc = (await account(c))!;
  const db = await sql();
  const f = await c.req.parseBody();
  try {
    await createPack(db, acc.workspaceId, acc.userId, { name: String(f.name ?? ''), project: String(f.project ?? '') });
    return c.redirect('/app');
  } catch (e) {
    return html(c, await renderDashboard(db, acc, { error: (e as Error).message }), acc, 'ダッシュボード', 400);
  }
});

app.get('/app/packs/:id', async (c) => {
  const acc = (await account(c))!;
  const db = await sql();
  const pack = await getPack(db, acc.workspaceId, c.req.param('id'));
  if (!pack) return c.notFound();
  const q = c.req.query('q');
  const results =
    q && q.trim()
      ? (await searchWithEvidence(db, acc.workspaceId, acc.userId, { query: q, packIds: [pack.id] })).results
      : null;
  return html(
    c,
    V.packPage({ pack, docs: await listDocuments(db, acc.workspaceId, pack.id), results, query: q }),
    acc,
    pack.name,
  );
});

app.post('/app/packs/:id/documents', async (c) => {
  const acc = (await account(c))!;
  const db = await sql();
  const pack = await getPack(db, acc.workspaceId, c.req.param('id'));
  if (!pack) return c.notFound();
  const f = await c.req.parseBody();
  try {
    await addDocument(db, acc.workspaceId, acc.userId, pack.id, {
      title: String(f.title ?? ''),
      body: String(f.body ?? ''),
      sourceUrl: String(f.source_url ?? '') || null,
    });
    return c.redirect(`/app/packs/${pack.id}`);
  } catch (e) {
    const msg = e instanceof LimitError ? `${e.message} プランを変更すると上限を引き上げられます。` : (e as Error).message;
    return html(
      c,
      V.packPage({ pack, docs: await listDocuments(db, acc.workspaceId, pack.id), error: msg }),
      acc,
      pack.name,
      400,
    );
  }
});

app.post('/app/documents/:id/delete', async (c) => {
  const acc = (await account(c))!;
  const db = await sql();
  const { rows } = await db.query<{ pack_id: string }>(
    'select pack_id from documents where id = $1 and workspace_id = $2',
    [c.req.param('id'), acc.workspaceId],
  );
  if (!rows[0]) return c.notFound();
  await deleteDocument(db, acc.workspaceId, acc.userId, c.req.param('id'));
  return c.redirect(`/app/packs/${rows[0].pack_id}`);
});

app.post('/app/packs/:id/delete', async (c) => {
  const acc = (await account(c))!;
  await deletePack(await sql(), acc.workspaceId, acc.userId, c.req.param('id'));
  return c.redirect('/app');
});

app.get('/app/packs/:id/export', async (c) => {
  const acc = (await account(c))!;
  try {
    const md = await exportPackMarkdown(await sql(), acc.workspaceId, c.req.param('id'));
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

app.get('/app/danger', async (c) => html(c, V.dangerPage(), await account(c), 'データの削除'));

app.post('/app/danger', async (c) => {
  const acc = (await account(c))!;
  const f = await c.req.parseBody();
  if (String(f.confirm ?? '').trim() !== '削除します') return html(c, V.dangerPage(), acc, 'データの削除', 400);
  const db = await sql();
  await audit(db, acc.workspaceId, acc.userId, 'account.deleted');
  // packs / documents / chunks / tokens / sessions は外部キーの cascade で落ちる。
  // tsvector は chunks の同じ行にあるので索引の取り残しが出ない。
  await db.query('delete from audit_events where workspace_id = $1', [acc.workspaceId]);
  await db.query('delete from usage_counters where workspace_id = $1', [acc.workspaceId]);
  await db.query('delete from users where id = $1', [acc.userId]);
  deleteCookie(c, COOKIE, { path: '/' });
  return c.redirect('/');
});

// --- 課金導線 ---
app.post('/billing/checkout', async (c) => {
  const acc = (await account(c))!;
  const db = await sql();
  if (!billingConfigured()) {
    return html(
      c,
      await renderDashboard(db, acc, { error: '決済がまだ設定されていません（STRIPE_SECRET_KEY / STRIPE_PRO_PRICE_ID）。' }),
      acc,
      'ダッシュボード',
      503,
    );
  }
  try {
    return c.redirect(await createCheckoutSession(db, acc.workspaceId, acc.email), 303);
  } catch (e) {
    return html(c, await renderDashboard(db, acc, { error: (e as Error).message }), acc, 'ダッシュボード', 500);
  }
});

app.post('/billing/portal', async (c) => {
  const acc = (await account(c))!;
  const db = await sql();
  try {
    return c.redirect(await createPortalSession(db, acc.workspaceId), 303);
  } catch (e) {
    return html(c, await renderDashboard(db, acc, { error: (e as Error).message }), acc, 'ダッシュボード', 400);
  }
});

/**
 * default export。
 *
 * Vercel はこのファイルを（api/index.ts 経由ではなく）直接エントリポイントとして
 * 読み込むことがあり、その場合 default export が無いと
 * "Invalid export found in module /var/task/src/app.js" で落ちる。
 * 実際に本番のログでこれが起きた。
 *
 * どちらのファイルが呼ばれても同じ挙動になるよう、ここにも Node 形式の
 * リクエストリスナーを置く。app 自体は名前付きで export したままなので、
 * src/server.ts（ローカル起動）からの利用は変わらない。
 */
export default getRequestListener(app.fetch);
