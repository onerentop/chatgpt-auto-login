# 代理节点黑名单 + 轮换游标延续 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让代理节点连续 3 次失败才入黑名单（中间成功清零）；黑名单写 SQLite 跨重启保留；轮换游标在 `refresh()` 不重置；Config.vue 暴露主代理 + JP 两个黑名单表格 + 移除 / 清空操作。

**Architecture:** 计数器嵌在 `server/proxy/index.js`（仅内存），到阈值才入 `_state.badNodes` Map 并同步写新表 `proxy_blacklist`（通过新模块 `server/proxy/blacklist.js`）。`markBad`/`markJpBad` 保留作 `recordBadAttempt` 的别名；新增 `recordGoodAttempt` 在成功路径清零计数。三个 engine 文件（`server/engine.js` / `protocol-engine.js` / `server/chatgpt-checkout.js` / `server/stripe-verify.js`）在已有失败处加 `recordBadAttempt`、在对应成功处加 `recordGoodAttempt`。新增 4 个 REST endpoint 给 Config.vue 的两个 `el-table` 用。

**Tech Stack:** Node.js 18 / sql.js (WASM SQLite) / Express 5 / Vue 3 + Element Plus / `node:test` 内置测试。

**Spec:** `docs/superpowers/specs/2026-05-24-proxy-blacklist-and-rotation-cursor-design.md`

---

## 文件清单

**新建：**
- `server/proxy/blacklist.js` — 持久化封装（add / remove / removeAll / loadAll / pruneExpired）
- `server/proxy/__tests__/blacklist.test.js` — B1-B4 持久化测试
- `server/proxy/__tests__/rotation.test.js` — R1-R4 游标行为测试
- `server/__tests__/proxy-route-blacklist.test.js` — REST endpoint 测试

**修改：**
- `server/db.js` — `initDB()` 中加 `proxy_blacklist` 表
- `server/proxy/index.js` — _state 增量、新函数、refresh 不重置游标、isBad 适配 object、hydrate
- `server/proxy/__tests__/index.test.js` — 追加 U1-U10
- `server/routes/proxy.js` — 4 个新 endpoint
- `server/engine.js` — 第 399 行 markBad 改为 recordBadAttempt + 4 处加 recordGoodAttempt
- `protocol-engine.js` — 第 241/245/389 行同上 + 加 T8 网络错误识别
- `server/chatgpt-checkout.js` — 第 44/78/82 行加 reason 参数 + 成功路径加 recordGoodAttempt
- `server/stripe-verify.js` — 加 T7（4 个失败 reason）+ G5 成功路径
- `web/src/views/Config.vue` — 加"节点黑名单"分节（2 个表格 + 移除 / 清空 + 10s 轮询）
- `docs/CHANGELOG.md` — 追加 v2.20 节

---

## Task 1：SQL 表 + 持久化模块（TDD）

**Files:**
- Create: `server/proxy/blacklist.js`
- Create: `server/proxy/__tests__/blacklist.test.js`
- Modify: `server/db.js`

### Step 1: 写失败测试 `blacklist.test.js`

- [ ] **Step 1:** Create `server/proxy/__tests__/blacklist.test.js`:

```js
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
  // Inject db handle into the module. Production wires real db.js; tests inject an in-memory one.
  blacklist = require('../blacklist');
  blacklist.__setDb(db, () => {});  // (db, saveFn) — noop save in tests
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
  blacklist.add('past', 'main', -60000, 'old', 'auto');  // 已过期
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/proxy/__tests__/blacklist.test.js`
Expected: FAIL — `Cannot find module '../blacklist'`

### Step 3: 创建 `server/proxy/blacklist.js`

- [ ] **Step 3:** Create `server/proxy/blacklist.js`:

```js
// Persistence layer for proxy blacklist. Style mirrors server/db.js (accountsDB / statusDB).
// In tests, __setDb() injects an in-memory sql.js database; production wires server/db.js.

let _db = null;
let _save = null;

function __setDb(db, saveFn) {
  _db = db;
  _save = saveFn || (() => {});
}

function add(tag, channel, ttlMs, reason = '', source = 'auto') {
  if (!_db) throw new Error('blacklist: db not initialized');
  const expiresAt = Date.now() + ttlMs;
  _db.run(
    'INSERT OR REPLACE INTO proxy_blacklist (tag, channel, expires_at, reason, source, added_at) VALUES (?,?,?,?,?,datetime(\'now\'))',
    [tag, channel, expiresAt, String(reason).slice(0, 60), source],
  );
  _save();
}

function remove(tag, channel) {
  if (!_db) return;
  _db.run('DELETE FROM proxy_blacklist WHERE tag=? AND channel=?', [tag, channel]);
  _save();
}

function removeAll(channel) {
  if (!_db) return;
  _db.run('DELETE FROM proxy_blacklist WHERE channel=?', [channel]);
  _save();
}

function loadAll(channel) {
  if (!_db) return [];
  const now = Date.now();
  const stmt = _db.prepare('SELECT tag, expires_at, reason, source FROM proxy_blacklist WHERE channel=? AND expires_at > ?');
  stmt.bind([channel, now]);
  const out = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    out.push({ tag: row.tag, expiresAt: row.expires_at, reason: row.reason || '', source: row.source || 'auto' });
  }
  stmt.free();
  return out;
}

function pruneExpired() {
  if (!_db) return;
  _db.run('DELETE FROM proxy_blacklist WHERE expires_at <= ?', [Date.now()]);
  _save();
}

module.exports = { __setDb, add, remove, removeAll, loadAll, pruneExpired };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/proxy/__tests__/blacklist.test.js`
Expected: PASS（6 个用例）

### Step 5: 把表建到 `server/db.js`

- [ ] **Step 5:** Modify `server/db.js` — 在 `initDB()` 的 `db.run(...)` SQL 块尾（约第 44 行 `);` 之前）追加新表 + 索引，并在表创建后调用 `blacklist.__setDb(db, save)`：

Find this block in `server/db.js`:

```js
    CREATE TABLE IF NOT EXISTS execution_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      phase TEXT DEFAULT '',
      message TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now')),
      run_id TEXT DEFAULT ''
    );
  `);
```

Replace with:

```js
    CREATE TABLE IF NOT EXISTS execution_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      phase TEXT DEFAULT '',
      message TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now')),
      run_id TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS proxy_blacklist (
      tag        TEXT NOT NULL,
      channel    TEXT NOT NULL,
      added_at   TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at INTEGER NOT NULL,
      reason     TEXT DEFAULT '',
      source     TEXT NOT NULL DEFAULT 'auto',
      PRIMARY KEY (tag, channel)
    );
    CREATE INDEX IF NOT EXISTS idx_proxy_blacklist_expires ON proxy_blacklist(expires_at);
  `);

  // Wire blacklist persistence module to the live DB
  try { require('./proxy/blacklist').__setDb(db, save); } catch {}
```

- [ ] **Step 6: 跑现有 DB 路径冒烟 + blacklist 单测一遍**

Run: `node --test server/proxy/__tests__/blacklist.test.js && node --test server/__tests__/`
Expected: 全 PASS（确认 server/db.js 改动不破坏现有用例）

### Step 7: Commit

- [ ] **Step 7:** Commit:

```bash
git add server/proxy/blacklist.js server/proxy/__tests__/blacklist.test.js server/db.js
git commit -m "$(cat <<'EOF'
feat(proxy): add proxy_blacklist table + persistence module

新增 server/proxy/blacklist.js 封装 sql.js CRUD，
风格对齐现有 accountsDB / statusDB。
server/db.js initDB 中建表 + 自动 wire blacklist 模块。
6 个单测覆盖 add/remove/removeAll/loadAll/pruneExpired。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2：proxy/index.js 计数器 + 黑名单管理 API（TDD · U1-U10）

**Files:**
- Modify: `server/proxy/index.js`
- Modify: `server/proxy/__tests__/index.test.js`

### Step 1: 追加 U1-U10 测试

- [ ] **Step 1:** Append to `server/proxy/__tests__/index.test.js`:

```js
// ============== U1-U10: blacklist counter API ==============
// Use a fresh require for the proxy module (it caches state internally) plus
// mock blacklist module so persistence calls don't blow up in unit tests.

const Module = require('module');
const origResolve = Module._resolveFilename;

function freshProxy({ blacklistMock } = {}) {
  // Mock blacklist module before require
  const origRequire = Module.prototype.require;
  const blMock = blacklistMock || { add: () => {}, remove: () => {}, removeAll: () => {}, loadAll: () => [], pruneExpired: () => {}, __setDb: () => {} };
  Module.prototype.require = function (id) {
    if (id === './blacklist') return blMock;
    return origRequire.apply(this, arguments);
  };
  delete require.cache[require.resolve('../index')];
  delete require.cache[require.resolve('../blacklist')];
  const p = require('../index');
  Module.prototype.require = origRequire;
  return p;
}

