/**
 * 画面。ビルド工程を持たないサーバー描画のHTML。
 * SPA・CSSフレームワーク・バンドラは入れない（MVPの表面積を増やさないため）。
 */
import { config, PLANS, type Plan } from './config.ts';

/**
 * 抜粋の中で一致した箇所を <mark> で囲む。
 *
 * 必ず「原文を分割 → 各片をエスケープ → mark を挟む」順で組む。
 * エスケープ済みの文字列に対して検索語を探すと、実体参照（&amp; など）を
 * またいでタグを挿入してしまい、HTML を壊す／XSS になる。
 */
export function highlight(text: string, query: string | undefined): string {
  const q = (query ?? '').trim();
  if (!q) return esc(text);
  const hay = text.toLowerCase();
  const needle = q.toLowerCase();
  let out = '';
  let i = 0;
  for (;;) {
    const at = hay.indexOf(needle, i);
    if (at < 0) {
      out += esc(text.slice(i));
      return out;
    }
    out += esc(text.slice(i, at)) + `<mark>${esc(text.slice(at, at + q.length))}</mark>`;
    i = at + q.length;
  }
}

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CSS = `
:root{--bg:#fff;--fg:#16181d;--muted:#666b76;--line:#e3e5ea;--accent:#1a56db;--accent-fg:#fff;--warn:#8a5a00;--warn-bg:#fff8e6;--card:#fafbfc}
@media(prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e9eaee;--muted:#9aa0aa;--line:#2b2f36;--accent:#5b8def;--accent-fg:#0b0d10;--warn:#e5b567;--warn-bg:#2a2416;--card:#1a1d22}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.7 system-ui,-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:24px 20px 72px}
header.nav{border-bottom:1px solid var(--line)}
header.nav .wrap{padding:14px 20px;display:flex;gap:16px;align-items:center}
header.nav a{color:var(--fg);text-decoration:none}
header.nav .sp{flex:1}
h1{font-size:28px;line-height:1.35;margin:24px 0 8px}
h2{font-size:20px;margin:32px 0 10px;padding-top:8px}
h3{font-size:16px;margin:20px 0 6px}
p{margin:10px 0}
.muted{color:var(--muted)}
.small{font-size:14px}
a{color:var(--accent)}
.btn{display:inline-block;background:var(--accent);color:var(--accent-fg);padding:10px 18px;border-radius:7px;border:0;text-decoration:none;font-size:15px;cursor:pointer;font-family:inherit}
.btn.sec{background:transparent;color:var(--fg);border:1px solid var(--line)}
.btn.sm{padding:5px 11px;font-size:13px}
input,textarea,select{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--fg);font:inherit;font-size:15px}
textarea{min-height:170px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.6}
label{display:block;margin:14px 0 4px;font-size:14px;font-weight:600}
form.card,.card{border:1px solid var(--line);border-radius:10px;padding:18px;background:var(--card);margin:16px 0}
table{width:100%;border-collapse:collapse;margin:12px 0;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600}
.err{background:#fdecec;color:#8a1c1c;border:1px solid #f5c2c2;padding:10px 13px;border-radius:7px;margin:12px 0;font-size:14px}
@media(prefers-color-scheme:dark){.err{background:#2c1618;color:#f3b5b5;border-color:#5a2a2c}}
.ok{background:#e8f6ec;color:#14612e;border:1px solid #b6e0c2;padding:10px 13px;border-radius:7px;margin:12px 0;font-size:14px}
@media(prefers-color-scheme:dark){.ok{background:#14261a;color:#a8dcb8;border-color:#2f5a3c}}
.warn{background:var(--warn-bg);color:var(--warn);border:1px solid currentColor;padding:11px 13px;border-radius:7px;margin:14px 0;font-size:14px}
pre{background:var(--card);border:1px solid var(--line);border-radius:7px;padding:13px;overflow-x:auto;font-size:13px;line-height:1.55}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px;margin:20px 0}
.plan{border:1px solid var(--line);border-radius:10px;padding:20px;background:var(--card)}
.plan.hi{border-color:var(--accent);border-width:2px}
.price{font-size:30px;font-weight:700;margin:6px 0}
.plan ul{padding-left:20px;margin:12px 0}
.plan li{margin:5px 0;font-size:14px}
.ev{border-left:3px solid var(--accent);padding:2px 0 2px 14px;margin:16px 0}
.ev .meta{font-size:12px;color:var(--muted);margin-top:5px}
mark{background:#fde68a;color:#1a1a1a;padding:0 2px;border-radius:2px;font-weight:600}
@media(prefers-color-scheme:dark){mark{background:#8a6d1f;color:#fff3d0}}
@media(max-width:600px){
  .wrap{padding:16px 14px 56px}
  h1{font-size:23px}
  table{display:block;overflow-x:auto;white-space:nowrap;-webkit-overflow-scrolling:touch}
  .ev{padding-left:10px}
}
footer{border-top:1px solid var(--line);margin-top:56px;padding:20px;font-size:13px;color:var(--muted);text-align:center}
footer a{color:var(--muted);margin:0 8px}
`;

