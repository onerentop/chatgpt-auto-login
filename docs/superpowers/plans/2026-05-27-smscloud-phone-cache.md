# smscloud 一号多绑号缓存实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** smscloud provider 在 add-phone 取号时复用未过期 + 未满 maxBindingsPerPhone 的号，节省接码方余额。

**Architecture:** 新建 SQLite 表 `smscloud_phone_cache` 持久化缓存。新模块 `server/smscloud-pool.js` 提供 `acquirePhone / markRejected / releaseBinding / expireOldEntries / listCache`，封装 SQL-first 逻辑参考 `phone-pool.js` 风格。`protocol-engine.js` smscloud branch 改调 `smscloud-pool.acquirePhone(... takeOrderFn)` 而非直接 takeOrder。`_finalizePhoneVerify` saturate 分支按 `meta.provider === 'smscloud'` 走 `markRejected + deferred-cancel.enqueue`。`server/smscloud-deferred-cancel.start(getDb)` 接口微变，tick 顺带跑过期清理 + cancel rejected entry。

**Tech Stack:** Node.js (CommonJS) + sql.js (WASM SQLite) + node:test。无外部新依赖。

**Spec:** `docs/superpowers/specs/2026-05-27-smscloud-phone-cache-design.md`

---

## File Structure

- **Create:** `server/smscloud-pool.js` —— smscloud cache CRUD + acquire API
- **Create:** `server/__tests__/smscloud-pool.test.js` —— 9 单测
- **Create:** `__tests__/protocol-engine-smscloud-cache.test.js` —— 2 集成测试
- **Modify:** `server/db.js` —— CREATE TABLE `smscloud_phone_cache` + 2 索引
- **Modify:** `protocol-engine.js` —— smscloud branch 改用 pool + acq 加 meta 字段 + saturate 分支按 meta 分流
- **Modify:** `server/smscloud-deferred-cancel.js` —— `start(getDb)` + `_tickOnce` 加过期清理 + cancel rejected
- **Modify:** `server/__tests__/smscloud-deferred-cancel.test.js` —— 适配新签名 + 加 2 新用例
- **Modify:** `server/index.js` —— `start(() => require('./db').getRawDb())`
- **Modify:** `docs/CHANGELOG.md` —— v2.45.0 节

---

## Task 1: db schema 加表

**Files:**
- Modify: `server/db.js` —— CREATE TABLE 区追加

依赖：无。

- [ ] **Step 1: 找到 `initDB` 的 `db.run(\`` 大块 CREATE TABLE 区（约 line 17-89），在 `phone_bindings` 表 CREATE 之后、`);` 闭合之前加：**

```sql
CREATE TABLE IF NOT EXISTS smscloud_phone_cache (
  order_no       TEXT PRIMARY KEY,
  phone          TEXT NOT NULL,
  api_key        TEXT NOT NULL,
  base_url       TEXT NOT NULL,
  taken_at_ms    INTEGER NOT NULL,
  bindings_used  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_smscloud_phone_cache_phone ON smscloud_phone_cache(phone);
CREATE INDEX IF NOT EXISTS idx_smscloud_phone_cache_active ON smscloud_phone_cache(status, taken_at_ms);
```

- [ ] **Step 2: 烟测 schema —— 启 server 看启动无错**

Run: `node -e "require('./server/db').initDB().then(() => { const db = require('./server/db').getRawDb(); const r = db.exec('SELECT name FROM sqlite_master WHERE type=\"table\" AND name=\"smscloud_phone_cache\"'); console.log(r[0]?.values || 'NONE'); process.exit(0); })"`
Expected: `[ [ 'smscloud_phone_cache' ] ]`

- [ ] **Step 3: 提交**

```bash
git add server/db.js
git commit -m "feat(db): 加 smscloud_phone_cache 表"
```

---

## Task 2: smscloud-pool 模块 + 9 单测（TDD）

**Files:**
- Create: `server/smscloud-pool.js`
- Test: `server/__tests__/smscloud-pool.test.js`

依赖：Task 1 完成（用 freshDb helper 自建表，不直接依赖 db.js，但模块设计参考 phone-pool）。

- [ ] **Step 1: 写 9 个失败测试**

Create `server/__tests__/smscloud-pool.test.js`:

