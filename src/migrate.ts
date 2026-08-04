/** マイグレーション実行スクリプト。`npm run migrate` から呼ぶ。 */
import { sql, migrate } from './db.ts';
import { config } from './config.ts';

const db = await sql();
await migrate(db);
console.log(`マイグレーション完了: ${config.databaseUrl ? 'Neon (DATABASE_URL)' : 'PGlite'}`);
process.exit(0);
