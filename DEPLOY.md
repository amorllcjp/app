# リリース手順（Vercel + Neon）

外部サービスのOAuth審査に依存しない。**鍵とNeonのデータベースだけ**で公開できる。

## 1. ローカルで動かす

`DATABASE_URL` が無ければ PGlite（Postgres の WASM ビルド）に自動でフォールバックするので、
Neon を用意しなくてもそのまま動く。

```bash
npm install
export SESSION_SECRET=$(openssl rand -base64 32)
export PGLITE_DIR=./data/pg      # 省略するとメモリ（プロセス終了で消える）
npm start                        # http://localhost:8787
```

```bash
npm test           # 26件。PGlite上で走るので外部サービス不要
npm run typecheck
```

## 2. 公開に必要なもの

| # | 項目 | 誰が | 所要 | 無いとどうなるか |
|---|---|---|---|---|
| 1 | Vercel プロジェクト | あなた | 10分 | 公開できない |
| 2 | Neon データベース | あなた | 10分 | 起動しない |
| 3 | `SESSION_SECRET` | 生成するだけ | 1分 | 起動しない |
| 4 | Stripe アカウントと Pro の Price | あなた | 30分 | 課金できない（Freeのみ動く） |
| 5 | Stripe Webhook エンドポイント | あなた | 10分 | 決済後にProへ昇格しない |
| 6 | `LEGAL_*`（特商法の表記） | あなた | 15分 | **有料販売が法令違反になる** |

## 3. Neon の準備

### プロジェクト作成時の設定

| 項目 | 設定 | 理由 |
|---|---|---|
| Project name | `context-bridge` | 任意 |
| Postgres version | **18** | テストは Postgres 18（PGlite）で通している。合わせる |
| Region | **AWS Asia Pacific (Singapore)** | 下記。東京が選べない場合の最寄り |
| Enable Neon Auth | **OFF** | 自前の認証を実装済み。使わないテーブルが増えるだけ |

### リージョンは Vercel と必ず揃える

判断基準はユーザーの所在地ではなく、**Vercel の関数と Neon の距離**。

| 経路 | 1リクエストあたりの回数 |
|---|---|
| ユーザー → Vercel | 1回 |
| Vercel → Neon | **数回**（ダッシュボード表示は5往復程度） |

ユーザーとの距離は一度しか効かないが、関数とDBの距離は往復回数だけ掛け算になる。
**だから合わせるべきは「関数とDB」であり、「ユーザーとDB」ではない。**

現在の構成は **両方ともシンガポール**（Neon に東京リージョンが無かったため）。

```
Vercel → プロジェクト → Settings → Functions → Function Region → Singapore (sin1)
```

Vercel の既定は米国東部（`iad1`）。ここを放置して Neon だけシンガポールにすると、
両方を米国東部にするより遅くなる。一番やりがちな失敗。

Neon のリージョンを変えたときは、**必ず Vercel の関数リージョンも同じに直すこと。**

### データ所在地について

シンガポールを選んだ結果、**利用者のデータは日本国外（AWS ap-southeast-1）に保存される**。

`/legal/privacy` を埋めるときに、保存場所を事実どおり記載すること。
個人情報保護法では、外国にある事業者への委託・提供にあたって保管先の国名の明示が
求められる場面がある。**海外保管であることを書き漏らすほうが問題になる。**
専門家に確認を依頼する際は、この点を必ず伝えること（要件書 §10.3）。

国内保管が商談条件になった場合は、Neon の東京リージョン（提供され次第）または
別の Postgres へ移す。拡張を使っていないため `DATABASE_URL` の差し替えで済む。

### Free プランの注意

「Scales to zero when inactive」により、しばらく使わないと最初のリクエストが遅くなる。
Vercel のコールドスタートと重なると初回は数秒かかることがある。
**デザインパートナーに見せる直前は一度アクセスして温めておくこと。**

ストレージ 0.5GB は、Markdown のテキストだけなら当面足りる。

### 接続文字列とマイグレーション

1. **pooled 接続文字列**（ホスト名に `-pooler` が入っているもの）を控える
   - Connection Details で pooled / direct を切り替えられる
   - サーバーレスは同時実行が増えるとDB接続を食い潰す。直結の接続文字列を使わないこと
2. マイグレーションを一度だけ実行する

```bash
DATABASE_URL='postgresql://...-pooler.../db?sslmode=require' npm run migrate
```

スキーマ変更を入れたときは、デプロイのたびにこれを実行する。
すべて `IF NOT EXISTS` なので、二重に実行しても壊れない。

## 4. Vercel の設定

```bash
vercel link
vercel env add SESSION_SECRET production      # openssl rand -base64 32 の出力
vercel env add DATABASE_URL production        # Neon の pooled 接続文字列
vercel env add BASE_URL production            # https://your-app.vercel.app
vercel env add STRIPE_SECRET_KEY production
vercel env add STRIPE_PRO_PRICE_ID production
vercel env add STRIPE_WEBHOOK_SECRET production
vercel env add LEGAL_SELLER_NAME production
vercel env add LEGAL_REPRESENTATIVE production
vercel env add LEGAL_ADDRESS production
vercel env add LEGAL_PHONE production
vercel env add LEGAL_EMAIL production
vercel deploy --prod
```

`vercel.json` ですべてのパスを `api/index.ts` に流している。
`api/index.ts` はマイグレーションを実行しない（cold start ごとに走ると無駄で、同時実行で競合するため）。