```js
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
  const row = db.exec('SELECT bindings_used FROM smscloud_phone_cache WHERE order_no=\"O1\"');
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
  const row = db.exec('SELECT bindings_used FROM smscloud_phone_cache WHERE order_no=\"O2\"');
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
```

- [ ] **Step 2: 跑测试确认 9 个 FAIL**

Run: `node --test server/__tests__/smscloud-pool.test.js`
Expected: 9 失败 (MODULE_NOT_FOUND)

- [ ] **Step 3: 实现 `server/smscloud-pool.js`**

```js
// v2.45.0 — smscloud 一号多绑缓存。配 phone-pool.js 的 SQL-first 风格。
// 表 smscloud_phone_cache 由 server/db.js 在 initDB 时建。
// acquirePhone 优先复用未过期 + 未满 max + 未绑过本 email 的 entry，否则 takeOrderFn 拿新号。

function acquirePhone(db, email, maxBindingsPerPhone, expiryMs, excludePhones, takeOrderFn) {
  const now = Date.now();
  const exclusionClause = excludePhones.length > 0
    ? `AND phone NOT IN (${excludePhones.map(() => '?').join(',')})`
    : '';
  const r = db.exec(`
    SELECT order_no, phone, api_key, base_url, taken_at_ms, bindings_used
    FROM smscloud_phone_cache
    WHERE status = 'active'
      AND taken_at_ms + ? > ?
      AND bindings_used < ?
      AND phone NOT IN (SELECT phone FROM phone_bindings WHERE email = ?)
      ${exclusionClause}
    ORDER BY bindings_used ASC, taken_at_ms ASC
    LIMIT 1
  `, [expiryMs, now, maxBindingsPerPhone, email, ...excludePhones]);
  if (r.length && r[0].values.length) {
    const [orderNo, phone, apiKey, baseUrl, taken_at_ms, bindings_used] = r[0].values[0];
    db.run('INSERT INTO phone_bindings (phone, email) VALUES (?, ?)', [phone, email]);
    db.run('UPDATE smscloud_phone_cache SET bindings_used = bindings_used + 1 WHERE order_no = ?', [orderNo]);
    return Promise.resolve({ orderNo, phone, apiKey, baseUrl, taken_at_ms, bindings_used: bindings_used + 1, reused: true });
  }
  return Promise.resolve(takeOrderFn()).then(({ orderNo, phone, apiKey, baseUrl }) => {
    const taken_at_ms = Date.now();
    db.run(
      `INSERT INTO smscloud_phone_cache (order_no, phone, api_key, base_url, taken_at_ms, bindings_used, status)
       VALUES (?, ?, ?, ?, ?, 1, 'active')`,
      [orderNo, phone, apiKey, baseUrl, taken_at_ms]
    );
    db.run('INSERT INTO phone_bindings (phone, email) VALUES (?, ?)', [phone, email]);
    return { orderNo, phone, apiKey, baseUrl, taken_at_ms, bindings_used: 1, reused: false };
  });
}

function markRejected(db, orderNo) {
  db.run("UPDATE smscloud_phone_cache SET status = 'rejected' WHERE order_no = ?", [orderNo]);
}

function releaseBinding(db, orderNo, email, phone) {
  db.run('DELETE FROM phone_bindings WHERE phone = ? AND email = ?', [phone, email]);
  db.run('UPDATE smscloud_phone_cache SET bindings_used = MAX(0, bindings_used - 1) WHERE order_no = ?', [orderNo]);
}

function expireOldEntries(db, expiryMs) {
  const now = Date.now();
  const before = db.exec("SELECT COUNT(*) FROM smscloud_phone_cache WHERE status = 'active' AND taken_at_ms + ? < ?", [expiryMs, now]);
  const expired = before[0]?.values[0][0] || 0;
  db.run("DELETE FROM smscloud_phone_cache WHERE status = 'active' AND taken_at_ms + ? < ?", [expiryMs, now]);
  return { expired };
}

function listCache(db) {
  const r = db.exec(`
    SELECT order_no, phone, taken_at_ms, bindings_used, status
    FROM smscloud_phone_cache
    ORDER BY taken_at_ms DESC
  `);
  if (!r.length) return [];
  return r[0].values.map(([orderNo, phone, taken_at_ms, bindings_used, status]) => ({
    orderNo, phone, taken_at_ms, bindings_used, status,
  }));
}

module.exports = { acquirePhone, markRejected, releaseBinding, expireOldEntries, listCache };
```