export interface LayoutOpts {
  title: string;
  account?: { email: string; plan: string } | null;
  body: string;
}

export function layout({ title, account, body }: LayoutOpts): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} | Context Bridge</title><style>${CSS}</style></head><body>
<header class="nav"><div class="wrap">
  <a href="/"><strong>Context Bridge</strong></a>
  <span class="sp"></span>
  ${
    account
      ? `<a href="/app" class="small">ダッシュボード</a>
         <a href="/pricing" class="small">${esc(account.plan === 'pro' ? 'Pro' : 'Free')}</a>
         <form method="post" action="/logout" style="display:inline;margin:0"><button class="btn sec sm">ログアウト</button></form>`
      : `<a href="/pricing" class="small">料金</a><a href="/login" class="small">ログイン</a>
         <a href="/signup" class="btn sm">無料で始める</a>`
  }
</div></header>
<main class="wrap">${body}</main>
<footer>
  <a href="/pricing">料金</a><a href="/legal/tokushoho">特定商取引法に基づく表記</a>
  <a href="/legal/privacy">プライバシー</a><a href="/legal/terms">利用規約</a>
  <div style="margin-top:8px">Context Bridge</div>
</footer></body></html>`;
}

export function landing(): string {
  return `
<h1>AIに毎回同じ説明をするのをやめる。</h1>
<p class="muted">案件ごとの前提・決定事項・手順を Context Pack にまとめておくと、Claude や Cursor から
<strong>出典つき</strong>で引けるようになります。どのAIに乗り換えても、説明し直す必要がありません。</p>
<p><a class="btn" href="/signup">無料で始める（カード不要）</a>
   <a class="btn sec" href="/pricing">料金を見る</a></p>

<h2>できること</h2>
<div class="card">
<p><strong>1. Pack を作る</strong> — 案件や顧客ごとに、決定事項・前提・議事メモを貼り付けます。</p>
<p><strong>2. AIをつなぐ</strong> — 発行されたURLとトークンを Claude / Cursor に登録します。</p>
<p><strong>3. 出典つきで引く</strong> — AIが答えるとき、どの資料の何行目かが必ず添えられます。</p>
</div>

<h2>できないことを先に書きます</h2>
<div class="warn">
<p style="margin-top:0"><strong>自動同期はしません。</strong> Notion や Chatwork との連携は未実装です。
現在の取り込み方法は、Markdown・テキストの貼り付けだけです。</p>
<p><strong>「常に最新」を約束しません。</strong> 表示するのは利用者が取り込んだ時点の時刻です。
鮮度が重要な情報は元の資料で確認してください。</p>
<p style="margin-bottom:0"><strong>AIが勝手に覚えることはありません。</strong> 保存は利用者が確認したときだけ行われます。</p>
</div>

