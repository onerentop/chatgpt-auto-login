const test = require('node:test');
const assert = require('node:assert');
const initSqlJs = require('sql.js');

let SQL;
let pool;

test.before(async () => {
  SQL = await initSqlJs();
  pool = require('../smscloud-pool');
});

function freshDb() {
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE smscloud_phone_cache (
      order_no       TEXT PRIMARY KEY,
      phone          TEXT NOT NULL,
      api_key        TEXT NOT NULL,
      base_url       TEXT NOT NULL,
      taken_at_ms    INTEGER NOT NULL,
      bindings_used  INTEGER NOT NULL DEFAULT 0,
      status         TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE phone_bindings (
      phone TEXT NOT NULL,
      email TEXT NOT NULL,
      bound_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (phone, email)
    );
  `);
  return db;
}

function insertEntry(db, { orderNo, phone, taken_at_ms, bindings_used = 0, status = 'active' }) {
  db.run(
    `INSERT INTO smscloud_phone_cache (order_no, phone, api_key, base_url, taken_at_ms, bindings_used, status)
     VALUES (?, ?, 'k', 'b', ?, ?, ?)`,
    [orderNo, phone, taken_at_ms, bindings_used, status]
  );
}

const EXPIRY_MS = 18 * 60 * 1000;

test('S1 acquirePhone: cache miss → 调 takeOrderFn + 写 cache + binding', async () => {
  const db = freshDb();
  let called = 0;
  const takeOrderFn = async () => {
    called++;
    return { orderNo: 'O1', phone: '+11111111111', apiKey: 'k', baseUrl: 'b' };
  };
  const r = await pool.acquirePhone(db, 'a@b.com', 3, EXPIRY_MS, [], takeOrderFn);
  assert.strictEqual(called, 1);
  assert.strictEqual(r.reused, false);
  assert.strictEqual(r.phone, '+11111111111');
  assert.strictEqual(r.orderNo, 'O1');
  assert.ok(r.taken_at_ms > 0);
  const row = db.exec("SELECT bindings_used FROM smscloud_phone_cache WHERE order_no='O1'");
  assert.strictEqual(row[0].values[0][0], 1);
  const bind = db.exec("SELECT * FROM phone_bindings WHERE email='a@b.com'");
  assert.strictEqual(bind[0].values.length, 1);
});

test('S2 acquirePhone: cache hit → 不调 takeOrderFn + 复用号', async () => {
  const db = freshDb();
  insertEntry(db, { orderNo: 'O2', phone: '+12222222222', taken_at_ms: Date.now() - 1000 });
  let called = 0;
  const takeOrderFn = async () => { called++; throw new Error('should not be called'); };
  const r = await pool.acquirePhone(db, 'b@c.com', 3, EXPIRY_MS, [], takeOrderFn);
  assert.strictEqual(called, 0);
  assert.strictEqual(r.reused, true);
  assert.strictEqual(r.phone, '+12222222222');
  const row = db.exec("SELECT bindings_used FROM smscloud_phone_cache WHERE order_no='O2'");
  assert.strictEqual(row[0].values[0][0], 1);
});

test('S3 acquirePhone: bindings 满 max → 跳过 → takeOrderFn', async () => {
  const db = freshDb();
  insertEntry(db, { orderNo: 'O3', phone: '+13333333333', taken_at_ms: Date.now(), bindings_used: 3 });
  let called = 0;
  const takeOrderFn = async () => { called++; return { orderNo: 'NEW', phone: '+19999999999', apiKey: 'k', baseUrl: 'b' }; };
  const r = await pool.acquirePhone(db, 'c@d.com', 3, EXPIRY_MS, [], takeOrderFn);
  assert.strictEqual(called, 1);
  assert.strictEqual(r.orderNo, 'NEW');
});

test('S4 acquirePhone: 已过期 → 跳过 → takeOrderFn', async () => {
  const db = freshDb();
  insertEntry(db, { orderNo: 'O4', phone: '+14444444444', taken_at_ms: Date.now() - (EXPIRY_MS + 1000) });
  let called = 0;
  const takeOrderFn = async () => { called++; return { orderNo: 'NEW2', phone: '+19999999998', apiKey: 'k', baseUrl: 'b' }; };
  const r = await pool.acquirePhone(db, 'd@e.com', 3, EXPIRY_MS, [], takeOrderFn);
  assert.strictEqual(called, 1);
  assert.strictEqual(r.orderNo, 'NEW2');
});

test('S5 acquirePhone: 同 email 已绑该号 → 跳过 → takeOrderFn', async () => {
  const db = freshDb();
  insertEntry(db, { orderNo: 'O5', phone: '+15555555555', taken_at_ms: Date.now() });
  db.run("INSERT INTO phone_bindings (phone, email) VALUES ('+15555555555', 'e@f.com')");
  let called = 0;
  const takeOrderFn = async () => { called++; return { orderNo: 'NEW3', phone: '+19999999997', apiKey: 'k', baseUrl: 'b' }; };
  const r = await pool.acquirePhone(db, 'e@f.com', 3, EXPIRY_MS, [], takeOrderFn);
  assert.strictEqual(called, 1);
  assert.strictEqual(r.orderNo, 'NEW3');
});

test('S6 acquirePhone: excludePhones 屏蔽 → takeOrderFn', async () => {
  const db = freshDb();
  insertEntry(db, { orderNo: 'O6', phone: '+16666666666', taken_at_ms: Date.now() });
  let called = 0;
  const takeOrderFn = async () => { called++; return { orderNo: 'NEW4', phone: '+19999999996', apiKey: 'k', baseUrl: 'b' }; };
  const r = await pool.acquirePhone(db, 'f@g.com', 3, EXPIRY_MS, ['+16666666666'], takeOrderFn);
  assert.strictEqual(called, 1);
  assert.strictEqual(r.orderNo, 'NEW4');
});

test('S7 markRejected: 状态变 rejected → 后续 acquire 跳过', async () => {
  const db = freshDb();
  insertEntry(db, { orderNo: 'O7', phone: '+17777777777', taken_at_ms: Date.now() });
  pool.markRejected(db, 'O7');
  const row = db.exec("SELECT status FROM smscloud_phone_cache WHERE order_no='O7'");
  assert.strictEqual(row[0].values[0][0], 'rejected');
  let called = 0;
  const takeOrderFn = async () => { called++; return { orderNo: 'NEW5', phone: '+19999999995', apiKey: 'k', baseUrl: 'b' }; };
  await pool.acquirePhone(db, 'g@h.com', 3, EXPIRY_MS, [], takeOrderFn);
  assert.strictEqual(called, 1);
});

test('S8 releaseBinding: 删 binding + bindings_used 减 1 (按 orderNo 精确)', async () => {
  const db = freshDb();
  insertEntry(db, { orderNo: 'O8', phone: '+18888888888', taken_at_ms: Date.now(), bindings_used: 2 });
  db.run("INSERT INTO phone_bindings (phone, email) VALUES ('+18888888888', 'h@i.com')");
  pool.releaseBinding(db, 'O8', 'h@i.com', '+18888888888');
  const row = db.exec("SELECT bindings_used FROM smscloud_phone_cache WHERE order_no='O8'");
  assert.strictEqual(row[0].values[0][0], 1);
  const bind = db.exec("SELECT * FROM phone_bindings WHERE email='h@i.com'");
  assert.strictEqual(bind.length, 0);
});

test('S9 expireOldEntries: 删过期 active 行 (rejected 行不删)', async () => {
  const db = freshDb();
  insertEntry(db, { orderNo: 'A', phone: '+1A', taken_at_ms: Date.now() });
  insertEntry(db, { orderNo: 'B', phone: '+1B', taken_at_ms: Date.now() - (EXPIRY_MS + 1000) });
  insertEntry(db, { orderNo: 'C', phone: '+1C', taken_at_ms: Date.now() - (EXPIRY_MS + 1000), status: 'rejected' });
  const r = pool.expireOldEntries(db, EXPIRY_MS);
  assert.strictEqual(r.expired, 1);
  const rows = db.exec("SELECT order_no FROM smscloud_phone_cache ORDER BY order_no");
  assert.deepStrictEqual(rows[0].values.map(v => v[0]), ['A', 'C']);
});