- [ ] **Step 4: 跑测试确认 9/9 PASS**

Run: `node --test server/__tests__/smscloud-pool.test.js`
Expected: 9/9 pass

- [ ] **Step 5: 提交**

```bash
git add server/smscloud-pool.js server/__tests__/smscloud-pool.test.js
git commit -m "feat(smscloud-pool): 加 acquirePhone/markRejected/releaseBinding/expireOldEntries"
```

---

## Task 3: protocol-engine 改造 + 集成测试

**Files:**
- Modify: `protocol-engine.js` —— smscloud branch + acq.meta + saturate 分支
- Test: `__tests__/protocol-engine-smscloud-cache.test.js` (新)

依赖：Task 1 + Task 2 完成。

- [ ] **Step 1: 写 2 个集成测试（先写测试）**

Create `__tests__/protocol-engine-smscloud-cache.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

let _origCfg = null;
function setupCfg() {
  try { _origCfg = fs.readFileSync(CONFIG_PATH, 'utf-8'); } catch { _origCfg = null; }
  const merged = _origCfg ? JSON.parse(_origCfg) : {};
  merged.phonePool = Object.assign({}, merged.phonePool, {
    enabled: true,
    provider: 'smscloud',
    maxBindingsPerPhone: 3,
    smscloud: { apiKey: 'k', baseUrl: 'b', serviceCode: 'tg', countryCode: 187 },
  });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
}
function restoreCfg() {
  if (_origCfg !== null) fs.writeFileSync(CONFIG_PATH, _origCfg);
  else try { fs.unlinkSync(CONFIG_PATH); } catch {}
}

async function freshEngine() {
  // 重置 require cache + 在 db 表里建 smscloud_phone_cache（也建 phone_bindings 让 acquire 工作）
  delete require.cache[require.resolve('../protocol-engine')];
  delete require.cache[require.resolve('../server/smscloud-pool')];
  delete require.cache[require.resolve('../server/db')];
  const dbMod = require('../server/db');
  await dbMod.initDB();  // 实表已含 smscloud_phone_cache 由 Task 1 加
  const rawDb = dbMod.getRawDb();
  // 测试隔离：清表
  rawDb.run('DELETE FROM smscloud_phone_cache');
  rawDb.run('DELETE FROM phone_bindings');
  const { ProtocolEngine } = require('../protocol-engine');
  return { engine: new ProtocolEngine(), rawDb, protoMod: require('../protocol-engine') };
}

test('SC1 两账号连续 add-phone：第 2 个复用 cache 号，takeOrder 只调一次', async () => {
  setupCfg();
  try {
    const { engine, rawDb, protoMod } = await freshEngine();

    let takeOrderCalls = 0;
    // patch smscloud.takeOrder 通过 require cache
    delete require.cache[require.resolve('../server/smscloud-provider')];
    const smscloud = require('../server/smscloud-provider');
    const origTake = smscloud.takeOrder;
    smscloud.takeOrder = async () => {
      takeOrderCalls++;
      return { order_no: 'OO1', phone: '+15550001111', raw: {} };
    };

    const orig = protoMod.__runProtocolPhoneVerify;
    protoMod.__setRunProtocolPhoneVerify(async () => ({ status: 'ok', tokens: { access_token: 'tok' } }));

    try {
      const r1 = await engine._finalizePhoneVerify({}, { email: 'u1@x.com' });
      assert.ok(r1.tokens, 'account 1 success');
      const r2 = await engine._finalizePhoneVerify({}, { email: 'u2@x.com' });
      assert.ok(r2.tokens, 'account 2 success');
      assert.strictEqual(takeOrderCalls, 1, 'takeOrder only called once (cache reused)');
      const row = rawDb.exec("SELECT bindings_used FROM smscloud_phone_cache WHERE order_no='OO1'");
      assert.strictEqual(row[0].values[0][0], 2, 'bindings_used = 2');
    } finally {
      smscloud.takeOrder = origTake;
      protoMod.__setRunProtocolPhoneVerify(orig);
    }
  } finally { restoreCfg(); }
});

test('SC2 rate-limited → cache entry 标 rejected + deferred-cancel queue 含该 orderNo', async () => {
  setupCfg();
  try {
    const { engine, rawDb, protoMod } = await freshEngine();

    delete require.cache[require.resolve('../server/smscloud-provider')];
    const smscloud = require('../server/smscloud-provider');
    const origTake = smscloud.takeOrder;
    let takeCalls = 0;
    smscloud.takeOrder = async () => {
      takeCalls++;
      return { order_no: 'OO' + takeCalls, phone: '+1555' + String(takeCalls).padStart(7, '0'), raw: {} };
    };

    delete require.cache[require.resolve('../server/smscloud-deferred-cancel')];
    const deferred = require('../server/smscloud-deferred-cancel');
    // 已经 in-memory queue，无需 patch

    const orig = protoMod.__runProtocolPhoneVerify;
    let i = 0;
    protoMod.__setRunProtocolPhoneVerify(async () => {
      i++;
      if (i === 1) return { status: 'rate-limited', detail: 'rate_limit_exceeded' };
      return { status: 'ok', tokens: { access_token: 'tok' } };
    });

    try {
      const r = await engine._finalizePhoneVerify({}, { email: 'u3@x.com' });
      assert.ok(r.tokens, 'attempt 2 success');
      // cache 第一个 entry rejected
      const rejected = rawDb.exec("SELECT order_no FROM smscloud_phone_cache WHERE status='rejected'");
      assert.deepStrictEqual(rejected[0].values.map(v => v[0]), ['OO1']);
      // deferred queue 含 OO1
      assert.ok(deferred._queueForTest().has('OO1'), 'OO1 enqueued for deferred cancel');
    } finally {
      smscloud.takeOrder = origTake;
      protoMod.__setRunProtocolPhoneVerify(orig);
    }
  } finally { restoreCfg(); }
});
```

