/**
 * ローカル開発用のエントリ。Vercel では api/index.ts が使われる。
 *
 * DATABASE_URL が無ければ PGlite にフォールバックするので、Neon を用意しなくても動く。
 */
import { serve } from '@hono/node-server';
import { app } from './app.ts';
import { config } from './config.ts';
import { sql, migrate } from './db.ts';
import { billingConfigured } from './billing.ts';

if (!config.sessionSecret) {
  console.error('起動できません: SESSION_SECRET が未設定です。');
  console.error('  例: SESSION_SECRET=$(openssl rand -base64 32) npm start');
  process.exit(1);
}

// ローカルは起動時にマイグレーションまで済ませる。Vercel では `npm run migrate` を一度だけ実行する。
await migrate(await sql());

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Context Bridge  http://localhost:${info.port}`);
  console.log(`  MCP           ${config.baseUrl}/mcp`);
  console.log(`  DB            ${config.databaseUrl ? 'Neon (DATABASE_URL)' : `PGlite (${config.pgliteDir ?? 'メモリ'})`}`);
  console.log(`  決済設定      ${billingConfigured() ? '有効' : '未設定（Freeプランのみ動作）'}`);
});
