/**
 * Vercel のエントリ。すべてのリクエストをここで受けて Hono に流す（vercel.json の rewrites 参照）。
 *
 * Vercel の Node ランタイムは、ハンドラを呼ぶ前にリクエストボディを読み切って
 * `req.body` に入れることがある。その状態で @hono/node-server の getRequestListener に
 * 素の `req` を渡すと、ストリームは空なので Hono の parseBody() が何も取れず、
 * POST が「入力が空」として弾かれる（サインアップが必ず失敗する形で観測された）。
 *
 * そこで、先読みされていた場合は同じ内容のストリームを作り直してから渡す。
 * GET は影響を受けないため、この不具合は POST だけに出る。
 *
 * マイグレーションはここでは実行しない。cold start ごとに走らせると無駄が大きいうえ、
 * 同時実行で競合する。デプロイ時に `npm run migrate` を一度だけ実行すること。
 */
import { getRequestListener } from '@hono/node-server';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { app } from '../src/app.ts';

export const config = { runtime: 'nodejs' };

const listener = getRequestListener(app.fetch);

/**
 * 先読みされたボディを取り出す。無ければ null（ストリームがそのまま使える）。
 *
 * 生のバイト列が残っていればそれを最優先で使う。Stripe の Webhook は
 * 署名検証にバイト単位の一致が要るため、JSON を再文字列化すると検証に失敗する。
 */
function preparsedBody(req: IncomingMessage): Buffer | null {
  const r = req as IncomingMessage & { body?: unknown; rawBody?: unknown };
  if (r.rawBody != null) {
    return Buffer.isBuffer(r.rawBody) ? r.rawBody : Buffer.from(String(r.rawBody), 'utf8');
  }
  const body = r.body;
  if (body == null) return null;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  const contentType = String(req.headers['content-type'] ?? '');
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Buffer.from(new URLSearchParams(body as Record<string, string>).toString(), 'utf8');
  }
  return Buffer.from(JSON.stringify(body), 'utf8');
}

export default function handler(req: IncomingMessage, res: ServerResponse) {
  const buf = preparsedBody(req);
  if (!buf) return listener(req, res);

  // 同じ内容を流し直すストリームを作り、元の req の属性を引き継がせる。
  const headers: NodeJS.Dict<string | string[]> = {
    ...req.headers,
    'content-length': String(buf.byteLength),
  };
  delete headers['transfer-encoding'];

  // @hono/node-server は headers ではなく rawHeaders を読む。両方揃えないと落ちる。
  const rawHeaders: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) rawHeaders.push(key, v);
  }

  const replay = Readable.from([buf]) as unknown as IncomingMessage;
  replay.headers = headers as IncomingMessage['headers'];
  replay.rawHeaders = rawHeaders;
  replay.method = req.method;
  replay.url = req.url;
  replay.httpVersion = req.httpVersion ?? '1.1';
  replay.socket = req.socket;
  return listener(replay, res);
}