**Note**：测试需要操作 `server/db.js` 真实 DB（含 Task 1 加的 smscloud_phone_cache 表）。`freshEngine()` 调 `initDB()` + 清表保证隔离。**`config.json` 测试期间被改写**，restoreCfg 还原；commit 时 `git status` 确认 config.json 不在 staged。

- [ ] **Step 2: 跑测试确认 2 个 FAIL**

Run: `node --test "__tests__/protocol-engine-smscloud-cache.test.js"`
Expected: 2 失败 (smscloud branch 还在直接 takeOrder)

- [ ] **Step 3: 改 `protocol-engine.js` smscloud branch（line 207-241）**

把整个 `if (provider === 'smscloud') { ... }` 块替换为：

```js
    if (provider === 'smscloud') {
      const s = cfg.phonePool.smscloud || {};
      if (!s.apiKey || !s.serviceCode || !s.countryCode) {
        console.log(`[protocol] smscloud config incomplete (apiKey/serviceCode/countryCode 任一为空)`);
        return {};
      }
      try {
        const smscloud = require('./server/smscloud-provider');
        const smscloudPool = require('./server/smscloud-pool');
        const max = cfg.phonePool.maxBindingsPerPhone || 3;
        const EXPIRY_MS = 18 * 60 * 1000;
        const baseUrl = s.baseUrl || 'https://smscloud.sbs/api/system';
        const takeOrderFn = async () => {
          const order = await smscloud.takeOrder(s.apiKey, baseUrl, s.serviceCode, s.countryCode);
          if (!order || !order.phone) throw new Error('takeOrder empty');
          return { orderNo: order.order_no, phone: order.phone, apiKey: s.apiKey, baseUrl };
        };
        const acq = await smscloudPool.acquirePhone(getRawDb(), email, max, EXPIRY_MS, excludePhones, takeOrderFn);
        try { save(); } catch {}
        console.log(`[protocol] smscloud ${acq.reused ? '复用' : '新取'}号 ${acq.phone} (orderNo=${acq.orderNo}, bindings=${acq.bindings_used})`);
        return {
          phone: acq.phone,
          smsConfig: { provider: 'smscloud', order_no: acq.orderNo, api_key: acq.apiKey, base_url: acq.baseUrl },
          releaseFn: async () => {
            try {
              smscloudPool.releaseBinding(getRawDb(), acq.orderNo, email, acq.phone);
              save();
            } catch (e) {
              console.log(`[protocol] smscloud releaseBinding failed: ${e?.message?.slice(0, 60)}`);
            }
          },
          meta: {
            provider: 'smscloud',
            orderNo: acq.orderNo,
            apiKey: acq.apiKey,
            baseUrl: acq.baseUrl,
            takenAtMs: acq.taken_at_ms,
          },
        };
      } catch (e) {
        console.log(`[protocol] smscloud acquire failed: ${e?.message?.slice(0, 60)}`);
        return {};
      }
    }
```

