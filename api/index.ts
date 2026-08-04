/**
 * Vercel のエントリ。すべてのリクエストをここで受けて Hono に流す（vercel.json の rewrites 参照）。
 *
 * マイグレーションはここでは実行しない。cold start ごとに走らせると無駄が大きいうえ、
 * 同時実行で競合する。デプロイ時に `npm run migrate` を一度だけ実行すること。
 */
import { handle } from 'hono/vercel';
import { app } from '../src/app.ts';

export const config = { runtime: 'nodejs' };

export default handle(app);
