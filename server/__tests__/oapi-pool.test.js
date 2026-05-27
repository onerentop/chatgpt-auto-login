const test = require('node:test');
const assert = require('node:assert');
const initSqlJs = require('sql.js');

let SQL;
let pool;

test.before(async () => {
  SQL = await initSqlJs();
  pool = require('../oapi-pool');
});

function freshDb() {
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE oapi_cdk_pool (
      cdk           TEXT PRIMARY KEY,
      phone         TEXT,
      base_url      TEXT NOT NULL,
      taken_at_ms   INTEGER,
      bindings_used INTEGER NOT NULL DEFAULT 0,
      remaining     INTEGER,
      status        TEXT NOT NULL DEFAULT 'available',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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

function insertCdk(db, { cdk, phone = null, base_url = 'https://sms.oapi.vip/api.php', bindings_used = 0, remaining = null, status = 'available' }) {
  db.run(
    `INSERT INTO oapi_cdk_pool (cdk, phone, base_url, taken_at_ms, bindings_used, remaining, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [cdk, phone, base_url, phone ? Date.now() : null, bindings_used, remaining, status]
  );
}

const BASE_URL = 'https://sms.oapi.vip/api.php';

test('P1 importCdks: 多行合法 / 跳过非法 / 重复', () => {
  const db = freshDb();
  const text = "SMS-AAAA-BBBB-CCCC\n\ninvalid-cdk\nSMS-DDDD-EEEE-FFFF\nSMS-AAAA-BBBB-CCCC";
  const r = pool.importCdks(db, text, BASE_URL);
  assert.strictEqual(r.added, 2);
  assert.strictEqual(r.skipped, 3);
  const rows = db.exec("SELECT cdk FROM oapi_cdk_pool ORDER BY cdk");
  assert.deepStrictEqual(rows[0].values.map(v => v[0]), ['SMS-AAAA-BBBB-CCCC', 'SMS-DDDD-EEEE-FFFF']);
});

test('P2 acquireCdk: 首次 phone=NULL → 调 takeOrderFn + UPDATE phone', async () => {
  const db = freshDb();
  insertCdk(db, { cdk: 'SMS-X' });
  let called = 0;
  const takeOrderFn = async (cdk, baseUrl) => {
    called++;
    assert.strictEqual(cdk, 'SMS-X');
    return { phone: '+18001234567', remaining: 3 };
  };
  const r = await pool.acquireCdk(db, 'a@b', 3, BASE_URL, takeOrderFn);
  assert.strictEqual(called, 1);
  assert.strictEqual(r.reused, false);
  assert.strictEqual(r.phone, '+18001234567');
  const row = db.exec("SELECT phone, remaining, bindings_used FROM oapi_cdk_pool WHERE cdk='SMS-X'");
  assert.strictEqual(row[0].values[0][0], '+18001234567');
  assert.strictEqual(row[0].values[0][1], 3);
  assert.strictEqual(row[0].values[0][2], 1);
  const bind = db.exec("SELECT * FROM phone_bindings WHERE email='a@b'");
  assert.strictEqual(bind[0].values.length, 1);
});

test('P3 acquireCdk: cache hit (phone!=NULL, bindings_used<max) 不调 takeOrderFn', async () => {
  const db = freshDb();
  insertCdk(db, { cdk: 'SMS-Y', phone: '+19001234567', bindings_used: 1, remaining: 2 });
  let called = 0;
  const takeOrderFn = async () => { called++; throw new Error('should not be called'); };
  const r = await pool.acquireCdk(db, 'b@c', 3, BASE_URL, takeOrderFn);
  assert.strictEqual(called, 0);
  assert.strictEqual(r.reused, true);
  assert.strictEqual(r.phone, '+19001234567');
  const row = db.exec("SELECT bindings_used FROM oapi_cdk_pool WHERE cdk='SMS-Y'");
  assert.strictEqual(row[0].values[0][0], 2);
});

test('P4 acquireCdk: 全 rejected → null', async () => {
  const db = freshDb();
  insertCdk(db, { cdk: 'SMS-Z', phone: '+1Z', status: 'rejected' });
  const r = await pool.acquireCdk(db, 'c@d', 3, BASE_URL, async () => { throw new Error('na'); });
  assert.strictEqual(r, null);
});

test('P5 acquireCdk: 同 email 已绑该号 → null', async () => {
  const db = freshDb();
  insertCdk(db, { cdk: 'SMS-W', phone: '+1W', bindings_used: 1 });
  db.run("INSERT INTO phone_bindings (phone, email) VALUES ('+1W', 'd@e')");
  const r = await pool.acquireCdk(db, 'd@e', 3, BASE_URL, async () => { throw new Error('na'); });
  assert.strictEqual(r, null);
});

test('P6 acquireCdk: remaining=0 跳过', async () => {
  const db = freshDb();
  insertCdk(db, { cdk: 'SMS-R0', phone: '+1R0', remaining: 0 });
  const r = await pool.acquireCdk(db, 'e@f', 3, BASE_URL, async () => { throw new Error('na'); });
  assert.strictEqual(r, null);
});

test('P7 markRejected + releaseBinding', () => {
  const db = freshDb();
  insertCdk(db, { cdk: 'SMS-K', phone: '+1K', bindings_used: 2 });
  db.run("INSERT INTO phone_bindings (phone, email) VALUES ('+1K', 'f@g')");
  pool.markRejected(db, 'SMS-K');
  const s = db.exec("SELECT status FROM oapi_cdk_pool WHERE cdk='SMS-K'");
  assert.strictEqual(s[0].values[0][0], 'rejected');
  pool.releaseBinding(db, 'SMS-K', 'f@g', '+1K');
  const b = db.exec("SELECT bindings_used FROM oapi_cdk_pool WHERE cdk='SMS-K'");
  assert.strictEqual(b[0].values[0][0], 1);
  const bd = db.exec("SELECT * FROM phone_bindings WHERE email='f@g'");
  assert.strictEqual(bd.length, 0);
});

test('P8 listCdks + deleteCdk', () => {
  const db = freshDb();
  insertCdk(db, { cdk: 'SMS-L', phone: '+1L', bindings_used: 1, remaining: 5 });
  db.run("INSERT INTO phone_bindings (phone, email) VALUES ('+1L', 'g@h')");
  const list1 = pool.listCdks(db);
  assert.strictEqual(list1.length, 1);
  assert.deepStrictEqual(list1[0].boundEmails, ['g@h']);
  pool.deleteCdk(db, 'SMS-L');
  const list2 = pool.listCdks(db);
  assert.strictEqual(list2.length, 0);
  const bd = db.exec("SELECT * FROM phone_bindings WHERE phone='+1L'");
  assert.strictEqual(bd.length, 0, 'cascade phone_bindings');
});

test('P9 diagnose: 空池 / 全 rejected / 全已满 区分输出', () => {
  // case 1: 空池
  let db = freshDb();
  assert.match(pool.diagnose(db), /CDK 池为空/);
  // case 2: 全 rejected
  db = freshDb();
  insertCdk(db, { cdk: 'SMS-R1', phone: '+1R', status: 'rejected' });
  insertCdk(db, { cdk: 'SMS-R2', phone: '+1R2', status: 'rejected' });
  assert.match(pool.diagnose(db), /CDK 全部 rejected.*共 2 个/);
  // case 3: 有 available 但 bindings 已满
  db = freshDb();
  insertCdk(db, { cdk: 'SMS-F', phone: '+1F', bindings_used: 99, status: 'available' });
  assert.match(pool.diagnose(db), /CDK 共 1 个.*1 个 available/);
});
