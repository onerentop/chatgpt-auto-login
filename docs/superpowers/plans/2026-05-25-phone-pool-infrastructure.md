# v2.37.0 手机号号池基础设施 (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付号池基础设施（DB + 后端 service + 路由 + 前端页面 + Config 配置），不动 PKCE 流程。

**Architecture:** `server/db.js` 加 `phone_pool` + `phone_bindings` 两张表。`server/phone-pool.js` 新建 service（注入 db）。`server/routes/phone-pool.js` 4 个 endpoints。`web/src/views/PhonePool.vue` 新页 + router + nav 入口。`config.example.json` 加 `phonePool` 配置块。

**Tech Stack:** sql.js (WASM SQLite)、Express、Vue 3 + Element Plus、node:test。

**Spec:** `docs/superpowers/specs/2026-05-25-phone-pool-infrastructure-design.md`

---

## File Structure

| 文件 | 改动 | 类型 |
|---|---|---|
| `server/db.js` | ensureSchema 加 2 个 `CREATE TABLE IF NOT EXISTS` | 修改 |
| `server/phone-pool.js` | service: list/import/export/delete/acquirePhone/fetchSmsCode | 新建 |
| `server/__tests__/phone-pool.test.js` | +6 单测 | 新建 |
| `server/routes/phone-pool.js` | 4 endpoints | 新建 |
| `server/index.js` | 挂载 `/api/phone-pool` 路由 | 修改 (1 行) |
| `config.example.json` | +`phonePool` 块 | 修改 |
| `web/src/views/Config.vue` | +4 input for phonePool | 修改 |
| `web/src/views/PhonePool.vue` | 新页（PageHeader + 表格 + import dialog） | 新建 |
| `web/src/router.js` | +1 route | 修改 |
| `web/src/components/AppLayout.vue` | +1 nav 项「号池」 | 修改 |
| `docs/CHANGELOG.md` | v2.37.0 节 | 修改 |

依赖：Task 1（DB）→ Task 2（service + tests）→ Task 3（routes + config 后端） → Task 4（前端页面 + 配置 UI） → Task 5（CHANGELOG）。线性顺序。

---

## Task 1: DB schema — `phone_pool` + `phone_bindings` 两张新表

**Files:**
- Modify: `server/db.js:65-73` (ensureSchema 内部 CREATE TABLE 块尾部)

### Step 1: 修改 db.js 加表

打开 `server/db.js`. 找到 ensureSchema 内的 CREATE TABLE 块（约 line 65-72，含 `liveness_logs` 等）：

```js
    CREATE TABLE IF NOT EXISTS liveness_logs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      email     TEXT DEFAULT '',
      level     TEXT DEFAULT 'info',
      message   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_liveness_logs_id_desc ON liveness_logs(id DESC);
  `);
