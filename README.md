# Context Bridge

案件ごとの前提・決定事項を Context Pack にまとめ、Claude や Cursor から
**出典つき**で引けるようにする MCP サーバー。AIに毎回同じ説明をし直さないために作る。

**状態: MVP実装済み・未デプロイ。** 鍵とデプロイ先があれば公開できる（[DEPLOY.md](DEPLOY.md)）。

```bash
npm install
SESSION_SECRET=$(openssl rand -base64 32) npm start   # http://localhost:8787
npm test                                              # 26件
```

DBは本番が **Neon（PostgreSQL）**、ローカルとテストが **PGlite**（Postgres の WASM ビルド）。
`DATABASE_URL` 未設定なら自動で PGlite になるので、何も用意せず動く。
テストも PGlite 上で走るため、Docker も外部サービスも要らない。

## できること

| | |
|---|---|
| 取り込み | Markdown / テキストの貼り付け |
| 検索 | 日本語のbigram索引（tsvector + GIN）。2文字語（単価・面談）も取りこぼさない。拡張不要 |
| 出典 | 全結果に Pack名・タイトル・出典URL・由来・取得時刻が付く。出典の無い結果は返さない |
| AI接続 | リモートMCP（Claude / Claude Code / Cursor）。2025系と2026-07-28系の両方 |
| 逃げ道 | Markdownエクスポート。MCP非対応のAIにも貼り付けて使える |
| 課金 | Stripe。Free（Pack 1・検索100回/月）/ Pro 月額2,980円（Pack 20・検索5,000回/月） |

## できないこと（意図的に作っていない）

- **自動同期しない。** Notion / Chatwork 連携は未実装。理由と復活条件は [ADR-0001](docs/adr/ADR-0001-削除した要件.md)
- **「常に最新」を約束しない。** 表示するのは取り込み時点の時刻
- **AIが勝手に保存しない。** `context_save` は `confirm=true` が無ければ保存しない
- **外部サービスへ書き込まない。** メール送信もメッセージ投稿もしない
- **チーム共有しない。** 1アカウント = 1個人ワークスペース

## MCPツール

| ツール | 動作 | 書き込み |
|---|---|---|
| `context_search` | Pack内を検索し、抜粋と出典を返す | なし |
| `context_get_evidence` | 根拠の全文を取り直す | なし |
| `context_pack_status` | Packと収録状況、今月の利用量を返す | なし |
| `context_save` | 確認済みの内容を保存する | あり（要確認） |
| `context_export` | PackをMarkdownで返す | なし |

接続例（Claude Code）:

```bash
claude mcp add --transport http context-bridge https://your-domain.example/mcp \
  --header "Authorization: Bearer <ダッシュボードで発行したトークン>"
```

## 構成

```
src/config.ts    プランと上限。料金はここだけ見れば分かる
src/db.ts        Postgresスキーマ、driver抽象（Neon / PGlite）、監査ログ
src/search.ts    bigram索引 + 実体再チェック（日本語検索の中核）
src/auth.ts      パスワード、セッション、MCPトークン
src/packs.ts     Pack・資料・出典・保存・エクスポート・上限
src/billing.ts   Stripe Checkout / Portal / Webhook
src/mcp.ts       MCPサーバー（5ツール）
src/views.ts     画面（サーバー描画HTML、ビルド工程なし）
src/app.ts       ルーティング（実行環境に依存しない）
src/server.ts    ローカル起動（@hono/node-server）
api/index.ts     Vercel エントリ（hono/vercel）
src/migrate.ts   マイグレーション実行
api/ping.ts      依存ゼロの疎通確認（切り分け用）
docs/schema.sql  スキーマのSQL（npm run schema で生成）
test/core.test.ts
```

`src/app.ts` は実行環境に依存しないので、Vercel 以外へ移すときもエントリだけ差し替えればよい。

## テストが守っている不変条件

CIで毎回実行する。ここが壊れたらリリースしない。

- 別ワークスペースのデータが、検索・根拠取得・エクスポート・MCPトークンのいずれからも漏れない
- 出典項目が欠けた検索結果を返さない。抜粋は必ず原文の一部
- `confirm` なしで `context_save` が保存しない
- 削除した資料が検索結果に残らない
- 支払い停止中はFreeの上限に落ちる（データは消さない）
- 日本語2文字語で取りこぼさない／bigramの偽陽性を除去する

## 文書

| | |
|---|---|
| [使い方と動作確認](docs/使い方.md) | **操作手順と、壊れていないことの確かめ方** |
| [要件定義書 v2](docs/requirements/unabyss-japan-requirements-v2.md) | 元の要件。事実と仮説を分けた基準 |
| [実装計画 v1](docs/plan/implementation-plan-v1.md) | Gate 0〜4 の計画 |
| [ADR-0001 削除した要件](docs/adr/ADR-0001-削除した要件.md) | **何を削り、いつ戻すか** |
| [ADR-0002 技術判断](docs/adr/ADR-0002-技術判断.md) | 検索方式、MCP、認証の根拠と実測値 |
| [DEPLOY.md](DEPLOY.md) | リリース手順と公開前チェック |

## 公開前に必ず読むこと

`/legal/privacy` と `/legal/terms` は**雛形**。日本の専門家の確認を受けてから公開すること。
`/legal/tokushoho`（特定商取引法に基づく表記）は、有料販売する場合の法令上の義務。
`LEGAL_*` を設定しないと「未設定」と赤字で表示される。
