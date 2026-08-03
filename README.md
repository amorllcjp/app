# 日本版Context Bridge

日本の小規模チーム向けに、選択した業務文脈（Notion / Chatwork / Markdown）を、
出典と更新時刻つきでAIから検索できるようにする、個人中心・読み取り中心のMCPブリッジ。

**現在の状態: 計画段階。実装は未着手。**

## 文書

| 文書 | 内容 |
|---|---|
| [要件定義書 v2](docs/requirements/unabyss-japan-requirements-v2.md) | 何を作るか / 何を作らないか。事実と仮説を分けた実装基準 |
| [実装計画 v1](docs/plan/implementation-plan-v1.md) | どの順で作り、どこで止まるか。マイルストーンと合格条件 |

読む順序は、要件定義書 → 実装計画。

## 要点

- 作るのは「すべてのAIに常時つながる万能記憶」ではなく、**ユーザーが選んだ範囲をPack化し、出典つきで検索する薄い橋**。
- 対象クライアントはP0で **Claude系 / Cursor** のみ。ChatGPT / Codex はP1の検証対象。
- 対象ソースはP0で **Notion / Chatwork（条件確認中）/ Markdown** のみ。Gmail / Drive は実装しない。
- 進行は週数ではなく **Gate 0〜4 の合格条件** で管理する。合格しない場合、機能を足さずに範囲を削る。

## 未決事項

実装計画 §8 を参照。特に以下は着手前に確認が必要。

- ホスティングとデータ所在地（D-2）
- Chatwork をP0に残すか（D-3、実機・API条件が未確認）
- 埋め込み生成の外部送信可否（D-5）

## 補足

要件定義書 冒頭が参照する旧版 `unabyss-japan-technical-feasibility-requirements.md` は、
このリポジトリには存在しない（実装計画 §8 D-6）。
