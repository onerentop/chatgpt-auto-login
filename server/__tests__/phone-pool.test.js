const test = require('node:test')
const assert = require('node:assert')
const initSqlJs = require('sql.js')

let SQL
let phonePool

test.before(async () => {
  SQL = await initSqlJs()
  phonePool = require('../phone-pool')
})

function freshDb() {
  const db = new SQL.Database()
  db.run(`
    CREATE TABLE phone_pool (
      phone TEXT PRIMARY KEY,
      sms_api_url TEXT NOT NULL,
      bindings_used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE phone_bindings (
      phone TEXT NOT NULL,
      email TEXT NOT NULL,
      bound_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (phone, email)
    );
  `)
  return db
}

test('P1 importPhones basic — 3 条合法行', () => {
  const db = freshDb()
  const text = '+14642840651|http://a.com/sms?k=1\n+15001234567|http://b.com/sms?k=2\n+15009998888|http://c.com/sms?k=3'
  const r = phonePool.importPhones(db, text)
  assert.strictEqual(r.added, 3)
  assert.strictEqual(r.skipped, 0)
  const list = phonePool.listPhones(db)
  assert.strictEqual(list.length, 3)
})

test('P2 importPhones 跳过非法 / 空行 / 无 | / 非 E.164 / 重复', () => {
  const db = freshDb()
  const text = [
    '+14642840651|http://a.com/sms?k=1',
    '',
    '+1500|http://x.com',
    'no-pipe-here-12345',
    '+15001234567|',
    '+14642840651|http://dup.com/sms',
    '+1234567890123|http://ok.com/sms',
  ].join('\n')
  const r = phonePool.importPhones(db, text)
  assert.strictEqual(r.added, 2, '只有 2 条合法且非重复')
  assert.strictEqual(r.skipped, 5)
})

test('P3 listPhones 含 boundEmails', () => {
  const db = freshDb()
  db.run("INSERT INTO phone_pool (phone, sms_api_url) VALUES ('+14642840651', 'http://a.com')")
  db.run("INSERT INTO phone_bindings (phone, email) VALUES ('+14642840651', 'a@x.com')")
  db.run("INSERT INTO phone_bindings (phone, email) VALUES ('+14642840651', 'b@x.com')")
  const list = phonePool.listPhones(db)
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].boundEmails.length, 2)
  assert.ok(list[0].boundEmails.includes('a@x.com'))
  assert.ok(list[0].boundEmails.includes('b@x.com'))
})

test('P4 acquirePhone 满绑定跳过', () => {
  const db = freshDb()
  db.run("INSERT INTO phone_pool (phone, sms_api_url, bindings_used) VALUES ('+14642840651', 'http://A.com', 5)")
  db.run("INSERT INTO phone_pool (phone, sms_api_url, bindings_used) VALUES ('+15001234567', 'http://B.com', 0)")
  const r = phonePool.acquirePhone(db, 'foo@x.com', 5)
  assert.ok(r, '应拿到 phone')
  assert.strictEqual(r.phone, '+15001234567', '满号 A 跳过，拿 B')
  assert.strictEqual(r.smsApiUrl, 'http://B.com')
})

test('P5 acquirePhone 同 email 不重绑同 phone', () => {
  const db = freshDb()
  db.run("INSERT INTO phone_pool (phone, sms_api_url, bindings_used) VALUES ('+14642840651', 'http://A.com', 0)")
  db.run("INSERT INTO phone_pool (phone, sms_api_url, bindings_used) VALUES ('+15001234567', 'http://B.com', 0)")
  const r1 = phonePool.acquirePhone(db, 'foo@x.com', 5)
  const r2 = phonePool.acquirePhone(db, 'foo@x.com', 5)
  assert.strictEqual(r1.phone, '+14642840651')
  assert.strictEqual(r2.phone, '+15001234567', '同 email 第二次拿到不同 phone')
  const r3 = phonePool.acquirePhone(db, 'foo@x.com', 5)
  assert.strictEqual(r3, null, '同 email 全部 phone 用尽 → null')
})

test('P6 deletePhone cascade bindings', () => {
  const db = freshDb()
  db.run("INSERT INTO phone_pool (phone, sms_api_url) VALUES ('+14642840651', 'http://A.com')")
  db.run("INSERT INTO phone_pool (phone, sms_api_url) VALUES ('+15001234567', 'http://B.com')")
  db.run("INSERT INTO phone_bindings (phone, email) VALUES ('+14642840651', 'a@x.com')")
  db.run("INSERT INTO phone_bindings (phone, email) VALUES ('+14642840651', 'b@x.com')")
  db.run("INSERT INTO phone_bindings (phone, email) VALUES ('+15001234567', 'c@x.com')")
  phonePool.deletePhone(db, '+14642840651')
  const list = phonePool.listPhones(db)
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].phone, '+15001234567')
  const bindingsLeft = db.exec("SELECT phone, email FROM phone_bindings")[0]?.values || []
  assert.strictEqual(bindingsLeft.length, 1)
  assert.strictEqual(bindingsLeft[0][0], '+15001234567')
})