注意：`save` 是 `server/db.js` 的 export，已在 protocol-engine.js 顶部 require（grep 验证；不在的话需顶部加 `const { save, getRawDb } = require('./server/db');`）。

- [ ] **Step 4: `_finalizePhoneVerify` saturate 分支按 meta 分流**

找 protocol-engine.js:298-316 的 rate-limited / fraud-blocked / voip-blocked if 块。当前形态（v2.44.1）：

```js
      if (result.status === 'rate-limited' || result.status === 'fraud-blocked' || result.status === 'voip-blocked') {
        console.log(`[protocol] ${result.status} for ${phone}: ${(result.detail || '').slice(0, 500)}, retry with new phone`);
        if (provider === 'local') {
          try {
            const max = cfg.phonePool.maxBindingsPerPhone || 3;
            phonePool.markPhoneSaturated(getRawDb(), phone, max);
            save();
          } catch (e) { console.log(`[protocol] markPhoneSaturated err: ${e?.message}`); }
        } else {
          if (releaseFn) try { await releaseFn(); } catch {}
          try { save(); } catch {}
        }
        lastReason = result.status;
        continue;
      }
```

`_finalizePhoneVerify` 的解构 `const { phone, smsConfig, releaseFn } = acq;` 改为 `const { phone, smsConfig, releaseFn, meta } = acq;`（找 line 276，原 `const { phone, smsConfig, releaseFn } = acq;`）。

然后把 else 分支按 meta.provider 拆分：

```js
      if (result.status === 'rate-limited' || result.status === 'fraud-blocked' || result.status === 'voip-blocked') {
        console.log(`[protocol] ${result.status} for ${phone}: ${(result.detail || '').slice(0, 500)}, retry with new phone`);
        if (provider === 'local') {
          try {
            const max = cfg.phonePool.maxBindingsPerPhone || 3;
            phonePool.markPhoneSaturated(getRawDb(), phone, max);
            save();
          } catch (e) { console.log(`[protocol] markPhoneSaturated err: ${e?.message}`); }
        } else if (meta?.provider === 'smscloud') {
          try {
            const smscloudPool = require('./server/smscloud-pool');
            const deferredCancel = require('./server/smscloud-deferred-cancel');
            smscloudPool.markRejected(getRawDb(), meta.orderNo);
            deferredCancel.enqueue({ apiKey: meta.apiKey, baseUrl: meta.baseUrl, orderNo: meta.orderNo, takenAtMs: meta.takenAtMs });
            save();
          } catch (e) { console.log(`[protocol] smscloud markRejected err: ${e?.message}`); }
        } else {
          if (releaseFn) try { await releaseFn(); } catch {}
          try { save(); } catch {}
        }
        lastReason = result.status;
        continue;
      }
```

注：**不调** releaseFn 在 smscloud saturate 分支 —— releaseFn 是 releaseBinding 撤本次 binding；但 saturate 时 binding 应保留作为"该号本账号已试过"的记录（避免本 session retry 又分到同号）。

- [ ] **Step 5: 跑集成测试**

Run: `node --test "__tests__/protocol-engine-smscloud-cache.test.js"`
Expected: 2/2 pass

- [ ] **Step 6: 跑全套测试**

Run: `npm test`
Expected: 全套 pass（v2.44.1 的现有测试不受影响 —— meta 字段是 additive，zhusms/local branch 不返 meta，saturate 分支 `meta?.provider === 'smscloud'` false 走原 else 路径）

- [ ] **Step 7: 提交**

确认 `git status` config.json 不在 staged，然后：

```bash
git add protocol-engine.js __tests__/protocol-engine-smscloud-cache.test.js
git commit -m "feat(protocol): smscloud add-phone 使用 cache 复用号 + saturate 按 meta 分流"
```

---

## Task 4: deferred-cancel 扩展（start(getDb) + tick 顺带 expire + cancel rejected）

**Files:**
- Modify: `server/smscloud-deferred-cancel.js`
- Modify: `server/__tests__/smscloud-deferred-cancel.test.js`（适配 + 2 新用例）