test('U1 recordBadAttempt 第 1、2 次不入黑名单', () => {
  const p = freshProxy();
  const r1 = p.recordBadAttempt('us-1', 'main', 'tls');
  assert.strictEqual(r1.blacklisted, false);
  assert.strictEqual(r1.count, 1);
  const r2 = p.recordBadAttempt('us-1', 'main', 'tls');
  assert.strictEqual(r2.blacklisted, false);
  assert.strictEqual(r2.count, 2);
  assert.strictEqual(p.isBad('us-1'), false);
});

test('U2 recordBadAttempt 连续 3 次：入黑名单，failCount 清零', () => {
  const calls = [];
  const blMock = { add: (tag, ch, ttl, reason, src) => calls.push({ tag, ch, ttl, reason, src }), remove: () => {}, removeAll: () => {}, loadAll: () => [], pruneExpired: () => {}, __setDb: () => {} };
  const p = freshProxy({ blacklistMock: blMock });
  p.recordBadAttempt('us-1', 'main', 'tls');
  p.recordBadAttempt('us-1', 'main', 'tls');
  const r3 = p.recordBadAttempt('us-1', 'main', 'tls');
  assert.strictEqual(r3.blacklisted, true);
  assert.strictEqual(r3.count, 3);
  assert.strictEqual(p.isBad('us-1'), true);
  assert.strictEqual(calls.length, 1, '应调一次 blacklist.add');
  assert.strictEqual(calls[0].src, 'auto');
  // 第 4 次再调（节点仍在黑名单期间）：计数器从 0 重新开始
  const r4 = p.recordBadAttempt('us-1', 'main', 'tls');
  assert.strictEqual(r4.count, 1, '入黑名单后 failCount 已清零');
});

test('U3 2 次 bad + 1 次 good + 1 次 bad：不入黑名单', () => {
  const p = freshProxy();
  p.recordBadAttempt('us-1', 'main', 'tls');
  p.recordBadAttempt('us-1', 'main', 'tls');
  p.recordGoodAttempt('us-1', 'main');
  const r = p.recordBadAttempt('us-1', 'main', 'tls');
  assert.strictEqual(r.blacklisted, false);
  assert.strictEqual(r.count, 1, 'good 之后 bad 计数从 1 重新开始');
});

test('U4 main 与 jp 通道独立计数（同 tag）', () => {
  const p = freshProxy();
  p.recordBadAttempt('node-X', 'main', 'a');
  p.recordBadAttempt('node-X', 'main', 'a');
  p.recordBadAttempt('node-X', 'jp', 'b');
  assert.strictEqual(p.isBad('node-X'), false);
  assert.strictEqual(p.isJpBad('node-X'), false);
  p.recordBadAttempt('node-X', 'main', 'a');
  assert.strictEqual(p.isBad('node-X'), true);
  assert.strictEqual(p.isJpBad('node-X'), false, 'jp 通道独立');
});

test('U5 blacklistManually 立即入黑名单且清掉计数器', () => {
  const calls = [];
  const blMock = { add: (tag, ch, ttl, reason, src) => calls.push({ tag, ch, ttl, reason, src }), remove: () => {}, removeAll: () => {}, loadAll: () => [], pruneExpired: () => {}, __setDb: () => {} };
  const p = freshProxy({ blacklistMock: blMock });
  p.recordBadAttempt('us-1', 'main', 'tls');  // 计数 = 1
  p.blacklistManually('us-1', 'main', 60000, 'manual disable');
  assert.strictEqual(p.isBad('us-1'), true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].src, 'manual');
  // 移除后再调 bad，计数从 1（不是 2）
  p.removeFromBlacklist('us-1', 'main');
  const r = p.recordBadAttempt('us-1', 'main', 'tls');
  assert.strictEqual(r.count, 1, 'manual 入黑名单时也应清 failCount');
});

test('U6 removeFromBlacklist 联动持久化层', () => {
  const removes = [];
  const blMock = { add: () => {}, remove: (tag, ch) => removes.push({ tag, ch }), removeAll: () => {}, loadAll: () => [], pruneExpired: () => {}, __setDb: () => {} };
  const p = freshProxy({ blacklistMock: blMock });
  p.blacklistManually('us-1', 'main', 60000, 'm');
  p.removeFromBlacklist('us-1', 'main');
  assert.strictEqual(p.isBad('us-1'), false);
  assert.deepStrictEqual(removes, [{ tag: 'us-1', ch: 'main' }]);
});

test('U7 isBad 对过期 entry：删除内存 + 调 blacklist.remove，返回 false', () => {
  const removes = [];
  const blMock = { add: () => {}, remove: (tag, ch) => removes.push({ tag, ch }), removeAll: () => {}, loadAll: () => [], pruneExpired: () => {}, __setDb: () => {} };
  const p = freshProxy({ blacklistMock: blMock });
  p.blacklistManually('us-1', 'main', -1000, 'expired');  // 立即过期
  const v = p.isBad('us-1');
  assert.strictEqual(v, false);
  assert.deepStrictEqual(removes, [{ tag: 'us-1', ch: 'main' }]);
});

test('U8 getState().badNodes shape 为 {tag: {expiresAt, reason, source}}', () => {
  const p = freshProxy();
  p.blacklistManually('us-1', 'main', 60000, 'm', 'manual');
  const state = p.getState();
  const entry = state.badNodes['us-1'];
  assert.strictEqual(typeof entry, 'object');
  assert.strictEqual(typeof entry.expiresAt, 'number');
  assert.strictEqual(entry.reason, 'm');
  assert.strictEqual(entry.source, 'manual');
});

test('U9 isProxyNetError 命中 / 不命中', () => {
  const p = freshProxy();
  assert.ok(p.isProxyNetError('ECONNRESET'));
  assert.ok(p.isProxyNetError('connect ETIMEDOUT 1.2.3.4:443'));
  assert.ok(p.isProxyNetError('socket hang up'));
  assert.ok(p.isProxyNetError('getaddrinfo ENOTFOUND foo'));
  assert.ok(p.isProxyNetError('ECONNREFUSED'));
  assert.ok(p.isProxyNetError('net::ERR_TUNNEL_CONNECTION_FAILED'));
  assert.ok(p.isProxyNetError('net::ERR_PROXY_CONNECTION_FAILED'));
  assert.strictEqual(p.isProxyNetError('account_deactivated'), false);
  assert.strictEqual(p.isProxyNetError('invalid password'), false);
  assert.strictEqual(p.isProxyNetError(''), false);
  assert.strictEqual(p.isProxyNetError(null), false);
});

test('U10 FAIL_THRESHOLD 通过 module export 可读', () => {
  const p = freshProxy();
  assert.strictEqual(p.FAIL_THRESHOLD, 3);
});
```

- [ ] **Step 2: 跑测试确认全部失败**

Run: `node --test server/proxy/__tests__/index.test.js`
Expected: FAIL — `recordBadAttempt is not a function` 等

### Step 3: 改 `server/proxy/index.js` _state 增量 + 新函数

- [ ] **Step 3:** Modify `server/proxy/index.js`:

**(a)** 在文件顶部 `const BAD_NODE_TTL_MS = ...` 之下加：

```js
const FAIL_THRESHOLD = 3;
const blacklist = require('./blacklist');

const PROXY_NET_ERROR_RE = /ECONNRESET|ETIMEDOUT|socket hang up|getaddrinfo|ECONNREFUSED|tunneling socket|net::ERR_(PROXY|TUNNEL|CONNECTION_RESET|TIMED_OUT|EMPTY_RESPONSE)/i;

function isProxyNetError(msg) {
  return PROXY_NET_ERROR_RE.test(String(msg || ''));
}
```

**(b)** 在 `_state = { ... }` 初始化块内主通道部分加：

```js
  failCount: new Map(),     // tag → 0..2
  failReasons: new Map(),   // tag → 最近一次原因 (60 字截断)
```

并在 `jp: { ... }` 内对称加：

```js
    failCount: new Map(),
    failReasons: new Map(),
```

**(c)** 替换现有 `markBad` / `markJpBad` 实现（约第 61-65、449-453 行）+ 新增函数。把以下整块插入到 `function markBad(...)` 之前（删掉原 `markBad` / `markJpBad` 两个函数体）：

```js
function _addToBlacklist(tag, channel, ttlMs, reason, source) {
  const expiresAt = Date.now() + ttlMs;
  const entry = { expiresAt, reason: String(reason).slice(0, 60), source };
  const ns = channel === 'jp' ? _state.jp : _state;
  ns.badNodes.set(tag, entry);
  try { blacklist.add(tag, channel, ttlMs, reason, source); } catch (e) { console.log(`[Proxy] blacklist.add failed: ${e.message?.slice(0, 60)}`); }
}

