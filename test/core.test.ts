/**
 * 中核のテスト。
 * 特に「別ワークスペースのデータが漏れないこと」は要件書 §12.3 でリリースゲートに
 * している項目なので、CIで毎回実行する。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/db.ts';
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

function setup() {
  const d = openMemoryDb();
  const a = createAccount(d, 'a@example.com', 'password-aaaa');
  const b = createAccount(d, 'b@example.com', 'password-bbbb');
  return { d, a, b };
}

describe('日本語検索', () => {
  test('2文字の語で取りこぼさない', () => {
    const { d, a } = setup();
    const pack = createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    addDocument(d, a.workspaceId, a.userId, pack.id, {
      title: 'キックオフ議事録',
      body: '来週の請求書は田中さんが確認してから送付する。単価は8万円で合意済み。',
    });
    for (const q of ['単価', '田中', '請求書', '8万円']) {
      const r = searchWithEvidence(d, a.workspaceId, a.userId, { query: q });
      assert.equal(r.results.length, 1, `「${q}」で見つからない`);
    }
  });

  test('存在しない語は空を返す（推測で埋めない）', () => {
    const { d, a } = setup();
    const pack = createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    addDocument(d, a.workspaceId, a.userId, pack.id, { title: 'メモ', body: '単価は8万円。' });
    assert.equal(searchWithEvidence(d, a.workspaceId, a.userId, { query: '存在しない語' }).results.length, 0);
  });

  test('bigramの偽陽性を実体チェックで除去する', () => {
    const { d, a } = setup();
    const pack = createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    // 「東京」「京都」の bigram は含むが「東京都」という並びは無い文書
    addDocument(d, a.workspaceId, a.userId, pack.id, { title: 'メモ', body: '東京から京都へ移動する。' });
    assert.equal(searchWithEvidence(d, a.workspaceId, a.userId, { query: '東京都' }).results.length, 0);
    assert.equal(searchWithEvidence(d, a.workspaceId, a.userId, { query: '東京' }).results.length, 1);
  });

  test('全角半角・大文字小文字の揺れを吸収する', () => {
    const { d, a } = setup();
    const pack = createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    addDocument(d, a.workspaceId, a.userId, pack.id, { title: 'メモ', body: 'Stripeで決済を実装した。' });
    for (const q of ['stripe', 'STRIPE', 'Ｓｔｒｉｐｅ']) {
      assert.equal(searchWithEvidence(d, a.workspaceId, a.userId, { query: q }).results.length, 1, q);
    }
  });

  test('grams と chunkText の基本', () => {
    assert.ok(grams('単価').includes('単価'));
    assert.equal(normalize('ＡＢＣ'), 'abc');
    assert.ok(chunkText('a'.repeat(2000)).length > 1);
    assert.deepEqual(chunkText(''), []);
  });
});

describe('出典（要件書 FR-007）', () => {
  test('検索結果は出典項目をすべて持つ', () => {
    const { d, a } = setup();
    const pack = createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    addDocument(d, a.workspaceId, a.userId, pack.id, {
      title: '議事録',
      body: '単価は8万円で合意済み。',
      sourceUrl: 'https://example.com/doc',
    });
    const r = searchWithEvidence(d, a.workspaceId, a.userId, { query: '単価' }).results[0]!;
    assert.equal(r.pack_name, 'A案件');
    assert.equal(r.title, '議事録');
    assert.equal(r.source_url, 'https://example.com/doc');
    assert.equal(r.provenance, 'markdown');
    assert.ok(r.fetched_at);
    assert.ok(r.excerpt.includes('8万円'));
  });

  test('抜粋は原文の一部である（生成しない）', () => {
    const { d, a } = setup();
    const pack = createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    const body = '単価は8万円で合意済み。';
    addDocument(d, a.workspaceId, a.userId, pack.id, { title: '議事録', body });
    const r = searchWithEvidence(d, a.workspaceId, a.userId, { query: '単価' }).results[0]!;
    assert.ok(body.includes(r.excerpt.replace(/^…|…$/g, '')));
  });

  test('根拠を chunk_id で取り直せる', () => {
    const { d, a } = setup();
    const pack = createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    addDocument(d, a.workspaceId, a.userId, pack.id, { title: '議事録', body: '単価は8万円で合意済み。' });
    const hit = searchWithEvidence(d, a.workspaceId, a.userId, { query: '単価' }).results[0]!;
    const ev = getEvidence(d, a.workspaceId, hit.chunk_id);
    assert.ok(ev);
    assert.ok(ev.full_text.includes('8万円'));
  });
});

describe('権限境界（要件書 §12.3: 漏えい0件）', () => {
  test('別ワークスペースの資料は検索に出ない', () => {
    const { d, a, b } = setup();
    const packA = createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    addDocument(d, a.workspaceId, a.userId, packA.id, { title: '秘密', body: 'A社の単価は8万円。' });
    assert.equal(searchWithEvidence(d, b.workspaceId, b.userId, { query: '単価' }).results.length, 0);
  });

  test('別ワークスペースの pack_id を指定しても取得できない', () => {
    const { d, a, b } = setup();
    const packA = createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    addDocument(d, a.workspaceId, a.userId, packA.id, { title: '秘密', body: 'A社の単価は8万円。' });
    const r = searchWithEvidence(d, b.workspaceId, b.userId, { query: '単価', packIds: [packA.id] });
    assert.equal(r.results.length, 0);
  });

  test('別ワークスペースの chunk_id を指定しても根拠を取れない', () => {
    const { d, a, b } = setup();
    const packA = createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    addDocument(d, a.workspaceId, a.userId, packA.id, { title: '秘密', body: 'A社の単価は8万円。' });
    const hit = searchWithEvidence(d, a.workspaceId, a.userId, { query: '単価' }).results[0]!;
    assert.equal(getEvidence(d, b.workspaceId, hit.chunk_id), null);
  });

  test('別ワークスペースのPackはエクスポートできない', () => {
    const { d, a, b } = setup();
    const packA = createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    assert.throws(() => exportPackMarkdown(d, b.workspaceId, packA.id));
  });

  test('MCPトークンは発行元ワークスペースだけを解決する', () => {
    const { d, a, b } = setup();
    const tokenA = issueMcpToken(d, a.workspaceId, a.userId);
    assert.equal(authenticateMcp(d, `Bearer ${tokenA}`)?.workspaceId, a.workspaceId);
    assert.notEqual(authenticateMcp(d, `Bearer ${tokenA}`)?.workspaceId, b.workspaceId);
    assert.equal(authenticateMcp(d, 'Bearer にせもの'), null);
    assert.equal(authenticateMcp(d, null), null);
  });

  test('再発行すると古いトークンは無効になる', () => {
    const { d, a } = setup();
    const old = issueMcpToken(d, a.workspaceId, a.userId);
    issueMcpToken(d, a.workspaceId, a.userId);
    assert.equal(authenticateMcp(d, `Bearer ${old}`), null);
  });
});

describe('削除の伝播', () => {
  test('削除した資料は検索に出ない', () => {
    const { d, a } = setup();
    const pack = createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    const docId = addDocument(d, a.workspaceId, a.userId, pack.id, { title: 'メモ', body: '単価は8万円。' });
    assert.equal(searchWithEvidence(d, a.workspaceId, a.userId, { query: '単価' }).results.length, 1);
    deleteDocument(d, a.workspaceId, a.userId, docId);
    assert.equal(searchWithEvidence(d, a.workspaceId, a.userId, { query: '単価' }).results.length, 0);
  });
});

describe('明示保存（要件書 FR-008）', () => {
  test('confirm なしでは保存しない', () => {
    const { d, a } = setup();
    const pack = createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    const r = saveContext(d, a.workspaceId, 'mcp', {
      packId: pack.id,
      title: 'AIの推測',
      content: 'たぶん単価は10万円。',
      confirm: false,
    });
    assert.equal(r.saved, false);
    assert.equal(searchWithEvidence(d, a.workspaceId, a.userId, { query: '10万円' }).results.length, 0);
  });

  test('confirm ありなら保存し、由来が user_saved になる', () => {
    const { d, a } = setup();
    const pack = createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    const r = saveContext(d, a.workspaceId, 'mcp', {
      packId: pack.id,
      title: '確認済み',
      content: '単価は10万円で確定。',
      confirm: true,
    });
    assert.equal(r.saved, true);
    const hit = searchWithEvidence(d, a.workspaceId, a.userId, { query: '10万円' }).results[0]!;
    assert.equal(hit.provenance, 'user_saved');
  });
});

describe('上限と課金（要件書 FR-013）', () => {
  test('Freeプランは2つ目のPackを作れない', () => {
    const { d, a } = setup();
    createPack(d, a.workspaceId, a.userId, { name: '1つ目' });
    assert.throws(() => createPack(d, a.workspaceId, a.userId, { name: '2つ目' }), LimitError);
  });

  test('Proにすると上限が上がる', () => {
    const { d, a } = setup();
    createPack(d, a.workspaceId, a.userId, { name: '1つ目' });
    d.prepare("update workspaces set plan = 'pro' where id = ?").run(a.workspaceId);
    assert.doesNotThrow(() => createPack(d, a.workspaceId, a.userId, { name: '2つ目' }));
  });

  test('支払い停止中は Free の上限に落ちる（データは消さない）', () => {
    const { d, a } = setup();
    d.prepare("update workspaces set plan = 'pro', plan_status = 'past_due' where id = ?").run(a.workspaceId);
    createPack(d, a.workspaceId, a.userId, { name: '1つ目' });
    assert.throws(() => createPack(d, a.workspaceId, a.userId, { name: '2つ目' }), LimitError);
  });

  test('検索回数の上限に達すると limitReached を返す', () => {
    const { d, a } = setup();
    const pack = createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    addDocument(d, a.workspaceId, a.userId, pack.id, { title: 'メモ', body: '単価は8万円。' });
    d.prepare("insert into usage_counters (workspace_id, period, searches) values (?, strftime('%Y-%m','now'), 100)").run(
      a.workspaceId,
    );
    const r = searchWithEvidence(d, a.workspaceId, a.userId, { query: '単価' });
    assert.equal(r.limitReached, true);
    assert.equal(r.results.length, 0);
  });
});

describe('エクスポートと鮮度表示', () => {
  test('Markdown出力に出典と注意書きが入る', () => {
    const { d, a } = setup();
    const pack = createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    addDocument(d, a.workspaceId, a.userId, pack.id, {
      title: '議事録',
      body: '単価は8万円で合意済み。',
      sourceUrl: 'https://example.com/doc',
    });
    const md = exportPackMarkdown(d, a.workspaceId, pack.id);
    assert.ok(md.includes('https://example.com/doc'));
    assert.ok(md.includes('取得時刻'));
    assert.ok(md.includes('自動同期は行っていません'));
    assert.ok(md.includes('8万円'));
  });

  test('pack_status は自動同期していないことを明示する', () => {
    const { d, a } = setup();
    createPack(d, a.workspaceId, a.userId, { name: 'A案件' });
    const s = packStatus(d, a.workspaceId);
    assert.equal(s.packs[0]!.sync, 'manual_import_only');
  });
});

describe('パスワード', () => {
  test('ハッシュ照合が正しく動く', () => {
    const h = hashPassword('password-aaaa');
    assert.ok(verifyPassword('password-aaaa', h));
    assert.ok(!verifyPassword('wrong', h));
    assert.ok(!verifyPassword('password-aaaa', 'garbage'));
  });

  test('誤ったパスワードではログインできない', () => {
    const { d } = setup();
    assert.equal(login(d, 'a@example.com', 'wrong-password'), null);
    assert.ok(login(d, 'a@example.com', 'password-aaaa'));
  });

  test('短いパスワードと重複メールを拒否する', () => {
    const { d } = setup();
    assert.throws(() => createAccount(d, 'c@example.com', 'short'));
    assert.throws(() => createAccount(d, 'a@example.com', 'password-cccc'));
  });
});