依赖：Task 1 + Task 2 完成。

- [ ] **Step 1: 改 `server/smscloud-deferred-cancel.js`**

把 `start()` 改为 `start(getDb)`，并把 `_tickOnce()` 改为 `_tickOnce(getDb)`：

```js
// v2.45.0 — 扩展：tick 顺带跑 smscloud_phone_cache 过期清理 + cancel rejected entry
// （v2.44.1 的 deferred queue cancel 行为保留）

const READY_DELAY_MS = 125_000;
const TICK_INTERVAL_MS = 30_000;
const MAX_ATTEMPTS = 3;
const EXPIRY_MS = 18 * 60 * 1000;

const _queue = new Map();
let _timer = null;
let _ticking = false;
let _getDb = null;

function enqueue({ apiKey, baseUrl, orderNo, takenAtMs }) {
  if (!orderNo) return;
  if (_queue.has(orderNo)) return;
  _queue.set(orderNo, { apiKey, baseUrl, orderNo, takenAtMs, attempts: 0 });
  console.log(`[smscloud-deferred-cancel] enqueued orderNo=${orderNo} takenAtMs=${takenAtMs}`);
}

async function _processDeferredQueue() {
  const smscloud = require('./smscloud-provider');
  const now = Date.now();
  for (const entry of [..._queue.values()]) {
    if (now < entry.takenAtMs + READY_DELAY_MS) continue;
    entry.attempts++;
    try {
      await smscloud.cancelOrder(entry.orderNo, entry.apiKey, entry.baseUrl);
      _queue.delete(entry.orderNo);
      console.log(`[smscloud-deferred-cancel] cancelled orderNo=${entry.orderNo} ok`);
    } catch (e) {
      console.log(`[smscloud-deferred-cancel] cancel orderNo=${entry.orderNo} attempt=${entry.attempts}/${MAX_ATTEMPTS} failed: ${e?.message?.slice(0, 200)}`);
      if (entry.attempts >= MAX_ATTEMPTS) {
        _queue.delete(entry.orderNo);
        console.log(`[smscloud-deferred-cancel] dropped orderNo=${entry.orderNo} after ${MAX_ATTEMPTS} attempts`);
      }
    }
  }
}

async function _processCacheMaintenance(getDb) {
  if (!getDb) return;
  let db;
  try { db = getDb(); } catch { return; }
  if (!db) return;
  const smscloudPool = require('./smscloud-pool');
  const smscloud = require('./smscloud-provider');
  // 1) 过期 active entry 清理
  try {
    const r = smscloudPool.expireOldEntries(db, EXPIRY_MS);
    if (r.expired > 0) console.log(`[smscloud-deferred-cancel] expired ${r.expired} cache entry(s)`);
  } catch (e) { console.log(`[smscloud-deferred-cancel] expire err: ${e?.message?.slice(0, 200)}`); }
  // 2) rejected entry 调 cancelOrder + 删
  let rejectedRows;
  try {
    rejectedRows = db.exec("SELECT order_no, api_key, base_url, taken_at_ms FROM smscloud_phone_cache WHERE status='rejected'");
  } catch (e) { console.log(`[smscloud-deferred-cancel] query rejected err: ${e?.message?.slice(0, 200)}`); return; }
  if (!rejectedRows.length || !rejectedRows[0].values.length) return;
  for (const [orderNo, apiKey, baseUrl, takenAtMs] of rejectedRows[0].values) {
    if (Date.now() < takenAtMs + READY_DELAY_MS) {
      enqueue({ apiKey, baseUrl, orderNo, takenAtMs });
      continue;
    }
    try {
      const r = await smscloud.cancelOrder(orderNo, apiKey, baseUrl);
      if (r && r.deferred) {
        enqueue({ apiKey, baseUrl, orderNo, takenAtMs });
        continue;
      }
      db.run("DELETE FROM smscloud_phone_cache WHERE order_no = ?", [orderNo]);
      console.log(`[smscloud-deferred-cancel] cancelled+deleted rejected orderNo=${orderNo}`);
    } catch (e) {
      console.log(`[smscloud-deferred-cancel] rejected cancel orderNo=${orderNo} failed: ${e?.message?.slice(0, 200)}, leaving in cache`);
    }
  }
}

async function _tickOnce(getDb) {
  await _processDeferredQueue();
  await _processCacheMaintenance(getDb || _getDb);
}

function start(getDb) {
  if (_timer) return;
  _getDb = getDb || null;
  _timer = setInterval(async () => {
    if (_ticking) return;
    _ticking = true;
    try { await _tickOnce(_getDb); }
    catch (e) { console.log(`[smscloud-deferred-cancel] tick error: ${e?.message?.slice(0, 200)}`); }
    finally { _ticking = false; }
  }, TICK_INTERVAL_MS);
  _timer.unref?.();
  console.log(`[smscloud-deferred-cancel] started, tick=${TICK_INTERVAL_MS}ms`);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _getDb = null;
}

module.exports = { enqueue, start, stop, _tickOnce, _processDeferredQueue, _processCacheMaintenance, _queueForTest: () => _queue };
```