```

在 `CREATE INDEX IF NOT EXISTS idx_liveness_logs_id_desc ...` 之后、`);` 之前插入两张表的 CREATE：

```js
    CREATE TABLE IF NOT EXISTS liveness_logs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      email     TEXT DEFAULT '',
      level     TEXT DEFAULT 'info',
      message   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_liveness_logs_id_desc ON liveness_logs(id DESC);

    -- v2.37.0 phone pool
    CREATE TABLE IF NOT EXISTS phone_pool (
      phone          TEXT PRIMARY KEY,
      sms_api_url    TEXT NOT NULL,
      bindings_used  INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS phone_bindings (
      phone    TEXT NOT NULL,
      email    TEXT NOT NULL,
      bound_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (phone, email)
    );
    CREATE INDEX IF NOT EXISTS idx_phone_bindings_phone ON phone_bindings(phone);
    CREATE INDEX IF NOT EXISTS idx_phone_bindings_email ON phone_bindings(email);
  `);
```

注意：sql.js 不强制 FOREIGN KEY；不写 FK 关键字，避免运行时风险。删除 phone 时由 service 层手动 cascade。

### Step 2: 暴露 raw db handle

打开同文件，找到 `module.exports = { initDB, accountsDB, statusDB, logsDB, livenessLogsDB, save };`（约 line 371）。

替换为（追加导出 `getRawDb()` 让 phone-pool service 使用）：

```js
module.exports = { initDB, accountsDB, statusDB, logsDB, livenessLogsDB, save, getRawDb: () => db };
```

注意 db 变量是模块顶层 let。getRawDb 是 lazy getter（initDB 还没跑时是 null，但 phone-pool service 会在 server 启动后才调）。

### Step 3: Syntax check

```
node --check server/db.js
```

Expected: no output.

### Step 4: 跑全套件回归

```
npm test
```

Expected: 既有全过（"fail 0"）。新表对老路径无影响。

### Step 5: Commit

```bash
git add server/db.js
git commit -m "$(cat <<'EOF'
feat(db): phone_pool + phone_bindings 两张新表 (v2.37.0 Phase 1)

phone_pool 字段：phone (PK) / sms_api_url / bindings_used (monotonic
计数器) / created_at。
phone_bindings：phone + email 复合主键，记录哪个号绑了哪个账户。
两个 index 加速 binding 按 phone / email 反查。

不强制 FK（sql.js 限制），删除 phone 由 service 层手动 cascade。

getRawDb() helper 暴露给 server/phone-pool.js service 用。
EOF
)"
```

---

## Task 2: `server/phone-pool.js` service + 6 单测

**Files:**
- Create: `server/phone-pool.js`
- Create: `server/__tests__/phone-pool.test.js`

### Step 1: 写 6 个失败测试

新建 `server/__tests__/phone-pool.test.js`:

```js
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
    '+14642840651|http://a.com/sms?k=1',  // OK
    '',  // 空行
    '+1500|http://x.com',  // E.164 太短
    'no-pipe-here-12345',  // 无 |
    '+15001234567|',  // url 空
    '+14642840651|http://dup.com/sms',  // 重复 phone
    '+1234567890123|http://ok.com/sms',  // 13 digits OK
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
  // 第三次：两个 phone 都被 foo 用过 → null
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
  // bindings 表里 A 行的 bindings 也删了，B 行的 binding 保留
  const bindingsLeft = db.exec("SELECT phone, email FROM phone_bindings")[0]?.values || []
  assert.strictEqual(bindingsLeft.length, 1)
  assert.strictEqual(bindingsLeft[0][0], '+15001234567')
})
```

### Step 2: 跑测试验证 FAIL

```
node --test server/__tests__/phone-pool.test.js
```

Expected: 6 tests FAIL（`phonePool` module 不存在）。

### Step 3: 实现 `server/phone-pool.js`

新建 `server/phone-pool.js`:

```js
// v2.37.0 — Phone pool service for OAuth PKCE phone verification.
// Phase 1: 不消费 pool，只交付 CRUD + acquire API + SMS poll helper。
// Phase 2 PKCE 集成时调用 acquirePhone() + fetchSmsCode()。

const E164_RE = /^\+\d{10,15}$/

/**
 * 行 -> {phone, sms_api_url, bindings_used, created_at, boundEmails}
 * @param {Object} db sql.js Database
 */
function listPhones(db) {
  const r = db.exec('SELECT phone, sms_api_url, bindings_used, created_at FROM phone_pool ORDER BY created_at DESC')
  if (!r.length) return []
  const rows = r[0].values.map(v => ({
    phone: v[0],
    smsApiUrl: v[1],
    bindings_used: v[2],
    created_at: v[3],
    boundEmails: [],
  }))
  // batch-fetch bindings
  const bindingsR = db.exec('SELECT phone, email FROM phone_bindings')
  if (bindingsR.length) {
    const byPhone = new Map()
    for (const [phone, email] of bindingsR[0].values) {
      if (!byPhone.has(phone)) byPhone.set(phone, [])
      byPhone.get(phone).push(email)
    }
    for (const row of rows) {
      row.boundEmails = byPhone.get(row.phone) || []
    }
  }
  return rows
}

/**
 * 解析 `phone|url\n...` 文本，逐行 INSERT，跳过非法 / 重复。
 * 返回 { added, skipped }。
 */
function importPhones(db, text) {
  const lines = String(text || '').split(/[\r\n]+/).map(l => l.trim()).filter(Boolean)
  let added = 0, skipped = 0
  const stmt = db.prepare('INSERT OR IGNORE INTO phone_pool (phone, sms_api_url) VALUES (?, ?)')
  try {
    for (const line of lines) {
      const idx = line.indexOf('|')
      if (idx < 0) { skipped++; continue }
      const phone = line.slice(0, idx).trim()
      const url = line.slice(idx + 1).trim()
      if (!phone || !url) { skipped++; continue }
      if (!E164_RE.test(phone)) { skipped++; continue }
      stmt.run([phone, url])
      // sql.js INSERT OR IGNORE 不返回 changes 直接；用 db.getRowsModified() 间接判断
      const changed = db.getRowsModified()
      if (changed > 0) added++
      else skipped++
    }
  } finally {
    stmt.free()
  }
  return { added, skipped }
}

/**
 * 导出与导入相同格式：`phone|url` 每行一条。
 */
function exportPhones(db) {
  const r = db.exec('SELECT phone, sms_api_url FROM phone_pool ORDER BY created_at ASC')
  if (!r.length) return ''
  return r[0].values.map(([phone, url]) => `${phone}|${url}`).join('\n')
}

/**
 * 删除 phone + cascade 所有 bindings。bindings_used 计数不动（监管），
 * 但因为 phone 行也没了，下次 list 看不到任何数据。
 */
function deletePhone(db, phone) {
  db.run('DELETE FROM phone_bindings WHERE phone = ?', [phone])
  db.run('DELETE FROM phone_pool WHERE phone = ?', [phone])
}

/**
 * 拿一个未满绑定 + 未与本 email 绑过 的 phone。
 * 排序优先级：bindings_used ASC（轮转使用避免某号被打），同分按 created_at ASC（FIFO）。
 * 找到 → 写 binding + 自增 bindings_used → 返回 { phone, smsApiUrl }
 * 没找到 → 返回 null
 */
function acquirePhone(db, email, maxBindingsPerPhone) {
  const r = db.exec(`
    SELECT phone, sms_api_url
    FROM phone_pool
    WHERE bindings_used < ?
      AND phone NOT IN (SELECT phone FROM phone_bindings WHERE email = ?)
    ORDER BY bindings_used ASC, created_at ASC
    LIMIT 1
  `, [maxBindingsPerPhone, email])
  if (!r.length || !r[0].values.length) return null
  const [phone, smsApiUrl] = r[0].values[0]
  db.run('INSERT INTO phone_bindings (phone, email) VALUES (?, ?)', [phone, email])
  db.run('UPDATE phone_pool SET bindings_used = bindings_used + 1 WHERE phone = ?', [phone])
  return { phone, smsApiUrl }
}

/**
 * 轮询 smsApiUrl，regex /\b(\d{6})\b/ 提取 6 位数字。
 * - signal 支持 AbortController（用于"停止"按钮）
 * - 跟 payment.js:586 现有 PayPal 路径 regex 一致，复用 Phase 2
 */
async function fetchSmsCode(smsApiUrl, { pollIntervalMs = 3000, maxAttempts = 30, signal } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) throw new Error('aborted')
    try {
      const resp = await fetch(smsApiUrl, { signal })
      const text = await resp.text()
      const m = text.match(/\b(\d{6})\b/)
      if (m) return m[1]
    } catch (e) {
      if (e?.name === 'AbortError') throw e
      // 网络错误 → 继续轮询
    }
    if (i < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, pollIntervalMs))
    }
  }
  throw new Error('sms-poll-timeout')
}

module.exports = { listPhones, importPhones, exportPhones, deletePhone, acquirePhone, fetchSmsCode }
```

### Step 4: 跑测试验证 PASS

```
node --test server/__tests__/phone-pool.test.js
```

Expected: 6 pass.

常见失败：
- P2 added !== 2: 检查 `db.getRowsModified()` 在 INSERT OR IGNORE 重复时返回 0；如果环境不支持，改用 SELECT 检查 phone 是否已存在
- P5 r2.phone === r1.phone: WHERE 子句 `phone NOT IN (...)` 没生效；检查 SQL string + params 占位符顺序
- P6 listPhones.length !== 1: deletePhone 顺序写反（必须先删 bindings 再删 phone_pool 防止 FK 失败 —— 即便无 FK 也保持习惯）

### Step 5: 全套件回归

```
npm test
```

Expected: 既有 baseline + 6 新测，"fail 0"。

### Step 6: Commit

```bash
git add server/phone-pool.js server/__tests__/phone-pool.test.js
git commit -m "$(cat <<'EOF'
feat(phone-pool): service + 6 单测 (v2.37.0 Phase 1)

server/phone-pool.js 提供号池操作 6 个函数：
- listPhones(db) — 列表 with boundEmails 子查询
- importPhones(db, text) — parse 'phone|url\\n...'，E.164 校验，
  INSERT OR IGNORE 跳重复，返回 {added, skipped}
- exportPhones(db) — 反向 dump
- deletePhone(db, phone) — cascade bindings 表
- acquirePhone(db, email, max) — 原子取号 + 写 binding +
  自增 bindings_used。排序 bindings_used ASC + created_at ASC。
  WHERE 排除满号 + 已与该 email 绑过的号。null = 池子用尽。
- fetchSmsCode(url, opts) — 轮询 + regex /\\b(\\d{6})\\b/，
  与 payment.js:586 现有 PayPal 路径一致。Phase 2 复用。

6 单测：import 基本 / import 跳非法 / list 含 boundEmails /
acquire 跳满号 / acquire 同 email 不重绑 / delete cascade。
EOF
)"
```

---

## Task 3: API routes + config 后端 + server/index.js 挂载

**Files:**
- Create: `server/routes/phone-pool.js`
- Modify: `server/index.js` (挂载 1 行)
- Modify: `config.example.json` (+phonePool 块)

### Step 1: 新建 `server/routes/phone-pool.js`

```js
const express = require('express')
const fs = require('fs')
const path = require('path')
const router = express.Router()
const phonePool = require('../phone-pool')
const { getRawDb, save } = require('../db')

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json')

function readMaxBindings() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    const cfg = JSON.parse(raw)
    return Number(cfg?.phonePool?.maxBindingsPerPhone) || 5
  } catch { return 5 }
}

router.get('/', (req, res) => {
  try {
    const db = getRawDb()
    const list = phonePool.listPhones(db)
    res.json({ items: list, maxBindingsPerPhone: readMaxBindings() })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/import', (req, res) => {
  const text = String(req.body?.text || '')
  if (!text) return res.status(400).json({ error: 'text required' })
  try {
    const db = getRawDb()
    const r = phonePool.importPhones(db, text)
    save()
    res.json({ ok: true, ...r })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/export', (req, res) => {
  try {
    const db = getRawDb()
    const text = phonePool.exportPhones(db)
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="phone-pool-${Date.now()}.txt"`)
    res.send(text)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.delete('/:phone', (req, res) => {
  const phone = req.params.phone
  if (!phone) return res.status(400).json({ error: 'phone required' })
  try {
    const db = getRawDb()
    phonePool.deletePhone(db, phone)
    save()
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

module.exports = router
```

### Step 2: 挂载到 `server/index.js`

打开 `server/index.js`. 找到 line 87-88 区域（既有路由 mount）：

```js
  app.use('/api/liveness', livenessRoutes(livenessRunner, accountsDB, livenessLogsDB));
  app.use('/api/health', require('./routes/health'));
```

在 `/api/health` 之后追加：

```js
  app.use('/api/liveness', livenessRoutes(livenessRunner, accountsDB, livenessLogsDB));
  app.use('/api/health', require('./routes/health'));
  app.use('/api/phone-pool', require('./routes/phone-pool'));
```

### Step 3: `config.example.json` 加 `phonePool` 块

打开 `config.example.json`. 找到顶层 JSON。在合适位置（紧贴 `phone` / `smsApiUrl` 字段附近，或文件末尾紧贴最后一个字段前）追加：

```json
  "phonePool": {
    "enabled": false,
    "maxBindingsPerPhone": 5,
    "smsPollIntervalMs": 3000,
    "smsMaxAttempts": 30
  },
```

注意：JSON 不支持注释；保留尾部逗号正确（取决于位置）。**实施时打开文件确认正确插入位置和逗号**。

### Step 4: Syntax check

```
node --check server/routes/phone-pool.js
node --check server/index.js
```

Expected: no output.

### Step 5: 启动 server 烟测 (本地实测，非自动化)

启 server，POST `/api/phone-pool/import`：

```
curl -X POST http://localhost:3000/api/phone-pool/import -H 'Content-Type: application/json' -d '{"text":"+14642840651|http://a.com/sms?k=1"}'
```

Expected: `{"ok":true,"added":1,"skipped":0}`

GET `/api/phone-pool`：

```
curl http://localhost:3000/api/phone-pool
```

Expected: `{"items":[{"phone":"+14642840651",...,"boundEmails":[]}],"maxBindingsPerPhone":5}`

**注意**：这步可选；如果 server 在并行 session 控制下不便启停，跳过 — 单测已覆盖核心逻辑。

### Step 6: 全套件回归

```
npm test
```

Expected: same baseline (跟 Task 2 末尾相同) "fail 0"。

### Step 7: Commit

```bash
git add server/routes/phone-pool.js server/index.js config.example.json
git commit -m "$(cat <<'EOF'
feat(phone-pool): /api/phone-pool 路由 + config.example.json 块 (v2.37.0 Phase 1)

4 endpoints：
- GET / — list with maxBindingsPerPhone 配置带回
- POST /import — body {text} 批量导入，返回 {added, skipped}
- GET /export — 文本下载 (与 import 同格式)
- DELETE /:phone — 删除 cascade

mount 到 server/index.js 与既有路由同位置。config.example.json
加 phonePool 块（enabled: false 默认 + 三个限值），用户填实际值前
仅 UI 可管理号池。

不动 routes/config.js 既有逻辑（phonePool 字段不在 SENSITIVE_FIELDS，
sms_api_url 仍在原列表里 mask 保留）。
EOF
)"
```

---

## Task 4: 前端 PhonePool.vue + router + AppLayout + Config.vue 配置

**Files:**
- Create: `web/src/views/PhonePool.vue`
- Modify: `web/src/router.js` (+1 route)
- Modify: `web/src/components/AppLayout.vue` (+1 nav)
- Modify: `web/src/views/Config.vue` (+4 input for phonePool)

### Step 1: 新建 `web/src/views/PhonePool.vue`

```vue
<template>
  <div>
    <PageHeader title="号池" :subtitle="`共 ${items.length} 个号 / 已用 ${totalBindings} 个绑定`">
      <template #actions>
        <el-button @click="showImport = true">批量导入</el-button>
        <el-button @click="exportAll">导出</el-button>
        <el-button @click="$router.push('/config')">号池配置</el-button>
      </template>
    </PageHeader>
    <SectionCard>
      <el-table :data="items" stripe border size="small" style="width:100%">
        <el-table-column type="expand">
          <template #default="{ row }">
            <div style="padding:8px 16px;color:#606266">
              已绑定账户 ({{ row.boundEmails.length }}):
              <el-tag v-for="e in row.boundEmails" :key="e" size="small" style="margin:2px">{{ e }}</el-tag>
              <span v-if="row.boundEmails.length === 0" style="color:#909399">（无）</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="phone" label="手机号" width="160" />
        <el-table-column label="SMS URL" min-width="280">
          <template #default="{ row }">
            <el-tooltip :content="row.smsApiUrl" placement="top">
              <span style="font-family:monospace">{{ row.smsApiUrl.slice(0, 50) }}{{ row.smsApiUrl.length > 50 ? '...' : '' }}</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="绑定数" width="100">
          <template #default="{ row }">
            <el-tag :type="row.bindings_used >= maxBindingsPerPhone ? 'danger' : 'success'" size="small">
              {{ row.bindings_used }} / {{ maxBindingsPerPhone }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="创建时间" width="160">
          <template #default="{ row }">
            <span style="color:#909399">{{ row.created_at }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100">
          <template #default="{ row }">
            <el-popconfirm :title="`删除 ${row.phone}？已有 ${row.boundEmails.length} 个绑定会一并删除。`" @confirm="del(row.phone)">
              <template #reference><el-button size="small" text type="danger">删除</el-button></template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
    </SectionCard>

    <el-dialog v-model="showImport" title="批量导入手机号" width="600px">
      <el-input
        v-model="importText"
        type="textarea"
        :rows="12"
        placeholder="每行一条，格式：&#10;+14642840651|http://a.62-us.com/api/get_sms?key=...&#10;+15001234567|http://b.cd.com/sms?key=..."
      />
      <div style="margin-top:8px;color:#909399;font-size:12px">
        手机号必须 E.164 格式（+ 开头 10-15 位数字）。重复、非法、空 URL 会跳过。
      </div>
      <template #footer>
        <el-button @click="showImport = false">取消</el-button>
        <el-button type="primary" @click="doImport" :loading="importing">导入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
import PageHeader from '../components/ui/PageHeader.vue'
import SectionCard from '../components/ui/SectionCard.vue'

const items = ref([])
const maxBindingsPerPhone = ref(5)
const showImport = ref(false)
const importText = ref('')
const importing = ref(false)

const totalBindings = computed(() => items.value.reduce((s, r) => s + r.bindings_used, 0))

async function load() {
  try {
    const { data } = await api.get('/phone-pool')
    items.value = data.items || []
    maxBindingsPerPhone.value = data.maxBindingsPerPhone || 5
  } catch (e) { ElMessage.error(e?.response?.data?.error || '加载失败') }
}

async function doImport() {
  if (!importText.value.trim()) return ElMessage.warning('请粘贴号池数据')
  importing.value = true
  try {
    const { data } = await api.post('/phone-pool/import', { text: importText.value })
    ElMessage.success(`导入完成：新增 ${data.added}，跳过 ${data.skipped}`)
    showImport.value = false
    importText.value = ''
    await load()
  } catch (e) { ElMessage.error(e?.response?.data?.error || '导入失败') }
  finally { importing.value = false }
}

function exportAll() {
  window.open('/api/phone-pool/export')
}

async function del(phone) {
  try {
    await api.delete(`/phone-pool/${encodeURIComponent(phone)}`)
    ElMessage.success('已删除')
    await load()
  } catch (e) { ElMessage.error(e?.response?.data?.error || '删除失败') }
}

onMounted(load)
</script>
```

**注意**：`PageHeader` 和 `SectionCard` 是 v2.34 design tokens 引入的通用组件（在 `web/src/components/ui/`），并行 session 已落地。**实施时打开 `web/src/components/ui/` 确认路径**；如果路径不同，按实际改。

### Step 2: `web/src/router.js` 加 route

打开 `web/src/router.js`. 找到 routes 数组（约 line 3-37）。在 `Config` 路由之前插入：

```js
  {
    path: '/phone-pool',
    name: 'PhonePool',
    component: () => import('./views/PhonePool.vue'),
    meta: { title: '号池' },
  },
```

完整 routes 顺序参考：Dashboard / Accounts / Execute / Results / **PhonePool（新增）** / Config。

### Step 3: `web/src/components/AppLayout.vue` 加 nav

打开 `web/src/components/AppLayout.vue`. 找到 line 50 `<el-menu-item index="/config">`. 在它**之前**插入：

```vue
          <el-menu-item index="/phone-pool">
            <el-icon><Iphone /></el-icon><span>号池</span>
          </el-menu-item>
```

需要 import `Iphone` icon。打开同文件的 `<script setup>` 块，找到既有 element-plus icons 的 import（grep `import .* from '@element-plus/icons-vue'`）：

```js
import { Monitor, User, VideoPlay, Document, Setting } from '@element-plus/icons-vue'
```

替换为：

```js
import { Monitor, User, VideoPlay, Document, Setting, Iphone } from '@element-plus/icons-vue'
```

**注意**：如果项目 element-plus icons 版本不含 `Iphone`，用 `Phone` 或 `Cellphone` 替代。**实施时如果 import 失败，grep `Iphone` / `Phone` / `Cellphone` 在 node_modules/@element-plus/icons-vue/ 选一个**。

### Step 4: `web/src/views/Config.vue` 加 phonePool 4 个 input

打开 `web/src/views/Config.vue`. 找到现有的 phone / smsApiUrl 字段附近（line 14-19 区域）。**在 smsApiUrl 字段之后**插入 phonePool 子段。

由于 Config.vue 的 UI 结构（el-form / el-divider 等）可能被并行 session 重构过，**实施时打开 Config.vue 看实际布局，按惯例插入**：

```vue
<el-divider content-position="left">号池</el-divider>
<el-form-item label="启用号池">
  <el-switch v-model="config.phonePool.enabled" />
  <span style="margin-left:8px;color:#909399;font-size:12px">PKCE 撞手机验证时从池里取号（Phase 2 接通）</span>
</el-form-item>
<el-form-item label="每号最大绑定数">
  <el-input-number v-model="config.phonePool.maxBindingsPerPhone" :min="1" :max="100" />
</el-form-item>
<el-form-item label="SMS 轮询间隔 (ms)">
  <el-input-number v-model="config.phonePool.smsPollIntervalMs" :min="500" :max="60000" :step="500" />
</el-form-item>
<el-form-item label="SMS 最多尝试次数">
  <el-input-number v-model="config.phonePool.smsMaxAttempts" :min="1" :max="100" />
</el-form-item>
```

如果 `config.phonePool` 在 load 时未存在（老 config.json 没这个字段），需要默认值初始化。在 Config.vue load 函数末尾追加：

```js
// v2.37.0: 兜底 phonePool 字段（防止旧 config.json 缺失）
if (!config.value.phonePool) {
  config.value.phonePool = { enabled: false, maxBindingsPerPhone: 5, smsPollIntervalMs: 3000, smsMaxAttempts: 30 }
}
```

**实施时打开 Config.vue 看 load 函数实际名字和位置**。

### Step 5: 构建前端

```
cd web ; npm run build
```

Expected: `✓ built`。常见错误：
- `Iphone` 找不到 → 改用 `Phone` / `Cellphone`
- `PageHeader / SectionCard` import 路径错 → 看 `web/src/components/ui/` 实际文件名
- `el-form-item` 在 Config.vue 外部使用 → 检查包在 el-form 内

### Step 6: 后端测试回归

```
cd .. ; npm test
```

Expected: 跟 Task 3 末尾相同 (前端改动不影响后端)。

### Step 7: Commit

```bash
git add web/src/views/PhonePool.vue web/src/router.js web/src/components/AppLayout.vue web/src/views/Config.vue
git commit -m "$(cat <<'EOF'
feat(phone-pool): 前端 PhonePool.vue 页面 + 导航 + Config 配置 (v2.37.0 Phase 1)

PhonePool.vue 使用 v2.34 design tokens（PageHeader + SectionCard）：
- toolbar：批量导入 (textarea dialog) / 导出 (window.open) / 跳 Config
- 表格：phone / SMS URL (短显 tooltip) / 绑定数 / 创建时间 / 删除
- 行展开显示已绑定 email tag 列表

router + AppLayout 加「号池」入口（在「配置设置」之前）。

Config.vue 新增 phonePool 4 个 input（enabled switch + max bindings
+ SMS poll interval + max attempts），load 兜底防止老 config.json
缺失字段崩溃。
EOF
)"
```

---

## Task 5: CHANGELOG v2.37.0

**Files:**
- Modify: `docs/CHANGELOG.md`

### Step 1: Prepend v2.37.0 section

打开 `docs/CHANGELOG.md`. 在 `# Changelog` 之后、第一个现有 `## v2.x.x` 之前插入：

```markdown
## v2.37.0 — 2026-05-25

### 手机号号池基础设施 (Phase 1/2)

OAuth PKCE 流程在某些账户上会被 ChatGPT 要求绑定手机号（`needsPhone:
true` 检测点见 `protocol_register.py:273`），**当前流水线在该点卡死**。
本次先建号池基础设施，Phase 2（独立 spec）再接通 PKCE 消费。

**Phase 1 交付**：

- **DB**：新增 `phone_pool` (phone PK / sms_api_url / bindings_used /
  created_at) + `phone_bindings` (phone + email 复合 PK) 两张表。
  `getRawDb()` helper 暴露给 service 用。
- **后端 service** `server/phone-pool.js`：list / import / export /
  delete / acquirePhone / fetchSmsCode 六个函数。
  - `acquirePhone(db, email, max)` 原子取号 + 写 binding + 自增计数器；
    排序 bindings_used ASC + created_at ASC（轮转使用避免某号被打）；
    WHERE 排除已与该 email 绑过的号 + 满号；null = 用尽
  - `fetchSmsCode` regex `/\b(\d{6})\b/` 与 `payment.js:586` PayPal
    路径一致，Phase 2 复用
- **路由** `/api/phone-pool` 4 个 endpoints（GET / + POST /import +
  GET /export + DELETE /:phone）
- **Config 字段** `phonePool.{enabled, maxBindingsPerPhone,
  smsPollIntervalMs, smsMaxAttempts}` 默认 disabled
- **前端** PhonePool.vue 新页面（PageHeader + SectionCard 沿用 v2.34
  设计），sidebar 加「号池」入口，Config.vue 加 4 个 input

**绑定语义**（per 用户明确）：首次使用建立 + 永久绑定 ——
账户被删除不释放 `bindings_used` 计数。满 max 后 phone 不再可用。

**Phase 2 预览**（独立 spec）：协议模式 + 浏览器模式两套 PKCE
add_phone 流程实现，消费 acquirePhone() + fetchSmsCode helper。

**测试**：`server/__tests__/phone-pool.test.js` +6（import 基本 /
import 跳非法 / list boundEmails / acquire 跳满号 / acquire 同 email
不重绑 / delete cascade）。

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-phone-pool-infrastructure-design.md`
+ `docs/superpowers/plans/2026-05-25-phone-pool-infrastructure.md`。

```

### Step 2: Final regression

```
npm test
```

Expected: 全套件 "fail 0"。

### Step 3: 手动 smoke (用户跑)

1. 重启 server + 硬刷 web
2. 进「号池」页 → 空列表 → 点「批量导入」→ 粘贴 `+14642840651|http://a.62-us.com/api/get_sms?key=45d480b96551db9a082a90ae7c96c054`
3. 确认 → 表格出现 1 条；绑定数显示 `0/5`
4. 点「导出」→ 浏览器下载 txt，内容跟导入一致
5. 点「删除」→ 行消失
6. 跳 Config 页 → 看到「号池」分区 4 个 input；调整 max 后刷新号池页确认显示更新

### Step 4: Commit

```bash
git add docs/CHANGELOG.md
git commit -m "docs(changelog): v2.37.0 — 手机号号池基础设施 (Phase 1)"
```

---

## Self-Review

**1. Spec coverage:**

- Spec §1 背景：informational。
- Spec §2 目标（DB / service / route / config / 前端 / 测试）→ Task 1-5 全 cover。
- Spec §3.1 DB schema → Task 1.
- Spec §3.2 Config schema → Task 3 Step 3 + Task 4 Step 4 (Config.vue UI)。
- Spec §3.3 后端 service → Task 2。
- Spec §3.4 API 路由 → Task 3 Steps 1-2。
- Spec §3.5 前端 PhonePool.vue → Task 4 Step 1; router + AppLayout → Steps 2-3。
- Spec §3.6 边界 11 条 → 实现里覆盖（phone 唯一 / bindings_used 单调 / 排序 / 不允许重复绑定 / cascade / Phase 1 不消费 / PayPal 不动 / E.164 校验 / 不 mask URL）。
- Spec §3.7 测试 6 个 → Task 2 Step 1 全部到位。
- Spec §3.8 文件清单 → matches Task 1-5。
- Spec §4 YAGNI → 不动 PKCE / 不动 PayPal / 不重构 / 计划严格遵守。
- Spec §5 Phase 2 预览 → informational + CHANGELOG 提及。
- Spec §6 版本 → Task 5 Step 1 标 v2.37.0。

**2. Placeholder scan:** 无 "TBD" / "implement later"。Task 4 几处 "实施时打开 X 确认" 是因为前端文件被并行 session 改动频繁（Config.vue 布局、PageHeader/SectionCard 路径、Iphone icon 名），具体规则给定（"如果 X 失败用 Y 替代"），不是占位符。

**3. Type/symbol consistency:**

- `phone_pool` / `phone_bindings` 表名 —— Task 1 CREATE TABLE、Task 2 SQL queries、Task 3 route via service。一致。
- `bindings_used` 列名 —— Task 1/2/4 一致。
- `sms_api_url` (DB) vs `smsApiUrl` (JS camelCase) —— listPhones 在 JS 侧返回 `smsApiUrl` 字段（值取自 sms_api_url 列），其它路径同此映射。一致。
- `acquirePhone(db, email, maxBindingsPerPhone)` 签名 —— Task 2 测试（P4/P5 传第 3 参 5）+ 实现一致。
- `fetchSmsCode(url, opts)` 与 Phase 2 复用约定 —— Task 2 + 文档说明 + CHANGELOG 引用。
- `getRawDb()` —— Task 1 db.js 导出、Task 3 routes 使用。一致。
- `/api/phone-pool` 4 endpoints —— Task 3 route 定义 + Task 4 前端 调用，路径完全一致。

无 issue。Plan ready.
