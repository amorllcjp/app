/**
 * Vercel のエントリ。すべてのリクエストをここで受けて Hono に流す（vercel.json の rewrites 参照）。
 *
 * hono/vercel の handle() は Web標準の Request を受ける形だが、Vercel の Node ランタイムは
 * Node の (req, res) でハンドラを呼ぶ。両者が食い違うと、Hono に到達する前に落ちるため
 * app.onError でも拾えず、Vercel の FUNCTION_INVOCATION_FAILED になる。
 *
 * そこで @hono/node-server の getRequestListener を使い、Node の (req, res) を
 * そのまま受けられる形にする。ローカルの src/server.ts と同じ経路を通るので、
 * 実行環境ごとの差異が減る。
 *
 * マイグレーションはここでは実行しない。cold start ごとに走らせると無駄が大きいうえ、
 * 同時実行で競合する。デプロイ時に `npm run migrate` を一度だけ実行すること。
 */
import { getRequestListener } from '@hono/node-server';
import { app } from '../src/app.ts';

export const config = { runtime: 'nodejs' };

export default getRequestListener(app.fetch);
