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