function recordBadAttempt(tag, channel, reason = '') {
  if (!tag) return { blacklisted: false, count: 0 };
  const ns = channel === 'jp' ? _state.jp : _state;
  const next = (ns.failCount.get(tag) || 0) + 1;
  ns.failCount.set(tag, next);
  ns.failReasons.set(tag, String(reason).slice(0, 60));
  console.log(`[Proxy${channel === 'jp' ? ':JP' : ''}] Bad attempt ${next}/${FAIL_THRESHOLD} on ${tag} (${String(reason).slice(0, 40)})`);
  if (next >= FAIL_THRESHOLD) {
    _addToBlacklist(tag, channel, BAD_NODE_TTL_MS, reason, 'auto');
    ns.failCount.delete(tag);
    ns.failReasons.delete(tag);
    return { blacklisted: true, count: next };
  }
  return { blacklisted: false, count: next };
}

function recordGoodAttempt(tag, channel) {
  if (!tag) return;
  const ns = channel === 'jp' ? _state.jp : _state;
  if (ns.failCount.has(tag)) {
    ns.failCount.delete(tag);
    ns.failReasons.delete(tag);
  }
}

function blacklistManually(tag, channel, ttlMs = BAD_NODE_TTL_MS, reason = 'manual') {
  if (!tag) throw new Error('tag required');
  _addToBlacklist(tag, channel, ttlMs, reason, 'manual');
  const ns = channel === 'jp' ? _state.jp : _state;
  ns.failCount.delete(tag);
  ns.failReasons.delete(tag);
}

function removeFromBlacklist(tag, channel) {
  const ns = channel === 'jp' ? _state.jp : _state;
  ns.badNodes.delete(tag);
  try { blacklist.remove(tag, channel); } catch {}
}

function clearBlacklist(channel) {
  const ns = channel === 'jp' ? _state.jp : _state;
  ns.badNodes.clear();
  try { blacklist.removeAll(channel); } catch {}
}

// Legacy aliases — preserve existing call sites in engine / chatgpt-checkout
function markBad(tag) { return recordBadAttempt(tag, 'main', 'legacy markBad'); }
function markJpBad(tag) { return recordBadAttempt(tag, 'jp', 'legacy markJpBad'); }
```

**(d)** 替换 `isBad` 函数（约第 54-59 行）：

```js
function isBad(tag) {
  const entry = _state.badNodes.get(tag);
  if (!entry) return false;
  // Support legacy number value (defensive); new value is { expiresAt, reason, source }
  const expiresAt = typeof entry === 'number' ? entry : entry.expiresAt;
  if (Date.now() > expiresAt) {
    _state.badNodes.delete(tag);
    try { blacklist.remove(tag, 'main'); } catch {}
    return false;
  }
  return true;
}
```

**(e)** 替换 `isJpBad` 函数（约第 442-447 行）：

```js
function isJpBad(tag) {
  const entry = _state.jp.badNodes.get(tag);
  if (!entry) return false;
  const expiresAt = typeof entry === 'number' ? entry : entry.expiresAt;
  if (Date.now() > expiresAt) {
    _state.jp.badNodes.delete(tag);
    try { blacklist.remove(tag, 'jp'); } catch {}
    return false;
  }
  return true;
}
```

**(f)** 替换 `getState` 函数（约第 67-89 行）—— 把 number 形态升级为 object：

```js
function getState() {
  const now = Date.now();
  const normalize = (map) => {
    const out = {};
    for (const [tag, entry] of map.entries()) {
      const obj = typeof entry === 'number' ? { expiresAt: entry, reason: '', source: 'auto' } : entry;
      if (obj.expiresAt > now) out[tag] = obj;
      else map.delete(tag);
    }
    return out;
  };
  const badNodes = normalize(_state.badNodes);
  const jpBadNodes = normalize(_state.jp.badNodes);
  return {
    ..._state,
    available: _state.nodeTags.length,
    badNodes,
    jp: {
      ..._state.jp,
      available: _state.jp.nodeTags.length,
      badNodes: jpBadNodes,
    },
  };
}
```

**(g)** 在 `module.exports = { ... }` 末尾加：

```js
  // blacklist + counter API
  recordBadAttempt,
  recordGoodAttempt,
  blacklistManually,
  removeFromBlacklist,
  clearBlacklist,
  isProxyNetError,
  FAIL_THRESHOLD,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/proxy/__tests__/index.test.js`
Expected: PASS（新 10 + 现有 11 = 21 用例）

### Step 5: Commit

- [ ] **Step 5:**

```bash
git add server/proxy/index.js server/proxy/__tests__/index.test.js
git commit -m "$(cat <<'EOF'
feat(proxy): connect-3-fail threshold + manual blacklist API

recordBadAttempt 累计 3 次才入黑名单，recordGoodAttempt 立刻清零。
blacklistManually / removeFromBlacklist / clearBlacklist 配套手动操作。
markBad / markJpBad 保留作 alias，向后兼容现有 engine 调用。
getState().badNodes 升级为 {tag: {expiresAt, reason, source}}。
新增 isProxyNetError 共享网络错误识别正则（供 engine 层 catch 用）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3：refresh 不重置游标 + hydrate（TDD · R1-R4）

**Files:**
- Modify: `server/proxy/index.js`
- Create: `server/proxy/__tests__/rotation.test.js`

### Step 1: 写失败测试

- [ ] **Step 1:** Create `server/proxy/__tests__/rotation.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

function freshProxyWithMocks({ subscription, singbox, clashApi, blacklist, configJson }) {
  const origRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === './subscription') return subscription;
    if (id === './singbox') return singbox;
    if (id === './clash-api') return clashApi;
    if (id === './blacklist') return blacklist;
    if (id === 'fs') {
      const fs = origRequire.call(this, 'fs');
      return {
        ...fs,
        readFileSync: (p, enc) => {
          if (typeof p === 'string' && p.endsWith('config.json')) return JSON.stringify(configJson);
          return fs.readFileSync(p, enc);
        },
      };
    }
    return origRequire.apply(this, arguments);
  };
  delete require.cache[require.resolve('../index')];
  delete require.cache[require.resolve('../blacklist')];
  const p = require('../index');
  Module.prototype.require = origRequire;
  return p;
}

const defaultMocks = (nodes) => ({
  subscription: {
    fetchAndParse: async () => nodes,
    filterByRegion: (all) => all,
    filterByJpKddi: () => [],
    filterByWhitelist: () => [],
  },
  singbox: { start: async () => {}, stop: async () => {} },
  clashApi: { switchSelector: async () => {} },
  blacklist: { __setDb: () => {}, add: () => {}, remove: () => {}, removeAll: () => {}, loadAll: () => [], pruneExpired: () => {} },
  configJson: {
    proxy: { enabled: true, subscriptionUrl: 'http://x', regionFilter: 'US', rotationStrategy: 'sequential', jpCheckout: { enabled: false } },
  },
});

test('R1 refresh 不重置 rotationIndex（节点池长度不变）', async () => {
  const nodes = Array.from({ length: 8 }, (_, i) => ({ type: 'ss', tag: `us-${i}` }));
  const p = freshProxyWithMocks(defaultMocks(nodes));
  await p.refresh();
  // simulate "user rotated 3 times" by calling rotate
  await p.rotate(); await p.rotate(); await p.rotate();
  const idxBefore = p.getState().rotationIndex;
  assert.strictEqual(idxBefore, 3);
  await p.refresh();
  const idxAfter = p.getState().rotationIndex;
  assert.strictEqual(idxAfter, 3, 'refresh 不应把 rotationIndex 重置到 0');
  assert.strictEqual(p.getState().currentNode, 'us-3', 'currentNode 应跟随 rotationIndex');
});

test('R2 refresh 后节点列表变短：rotationIndex 取模到合法范围', async () => {
  const nodes10 = Array.from({ length: 10 }, (_, i) => ({ type: 'ss', tag: `us-${i}` }));
  const mocks = defaultMocks(nodes10);
  const p = freshProxyWithMocks(mocks);
  await p.refresh();
  await p.rotate(); await p.rotate(); await p.rotate(); await p.rotate(); await p.rotate();
  await p.rotate(); await p.rotate();   // idx = 7
  assert.strictEqual(p.getState().rotationIndex, 7);
  // 订阅缩到 3 个
  mocks.subscription.fetchAndParse = async () => nodes10.slice(0, 3);
  mocks.subscription.filterByRegion = (all) => all;
  await p.refresh();
  assert.strictEqual(p.getState().rotationIndex, 7 % 3, '应取模到 1');
  assert.strictEqual(p.getState().currentNode, 'us-1');
});

test('R3 refresh 后节点列表为空：rotationIndex 安全 reset 为 0', async () => {
  const mocks = defaultMocks([]);
  mocks.configJson.proxy.enabled = false;
  mocks.configJson.proxy.jpCheckout.enabled = true;
  mocks.subscription.fetchAndParse = async () => [{ type: 'ss', tag: 'jp-1' }];
  mocks.subscription.filterByJpKddi = (all) => all;
  mocks.configJson.proxy.jpCheckout.keyword = 'jp';
  const p = freshProxyWithMocks(mocks);
  await p.refresh();
  assert.strictEqual(p.getState().rotationIndex, 0);
  assert.strictEqual(p.getState().currentNode, '');
});

test('R4 refresh 后 currentNode 跟随 rotationIndex 而非 filtered[0]', async () => {
  const nodes = Array.from({ length: 5 }, (_, i) => ({ type: 'ss', tag: `us-${i}` }));
  const p = freshProxyWithMocks(defaultMocks(nodes));
  await p.refresh();
  await p.rotate(); await p.rotate();   // idx = 2, currentNode = us-2
  assert.strictEqual(p.getState().currentNode, 'us-2');
  await p.refresh();
  assert.strictEqual(p.getState().currentNode, 'us-2');
});

test('R5 hydrate：首次 refresh 从 DB 灌入黑名单', async () => {
  const mocks = defaultMocks([{ type: 'ss', tag: 'us-1' }]);
  const loadCalls = [];
  mocks.blacklist.loadAll = (ch) => {
    loadCalls.push(ch);
    if (ch === 'main') return [{ tag: 'us-old-bad', expiresAt: Date.now() + 600000, reason: 'persisted', source: 'auto' }];
    return [];
  };
  const p = freshProxyWithMocks(mocks);
  await p.refresh();
  assert.deepStrictEqual(loadCalls, ['main', 'jp'], '应读 main + jp 两次');
  assert.strictEqual(p.isBad('us-old-bad'), true);
  // 二次 refresh 不再 hydrate
  loadCalls.length = 0;
  await p.refresh();
  assert.strictEqual(loadCalls.length, 0, 'badNodes 非空时不再 hydrate');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/proxy/__tests__/rotation.test.js`
