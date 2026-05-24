const test = require('node:test')
const assert = require('node:assert')
const initSqlJs = require('sql.js')

let SQL

test.before(async () => { SQL = await initSqlJs() })

test('M1 新装库 account_status CREATE 含 proxy_node / exit_ip 列', () => {
  const db = new SQL.Database()
  db.run(`
    CREATE TABLE IF NOT EXISTS account_status (
      email TEXT PRIMARY KEY,
      status TEXT DEFAULT 'idle',
      proxy_node TEXT DEFAULT '',
      exit_ip TEXT DEFAULT ''
    );
  `)
  const cols = db.exec("PRAGMA table_info(account_status)")
  const names = new Set(cols[0].values.map(v => v[1]))
  assert.ok(names.has('proxy_node'))
  assert.ok(names.has('exit_ip'))
})

test('M2 老库无 proxy_node 时 PRAGMA-gated ALTER 添加成功', () => {
  const db = new SQL.Database()
  db.run(`CREATE TABLE account_status (email TEXT PRIMARY KEY, status TEXT)`)
  const cols = db.exec("PRAGMA table_info(account_status)")
  const names = new Set(cols[0].values.map(v => v[1]))
  if (!names.has('proxy_node')) {
    db.run("ALTER TABLE account_status ADD COLUMN proxy_node TEXT DEFAULT ''")
  }
  if (!names.has('exit_ip')) {
    db.run("ALTER TABLE account_status ADD COLUMN exit_ip TEXT DEFAULT ''")
  }
  const cols2 = db.exec("PRAGMA table_info(account_status)")
  const names2 = new Set(cols2[0].values.map(v => v[1]))
  assert.ok(names2.has('proxy_node'))
  assert.ok(names2.has('exit_ip'))
})

test('M3 已含 proxy_node 列时跳过 ALTER（幂等不抛错）', () => {
  const db = new SQL.Database()
  db.run(`CREATE TABLE account_status (email TEXT PRIMARY KEY, proxy_node TEXT, exit_ip TEXT)`)
  const cols = db.exec("PRAGMA table_info(account_status)")
  const names = new Set(cols[0].values.map(v => v[1]))
  if (!names.has('proxy_node')) {
    db.run("ALTER TABLE account_status ADD COLUMN proxy_node TEXT DEFAULT ''")
  }
  if (!names.has('exit_ip')) {
    db.run("ALTER TABLE account_status ADD COLUMN exit_ip TEXT DEFAULT ''")
  }
  assert.ok(true)
})

// === M4-M6: actually exercise production statusDB code ===
// 上面 M1/M2/M3 只验证 sql.js schema 行为，没 require server/db.js，
// 对 statusDB.set / statusDB.setAlive 改动无回归保护。下面 3 个测试
// 走真实 production code，pin 住 proxy_node / exit_ip 合并语义。
//
// DB 隔离方式：完全复用 __tests__/db-payment-link.test.js 的 monkey-patch
// path.join 模式（server/db.js 在 require 期就 resolve DB_PATH，所以必须
// 在 require 前 patch path.join，让 path.join(__dirname, '..', 'data.db')
// 落到临时目录而非真实库）。

const fs = require('fs')
const path = require('path')
const os = require('os')

const m4TmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-status-proxy-cols-test-'))
const m4FakeDb = path.join(m4TmpDir, 'data.db')
const m4OrigJoin = path.join
path.join = function (...args) {
  if (args[args.length - 1] === 'data.db') return m4FakeDb
  return m4OrigJoin.apply(this, args)
}
const { initDB, statusDB } = require('../server/db')
path.join = m4OrigJoin  // restore for other modules

test('M4 setup + statusDB.set 写入 proxyNode / exitIp 后 get 读回', async () => {
  await initDB()
  statusDB.set('m4@x.com', { status: 'running', proxyNode: 'us-LA-1', exitIp: '1.2.3.4' })
  const row = statusDB.get('m4@x.com')
  assert.strictEqual(row.proxy_node, 'us-LA-1')
  assert.strictEqual(row.exit_ip, '1.2.3.4')
})

test('M5 关键不变式：set 不传 proxyNode/exitIp 时既有值不被清空', () => {
  statusDB.set('m5@x.com', { status: 'running', proxyNode: 'us-NY-2', exitIp: '5.6.7.8' })
  // 后续 emitStatus 只更新 status / reason，没传 proxyNode/exitIp
  statusDB.set('m5@x.com', { status: 'error', reason: 'something' })
  const row = statusDB.get('m5@x.com')
  assert.strictEqual(row.proxy_node, 'us-NY-2', 'set 缺 proxyNode 时不应清空已有 proxy_node')
  assert.strictEqual(row.exit_ip, '5.6.7.8', 'set 缺 exitIp 时不应清空已有 exit_ip')
  assert.strictEqual(row.status, 'error')
  assert.strictEqual(row.reason, 'something')
})

test('M6 关键不变式：setAlive 不清空 proxy_node / exit_ip（pin setAlive INSERT OR REPLACE 修复）', () => {
  // 先用 set 写入代理上下文
  statusDB.set('m6@x.com', { status: 'plus', proxyNode: 'us-LA-3', exitIp: '9.8.7.6' })
  // 然后 liveness 跑测活，调 setAlive — setAlive INSERT OR REPLACE 整行重写，
  // 如果列表里没有 proxy_node / exit_ip 字段，SQLite 会用 DEFAULT '' 替换
  statusDB.setAlive('m6@x.com', { alive_status: 'plus', alive_reason: 'ok' })
  const row = statusDB.get('m6@x.com')
  assert.strictEqual(row.proxy_node, 'us-LA-3', 'setAlive 不应清空 proxy_node')
  assert.strictEqual(row.exit_ip, '9.8.7.6', 'setAlive 不应清空 exit_ip')
  // 同时验证 alive_status 确实写入
  assert.strictEqual(row.alive_status, 'plus')
  assert.strictEqual(row.alive_reason, 'ok')
})
