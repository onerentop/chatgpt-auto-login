const test = require('node:test');
const assert = require('node:assert');

function freshModule() {
  delete require.cache[require.resolve('../smscloud-deferred-cancel')];
  delete require.cache[require.resolve('../smscloud-provider')];
  return require('../smscloud-deferred-cancel');
}

test('enqueue + tick: 未到 125s 不调 cancelOrder', async () => {
  const mod = freshModule();
  const smscloud = require('../smscloud-provider');
  let calls = 0;
  const origCancel = smscloud.cancelOrder;
  smscloud.cancelOrder = async () => { calls++; return { ok: true }; };
  try {
    mod.enqueue({ apiKey: 'k', baseUrl: 'b', orderNo: '1', takenAtMs: Date.now() });
    await mod._processDeferredQueue();
    assert.strictEqual(calls, 0, 'should not cancel yet');
    assert.strictEqual(mod._queueForTest().size, 1);
  } finally { smscloud.cancelOrder = origCancel; }
});

test('enqueue + tick: 到 125s 后调 cancelOrder 并出队', async () => {
  const mod = freshModule();
  const smscloud = require('../smscloud-provider');
  let calls = 0;
  const origCancel = smscloud.cancelOrder;
  smscloud.cancelOrder = async (orderNo) => { calls++; assert.strictEqual(orderNo, '2'); return { ok: true }; };
  try {
    mod.enqueue({ apiKey: 'k', baseUrl: 'b', orderNo: '2', takenAtMs: Date.now() - 130_000 });
    await mod._processDeferredQueue();
    assert.strictEqual(calls, 1);
    assert.strictEqual(mod._queueForTest().size, 0);
  } finally { smscloud.cancelOrder = origCancel; }
});

test('enqueue + tick: cancel 失败重试 3 次后丢弃', async () => {
  const mod = freshModule();
  const smscloud = require('../smscloud-provider');
  let calls = 0;
  const origCancel = smscloud.cancelOrder;
  smscloud.cancelOrder = async () => { calls++; throw new Error('boom'); };
  try {
    mod.enqueue({ apiKey: 'k', baseUrl: 'b', orderNo: '3', takenAtMs: Date.now() - 130_000 });
    await mod._processDeferredQueue();
    await mod._processDeferredQueue();
    await mod._processDeferredQueue();
    assert.strictEqual(calls, 3);
    assert.strictEqual(mod._queueForTest().size, 0, 'dropped after 3 retries');
  } finally { smscloud.cancelOrder = origCancel; }
});

test('enqueue: 同 orderNo 去重', async () => {
  const mod = freshModule();
  mod.enqueue({ apiKey: 'k', baseUrl: 'b', orderNo: '4', takenAtMs: 1000 });
  mod.enqueue({ apiKey: 'k', baseUrl: 'b', orderNo: '4', takenAtMs: 2000 });
  assert.strictEqual(mod._queueForTest().size, 1);
  assert.strictEqual(mod._queueForTest().get('4').takenAtMs, 1000);
});

test('S5 _tickOnce(getDb): 调 expireOldEntries 清理过期 active entry', async () => {
  const mod = freshModule();
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE smscloud_phone_cache (order_no TEXT PRIMARY KEY, phone TEXT, api_key TEXT, base_url TEXT, taken_at_ms INTEGER, bindings_used INTEGER DEFAULT 0, status TEXT DEFAULT 'active');
    CREATE TABLE phone_bindings (phone TEXT, email TEXT, bound_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (phone, email));
  `);
  db.run("INSERT INTO smscloud_phone_cache VALUES ('A', '+1A', 'k', 'b', ?, 1, 'active')", [Date.now()]);
  db.run("INSERT INTO smscloud_phone_cache VALUES ('B', '+1B', 'k', 'b', ?, 1, 'active')", [Date.now() - (19 * 60 * 1000)]);
  await mod._tickOnce(() => db);
  const rows = db.exec("SELECT order_no FROM smscloud_phone_cache ORDER BY order_no");
  assert.deepStrictEqual(rows[0].values.map(v => v[0]), ['A'], 'B (过期) 已清理');
});

test('S6 _tickOnce(getDb): cancel rejected entry (mock cancelOrder)', async () => {
  const mod = freshModule();
  const smscloud = require('../smscloud-provider');
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE smscloud_phone_cache (order_no TEXT PRIMARY KEY, phone TEXT, api_key TEXT, base_url TEXT, taken_at_ms INTEGER, bindings_used INTEGER DEFAULT 0, status TEXT DEFAULT 'active');
    CREATE TABLE phone_bindings (phone TEXT, email TEXT, bound_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (phone, email));
  `);
  // rejected entry，taken_at_ms 在 125s 之前（满足 ready）
  db.run("INSERT INTO smscloud_phone_cache VALUES ('R1', '+1R', 'k', 'b', ?, 0, 'rejected')", [Date.now() - 200_000]);
  let cancelCalls = 0;
  const origCancel = smscloud.cancelOrder;
  smscloud.cancelOrder = async (orderNo) => { cancelCalls++; assert.strictEqual(orderNo, 'R1'); return { ok: true }; };
  try {
    await mod._tickOnce(() => db);
    assert.strictEqual(cancelCalls, 1);
    const rows = db.exec("SELECT COUNT(*) FROM smscloud_phone_cache WHERE order_no='R1'");
    assert.strictEqual(rows[0].values[0][0], 0, 'R1 已从 cache 删');
  } finally { smscloud.cancelOrder = origCancel; }
});