- [ ] **Step 2: 适配现有 4 个测试用例**

打开 `server/__tests__/smscloud-deferred-cancel.test.js`。现有用例调 `mod._tickOnce()` 无参 —— 改为 `mod._tickOnce(null)`（明确 getDb=null 跳过 cache maintenance），其他保持不变。或者用 `mod._processDeferredQueue()` 直接调 queue 部分（更精确，绕开 cache 路径）。

推荐改成调 `mod._processDeferredQueue()`（4 处替换 `_tickOnce()` → `_processDeferredQueue()`），语义更清晰。

- [ ] **Step 3: 追加 2 个新用例**

In `server/__tests__/smscloud-deferred-cancel.test.js` 末尾：

```js
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
```

- [ ] **Step 4: 跑测试**

Run: `node --test server/__tests__/smscloud-deferred-cancel.test.js`
Expected: 6/6 pass（原 4 + 新 2）

- [ ] **Step 5: 跑全套测试无回归**

Run: `npm test`
Expected: pass

- [ ] **Step 6: 提交**

```bash
git add server/smscloud-deferred-cancel.js server/__tests__/smscloud-deferred-cancel.test.js
git commit -m "feat(deferred-cancel): tick 顺带跑 cache 过期清理 + cancel rejected entry"
```

---

## Task 5: server/index.js wire-up + CHANGELOG + tag

**Files:**
- Modify: `server/index.js` —— `start(getDb)`
- Modify: `docs/CHANGELOG.md`

依赖：Task 4 完成。

- [ ] **Step 1: 改 server/index.js wire-up**

找到 v2.44.1 加的 `require('./smscloud-deferred-cancel').start();` 这一行，改成：

```js
  require('./smscloud-deferred-cancel').start(() => require('./db').getRawDb());
```

`stop()` 行不动（无参形式仍兼容）。

- [ ] **Step 2: 烟测 server 启动**

后台启 server 6s，看启动日志有 `[smscloud-deferred-cancel] started, tick=30000ms`，无 stack。

Run（PowerShell 一行，已在项目 root）：
```
$p = Start-Process -FilePath node -ArgumentList 'server/index.js' -PassThru -NoNewWindow -RedirectStandardOutput .\_smoke.log -RedirectStandardError .\_smoke.err; Start-Sleep -Seconds 6; Stop-Process -Id $p.Id -Force; Get-Content .\_smoke.log -Tail 10; Remove-Item .\_smoke.log, .\_smoke.err
```

Expected output 含 `started, tick=30000ms` 行。

- [ ] **Step 3: 加 v2.45.0 CHANGELOG 节**

找到 v2.44.1 节，在它上方插入：