Expected: FAIL — R1 因为 `refresh()` 还会重置 rotationIndex；R5 因为 hydrate 还没接入

### Step 3: 改 `refresh()` 游标处理 + 加 hydrate

- [ ] **Step 3:** 在 `server/proxy/index.js` `refresh()` 函数内修改：

Find:

```js
  _state.outbounds = filtered;
  _state.nodeTags = filtered.map(o => o.tag);
  _state.rotationIndex = 0;
  _state.currentNode = filtered[0]?.tag || '';

  _state.jp.outbounds = jpFiltered;
  _state.jp.nodeTags = jpFiltered.map(o => o.tag);
  _state.jp.rotationIndex = 0;
  _state.jp.currentNode = jpFiltered[0]?.tag || '';
```

Replace with:

```js
  _state.outbounds = filtered;
  _state.nodeTags = filtered.map(o => o.tag);
  if (filtered.length === 0) {
    _state.rotationIndex = 0;
  } else if (_state.rotationIndex >= filtered.length) {
    _state.rotationIndex = _state.rotationIndex % filtered.length;
  }
  _state.currentNode = filtered[_state.rotationIndex]?.tag || '';

  _state.jp.outbounds = jpFiltered;
  _state.jp.nodeTags = jpFiltered.map(o => o.tag);
  if (jpFiltered.length === 0) {
    _state.jp.rotationIndex = 0;
  } else if (_state.jp.rotationIndex >= jpFiltered.length) {
    _state.jp.rotationIndex = _state.jp.rotationIndex % jpFiltered.length;
  }
  _state.jp.currentNode = jpFiltered[_state.jp.rotationIndex]?.tag || '';
```

### Step 4: 加 hydrate

- [ ] **Step 4:** 在 `refresh()` 内 `singbox.start(sbConfig)` 之后、`return filtered.length;` 之前加：

```js
  // Hydrate blacklist from DB on first refresh of this process.
  // Manual or auto entries added at runtime go through _addToBlacklist directly,
  // so the size === 0 guard only triggers on cold start.
  if (_state.badNodes.size === 0 && _state.jp.badNodes.size === 0) {
    try {
      blacklist.pruneExpired();
      for (const row of blacklist.loadAll('main')) {
        _state.badNodes.set(row.tag, { expiresAt: row.expiresAt, reason: row.reason, source: row.source });
      }
      for (const row of blacklist.loadAll('jp')) {
        _state.jp.badNodes.set(row.tag, { expiresAt: row.expiresAt, reason: row.reason, source: row.source });
      }
    } catch (e) {
      console.log(`[Proxy] hydrate blacklist failed: ${e.message?.slice(0, 60)}`);
    }
  }
```

- [ ] **Step 5: 跑 R1-R5 测试**

Run: `node --test server/proxy/__tests__/rotation.test.js`
Expected: PASS（5 用例）

- [ ] **Step 6: 跑全部 proxy 测试**

Run: `node --test server/proxy/__tests__/`
Expected: PASS（无回归，旧 11 + U 10 + R 5 + B 6 = 32 用例）

### Step 7: Commit

- [ ] **Step 7:**

```bash
git add server/proxy/index.js server/proxy/__tests__/rotation.test.js
git commit -m "$(cat <<'EOF'
feat(proxy): preserve rotation cursor across refresh() + hydrate from DB

refresh() 不再硬重置 rotationIndex = 0，仅在节点列表变短时取模，
解决"每次保存配置 / 重启代理头部节点被反复使用、尾部节点闲置"。
首次 refresh 时从 proxy_blacklist 表灌入内存 Map，跨重启恢复黑名单。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4：4 个新 REST endpoint

**Files:**
- Modify: `server/routes/proxy.js`
- Create: `server/__tests__/proxy-route-blacklist.test.js`

### Step 1: 写 endpoint 单测

- [ ] **Step 1:** Create `server/__tests__/proxy-route-blacklist.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

function freshApp({ proxyMock }) {
  const origRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === '../proxy') return proxyMock;
    return origRequire.apply(this, arguments);
  };
  delete require.cache[require.resolve('../routes/proxy')];
  const router = require('../routes/proxy');
  Module.prototype.require = origRequire;
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/proxy', router);
  return app;
}

async function request(app, method, url, body) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { 'content-type': 'application/json' } }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

function mkProxyMock(state) {
  const calls = [];
  return {
    calls,
    getState: () => state,
    blacklistManually: (tag, channel, ttlMs, reason) => calls.push({ fn: 'blacklistManually', tag, channel, ttlMs, reason }),
    removeFromBlacklist: (tag, channel) => calls.push({ fn: 'removeFromBlacklist', tag, channel }),
    clearBlacklist: (channel) => calls.push({ fn: 'clearBlacklist', channel }),
    // Stubs for unrelated endpoints that exist on the router but we don't exercise here
    refresh: async () => 0, stop: async () => {}, rotate: async () => '', switchTo: async () => '',
    markBad: () => {}, markJpBad: () => {}, rotateJp: async () => '',
    detectExit: async () => '', detectJpExit: async () => '',
  };
}

test('GET /blacklist 返回 main + jp 两数组，含 ttlRemainingMs', async () => {
  const expiresAt = Date.now() + 60000;
  const state = {
    badNodes: { 'us-1': { expiresAt, reason: 'tls', source: 'auto' } },
    jp: { badNodes: { 'jp-1': { expiresAt: expiresAt + 1000, reason: 'empty', source: 'manual' } } },
  };
  const proxyMock = mkProxyMock(state);
  const app = freshApp({ proxyMock });
  const r = await request(app, 'GET', '/api/proxy/blacklist');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.main.length, 1);
  assert.strictEqual(r.body.main[0].tag, 'us-1');
  assert.strictEqual(r.body.main[0].reason, 'tls');
  assert.strictEqual(r.body.main[0].source, 'auto');
  assert.ok(r.body.main[0].ttlRemainingMs > 0 && r.body.main[0].ttlRemainingMs <= 60000);
  assert.strictEqual(r.body.jp.length, 1);
  assert.strictEqual(r.body.jp[0].source, 'manual');
});