<h2>検索について</h2>
<p class="muted small">日本語の2文字語（「単価」「面談」など）で取りこぼさないよう、bigram索引に
原文の実体チェックを重ねています。要約や推測は返さず、原文の抜粋だけを返します。</p>

<p style="margin-top:32px"><a class="btn" href="/signup">無料で始める</a></p>`;
}

export function pricing(current?: string | null, canceled?: boolean): string {
  const card = (p: Plan, hi: boolean) => `
<div class="plan${hi ? ' hi' : ''}">
  <h3 style="margin-top:0">${esc(p.label)}</h3>
  <div class="price">${p.priceJpy === 0 ? '¥0' : `¥${p.priceJpy.toLocaleString()}`}<span class="small muted"> /月（税込）</span></div>
  <ul>${p.points.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
  ${
    current === p.id
      ? '<p class="small muted">現在のプランです</p>'
      : p.id === 'pro'
        ? '<form method="post" action="/billing/checkout"><button class="btn">Proにする</button></form>'
        : '<a class="btn sec" href="/signup">無料で始める</a>'
  }
</div>`;
  return `
<h1>料金</h1>
${canceled ? '<div class="warn">手続きを中止しました。プランは変更されていません。</div>' : ''}
<div class="plans">${card(PLANS.free, false)}${card(PLANS.pro, true)}</div>
<p class="small muted">価格は税込です。決済は Stripe を利用します。カード情報は当社サーバーを通過しません。
解約はいつでも可能で、日割り返金は行わず、当該請求期間の終了まで Pro の上限が適用されます。</p>
<p class="small muted">詳細は<a href="/legal/tokushoho">特定商取引法に基づく表記</a>をご確認ください。</p>`;
}

export function authPage(mode: 'signup' | 'login', error?: string): string {
  const isSignup = mode === 'signup';
  return `
<h1>${isSignup ? '無料で始める' : 'ログイン'}</h1>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form class="card" method="post" action="/${mode}">
  <label for="email">メールアドレス</label>
  <input id="email" name="email" type="email" required autocomplete="email">
  <label for="password">パスワード${isSignup ? '（10文字以上）' : ''}</label>
  <input id="password" name="password" type="password" required minlength="${isSignup ? 10 : 1}"
         autocomplete="${isSignup ? 'new-password' : 'current-password'}">
  <p style="margin-top:18px"><button class="btn">${isSignup ? 'アカウントを作る' : 'ログイン'}</button></p>
  <p class="small muted" style="margin-bottom:0">
    ${isSignup ? 'クレジットカードは不要です。既にお持ちの方は <a href="/login">ログイン</a>' : 'アカウントをお持ちでない方は <a href="/signup">無料登録</a>'}
  </p>
</form>`;
}

export interface DashboardData {
  account: { email: string; plan: string; workspaceName: string };
  packs: Array<{ id: string; name: string; project: string | null; status: string; docs: number; updated_at: string }>;
  usage: { searches: number; searchLimit: number; docs: number; docLimit: number; packLimit: number };
  plan: Plan;
  tokenPrefix: string | null;
  freshToken?: string | null;
  notice?: string | null;
  error?: string | null;
  upgraded?: boolean;
}

export function dashboard(d: DashboardData): string {
  const nearLimit = d.usage.searches >= d.usage.searchLimit * 0.8 || d.usage.docs >= d.usage.docLimit * 0.8;
  return `
<h1>${esc(d.account.workspaceName)}</h1>
${d.upgraded ? '<div class="ok">Proプランになりました。上限が引き上げられています。</div>' : ''}
${d.notice ? `<div class="ok">${esc(d.notice)}</div>` : ''}
${d.error ? `<div class="err">${esc(d.error)}</div>` : ''}

${
  d.freshToken
    ? `<div class="ok"><p style="margin-top:0"><strong>MCPトークンを発行しました。この画面を離れると二度と表示されません。</strong></p>
       <pre>${esc(d.freshToken)}</pre></div>`
    : ''
}

<h2>Context Pack</h2>
${
  d.packs.length === 0
    ? '<p class="muted">まだPackがありません。下のフォームから作成してください。</p>'
    : `<table><tr><th>名前</th><th>対象</th><th>資料</th><th>更新</th><th></th></tr>
       ${d.packs
         .map(
           (p) => `<tr>
        <td><a href="/app/packs/${esc(p.id)}">${esc(p.name)}</a>${p.status !== 'active' ? ' <span class="small muted">(無効)</span>' : ''}</td>
        <td class="small muted">${esc(p.project ?? '—')}</td>
        <td>${p.docs}</td>
        <td class="small muted">${esc(p.updated_at.slice(0, 10))}</td>
        <td><a class="btn sec sm" href="/app/packs/${esc(p.id)}/export">出力</a></td>
      </tr>`,
         )
         .join('')}</table>`
}

${
  d.packs.length >= d.plan.limits.packs
    ? `<div class="warn">${esc(d.plan.label)}プランのPack上限（${d.plan.limits.packs}個）に達しています。
       <a href="/pricing">プランを見る</a></div>`
    : `<form class="card" method="post" action="/app/packs">
    <label for="name">新しいPackの名前</label>
    <input id="name" name="name" required placeholder="例: A社リニューアル案件">
    <label for="project">対象（任意）</label>
    <input id="project" name="project" placeholder="例: 2026年度 Webサイト刷新">
    <p style="margin-top:16px"><button class="btn">Packを作る</button></p>
  </form>`
}

<h2>AIをつなぐ</h2>
<div class="card">
  <p style="margin-top:0">Claude や Cursor に、次のリモートMCPサーバーを登録してください。</p>
  <pre>URL: ${esc(config.baseUrl)}/mcp
Authorization: Bearer &lt;トークン&gt;</pre>
  <p class="small muted">${d.tokenPrefix ? `発行済み: <code>${esc(d.tokenPrefix)}…</code>` : 'トークンは未発行です。'}</p>
  <form method="post" action="/app/token" onsubmit="return confirm('新しいトークンを発行すると、いま設定されているトークンは使えなくなります。よろしいですか？')">
    <button class="btn ${d.tokenPrefix ? 'sec' : ''}">${d.tokenPrefix ? 'トークンを再発行' : 'トークンを発行'}</button>
  </form>
  <p class="small muted" style="margin-bottom:0">設定手順は <a href="/app/connect">接続方法</a> を参照してください。</p>
</div>

<h2>利用状況</h2>
<table>
  <tr><th>今月の検索</th><td>${d.usage.searches} / ${d.usage.searchLimit} 回</td></tr>
  <tr><th>ドキュメント</th><td>${d.usage.docs} / ${d.usage.docLimit} 件</td></tr>
  <tr><th>Pack</th><td>${d.packs.length} / ${d.usage.packLimit} 個</td></tr>
  <tr><th>プラン</th><td>${esc(d.plan.label)}
    ${d.plan.id === 'free' ? '<a class="btn sm" style="margin-left:8px" href="/pricing">Proにする</a>' : '<form method="post" action="/billing/portal" style="display:inline"><button class="btn sec sm">請求を管理</button></form>'}
  </td></tr>
</table>
${nearLimit && d.plan.id === 'free' ? '<div class="warn">上限が近づいています。Proプランで検索5,000回/月・ドキュメント2,000件まで拡張できます。<a href="/pricing">料金を見る</a></div>' : ''}

<h2>データの持ち出しと削除</h2>
<p class="small muted">各Packは Markdown で出力できます。アカウントとすべてのデータの削除は
<a href="/app/danger">こちら</a>から行えます。</p>`;
}

export function packPage(opts: {
  pack: { id: string; name: string; project: string | null; status: string };
  docs: Array<{ id: string; title: string; source_url: string | null; origin: string; fetched_at: string; chars: number }>;
  results?: Array<{
    excerpt: string;
    title: string;
    source_url: string | null;
    provenance: string;
    fetched_at: string;
  }> | null;
  query?: string;
  error?: string | null;
  notice?: string | null;
}): string {
  const { pack, docs } = opts;
  return `
<p class="small"><a href="/app">← ダッシュボード</a></p>
<h1>${esc(pack.name)}</h1>
<p class="small muted">Pack ID: <code>${esc(pack.id)}</code>${pack.project ? ` ／ 対象: ${esc(pack.project)}` : ''}</p>
${opts.error ? `<div class="err">${esc(opts.error)}</div>` : ''}
${opts.notice ? `<div class="ok">${esc(opts.notice)}</div>` : ''}

<h2>検索して確かめる</h2>
<form method="get" class="card">
  <label for="q">検索語</label>
  <input id="q" name="q" value="${esc(opts.query ?? '')}" placeholder="例: 単価">
  <p style="margin-top:14px"><button class="btn">検索</button></p>
</form>
${
  opts.results
    ? opts.results.length === 0
      ? '<p class="muted">一致する記載はありません。</p>'
      : opts.results
          .map(
            (r) => `<div class="ev">
        <div>${highlight(r.excerpt, opts.query)}</div>
        <div class="meta">出典: ${esc(r.title)}
          ${r.source_url ? ` ／ <a href="${esc(r.source_url)}">${esc(r.source_url)}</a>` : ''}
          ／ 由来: ${esc(r.provenance === 'user_saved' ? 'ユーザー保存' : '取り込み原文')}
          ／ 取得: ${esc(String(r.fetched_at).slice(0, 19).replace('T', ' '))}</div>
      </div>`,
          )
          .join('')
    : ''
}

<h2>資料を追加する</h2>
<form class="card" method="post" action="/app/packs/${esc(pack.id)}/documents">
  <label for="title">タイトル</label>
  <input id="title" name="title" required placeholder="例: キックオフ議事録 2026-07-15">
  <label for="source_url">出典URL（任意・後から根拠を辿るために推奨）</label>
  <input id="source_url" name="source_url" placeholder="https://...">
  <label for="body">本文（Markdown / テキスト）</label>
  <textarea id="body" name="body" required placeholder="決定事項、前提、手順などを貼り付けてください"></textarea>
  <p style="margin-top:16px"><button class="btn">追加する</button></p>
</form>

<h2>収録資料（${docs.length}件）</h2>
${
  docs.length === 0
    ? '<p class="muted">まだ資料がありません。</p>'
    : `<table><tr><th>タイトル</th><th>由来</th><th>文字数</th><th>取得</th><th></th></tr>
      ${docs
        .map(
          (x) => `<tr>
        <td>${esc(x.title)}${x.source_url ? `<div class="small muted">${esc(x.source_url)}</div>` : ''}</td>
        <td class="small">${esc(x.origin === 'user_saved' ? 'ユーザー保存' : '取り込み原文')}</td>
        <td class="small">${x.chars.toLocaleString()}</td>
        <td class="small muted">${esc(x.fetched_at.slice(0, 10))}</td>
        <td><form method="post" action="/app/documents/${esc(x.id)}/delete" onsubmit="return confirm('削除します。よろしいですか？')"><button class="btn sec sm">削除</button></form></td>
      </tr>`,
        )
        .join('')}</table>`
}

<h2>この Pack を持ち出す</h2>
<p><a class="btn sec" href="/app/packs/${esc(pack.id)}/export">Markdownで出力</a>
   <span class="small muted">MCP非対応のAIには、この出力を貼り付けて使えます。</span></p>
<p class="small muted">Claude や Cursor から直接引きたい場合は <a href="/app/connect">接続方法</a> を参照してください。</p>`;
}

export function connectPage(tokenPrefix: string | null): string {
  const url = `${config.baseUrl}/mcp`;
  return `
<p class="small"><a href="/app">← ダッシュボード</a></p>
<h1>AIクライアントの接続方法</h1>
<p class="muted">下記はいずれも、ダッシュボードで発行したトークンが必要です。
${tokenPrefix ? `現在のトークン: <code>${esc(tokenPrefix)}…</code>` : '<strong>まだ発行されていません。</strong>'}</p>

<h2>Claude（リモートMCP）</h2>
<p class="small">設定からカスタムコネクタとして以下を登録します。</p>
<pre>URL: ${esc(url)}
Authorization: Bearer &lt;トークン&gt;</pre>

<h2>Claude Code</h2>
<pre>claude mcp add --transport http context-bridge ${esc(url)} \\
  --header "Authorization: Bearer &lt;トークン&gt;"</pre>

<h2>Cursor</h2>
<p class="small"><code>~/.cursor/mcp.json</code> に追記します。</p>
<pre>{
  "mcpServers": {
    "context-bridge": {
      "url": "${esc(url)}",
      "headers": { "Authorization": "Bearer &lt;トークン&gt;" }
    }
  }
}</pre>

<h2>使い方</h2>
<p>接続後、AIに次のように頼みます。</p>
<pre>context-bridge で「単価」を検索して、出典つきで教えて</pre>
<div class="warn">
AIがツールを呼ぶかどうかは、そのクライアントとモデルの判断に依存します。
自動的に毎回読み込まれることは保証していません。確実に渡したい場合は、Packを
<a href="/app">Markdownで出力</a>して貼り付けてください。
</div>

<h2>公開しているツール</h2>
<table>
<tr><th>ツール</th><th>動作</th><th>書き込み</th></tr>
<tr><td><code>context_search</code></td><td>Pack内を検索し、抜粋と出典を返す</td><td>なし</td></tr>
<tr><td><code>context_get_evidence</code></td><td>根拠の全文を取り直す</td><td>なし</td></tr>
<tr><td><code>context_pack_status</code></td><td>Packと収録状況を返す</td><td>なし</td></tr>
<tr><td><code>context_save</code></td><td>確認済みの内容を保存する</td><td>あり（要確認）</td></tr>
<tr><td><code>context_export</code></td><td>PackをMarkdownで返す</td><td>なし</td></tr>
</table>
<p class="small muted">外部サービスへの書き込み、メール送信、メッセージ投稿は実装していません。</p>`;
}

export function dangerPage(): string {
  return `
<p class="small"><a href="/app">← ダッシュボード</a></p>
<h1>データの削除</h1>
<div class="warn">アカウント、ワークスペース、すべてのPack・資料・索引・監査ログを削除します。取り消せません。</div>
<p class="small muted">削除の対象と、対象外を明記します。</p>
<table>
<tr><th>対象</th><td>アカウント、Pack、資料、検索索引、MCPトークン、セッション、監査ログ</td></tr>
<tr><th>対象外</th><td>Stripe に保持される請求記録（法令上の保存義務のため）。サーバーのバックアップからは、最大30日で消えます。</td></tr>
</table>
<form class="card" method="post" action="/app/danger">
  <label for="confirm">確認のため <code>削除します</code> と入力してください</label>
  <input id="confirm" name="confirm" required placeholder="削除します">
  <p style="margin-top:16px"><button class="btn">アカウントとすべてのデータを削除する</button></p>
</form>`;
}

export function legalPage(kind: 'tokushoho' | 'privacy' | 'terms'): string {
  const L = config.legal;
  const missing = '<span class="small" style="color:#b00">（未設定）</span>';
  if (kind === 'tokushoho') {
    return `
<h1>特定商取引法に基づく表記</h1>
<div class="warn">この表記は日本で有料サービスを販売する場合に法令上必要です。
公開前に、環境変数 <code>LEGAL_*</code> をすべて実際の情報で設定してください。</div>
<table>
<tr><th>販売事業者</th><td>${L.sellerName ? esc(L.sellerName) : missing}</td></tr>
<tr><th>運営責任者</th><td>${L.representative ? esc(L.representative) : missing}</td></tr>
<tr><th>所在地</th><td>${L.address ? esc(L.address) : missing}</td></tr>
<tr><th>電話番号</th><td>${L.phone ? esc(L.phone) : missing}</td></tr>
<tr><th>メールアドレス</th><td>${L.email ? esc(L.email) : missing}</td></tr>
<tr><th>販売価格</th><td>Pro プラン 月額 ${PLANS.pro.priceJpy.toLocaleString()}円（税込）／ Free プラン 0円</td></tr>
<tr><th>対価以外の必要料金</th><td>インターネット接続に要する通信費等はお客様のご負担です。</td></tr>
<tr><th>支払方法</th><td>クレジットカード（Stripe）</td></tr>
<tr><th>支払時期</th><td>お申し込み時に初回課金、以後は毎月同日に自動更新</td></tr>
<tr><th>提供時期</th><td>決済完了後ただちに利用可能</td></tr>
<tr><th>返品・解約</th><td>デジタルサービスの性質上、返金は行いません。解約はいつでも可能で、
  解約後も当該請求期間の終了までご利用いただけます。</td></tr>
<tr><th>動作環境</th><td>最新版のWebブラウザ、およびMCPに対応したAIクライアント</td></tr>
</table>`;
  }
  if (kind === 'privacy') {
    return `
<h1>プライバシーポリシー</h1>
<div class="warn">これは雛形です。公開前に日本の専門家の確認を受けてください（要件書 §10.3）。</div>
<h2>取得する情報</h2>
<p>メールアドレス、パスワードのハッシュ、利用者が取り込んだ資料の本文、利用量、監査ログ。
クレジットカード情報は Stripe が扱い、当社サーバーを通過しません。</p>
<h2>利用目的</h2>
<p>サービスの提供、検索索引の作成、上限管理と課金、不正利用の防止。</p>
<h2>モデル学習について</h2>
<p>お預かりした資料を、当社が機械学習モデルの学習に利用することはありません。
一方、利用者がAIクライアント（Claude、Cursor等）へ送信したデータの扱いは、
各サービスの契約・設定に従います。当社の宣言でそれを上書きすることはできません。</p>
<h2>外部送信</h2>
<p>本サービスは検索のために外部のAIモデルへ本文を送信しません。埋め込み生成は行っていません。</p>
<h2>保存場所と委託先</h2>
<div class="warn">データの保存場所と委託先は、実際の配置が確定してから事実に基づいて記載してください。
確認前に「国内保管」等と表示しないでください（要件書 §10.2）。</div>
<h2>削除</h2>
<p>ダッシュボードからいつでも全データを削除できます。バックアップからは最大30日で消えます。</p>`;
  }
  return `
<h1>利用規約</h1>
<div class="warn">これは雛形です。公開前に日本の専門家の確認を受けてください。</div>
<h2>本サービスについて</h2>
<p>Context Bridge は、利用者が明示的に取り込んだ資料を検索し、出典つきで返すサービスです。</p>
<h2>保証しないこと</h2>
<p>本サービスは、検索結果の網羅性・正確性・最新性を保証しません。自動同期は行っておらず、
表示される時刻は利用者が取り込んだ時点のものです。重要な判断は必ず元の資料で確認してください。</p>
<p>AIクライアントがツールを呼び出すかどうかは各クライアントとモデルの判断に依存し、
当社はこれを制御できません。</p>
<h2>利用者の責任</h2>
<p>取り込む資料について、利用者は必要な権利と権限を有している必要があります。</p>
<h2>料金と解約</h2>
<p><a href="/legal/tokushoho">特定商取引法に基づく表記</a>のとおりです。</p>`;
}
