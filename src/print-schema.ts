/**
 * スキーマを SQL として出力する。`npm run schema` から呼ぶ。
 *
 * ローカルに開発環境が無くても、出力を Neon の SQL Editor に貼れば初期化できる。
 * 定義は db.ts の1か所だけなので、こちらと本体がずれることはない。
 */
import { schemaSql } from './db.ts';

console.log(schemaSql());
