/**
 * テスト用の環境変数。
 *
 * config.ts は読み込み時に process.env を固めるので、他のどの import よりも先に
 * 評価される必要がある。core.test.ts の一番上で読むこと。
 * （SESSION_SECRET が無いとトークン暗号化が動かず、Notion 連携のテストが全部落ちる）
 */
process.env.SESSION_SECRET ??= 'test-session-secret-not-for-production';
