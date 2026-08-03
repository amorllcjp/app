# リリース手順

MVPは外部サービスのOAuth審査に依存しない。**鍵とデプロイ先だけ**で公開できる。

## 1. ローカルで動かす

```bash
npm install
export SESSION_SECRET=$(openssl rand -base64 32)
npm start          # http://localhost:8787
```

決済を設定しなくても Free プランで全機能が動く。

```bash
npm test           # 26件（権限境界・出典・上限を含む）
npm run typecheck
```

## 2. 公開に必要なもの

| # | 項目 | 誰が | 所要 | 無いとどうなるか |
|---|---|---|---|---|
| 1 | デプロイ先（Fly.io / Render / VPS 等）と永続ディスク | あなた | 30分 | 公開できない |
| 2 | ドメインとHTTPS | あなた | 30分 | Cookieのsecure属性が効かない |
| 3 | `SESSION_SECRET` | 生成するだけ | 1分 | 起動しない |
| 4 | Stripe アカウントと Pro の Price | あなた | 30分 | 課金できない（Freeのみ動く） |
| 5 | Stripe Webhook エンドポイント | あなた | 10分 | 決済後にProへ昇格しない |
| 6 | `LEGAL_*`（特商法の表記） | あなた | 15分 | **有料販売が法令違反になる** |

SQLite を使っているため、**永続ディスクが必要**。コンテナの再作成でデータが消える構成にしないこと。

## 3. 環境変数

```bash
SESSION_SECRET=<openssl rand -base64 32 の出力>
BASE_URL=https://your-domain.example
DB_PATH=/data/context-bridge.db        # 永続ディスク上を指すこと
PORT=8787

# 決済（未設定ならFreeのみ動作）
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PRO_PRICE_ID=price_...
STRIPE_WEBHOOK_SECRET=whsec_...

# 特定商取引法に基づく表記（有料販売する場合は必須）
LEGAL_SELLER_NAME=＜事業者名＞
LEGAL_REPRESENTATIVE=＜運営責任者＞
LEGAL_ADDRESS=＜所在地＞
LEGAL_PHONE=＜電話番号＞
LEGAL_EMAIL=＜メールアドレス＞
```

## 4. Stripe の設定

1. ダッシュボードで商品「Context Bridge Pro」を作成し、**月額 2,980円（JPY）の定期価格**を追加
   → `price_...` を `STRIPE_PRO_PRICE_ID` に設定
2. Webhook エンドポイントを追加
   - URL: `https://your-domain.example/billing/webhook`
   - イベント: `checkout.session.completed`, `customer.subscription.created`,
     `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
   - 署名シークレット `whsec_...` を `STRIPE_WEBHOOK_SECRET` に設定
3. Billing Portal を有効化（解約導線に使う）

価格を変更するときは `src/config.ts` の `PLANS.pro.priceJpy` と Stripe の Price を
必ず同時に直す。片方だけ変えると表示と請求がずれる。

### 課金の検証

本番投入前に、Stripeのテストモードで次を確認する。

```bash
stripe listen --forward-to localhost:8787/billing/webhook
```

1. `/pricing` → 「Proにする」 → テストカード `4242 4242 4242 4242` で決済
2. `/app` の「プラン」が Pro になる（Webhook が届いている証拠）
3. Billing Portal から解約 → Free に戻る
4. 決済を伴わずに `/app` を直接叩いてもProにならない（プラン状態はWebhookでしか変わらない）

## 5. Fly.io の例

```bash
fly launch --no-deploy
fly volumes create data --size 1
fly secrets set SESSION_SECRET=$(openssl rand -base64 32) \
  BASE_URL=https://your-app.fly.dev DB_PATH=/data/context-bridge.db \
  STRIPE_SECRET_KEY=sk_live_... STRIPE_PRO_PRICE_ID=price_... STRIPE_WEBHOOK_SECRET=whsec_... \
  LEGAL_SELLER_NAME=... LEGAL_REPRESENTATIVE=... LEGAL_ADDRESS=... LEGAL_PHONE=... LEGAL_EMAIL=...
fly deploy
```

`fly.toml` の `[mounts]` で `destination = "/data"` を指定すること。

## 6. 公開前チェック

- [ ] `npm test` が通る
- [ ] `SESSION_SECRET` が本番用の値である（開発用を使い回さない）
- [ ] `BASE_URL` が https である（Cookie の secure 属性が有効になる）
- [ ] `DB_PATH` が永続ディスク上にある
- [ ] `/legal/tokushoho` に「未設定」の赤字が残っていない
- [ ] Stripeのテストモードで課金と解約を一巡した
- [ ] `/legal/privacy` の保存場所・委託先を、**実際の構成に合わせて書き換えた**
- [ ] プライバシーポリシーと利用規約を専門家に確認してもらった

最後の2項目は雛形のままでは公開できない。要件書 §10.2 のとおり、
確認していないことを書かないこと。

## 7. 運用

バックアップは SQLite ファイルのコピーで足りる。

```bash
sqlite3 /data/context-bridge.db ".backup /data/backup-$(date +%F).db"
```

監査ログは `audit_events` テーブルにある。本文とトークンは記録していない。
