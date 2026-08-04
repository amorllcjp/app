/**
 * 依存ゼロの疎通確認。切り分け専用。
 *
 * /api/ping が動いて / が落ちる → 原因はアプリ側の import か初期化
 * /api/ping も落ちる          → 原因は Vercel のプロジェクト設定かランタイム
 *
 * ここには何も import しない。壊れる余地を残さないため。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export const config = { runtime: 'nodejs' };

export default function handler(_req: IncomingMessage, res: ServerResponse) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(
    JSON.stringify({
      pong: true,
      node: process.version,
      region: process.env.VERCEL_REGION ?? null,
      env_present: {
        DATABASE_URL: Boolean(process.env.DATABASE_URL),
        SESSION_SECRET: Boolean(process.env.SESSION_SECRET),
        BASE_URL: process.env.BASE_URL ?? null,
      },
    }),
  );
}