test('POST /blacklist/add 校验 + 透传到 proxy.blacklistManually', async () => {
  const proxyMock = mkProxyMock({ badNodes: {}, jp: { badNodes: {} } });
  const app = freshApp({ proxyMock });
  // tag 缺失
  let r = await request(app, 'POST', '/api/proxy/blacklist/add', { channel: 'main' });
  assert.strictEqual(r.status, 400);
  // channel 非法
  r = await request(app, 'POST', '/api/proxy/blacklist/add', { tag: 'x', channel: 'us' });
  assert.strictEqual(r.status, 400);
  // happy path
  r = await request(app, 'POST', '/api/proxy/blacklist/add', { tag: 'us-1', channel: 'main', ttlMs: 12345, reason: 'manual' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { main: [], jp: [] });
  assert.deepStrictEqual(proxyMock.calls, [{ fn: 'blacklistManually', tag: 'us-1', channel: 'main', ttlMs: 12345, reason: 'manual' }]);
});

test('POST /blacklist/remove 校验 + 透传', async () => {
  const proxyMock = mkProxyMock({ badNodes: {}, jp: { badNodes: {} } });
  const app = freshApp({ proxyMock });
  let r = await request(app, 'POST', '/api/proxy/blacklist/remove', { tag: 'x' });
  assert.strictEqual(r.status, 400);
  r = await request(app, 'POST', '/api/proxy/blacklist/remove', { tag: 'us-1', channel: 'main' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(proxyMock.calls, [{ fn: 'removeFromBlacklist', tag: 'us-1', channel: 'main' }]);
});

test('POST /blacklist/clear 仅校验 channel', async () => {
  const proxyMock = mkProxyMock({ badNodes: {}, jp: { badNodes: {} } });
  const app = freshApp({ proxyMock });
  let r = await request(app, 'POST', '/api/proxy/blacklist/clear', {});
  assert.strictEqual(r.status, 400);
  r = await request(app, 'POST', '/api/proxy/blacklist/clear', { channel: 'jp' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(proxyMock.calls, [{ fn: 'clearBlacklist', channel: 'jp' }]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/__tests__/proxy-route-blacklist.test.js`
Expected: FAIL — 404 因 endpoint 还未实现

### Step 3: 加 endpoint

- [ ] **Step 3:** Append to `server/routes/proxy.js` (在 `module.exports = router;` 之前):

```js
function buildBlacklistView(state) {
  const now = Date.now();
  const toRows = (badNodes) => Object.entries(badNodes || {}).map(([tag, entry]) => ({
    tag,
    expiresAt: entry.expiresAt,
    ttlRemainingMs: Math.max(0, entry.expiresAt - now),
    reason: entry.reason || '',
    source: entry.source || 'auto',
  }));
  return { main: toRows(state.badNodes), jp: toRows(state.jp?.badNodes) };
}

router.get('/blacklist', (req, res) => {
  res.json(buildBlacklistView(proxy.getState()));
});

router.post('/blacklist/add', (req, res) => {
  const { tag, channel, ttlMs, reason } = req.body || {};
  if (!tag || typeof tag !== 'string') return res.status(400).json({ error: 'tag required' });
  if (!['main', 'jp'].includes(channel)) return res.status(400).json({ error: "channel must be 'main' or 'jp'" });
  try {
    proxy.blacklistManually(tag, channel, ttlMs, reason);
    res.json(buildBlacklistView(proxy.getState()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/blacklist/remove', (req, res) => {
  const { tag, channel } = req.body || {};
  if (!tag || typeof tag !== 'string') return res.status(400).json({ error: 'tag required' });
  if (!['main', 'jp'].includes(channel)) return res.status(400).json({ error: "channel must be 'main' or 'jp'" });
  proxy.removeFromBlacklist(tag, channel);
  res.json(buildBlacklistView(proxy.getState()));
});

router.post('/blacklist/clear', (req, res) => {
  const { channel } = req.body || {};
  if (!['main', 'jp'].includes(channel)) return res.status(400).json({ error: "channel must be 'main' or 'jp'" });
  proxy.clearBlacklist(channel);
  res.json(buildBlacklistView(proxy.getState()));
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/__tests__/proxy-route-blacklist.test.js`
Expected: PASS（4 用例）

### Step 5: Commit

- [ ] **Step 5:**

```bash
git add server/routes/proxy.js server/__tests__/proxy-route-blacklist.test.js
git commit -m "$(cat <<'EOF'
feat(api): proxy blacklist REST endpoints

GET    /api/proxy/blacklist
POST   /api/proxy/blacklist/add
POST   /api/proxy/blacklist/remove
POST   /api/proxy/blacklist/clear

返回统一 shape {main: [], jp: []} 含 tag / ttlRemainingMs / reason / source，
便于前端直接替换状态。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5：engine 触发点改造 · 主代理通道

按照 spec 第 4 节触发点矩阵，把"一次拉黑"改成 `recordBadAttempt`，并在成功路径加 `recordGoodAttempt`。

**Files:**
- Modify: `server/engine.js`
- Modify: `protocol-engine.js`
- Modify: `server/stripe-verify.js`

### Step 1: protocol-engine.js — T1 + T8 + G1

- [ ] **Step 1:** Modify `protocol-engine.js`:

**(a) T1 改造 + G1 成功路径** — 替换约 235-275 行（`try { result = await runProtocolRegister(...) ...} catch (e) {...}` 整块）：

Find:

```js
        let result;
        try {
          result = await runProtocolRegister(account, this);
          // tls_failure means the homepage step exhausted its 5 retries with TLS errors —
          // a network-layer (node) problem, not an account problem. Blacklist the current
          // node, rotate to a fresh one, and retry the same account once.
          if (result.status === 'tls_failure') {
            const badNode = proxyMgr.getState().currentNode;
            console.log(`[${progress}] TLS errors persisted on ${badNode}; blacklisting + rotating + retrying once`);
            if (proxyMgr.getState().enabled) {
              try { proxyMgr.markBad(badNode); } catch {}
              try {
                const newNode = await proxyMgr.rotate();
                console.log(`[${progress}] Retrying on ${newNode}`);
              } catch (e) {
                console.log(`[${progress}] Rotate failed: ${e.message?.slice(0, 60)}`);
              }
            }
            // Single retry on a fresh route. If this also fails, surface the original
            // tls_failure as a normal error so cooldown/summary handling stays consistent.
            result = await runProtocolRegister(account, this);
            if (result.status === 'tls_failure') {
              console.log(`[${progress}] TLS still failing after rotation — giving up on this account`);
              this.emitStatus({ email: account.email, status: 'error', phase: 'protocol-login', progress, reason: result.error });
              summary.error++;
              continue;
            }
          }
          if (result.status === 'deactivated') {
            console.log(`[${progress}] Account deactivated/deleted by OpenAI`);
            this.emitStatus({ email: account.email, status: 'deactivated', phase: 'done', progress, reason: 'account_deactivated' });
            summary.error++;
            continue;
          }
          console.log(`[${progress}] Protocol login OK: ${result.accessToken}`);
        } catch (e) {
          console.log(`[${progress}] Protocol login failed: ${e.message?.slice(0, 80)}`);
          this.emitStatus({ email: account.email, status: 'error', phase: 'protocol-login', progress, reason: e.message });
          summary.error++;
          continue;
        }
```

Replace with:

```js
        let result;
        try {
          result = await runProtocolRegister(account, this);
          if (result.status === 'tls_failure') {
            const badNode = proxyMgr.getState().currentNode;
            console.log(`[${progress}] TLS errors persisted on ${badNode}; counting + rotating + retrying once`);
            if (proxyMgr.getState().enabled) {
              try { proxyMgr.recordBadAttempt(badNode, 'main', 'tls_failure'); } catch {}
              try {
                const newNode = await proxyMgr.rotate();
                console.log(`[${progress}] Retrying on ${newNode}`);
              } catch (e) {
                console.log(`[${progress}] Rotate failed: ${e.message?.slice(0, 60)}`);
              }
            }
            result = await runProtocolRegister(account, this);
            if (result.status === 'tls_failure') {
              console.log(`[${progress}] TLS still failing after rotation — giving up on this account`);
              try { proxyMgr.recordBadAttempt(proxyMgr.getState().currentNode, 'main', 'tls_failure'); } catch {}
              this.emitStatus({ email: account.email, status: 'error', phase: 'protocol-login', progress, reason: result.error });
              summary.error++;
              continue;
            }
          }
          // G1: 任何"业务返回"（success / deactivated 等）都代表节点工作正常
          try { proxyMgr.recordGoodAttempt(proxyMgr.getState().currentNode, 'main'); } catch {}
          if (result.status === 'deactivated') {
            console.log(`[${progress}] Account deactivated/deleted by OpenAI`);
            this.emitStatus({ email: account.email, status: 'deactivated', phase: 'done', progress, reason: 'account_deactivated' });
            summary.error++;
            continue;
          }
          console.log(`[${progress}] Protocol login OK: ${result.accessToken}`);
        } catch (e) {
          console.log(`[${progress}] Protocol login failed: ${e.message?.slice(0, 80)}`);
          // T8: 网络类异常算节点失败；业务异常不算
          if (proxyMgr.isProxyNetError(e.message)) {
            try { proxyMgr.recordBadAttempt(proxyMgr.getState().currentNode, 'main', 'protocol_net_error'); } catch {}
          }
          this.emitStatus({ email: account.email, status: 'error', phase: 'protocol-login', progress, reason: e.message });
          summary.error++;
          continue;
        }
```

**(b) T2 + G3 改造** — 替换约 380-397 行 payment 页面打开块：

Find:

```js
          if (pageUrl.startsWith('chrome-error://') || pageUrl === 'about:blank') {
            const badNode = proxyMgr.getState().currentNode;
            console.log(`[${progress}] Payment page unreachable via ${badNode} (${pageUrl.slice(0, 40)}); rotating + retrying`);
            if (proxyMgr.getState().enabled) {
              try { proxyMgr.markBad(badNode); } catch {}
              try { const n = await proxyMgr.rotate(); console.log(`[${progress}] Retrying payment on ${n}`); } catch {}
            }
            await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            pageUrl = page.url();
            if (pageUrl.startsWith('chrome-error://') || pageUrl === 'about:blank') {
              throw new Error(`Payment page unreachable after node rotation (${pageUrl.slice(0, 40)})`);
            }
          }
```

Replace with:

```js
          if (pageUrl.startsWith('chrome-error://') || pageUrl === 'about:blank') {
            const badNode = proxyMgr.getState().currentNode;
            console.log(`[${progress}] Payment page unreachable via ${badNode} (${pageUrl.slice(0, 40)}); counting + rotating + retrying`);
            if (proxyMgr.getState().enabled) {
              try { proxyMgr.recordBadAttempt(badNode, 'main', 'payment_unreachable'); } catch {}
              try { const n = await proxyMgr.rotate(); console.log(`[${progress}] Retrying payment on ${n}`); } catch {}
            }
            await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            pageUrl = page.url();
            if (pageUrl.startsWith('chrome-error://') || pageUrl === 'about:blank') {
              try { proxyMgr.recordBadAttempt(proxyMgr.getState().currentNode, 'main', 'payment_unreachable'); } catch {}
              throw new Error(`Payment page unreachable after node rotation (${pageUrl.slice(0, 40)})`);
            }
            // 重试后真实页面打开 → 算 G3 成功
            try { proxyMgr.recordGoodAttempt(proxyMgr.getState().currentNode, 'main'); } catch {}
          } else {
            // G3: 一次到位也算成功
            try { proxyMgr.recordGoodAttempt(proxyMgr.getState().currentNode, 'main'); } catch {}
          }
```

### Step 2: server/engine.js — T3 + T9 + G2 + G3

- [ ] **Step 2:** Modify `server/engine.js`:

**(a) T9 + G2 改造** — 找到登录块（约 226-253 行），把 login 成功 / 失败之后的 proxy 反馈加上。

Find:

```js
          this._chromeProc = launchChrome(port, tempDir, { proxyServer: proxyMgr.getProxyUrl() || undefined });
          this._browser = await waitForCDP(port);
          const browser = this._browser;
          const loginResult = await loginAccount(browser, account);

          if (loginResult.status !== 'success' || !loginResult.accessToken) {
            const isDeactivated = loginResult.status === 'deactivated';
            const statusOut = isDeactivated ? 'deactivated' : 'error';
            console.log(`${p} Login ${isDeactivated ? 'account_deactivated' : 'failed'}: ${loginResult.reason || loginResult.status}`);
            finalResult.status = statusOut;
            finalResult.reason = isDeactivated ? 'account_deactivated' : `Login: ${loginResult.reason || loginResult.status}`;
            allResults.push(finalResult);

            this.emitStatus({
              email: account.email,
              status: statusOut,
              phase: isDeactivated ? 'done' : 'login',
              progress,
              reason: finalResult.reason,
            });
            continue;
          }
          console.log(`${p} Login OK, accessToken obtained.`);
```

Replace with:

```js
          this._chromeProc = launchChrome(port, tempDir, { proxyServer: proxyMgr.getProxyUrl() || undefined });
          this._browser = await waitForCDP(port);
          const browser = this._browser;
          const loginResult = await loginAccount(browser, account);

          if (loginResult.status !== 'success' || !loginResult.accessToken) {
            const isDeactivated = loginResult.status === 'deactivated';
            const statusOut = isDeactivated ? 'deactivated' : 'error';
            console.log(`${p} Login ${isDeactivated ? 'account_deactivated' : 'failed'}: ${loginResult.reason || loginResult.status}`);
            // T9: 失败 reason 是网络类才算节点错误；deactivated / 密码错误等不算
            if (!isDeactivated && proxyMgr.isProxyNetError(loginResult.reason)) {
              try { proxyMgr.recordBadAttempt(proxyMgr.getState().currentNode, 'main', 'login_net_error'); } catch {}
            } else if (isDeactivated) {
              // deactivated 是账号问题，节点工作正常
              try { proxyMgr.recordGoodAttempt(proxyMgr.getState().currentNode, 'main'); } catch {}
            }
            finalResult.status = statusOut;
            finalResult.reason = isDeactivated ? 'account_deactivated' : `Login: ${loginResult.reason || loginResult.status}`;
            allResults.push(finalResult);

            this.emitStatus({
              email: account.email,
              status: statusOut,
              phase: isDeactivated ? 'done' : 'login',
              progress,
              reason: finalResult.reason,
            });
            continue;
          }
          // G2: 登录成功
          try { proxyMgr.recordGoodAttempt(proxyMgr.getState().currentNode, 'main'); } catch {}
          console.log(`${p} Login OK, accessToken obtained.`);
```

**(b) T3 + G3 改造** — 替换 388-407 行 payment 页面打开块（与 protocol-engine.js 同结构）：

Find:

```js
                let pageUrl = page.url();
                if (pageUrl.startsWith('chrome-error://') || pageUrl === 'about:blank') {
                  const badNode = proxyMgr.getState().currentNode;
                  console.log(`${p} Payment page unreachable via ${badNode} (${pageUrl.slice(0, 40)}); rotating + retrying`);
                  if (proxyMgr.getState().enabled) {
                    try { proxyMgr.markBad(badNode); } catch {}
                    try { const n = await proxyMgr.rotate(); console.log(`${p} Retrying payment on ${n}`); } catch {}
                  }
                  await page.goto(discord.link, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                  pageUrl = page.url();
                  if (pageUrl.startsWith('chrome-error://') || pageUrl === 'about:blank') {
                    throw new Error(`Payment page unreachable after node rotation (${pageUrl.slice(0, 40)})`);
                  }
                }
```

Replace with:

```js
                let pageUrl = page.url();
                if (pageUrl.startsWith('chrome-error://') || pageUrl === 'about:blank') {
                  const badNode = proxyMgr.getState().currentNode;
                  console.log(`${p} Payment page unreachable via ${badNode} (${pageUrl.slice(0, 40)}); counting + rotating + retrying`);
                  if (proxyMgr.getState().enabled) {
                    try { proxyMgr.recordBadAttempt(badNode, 'main', 'payment_unreachable'); } catch {}
                    try { const n = await proxyMgr.rotate(); console.log(`${p} Retrying payment on ${n}`); } catch {}
                  }
                  await page.goto(discord.link, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                  pageUrl = page.url();
                  if (pageUrl.startsWith('chrome-error://') || pageUrl === 'about:blank') {
                    try { proxyMgr.recordBadAttempt(proxyMgr.getState().currentNode, 'main', 'payment_unreachable'); } catch {}
                    throw new Error(`Payment page unreachable after node rotation (${pageUrl.slice(0, 40)})`);
                  }
                  try { proxyMgr.recordGoodAttempt(proxyMgr.getState().currentNode, 'main'); } catch {}
                } else {
                  try { proxyMgr.recordGoodAttempt(proxyMgr.getState().currentNode, 'main'); } catch {}
                }
```

### Step 3: server/stripe-verify.js — T7 + G5

- [ ] **Step 3:** Modify `server/stripe-verify.js` `verifyCheckoutIsFree` —— 在每个 `resolve(...)` 处按主代理通道反馈结果。

Find:

```js
    const proxy = proxyMgr.getProxyUrl() || '';
    const py = spawn('py', ['-3', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      py.kill();
      resolve({ ok: false, reason: 'stripe_init_timeout' });
    }, TIMEOUT_MS);
```

Replace with:

```js
    const proxy = proxyMgr.getProxyUrl() || '';
    const currentNode = proxyMgr.getState().currentNode || '';
    const reportFail = (reason) => {
      if (currentNode && proxyMgr.getState().enabled) {
        try { proxyMgr.recordBadAttempt(currentNode, 'main', reason); } catch {}
      }
    };
    const reportOk = () => {
      if (currentNode && proxyMgr.getState().enabled) {
        try { proxyMgr.recordGoodAttempt(currentNode, 'main'); } catch {}
      }
    };
    const py = spawn('py', ['-3', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      py.kill();
      reportFail('stripe_init_timeout');
      resolve({ ok: false, reason: 'stripe_init_timeout' });
    }, TIMEOUT_MS);
```

Find:

```js
    py.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: 'spawn_error', raw: e.message?.slice(0, 200) });
    });
```

Replace with:

```js
    py.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      // spawn_error = 本地 Python 问题，不是节点问题
      resolve({ ok: false, reason: 'spawn_error', raw: e.message?.slice(0, 200) });
    });
```

(spawn_error 不上报 —— 与 chatgpt-checkout.js 的"spawn 错误不算节点问题"对齐。)

Find:

```js
    py.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      let parsed;
      try { parsed = JSON.parse(stdout); }
      catch {
        resolve({ ok: false, reason: 'stripe_init_unparsable', raw: stderr.slice(-200) });
        return;
      }
      if (parsed.status !== 'success') {
        const reason = parsed.reason || 'stripe_init_error';
        // Map common Stripe HTTP failures to canonical reasons per design spec.
        if (/init_http_40[13]/.test(reason)) {
          resolve({ ok: false, reason: 'stripe_init_403' });
          return;
        }
        resolve({ ok: false, reason });
        return;
      }
      resolve(parseInitResponse(parsed.data));
    });
```

Replace with:

```js
    py.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      let parsed;
      try { parsed = JSON.parse(stdout); }
      catch {
        reportFail('stripe_init_unparsable');
        resolve({ ok: false, reason: 'stripe_init_unparsable', raw: stderr.slice(-200) });
        return;
      }
      if (parsed.status !== 'success') {
        const reason = parsed.reason || 'stripe_init_error';
        reportFail(reason);
        if (/init_http_40[13]/.test(reason)) {
          resolve({ ok: false, reason: 'stripe_init_403' });
          return;
        }
        resolve({ ok: false, reason });
        return;
      }
      // G5: 节点可达 + Stripe 响应解析成功
      reportOk();
      resolve(parseInitResponse(parsed.data));
    });
```

### Step 4: 跑现有 stripe-verify 单测确认无回归

- [ ] **Step 4:**

Run: `node --test server/__tests__/stripe-verify.test.js`
Expected: PASS（覆盖的是 pure helpers，与 proxy 调用无关）

### Step 5: Commit

- [ ] **Step 5:**

```bash
git add server/engine.js protocol-engine.js server/stripe-verify.js
git commit -m "$(cat <<'EOF'
feat(engines): wire connect-3-fail counters into main-proxy trigger points

- protocol-engine.js: T1 (tls_failure) / T2 (payment unreachable) / T8 (net error in catch) / G1 (业务返回算成功) / G3
- server/engine.js: T3 (payment unreachable) / T9 (login 网络错误) / G2 (login 成功) / G3
- server/stripe-verify.js: T7 (timeout / unparsable / non-success) / G5

所有 markBad 调用点改用 recordBadAttempt + 携带 channel + reason；
对应成功路径同步加 recordGoodAttempt（关键不变式 1）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6：chatgpt-checkout.js 触发点改造 · JP 通道

**Files:**
- Modify: `server/chatgpt-checkout.js`

### Step 1: 改 T4 / T5 / T6 + 加 G4

- [ ] **Step 1:** Replace the entire `fetchCheckoutLink` body so all 3 fail paths carry reason + the success path records good:

Find the section starting at `const timer = setTimeout(() => {`:

```js
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      py.kill();
      if (currentJpNode) {
        try { proxyMgr.markJpBad(currentJpNode); } catch {}
      }
      resolve({ link: '', title: '', raw: 'ERROR: Python timeout (60s)', pk: '' });
    }, 60000);
```

Replace with:

```js
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      py.kill();
      if (currentJpNode) {
        try { proxyMgr.recordBadAttempt(currentJpNode, 'jp', 'checkout_timeout'); } catch {}
      }
      resolve({ link: '', title: '', raw: 'ERROR: Python timeout (60s)', pk: '' });
    }, 60000);
```

Find:

```js
    py.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      try {
        const r = JSON.parse(stdout);
        const link = r.link || '';
        const raw = r.raw || r.error || '';
        if (link === '' && currentJpNode) {
          proxyMgr.markJpBad(currentJpNode);
        }
        resolve({ link, title: '', raw, pk: r.pk || '' });
      } catch {
        if (currentJpNode) proxyMgr.markJpBad(currentJpNode);
        resolve({ link: '', title: '', raw: `ERROR: ${stderr.slice(-200) || 'Python parse failed'}`, pk: '' });
      }
    });
```

Replace with:

```js
    py.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      try {
        const r = JSON.parse(stdout);
        const link = r.link || '';
        const raw = r.raw || r.error || '';
        if (currentJpNode) {
          if (link === '') {
            try { proxyMgr.recordBadAttempt(currentJpNode, 'jp', 'checkout_empty_link'); } catch {}
          } else {
            // G4: 拿到非空 link 算成功
            try { proxyMgr.recordGoodAttempt(currentJpNode, 'jp'); } catch {}
          }
        }
        resolve({ link, title: '', raw, pk: r.pk || '' });
      } catch {
        if (currentJpNode) {
          try { proxyMgr.recordBadAttempt(currentJpNode, 'jp', 'checkout_parse_failed'); } catch {}
        }
        resolve({ link: '', title: '', raw: `ERROR: ${stderr.slice(-200) || 'Python parse failed'}`, pk: '' });
      }
    });
```

注：`py.on('error', ...)` 的 spawn error 分支保持不动 —— 已有注释明确"不算 JP 节点问题"。

### Step 2: 跑现有 checkout 单测

- [ ] **Step 2:**

Run: `node --test server/__tests__/chatgpt-checkout.test.js`
Expected: PASS（覆盖的是 pure helpers / 早返回，与新增 reason 无关）

### Step 3: Commit

- [ ] **Step 3:**

```bash
git add server/chatgpt-checkout.js
git commit -m "$(cat <<'EOF'
feat(checkout): wire connect-3-fail counters into JP-channel trigger points

T4 (timeout) / T5 (empty link) / T6 (parse fail) 改用 recordBadAttempt + reason；
G4：拿到非空 link 调 recordGoodAttempt 清零计数。
spawn error 保持不上报（与既有"非节点问题"语义一致）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7：Config.vue 黑名单 UI

**Files:**
- Modify: `web/src/views/Config.vue`

### Step 1: 加模板分节

- [ ] **Step 1:** Modify `web/src/views/Config.vue` template — 在 `<el-divider content-position="left">JP-Checkout 通道</el-divider>` 整块（含其内部所有 `<el-form-item>`，约 90-136 行）之后、`<el-form-item label="代理状态" v-if="proxyStatus">` 之前，插入：

```vue
      <el-divider content-position="left">节点黑名单</el-divider>
      <el-form-item label="主代理黑名单">
        <div style="width: 700px">
          <div style="display:flex; gap:8px; margin-bottom:8px; align-items:center">
            <span style="font-size:12px; color:#909399">
              共 {{ blacklist.main.length }} 个节点 · 连续 {{ FAIL_THRESHOLD }} 次代理错误自动加入
            </span>
            <el-button size="small" :disabled="!blacklist.main.length" @click="clearChannel('main')">
              清空主代理黑名单
            </el-button>
            <el-button size="small" @click="loadBlacklist">刷新</el-button>
          </div>
          <el-table :data="blacklist.main" size="small" empty-text="（无）" max-height="260">
            <el-table-column prop="tag" label="节点" min-width="220" show-overflow-tooltip />
            <el-table-column label="剩余时间" width="110">
              <template #default="{ row }">{{ formatTtl(row.ttlRemainingMs) }}</template>
            </el-table-column>
            <el-table-column label="来源" width="80">
              <template #default="{ row }">
                <el-tag size="small" :type="row.source === 'manual' ? 'warning' : 'info'">
                  {{ row.source === 'manual' ? '手动' : '自动' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="reason" label="原因" min-width="140" show-overflow-tooltip />
            <el-table-column label="操作" width="80">
              <template #default="{ row }">
                <el-button size="small" link type="primary" @click="removeNode(row.tag, 'main')">
                  移除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-form-item>
      <el-form-item label="JP 通道黑名单">
        <div style="width: 700px">
          <div style="display:flex; gap:8px; margin-bottom:8px; align-items:center">
            <span style="font-size:12px; color:#909399">
              共 {{ blacklist.jp.length }} 个节点 · 连续 {{ FAIL_THRESHOLD }} 次代理错误自动加入
            </span>
            <el-button size="small" :disabled="!blacklist.jp.length" @click="clearChannel('jp')">
              清空 JP 黑名单
            </el-button>
            <el-button size="small" @click="loadBlacklist">刷新</el-button>
          </div>
          <el-table :data="blacklist.jp" size="small" empty-text="（无）" max-height="260">
            <el-table-column prop="tag" label="节点" min-width="220" show-overflow-tooltip />
            <el-table-column label="剩余时间" width="110">
              <template #default="{ row }">{{ formatTtl(row.ttlRemainingMs) }}</template>
            </el-table-column>
            <el-table-column label="来源" width="80">
              <template #default="{ row }">
                <el-tag size="small" :type="row.source === 'manual' ? 'warning' : 'info'">
                  {{ row.source === 'manual' ? '手动' : '自动' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="reason" label="原因" min-width="140" show-overflow-tooltip />
            <el-table-column label="操作" width="80">
              <template #default="{ row }">
                <el-button size="small" link type="primary" @click="removeNode(row.tag, 'jp')">
                  移除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-form-item>
```

### Step 2: 改 `<script setup>` 块

- [ ] **Step 2:** 把 `import { ref, reactive, onMounted } from 'vue'` 改为：

```js
import { ref, reactive, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
```

(原文件第 151 行只 import 了 `ElMessage`；要加 `ElMessageBox`。)

### Step 3: 加 state + 方法

- [ ] **Step 3:** 在 `const jpKddiTagSet = ref(new Set())` 之下（约第 159 行后）加：

```js
const FAIL_THRESHOLD = 3
const blacklist = ref({ main: [], jp: [] })
let blacklistTimer = null
```

在 `async function detectJpExit() { ... }` 之后或文件末尾（在 `</script>` 之前）加：

```js
async function loadBlacklist() {
  try {
    const { data } = await api.get('/proxy/blacklist')
    blacklist.value = data
  } catch {
    blacklist.value = { main: [], jp: [] }
  }
}

async function removeNode(tag, channel) {
  try {
    const { data } = await api.post('/proxy/blacklist/remove', { tag, channel })
    blacklist.value = data
    ElMessage.success(`已移除 ${tag}`)
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '移除失败')
  }
}

async function clearChannel(channel) {
  try {
    await ElMessageBox.confirm(
      `确认清空${channel === 'main' ? '主代理' : 'JP 通道'}黑名单？`,
      '确认操作',
      { type: 'warning' },
    )
  } catch { return }
  try {
    const { data } = await api.post('/proxy/blacklist/clear', { channel })
    blacklist.value = data
    ElMessage.success('已清空')
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '清空失败')
  }
}

function formatTtl(ms) {
  if (ms <= 0) return '已过期'
  const min = Math.floor(ms / 60000)
  const sec = Math.floor((ms % 60000) / 1000)
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`
}

onBeforeUnmount(() => {
  if (blacklistTimer) clearInterval(blacklistTimer)
})
```

### Step 4: 在 `onMounted` 末尾挂初始化 + 轮询

- [ ] **Step 4:** Find:

```js
onMounted(async () => {
  try {
    // ... existing config load logic ...
  } catch (err) {
    console.error('Failed to load config:', err)
  }
  await loadProxyStatus()
  await loadAllNodes()
})
```

在 `await loadAllNodes()` 之后加：

```js
  await loadBlacklist()
  blacklistTimer = setInterval(loadBlacklist, 10000)
```

### Step 5: 构建前端

- [ ] **Step 5:**

Run: `cd web && npm run build`
Expected: build 成功，`web/dist/index.html` 更新

### Step 6: 手动验证

- [ ] **Step 6:** 启动服务：

```bash
node server/index.js
```

打开 `http://localhost:3000/#/config`，确认：
- "节点黑名单"分节出现在 JP-Checkout 通道之下、代理状态之上
- 两个表格各自有"清空"按钮，无数据时显示"（无）"
- 点"刷新"按钮触发一次 GET /api/proxy/blacklist（看浏览器 Network 面板）
- `curl -X POST http://localhost:3000/api/proxy/blacklist/add -H 'content-type: application/json' -d '{"tag":"manual-test","channel":"main","reason":"smoke"}'` 后表格 10s 内出现 `manual-test`，"来源"标签为黄色"手动"
- 点该行"移除"，立刻消失
- 点"清空主代理黑名单"，弹确认对话框

### Step 7: Commit

- [ ] **Step 7:**

```bash
git add web/src/views/Config.vue web/dist/
git commit -m "$(cat <<'EOF'
feat(web/config): proxy blacklist tables for main + JP channels

新增"节点黑名单"分节，含主代理 + JP 两个 el-table：
节点 / 剩余 TTL / 来源(自动 vs 手动) / 原因 / 移除按钮。
顶部带"清空"按钮（ElMessageBox 二次确认）+ "刷新"按钮，
10s 自动轮询 GET /api/proxy/blacklist。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8：CHANGELOG + 人工验证清单

**Files:**
- Modify: `docs/CHANGELOG.md`

### Step 1: 追加 v2.20 节

- [ ] **Step 1:** Insert at the top of `docs/CHANGELOG.md` (在 `## v2.19.1 — 2026-05-23` 之前):

```markdown
## v2.20.0 — 2026-05-24

### Proxy Blacklist Threshold + Rotation Cursor Persistence

之前的代理黑名单是"一次失败立即拉黑 30 min"，对网络偶发抖动过于敏感；运维也没有 UI 入口移除误拉黑的节点；`refresh()` 每次都把 `rotationIndex` 重置为 0，导致顺序轮换模式下头部节点反复使用、尾部节点长期闲置。

**核心改动：**

- **连续 3 次失败计数**（中间任一次成功立刻清零）：新函数 `recordBadAttempt(tag, channel, reason)` / `recordGoodAttempt(tag, channel)`，旧 `markBad` / `markJpBad` 保留作 alias 向后兼容。
- **黑名单跨重启持久化**：新表 `proxy_blacklist (tag, channel, expires_at, reason, source)`，新模块 `server/proxy/blacklist.js` 封装 CRUD；首次 `refresh()` 时 hydrate 回内存 Map；TTL 30 min 行为保持。计数器仍在内存。
- **`refresh()` 不重置游标**：仅在节点列表变短时取模到合法范围，`currentNode` 跟随 `rotationIndex` 而非固定 `filtered[0]`。
- **4 个新 REST endpoint**：`GET /api/proxy/blacklist` / `POST /add` / `POST /remove` / `POST /clear`。
- **Config.vue 节点黑名单分节**：主代理 + JP 各一个 `el-table`（节点 / 剩余 TTL / 来源 / 原因 / 移除按钮 + 清空），10s 轮询。
- **触发点扩充**：除现有 3 个点（TLS / payment unreachable / JP checkout 空 link）外，新增 Stripe verify timeout / 协议模式网络类 catch / 浏览器模式 login 网络类 reason 三个。`isProxyNetError` 共享网络错误关键字识别。

**对外契约变化**：`getState().badNodes` 从 `{tag: expiryMs}` 升级为 `{tag: {expiresAt, reason, source}}`。Config.vue 不再读这个字段（专门走 `/api/proxy/blacklist`），无回归。

**单测**：`server/proxy/__tests__/index.test.js` +10 (U1-U10)、`rotation.test.js` 新建 +5 (R1-R5)、`blacklist.test.js` 新建 +6 (B1-B4 + 边界)、`server/__tests__/proxy-route-blacklist.test.js` 新建 +4。共新增 25 用例，无回归。

**Spec / Plan**：`docs/superpowers/specs/2026-05-24-proxy-blacklist-and-rotation-cursor-design.md` + `docs/superpowers/plans/2026-05-24-proxy-blacklist-and-rotation-cursor.md`。

```

### Step 2: 人工验证清单（运维侧）

- [ ] **Step 2:** 启动服务，按 spec 第 7 节"人工验证清单"逐条跑：
  - [ ] 节点连续 3 次失败入黑名单（控制台 `1/3 → 2/3 → 3/3`），UI 表格出现
  - [ ] 2 次失败 + 1 次成功后计数归零；下次失败重新从 1/3 开始
  - [ ] 重启 `node server/index.js`，黑名单条目仍在，剩余 TTL 接续衰减
  - [ ] 重启后内存计数器归零（控制台首次失败仍是 `1/3`）
  - [ ] UI 点"移除"：节点立刻从表中消失，下一轮 `rotate()` 能调度到它
  - [ ] 修改订阅 URL 后点"应用并启动代理"：`rotationIndex` 不归零
  - [ ] 订阅节点数从 10 减到 3：`rotationIndex = 7` 取模为 1，无异常
  - [ ] `curl -X POST /api/proxy/blacklist/add` 加入不存在的 tag：成功入表，rotate 自然跳过

### Step 3: Commit

- [ ] **Step 3:**

```bash
git add docs/CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs: v2.20.0 proxy blacklist threshold + rotation cursor

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 全套测试一遍

- [ ] 全部任务完成后：

```bash
node --test __tests__ server/__tests__ server/proxy/__tests__ && py -3 -m unittest tests.test_protocol_register_h1_fallback
```

Expected: 全 PASS（JS：原有 ~30 + 新 25 = ~55；Python：原有 unittest 保持）
