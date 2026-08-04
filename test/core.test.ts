/**
 * 中核のテスト。
 * 特に「別ワークスペースのデータが漏れないこと」は要件書 §12.3 でリリースゲートに
 * している項目なので、CIで毎回実行する。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from '../src/db.ts';
import { createAccount, issueMcpToken, authenticateMcp, hashPassword, verifyPassword, login } from '../src/auth.ts';
import {
  createPack,
  addDocument,
  searchWithEvidence,
  getEvidence,
  saveContext,
  exportPackMarkdown,
  deleteDocument,
  packStatus,
  LimitError,
} from '../src/packs.ts';
import { grams, chunkText, normalize } from '../src/search.ts';

process.env.SESSION_SECRET ??= 'test-secret-for-unit-tests';

async function setup() {
  const d = await openTestDb();
  const a = await createAccount(d, 'a@example.com', 'password-aaaa');
  const b = await createAccount(d, 'b@example.com', 'password-bbbb');
  return { d, a, b };
}

describe('日本語検索', () => {
  test('2文字の語で取りこぼさない', async () => {
    const { d, a } = await setup();
    const pack = await createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    await addDocument(d, a.workspaceId, a.userId, pack.id, {
      title: 'キックオフ議事録',
      body: '来週の請求書は田中さんが確認してから送付する。単価は8万円で合意済み。',
    });
    for (const q of ['単価', '田中', '請求書', '8万円']) {
      const r = await searchWithEvidence(d, a.workspaceId, a.userId, { query: q });
      assert.equal(r.results.length, 1, `「${q}」で見つからない`);
    }
  });

  test('存在しない語は空を返す（推測で埋めない）', async () => {
    const { d, a } = await setup();
    const pack = await createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    await addDocument(d, a.workspaceId, a.userId, pack.id, { title: 'メモ', body: '単価は8万円。' });
    assert.equal((await searchWithEvidence(d, a.workspaceId, a.userId, { query: '存在しない語' })).results.length, 0);
  });

  test('bigramの偽陽性を実体チェックで除去する', async () => {
    const { d, a } = await setup();
    const pack = await createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    // 「東京」「京都」の bigram は含むが「東京都」という並びは無い文書
    await addDocument(d, a.workspaceId, a.userId, pack.id, { title: 'メモ', body: '東京から京都へ移動する。' });
    assert.equal((await searchWithEvidence(d, a.workspaceId, a.userId, { query: '東京都' })).results.length, 0);
    assert.equal((await searchWithEvidence(d, a.workspaceId, a.userId, { query: '東京' })).results.length, 1);
  });

  test('全角半角・大文字小文字の揺れを吸収する', async () => {
    const { d, a } = await setup();
    const pack = await createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    await addDocument(d, a.workspaceId, a.userId, pack.id, { title: 'メモ', body: 'Stripeで決済を実装した。' });
    for (const q of ['stripe', 'STRIPE', 'Ｓｔｒｉｐｅ']) {
      assert.equal((await searchWithEvidence(d, a.workspaceId, a.userId, { query: q })).results.length, 1, q);
    }
  });

  test('grams と chunkText の基本', async () => {
    assert.ok(grams('単価').includes('単価'));
    assert.equal(normalize('ＡＢＣ'), 'abc');
    assert.ok(chunkText('a'.repeat(2000)).length > 1);
    assert.deepEqual(chunkText(''), []);
  });
});

describe('出典（要件書 FR-007）', () => {
  test('検索結果は出典項目をすべて持つ', async () => {
    const { d, a } = await setup();
    const pack = await createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    await addDocument(d, a.workspaceId, a.userId, pack.id, {
      title: '議事録',
      body: '単価は8万円で合意済み。',
      sourceUrl: 'https://example.com/doc',
    });
    const r = (await searchWithEvidence(d, a.workspaceId, a.userId, { query: '単価' })).results[0]!;
    assert.equal(r.pack_name, 'A案件');
    assert.equal(r.title, '議事録');
    assert.equal(r.source_url, 'https://example.com/doc');
    assert.equal(r.provenance, 'markdown');
    assert.ok(r.fetched_at);
    assert.ok(r.excerpt.includes('8万円'));
  });

  test('抜粋は原文の一部である（生成しない）', async () => {
    const { d, a } = await setup();
    const pack = await createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    const body = '単価は8万円で合意済み。';
    await addDocument(d, a.workspaceId, a.userId, pack.id, { title: '議事録', body });
    const r = (await searchWithEvidence(d, a.workspaceId, a.userId, { query: '単価' })).results[0]!;
    assert.ok(body.includes(r.excerpt.replace(/^…|…$/g, '')));
  });

  test('根拠を chunk_id で取り直せる', async () => {
    const { d, a } = await setup();
    const pack = await createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    await addDocument(d, a.workspaceId, a.userId, pack.id, { title: '議事録', body: '単価は8万円で合意済み。' });
    const hit = (await searchWithEvidence(d, a.workspaceId, a.userId, { query: '単価' })).results[0]!;
    const ev = await getEvidence(d, a.workspaceId, hit.chunk_id);
    assert.ok(ev);
    assert.ok(ev.full_text.includes('8万円'));
  });
});

describe('権限境界（要件書 §12.3: 漏えい0件）', () => {
  test('別ワークスペースの資料は検索に出ない', async () => {
    const { d, a, b } = await setup();
    const packA = await createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    await addDocument(d, a.workspaceId, a.userId, packA.id, { title: '秘密', body: 'A社の単価は8万円。' });
    assert.equal((await searchWithEvidence(d, b.workspaceId, b.userId, { query: '単価' })).results.length, 0);
  });

  test('別ワークスペースの pack_id を指定しても取得できない', async () => {
    const { d, a, b } = await setup();
    const packA = await createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    await addDocument(d, a.workspaceId, a.userId, packA.id, { title: '秘密', body: 'A社の単価は8万円。' });
    const r = await searchWithEvidence(d, b.workspaceId, b.userId, { query: '単価', packIds: [packA.id] });
    assert.equal(r.results.length, 0);
  });

  test('別ワークスペースの chunk_id を指定しても根拠を取れない', async () => {
    const { d, a, b } = await setup();
    const packA = await createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    await addDocument(d, a.workspaceId, a.userId, packA.id, { title: '秘密', body: 'A社の単価は8万円。' });
    const hit = (await searchWithEvidence(d, a.workspaceId, a.userId, { query: '単価' })).results[0]!;
    assert.equal(await getEvidence(d, b.workspaceId, hit.chunk_id), null);
  });

  test('別ワークスペースのPackはエクスポートできない', async () => {
    const { d, a, b } = await setup();
    const packA = await createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    await assert.rejects(() => exportPackMarkdown(d, b.workspaceId, packA.id));
  });

  test('MCPトークンは発行元ワークスペースだけを解決する', async () => {
    const { d, a, b } = await setup();
    const tokenA = await issueMcpToken(d, a.workspaceId, a.userId);
    assert.equal((await authenticateMcp(d, `Bearer ${tokenA}`))?.workspaceId, a.workspaceId);
    assert.notEqual((await authenticateMcp(d, `Bearer ${tokenA}`))?.workspaceId, b.workspaceId);
    assert.equal(await authenticateMcp(d, 'Bearer にせもの'), null);
    assert.equal(await authenticateMcp(d, null), null);
  });

  test('再発行すると古いトークンは無効になる', async () => {
    const { d, a } = await setup();
    const old = await issueMcpToken(d, a.workspaceId, a.userId);
    await issueMcpToken(d, a.workspaceId, a.userId);
    assert.equal(await authenticateMcp(d, `Bearer ${old}`), null);
  });
});

describe('削除の伝播', () => {
  test('削除した資料は検索に出ない', async () => {
    const { d, a } = await setup();
    const pack = await createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    const docId = await addDocument(d, a.workspaceId, a.userId, pack.id, { title: 'メモ', body: '単価は8万円。' });
    assert.equal((await searchWithEvidence(d, a.workspaceId, a.userId, { query: '単価' })).results.length, 1);
    await deleteDocument(d, a.workspaceId, a.userId, docId);
    assert.equal((await searchWithEvidence(d, a.workspaceId, a.userId, { query: '単価' })).results.length, 0);
  });
});

describe('明示保存（要件書 FR-008）', () => {
  test('confirm なしでは保存しない', async () => {
    const { d, a } = await setup();
    const pack = await createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    const r = await saveContext(d, a.workspaceId, 'mcp', {
      packId: pack.id,
      title: 'AIの推測',
      content: 'たぶん単価は10万円。',
      confirm: false,
    });
    assert.equal(r.saved, false);
    assert.equal((await searchWithEvidence(d, a.workspaceId, a.userId, { query: '10万円' })).results.length, 0);
  });

  test('confirm ありなら保存し、由来が user_saved になる', async () => {
    const { d, a } = await setup();
    const pack = await createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    const r = await saveContext(d, a.workspaceId, 'mcp', {
      packId: pack.id,
      title: '確認済み',
      content: '単価は10万円で確定。',
      confirm: true,
    });
    assert.equal(r.saved, true);
    const hit = (await searchWithEvidence(d, a.workspaceId, a.userId, { query: '10万円' })).results[0]!;
    assert.equal(hit.provenance, 'user_saved');
  });
});

describe('上限と課金（要件書 FR-013）', () => {
  test('Freeプランは2つ目のPackを作れない', async () => {
    const { d, a } = await setup();
    await createPack(d, a.workspaceId, a.userId, { name: '1つ目' });
    await assert.rejects(() => createPack(d, a.workspaceId, a.userId, { name: '2つ目' }), LimitError);
  });

  test('Proにすると上限が上がる', async () => {
    const { d, a } = await setup();
    await createPack(d, a.workspaceId, a.userId, { name: '1つ目' });
    await d.query("update workspaces set plan = 'pro' where id = $1", [a.workspaceId]);
    await createPack(d, a.workspaceId, a.userId, { name: '2つ目' });
  });

  test('支払い停止中は Free の上限に落ちる（データは消さない）', async () => {
    const { d, a } = await setup();
    await d.query("update workspaces set plan = 'pro', plan_status = 'past_due' where id = $1", [a.workspaceId]);
    await createPack(d, a.workspaceId, a.userId, { name: '1つ目' });
    await assert.rejects(() => createPack(d, a.workspaceId, a.userId, { name: '2つ目' }), LimitError);
  });

  test('検索回数の上限に達すると limitReached を返す', async () => {
    const { d, a } = await setup();
    const pack = await createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    await addDocument(d, a.workspaceId, a.userId, pack.id, { title: 'メモ', body: '単価は8万円。' });
    await d.query(
      "insert into usage_counters (workspace_id, period, searches) values ($1, to_char(now(),'YYYY-MM'), 100)",
      [a.workspaceId],
    );
    const r = await searchWithEvidence(d, a.workspaceId, a.userId, { query: '単価' });
    assert.equal(r.limitReached, true);
    assert.equal(r.results.length, 0);
  });
});

describe('エクスポートと鮮度表示', () => {
  test('Markdown出力に出典と注意書きが入る', async () => {
    const { d, a } = await setup();
    const pack = await createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    await addDocument(d, a.workspaceId, a.userId, pack.id, {
      title: '議事録',
      body: '単価は8万円で合意済み。',
      sourceUrl: 'https://example.com/doc',
    });
    const md = await exportPackMarkdown(d, a.workspaceId, pack.id);
    assert.ok(md.includes('https://example.com/doc'));
    assert.ok(md.includes('取得時刻'));
    assert.ok(md.includes('自動同期は行っていません'));
    assert.ok(md.includes('8万円'));
  });

  test('pack_status は自動同期していないことを明示する', async () => {
    const { d, a } = await setup();
    await createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    const s = await packStatus(d, a.workspaceId);
    assert.equal(s.packs[0]!.sync, 'manual_import_only');
  });
});

describe('パスワード', () => {
  test('ハッシュ照合が正しく動く', async () => {
    const h = hashPassword('password-aaaa');
    assert.ok(verifyPassword('password-aaaa', h));
    assert.ok(!verifyPassword('wrong', h));
    assert.ok(!verifyPassword('password-aaaa', 'garbage'));
  });

  test('誤ったパスワードではログインできない', async () => {
    const { d } = await setup();
    assert.equal(await login(d, 'a@example.com', 'wrong-password'), null);
    assert.ok(await login(d, 'a@example.com', 'password-aaaa'));
  });

  test('短いパスワードと重複メールを拒否する', async () => {
    const { d } = await setup();
    await assert.rejects(() => createAccount(d, 'c@example.com', 'short'));
    await assert.rejects(() => createAccount(d, 'a@example.com', 'password-cccc'));
  });
});

describe('抜粋とハイライト（操作性）', () => {
  test('長文でも一致箇所が抜粋の中央付近に来る', async () => {
    const { d, a } = await setup();
    const pack = await createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    const filler = 'これは無関係な定型文です。担当と日程を調整しました。';
    // 一致箇所を本文の後半に置く
    const body = filler.repeat(20) + '本件の単価は8万円で合意した。' + filler.repeat(20);
    await addDocument(d, a.workspaceId, a.userId, pack.id, { title: '長い議事録', body });
    const r = (await searchWithEvidence(d, a.workspaceId, a.userId, { query: '単価' })).results[0]!;
    const at = r.excerpt.indexOf('単価');
    assert.ok(at >= 0, '抜粋に検索語が含まれていない');
    const ratio = at / r.excerpt.length;
    // 端に寄っていないこと。中央付近（25〜75%）に入っていれば読み手が見つけられる
    assert.ok(ratio > 0.25 && ratio < 0.75, `一致箇所が端に寄っている: ${Math.round(ratio * 100)}%`);
  });

  test('ハイライトはHTMLをエスケープしてから挿入する', async () => {
    const { highlight } = await import('../src/views.ts');
    assert.equal(highlight('単価は8万円', '単価'), '<mark>単価</mark>は8万円');
    // 検索語がタグでも、実行可能なHTMLにしない
    const out = highlight('a<script>alert(1)</script>b', '<script>');
    assert.ok(!out.includes('<script>'), 'エスケープされていない');
    assert.ok(out.includes('<mark>&lt;script&gt;</mark>'));
    // 実体参照をまたいでタグを挿入しない
    assert.equal(highlight('A&B', 'a&b'), '<mark>A&amp;B</mark>');
    // 検索語なしでもエスケープはする
    assert.equal(highlight('<b>x</b>', undefined), '&lt;b&gt;x&lt;/b&gt;');
  });
});