```markdown
## v2.45.0 — 2026-05-27 — smscloud 一号多绑号缓存

### 核心改动

- 新建 `server/smscloud-pool.js`：smscloud 接码方号本地缓存，SQL-first 风格仿 `phone-pool.js`。提供 `acquirePhone / markRejected / releaseBinding / expireOldEntries / listCache`。`acquirePhone` 优先复用 `smscloud_phone_cache` 表中未过期（18min buffer）+ 未满 `maxBindingsPerPhone` + 未与本 email 绑过的 entry，否则回退 `takeOrderFn` 拿新号。
- 新表 `smscloud_phone_cache (order_no PK, phone, api_key, base_url, taken_at_ms, bindings_used, status)`，由 `server/db.js initDB` 建表 + 2 索引。
- `protocol-engine.js _acquirePhoneForProtocol` smscloud branch 改调 `smscloudPool.acquirePhone(..., takeOrderFn)`；返对象新增 `meta: { provider, orderNo, apiKey, baseUrl, takenAtMs }` 让 `_finalizePhoneVerify` saturate 分支精确定位 cache entry。
- `_finalizePhoneVerify` rate-limited / fraud-blocked / voip-blocked 分支按 `meta?.provider === 'smscloud'` 分流：调 `smscloudPool.markRejected(orderNo)` + `deferredCancel.enqueue(...)`，不调 releaseFn（保留 binding 记录避免本 session 内同账号重选同号）。
- `server/smscloud-deferred-cancel.start(getDb)` 接口微变（v2.44.1 是无参）；`_tickOnce` 现在做三件事：v2.44.1 deferred queue cancel + cache 过期清理 + cancel rejected entry。`server/index.js` wire-up 同步改成 `start(() => require('./db').getRawDb())`。

### 端到端验证

- 跑 smscloud 配置下连续激活 2 个账号，日志：第 1 个 `smscloud 新取号 +XXX (orderNo=Y, bindings=1)`，第 2 个 `smscloud 复用号 +XXX (orderNo=Y, bindings=2)`，smscloud 余额仅扣 1 次。
- 跑同账号触发 rate-limited，`smscloud_phone_cache` entry `status='rejected'`，下个账号 acquire 跳过该号 takeOrder 新号；deferred-cancel queue 含 orderNo；2 分钟后 cancel + 删 entry。
- 单测新增 9 个 smscloud-pool + 2 个 deferred-cancel 扩展 + 2 个 protocol-engine 集成。`npm test` 全绿（无回归）。
- 进程重启后未过期号继续命中 cache。

### 对照前版（v2.44.1）

- smscloud 取号从"每次 takeOrder 拿新号"改为"先查本地 cache 复用"，节省接码方余额。
- `_finalizePhoneVerify` saturate 分支按 `meta.provider` 分流（v2.44.1 是按运行时 `provider` 变量，smscloud / zhusms 都走 releaseFn）。zhusms 行为不变。
- `start()` 接口微变 —— 由调用方传 `getDb` getter 给 worker 用于 cache 维护。无 getDb 的旧调用方仍可调（cache 维护静默跳过），向后兼容。
```

- [ ] **Step 4: 提交 + 打 tag**

```bash
git add server/index.js docs/CHANGELOG.md
git commit -m "feat(server): wire smscloud-deferred-cancel getDb 给 cache 维护 + CHANGELOG v2.45.0"
git tag v2.45.0
```

不 push。

---

## Self-Review

- **Spec coverage**：
  - spec §2 D1-D8 全部映射到 plan Task 1-5 ✓
  - spec §3.1 schema → Task 1 ✓
  - spec §3.2 smscloud-pool 模块 → Task 2 ✓
  - spec §3.3 protocol-engine smscloud branch → Task 3 ✓
  - spec §3.4 saturate fail 映射 + meta → Task 3 ✓
  - spec §3.5 deferred-cancel 扩展 + start(getDb) → Task 4 + Task 5 ✓
  - spec §3.6 测试 → Task 2 + Task 3 + Task 4 ✓
- **Placeholder scan**：无 TBD / TODO / "fill in" / "similar to" ✓
- **Type consistency**：
  - `acq.taken_at_ms`（pool 返）= `meta.takenAtMs`（protocol-engine 用）—— 字段命名不一致但显式映射在 protocol-engine.js Task 3 Step 3 内代码注明 ✓
  - `smscloudPool` / `deferredCancel` 引用一致 ✓
  - `EXPIRY_MS = 18 * 60 * 1000` 在 protocol-engine.js + smscloud-deferred-cancel.js 重复定义 —— 不抽常量模块（YAGNI）但两处必须值相同，已 plan 内显式写两遍同值 ✓

---

## Execution Handoff

Plan 落到 `docs/superpowers/plans/2026-05-27-smscloud-phone-cache.md`。

两种执行方式：

1. **Subagent-Driven（推荐）** —— 每 Task 派 implementer subagent，两轮 review，本会话内顺着 5 个 Task 顺序执行，最后报告
2. **Inline Execution** —— 本会话主体 Claude 逐 Task 执行，checkpoint 处给你看

选哪个？