`BASE_URL` は必ず本番のURLにする。ここが `http://` のままだとセッションCookieの
`secure` 属性が付かず、MCPの接続手順にも誤ったURLが表示される。

## 5. Stripe の設定

1. 商品「Context Bridge Pro」を作り、**月額 2,980円（JPY）の定期価格**を追加
   → `price_...` を `STRIPE_PRO_PRICE_ID` に設定
2. Webhook エンドポイントを追加
   - URL: `https://your-app.vercel.app/billing/webhook`
   - イベント: `checkout.session.completed`, `customer.subscription.created`,
     `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
   - 署名シークレット `whsec_...` を `STRIPE_WEBHOOK_SECRET` に設定
3. Billing Portal を有効化（解約導線に使う）

価格を変えるときは `src/config.ts` の `PLANS.pro.priceJpy` と Stripe の Price を
**必ず同時に**直す。片方だけ変えると表示と請求がずれる。

### 課金の検証（本番投入前に必ず）

```bash
stripe listen --forward-to localhost:8787/billing/webhook
```

1. `/pricing` → 「Proにする」 → テストカード `4242 4242 4242 4242`
2. `/app` の「プラン」が Pro になる（Webhookが届いている証拠）
3. Billing Portal から解約 → Free に戻る
4. 決済せずに `/app` を直接叩いてもProにならない（プラン状態はWebhookでしか変わらない）

## 6. 公開前チェック

- [ ] `npm test` が通る
- [ ] `npm run migrate` を本番の `DATABASE_URL` で実行した
- [ ] `DATABASE_URL` が **pooled**（`-pooler` 付き）である
- [ ] `SESSION_SECRET` が本番用の値である（開発用を使い回さない）
- [ ] `BASE_URL` が本番の https URL である
- [ ] `/healthz` が `{"ok":true,"migrated":true}` を返す
- [ ] `/legal/tokushoho` に「未設定」の赤字が残っていない
- [ ] Stripeのテストモードで課金と解約を一巡した
- [ ] Vercel の関数リージョンが Neon と同じ（現在: シンガポール）
- [ ] `/legal/privacy` の保存場所・委託先を、**実際の構成に合わせて書き換えた**
      （現在の保存先: AWS シンガポール / ap-southeast-1。海外保管である旨を明記する）
- [ ] プライバシーポリシーと利用規約を専門家に確認してもらった

最後の2項目は雛形のままでは公開できない。要件書 §10.2 のとおり、
確認していないことを書かないこと。

## 6.5 デプロイ後に落ちたときの切り分け

まず `/healthz` を開く。設定の状態が JSON で返る（接続文字列そのものは表示しない）。

```json
{"ok":false,"error":"...","env":{"database_url_set":false,"database_url_pooled":false,
 "session_secret_set":true,"base_url":"https://...","billing_configured":false}}
```

| 症状 | 原因 | 対処 |
|---|---|---|
| `database_url_set: false` | 環境変数が対象の環境に設定されていない | Vercel の Production / Preview それぞれに設定して再デプロイ |
| `database_url_pooled: false` | 直結の接続文字列を使っている | `-pooler` 入りに差し替える |
| `migrated: false` | テーブルが無い | `npm run migrate` を本番の `DATABASE_URL` で実行 |
| `error` に接続エラー | Neon が停止中／文字列が誤り | Neon の画面で状態と文字列を確認 |

`DATABASE_URL` を設定し忘れたまま本番へ出しても、PGlite（開発用の WASM Postgres）へは
**フォールバックしない**。サーバーレス関数の中で WASM の Postgres を起動すると落ちるうえ、
起動できてもリクエストごとに消えるため、意図的に明示的なエラーで止めている。

### 白い「This Serverless Function has crashed」が出る場合

これは Vercel のエラー画面であり、**アプリのエラーページではない**。
アプリ側で例外が出たなら `app.onError` が日本語のページを返すので、
白い画面が出ているときは**リクエスト処理に到達する前に落ちている**。

`/api/ping` を開いて切り分ける（依存ゼロの疎通確認用）。

| `/api/ping` | 判定 |
|---|---|
| 動く | 原因はアプリ側の import か初期化。`vercel logs` でスタックトレースを見る |
| 落ちる | 原因は Vercel のプロジェクト設定かランタイム。Node のバージョン、ビルド設定を確認 |

`/api/ping` は環境変数の有無とリージョンも返す（値そのものは返さない）。

### ログを直接見る

```bash
vercel logs <デプロイURL>
```

Vercel の画面からは、対象のデプロイを開いて **Runtime Logs** タブ。
ビルドログではなく Runtime のほうを見ること。

## 7. 運用

- バックアップは Neon の Point-in-time restore に任せる。自前のcronは不要
- 監査ログは `audit_events` テーブル。本文とトークンは記録していない
- 障害調査はまず `/healthz`。DB接続が切れていればここで分かる

## 8. 別のホスティングへ移す場合

`src/app.ts` は実行環境に依存しない。エントリだけ差し替えれば移せる。

| 環境 | エントリ |
|---|---|
| Vercel | `api/index.ts`（`hono/vercel`） |
| ローカル / VPS / Fly.io | `src/server.ts`（`@hono/node-server`） |

DBも `DATABASE_URL` を差し替えるだけで、Neon 以外の Postgres に移せる。
拡張を使っていないため、移行先の対応状況に縛られない。
