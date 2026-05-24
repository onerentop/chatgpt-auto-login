const test = require('node:test');
const assert = require('node:assert');
const initSqlJs = require('sql.js');

let SQL, db, blacklist;

test.before(async () => {
  SQL = await initSqlJs();
});

test.beforeEach(() => {
  db = new SQL.Database();
  db.run(`
    CREATE TABLE proxy_blacklist (
      tag TEXT NOT NULL,
      channel TEXT NOT NULL,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at INTEGER NOT NULL,
      reason TEXT DEFAULT '',
      source TEXT NOT NULL DEFAULT 'auto',
      PRIMARY KEY (tag, channel)
    );
  `);
  blacklist = require('../blacklist');
  blacklist.__setDb(db, () => {});
});

test('B1 add + loadAll 往返：main / jp 互不混入', () => {
  blacklist.add('us-1', 'main', 60000, 'tls', 'auto');
  blacklist.add('jp-1', 'jp', 60000, 'checkout_empty_link', 'auto');
  const mainRows = blacklist.loadAll('main');
  const jpRows = blacklist.loadAll('jp');
  assert.strictEqual(mainRows.length, 1);
  assert.strictEqual(mainRows[0].tag, 'us-1');
  assert.strictEqual(mainRows[0].reason, 'tls');
  assert.strictEqual(mainRows[0].source, 'auto');
  assert.ok(mainRows[0].expiresAt > Date.now());
  assert.strictEqual(jpRows.length, 1);
  assert.strictEqual(jpRows[0].tag, 'jp-1');
});

test('B2 同 (tag, channel) 重复 add：INSERT OR REPLACE 覆盖 expires_at', async () => {
  blacklist.add('us-1', 'main', 1000, 'first', 'auto');
  const first = blacklist.loadAll('main')[0].expiresAt;
  await new Promise(r => setTimeout(r, 5));
  blacklist.add('us-1', 'main', 60000, 'second', 'manual');
  const rows = blacklist.loadAll('main');
  assert.strictEqual(rows.length, 1);
  assert.ok(rows[0].expiresAt > first, '新 expires_at 应大于旧值');
  assert.strictEqual(rows[0].reason, 'second');
  assert.strictEqual(rows[0].source, 'manual');
});

test('B3 pruneExpired 只删 expires_at <= now', () => {
  blacklist.add('past', 'main', -60000, 'old', 'auto');
  blacklist.add('future', 'main', 60000, 'fresh', 'auto');
  blacklist.pruneExpired();
  const rows = blacklist.loadAll('main');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].tag, 'future');
});

test('B4 removeAll(channel) 只删指定通道', () => {
  blacklist.add('us-1', 'main', 60000, '', 'auto');
  blacklist.add('us-2', 'main', 60000, '', 'auto');
  blacklist.add('jp-1', 'jp', 60000, '', 'auto');
  blacklist.removeAll('main');
  assert.strictEqual(blacklist.loadAll('main').length, 0);
  assert.strictEqual(blacklist.loadAll('jp').length, 1);
});

test('B4b remove(tag, channel) 只删一行', () => {
  blacklist.add('us-1', 'main', 60000, '', 'auto');
  blacklist.add('us-2', 'main', 60000, '', 'auto');
  blacklist.remove('us-1', 'main');
  const rows = blacklist.loadAll('main');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].tag, 'us-2');
});

test('loadAll 跳过已过期条目（防 hydrate 灌入坏数据）', () => {
  blacklist.add('expired', 'main', -1000, '', 'auto');
  blacklist.add('alive', 'main', 60000, '', 'auto');
  const rows = blacklist.loadAll('main');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].tag, 'alive');
});

test('B5 recordBadAttempt 达到 FAIL_THRESHOLD 触发 fire-and-forget rotate (main)', async () => {
  const proxyMgr = require('../index');
  const calls = [];
  proxyMgr.__setAutoRotateForTest(
    () => { calls.push('main'); return Promise.resolve(); },
    () => { calls.push('jp'); return Promise.resolve(); }
  );
  try {
    const r1 = proxyMgr.recordBadAttempt('test-node-X', 'main', 'test1');
    const r2 = proxyMgr.recordBadAttempt('test-node-X', 'main', 'test2');
    const r3 = proxyMgr.recordBadAttempt('test-node-X', 'main', 'test3');
    assert.strictEqual(r1.blacklisted, false);
    assert.strictEqual(r1.count, 1);
    assert.strictEqual(r2.blacklisted, false);
    assert.strictEqual(r2.count, 2);
    assert.strictEqual(r3.blacklisted, true);
    assert.strictEqual(r3.count, 3);
    await new Promise(r => setImmediate(r));
    assert.strictEqual(calls.length, 1, 'main rotate called once');
    assert.strictEqual(calls[0], 'main');
  } finally {
    proxyMgr.__setAutoRotateForTest(null, null);
    try { proxyMgr.removeFromBlacklist?.('test-node-X', 'main'); } catch {}
  }
});

test('B6 recordBadAttempt (jp 通道) 达到阈值触发 rotateJp', async () => {
  const proxyMgr = require('../index');
  const calls = [];
  proxyMgr.__setAutoRotateForTest(
    () => { calls.push('main'); return Promise.resolve(); },
    () => { calls.push('jp'); return Promise.resolve(); }
  );
  try {
    proxyMgr.recordBadAttempt('test-jp-Y', 'jp', 'jpfail1');
    proxyMgr.recordBadAttempt('test-jp-Y', 'jp', 'jpfail2');
    const r3 = proxyMgr.recordBadAttempt('test-jp-Y', 'jp', 'jpfail3');
    assert.strictEqual(r3.blacklisted, true);
    await new Promise(r => setImmediate(r));
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0], 'jp', 'jp channel calls rotateJp');
  } finally {
    proxyMgr.__setAutoRotateForTest(null, null);
    try { proxyMgr.removeFromBlacklist?.('test-jp-Y', 'jp'); } catch {}
  }
});
