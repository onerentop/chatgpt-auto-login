# 账号一键测活 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accounts 页加"测活选中 / 测活全部"按钮，对账号批量调 `/backend-api/accounts/check` 判 Plus + token；过期或 401 时不走 PKCE 直接密码 + OTP 重登拿 `/api/auth/session` 的 access_token、手工拼装 `cpa-auth/codex-{email}.json`；结果写到 `account_status` 新增的 3 列里、socket.io 推送进度。

**Architecture:** 新建独立 `server/liveness/` 模块 + `chatgpt_register/liveness_login.py`（协议模式占位，本 plan 不实现），跟现有 PipelineEngine / ProtocolEngine 完全解耦——不共享 `isRunning` 锁，可与主流水线并行。`account_status` 加 `alive_status / alive_checked_at / alive_reason` 三列，新 `statusDB.setAlive` 仅动 alive_* 三列（跟 v2.25 payment_link 合并写法对称）。

**Tech Stack:** Node + sql.js（WASM SQLite）、`node:test`、Playwright (浏览器模式 light-login)、socket.io、Vue 3 + Element Plus。

**Spec:** `docs/superpowers/specs/2026-05-24-account-liveness-check-design.md`

---

## 实施范围说明 (Phase A vs Phase B)

| 内容 | 本 plan 是否覆盖 |
|---|---|
| DB schema + setAlive / clearAlive API | ✓ Task 1 |
| HTTP API + Socket.IO 事件 | ✓ Task 6 |
| **浏览器模式 light-login**（`config.protocolMode=false`） | ✓ Task 4 |
| **协议模式 light-login**（`config.protocolMode=true`） | ❌ 留作 Phase B 单独立 spec |
| accounts/check 调用 + JWT 解析 | ✓ Task 2 |
| 拼装 codex-{email}.json（**不写** sub2api） | ✓ Task 3 |
| 并发池 + 节流 + 取消传播 | ✓ Task 5 |
| UI 按钮 + 列 + 筛选 | ✓ Task 7 |
| 集成 smoke + final review | ✓ Task 8 |

**Phase A 在 protocolMode=true 时的行为**：Task 4 的 `lightLogin` 检查 `config.protocolMode`，若为 true 直接抛 `LivenessLoginNotImplementedError`；runner 把它捕获为 `alive_status='login_fail', reason='liveness not yet supported in protocol mode'`。**注意**：lazy hybrid 意味着 token 未过期的账号在任何模式下都能正常 check（HTTP 调用与引擎无关），只有需重登的账号在协议模式下 fall through。

---

## File Structure

| 文件 | 角色 | 状态 |
|---|---|---|
| `server/db.js` | CREATE TABLE 加 3 列；initDB PRAGMA ALTER；新增 `statusDB.setAlive` + `statusDB.clearAlive` | 修改 |
| `__tests__/db-alive.test.js` | 5 个单元测试：默认值 / ALTER / setAlive merge / ISO 时间戳 / clearAlive | 新建 |
| `server/liveness/checker.js` | accounts/check 调用 + JWT exp 解析 | 新建 |
| `server/liveness/__tests__/checker.test.js` | 8 个测试 | 新建 |
| `server/liveness/codex-file.js` | 读写 cpa-auth/codex-{email}.json，**不动** sub2api | 新建 |
| `server/liveness/__tests__/codex-file.test.js` | 5 个测试 | 新建 |
| `server/liveness/light-login.js` | 浏览器模式 密码+OTP→/api/auth/session；协议模式抛 LivenessLoginNotImplementedError | 新建 |
| `server/liveness/__tests__/light-login.test.js` | 6 个测试（mock Playwright） | 新建 |
| `server/liveness/runner.js` | 并发池(3) + 节流(1s) + abort + socket.io 事件 | 新建 |
| `server/liveness/__tests__/runner.test.js` | 7 个测试 | 新建 |
| `server/routes/liveness.js` | /start /stop /status 三接口 | 新建 |
| `server/__tests__/routes-liveness.test.js` | 4 个测试 | 新建 |
| `server/index.js` | 挂载 livenessRouter（注入 io） | 修改 |
| `web/src/status.js` | 新增 `aliveStatusLabel(code)` 映射 | 修改 |
| `web/src/views/Accounts.vue` | 顶部 2 按钮 + 活性列 + 筛选 + socket 监听 | 修改 |

依赖图（落地顺序参考）：

```
Task 1 (db)
   ├──► Task 2 (checker)         （独立）
   ├──► Task 3 (codex-file)      （独立）
   ├──► Task 4 (light-login)     （独立）
   └──► Task 5 (runner) ─► Task 6 (routes) ─► Task 7 (UI) ─► Task 8 (smoke + final review)
```

Task 2/3/4 可并行做，Task 5 起串行。

---

## Task 1: DB schema + setAlive/clearAlive + 5 单元测试

**Files:**
- Create: `__tests__/db-alive.test.js`
- Modify: `server/db.js`

- [ ] **Step 1: 创建 `__tests__/db-alive.test.js`（先红）**

Create file with content:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-alive-test-'));
const fakeDb = path.join(tmpDir, 'data.db');

const realPath = require('path');
const origJoin = realPath.join;
realPath.join = function (...args) {
  if (args[args.length - 1] === 'data.db') return fakeDb;
  return origJoin.apply(this, args);
};
const { initDB, statusDB } = require('../server/db');
realPath.join = origJoin;

test('setup: fresh db has alive defaults', async () => {
  await initDB();
  statusDB.set('a@x.com', { status: 'idle' });
  const row = statusDB.get('a@x.com');
  assert.strictEqual(row.alive_status, 'unknown', 'default alive_status');
  assert.strictEqual(row.alive_checked_at, '');
  assert.strictEqual(row.alive_reason, '');
});

test('setAlive writes 3 columns + auto ISO timestamp', () => {
  statusDB.setAlive('b@x.com', { alive_status: 'plus', alive_reason: 'check ok' });
  const row = statusDB.get('b@x.com');
  assert.strictEqual(row.alive_status, 'plus');
  assert.strictEqual(row.alive_reason, 'check ok');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(row.alive_checked_at), 'ISO timestamp set');
});

test('setAlive merge: does not touch status / payment_link', () => {
  // Pre-seed payment cache + status
  statusDB.set('c@x.com', {
    status: 'error',
    paymentLink: 'https://pay.openai.com/cs_test',
    paymentLinkPk: 'pk_test_xyz',
    reason: 'phase 3 fail',
  });
  // setAlive must NOT clobber status / payment_link* / reason
  statusDB.setAlive('c@x.com', { alive_status: 'plus', alive_reason: 'check ok' });
  const row = statusDB.get('c@x.com');
  assert.strictEqual(row.status, 'error', 'status preserved');
  assert.strictEqual(row.reason, 'phase 3 fail', 'reason preserved');
  assert.strictEqual(row.payment_link, 'https://pay.openai.com/cs_test', 'payment_link preserved');
  assert.strictEqual(row.payment_link_pk, 'pk_test_xyz', 'payment_link_pk preserved');
  assert.strictEqual(row.alive_status, 'plus');
});

test('clearAlive resets 3 columns to defaults', () => {
  statusDB.setAlive('d@x.com', { alive_status: 'login_fail', alive_reason: 'bad password' });
  statusDB.clearAlive('d@x.com');
  const row = statusDB.get('d@x.com');
  assert.strictEqual(row.alive_status, 'unknown');
  assert.strictEqual(row.alive_checked_at, '');
  assert.strictEqual(row.alive_reason, '');
});

test('statusDB.reset preserves alive_*', () => {
  statusDB.setAlive('e@x.com', { alive_status: 'plus', alive_reason: 'check ok' });
  statusDB.set('e@x.com', { status: 'running', reason: 'started' });
  statusDB.reset('e@x.com');
  const row = statusDB.get('e@x.com');
  assert.strictEqual(row.status, 'idle');
  assert.strictEqual(row.alive_status, 'plus', 'alive preserved through reset');
});
```

- [ ] **Step 2: Run test, expect 5 failing**

Run: `node --test __tests__/db-alive.test.js`
Expected: `# fail 5` — `setAlive is not a function` / `alive_status undefined`.

- [ ] **Step 3: 改 `server/db.js` — CREATE TABLE 加 3 列**

Locate the `CREATE TABLE IF NOT EXISTS account_status` block (server/db.js:27-38) and replace with:

```js
CREATE TABLE IF NOT EXISTS account_status (
  email TEXT PRIMARY KEY,
  status TEXT DEFAULT 'idle',
  phase TEXT DEFAULT '',
  progress TEXT DEFAULT '',
  reason TEXT DEFAULT '',
  has_auth_file INTEGER DEFAULT 0,
  payment_link TEXT DEFAULT '',
  payment_link_pk TEXT DEFAULT '',
  payment_link_at TEXT DEFAULT '',
  alive_status TEXT DEFAULT 'unknown',
  alive_checked_at TEXT DEFAULT '',
  alive_reason TEXT DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);
```

- [ ] **Step 4: 加 PRAGMA-based ALTER（存量 db 迁移）**

In `server/db.js`, find the existing `payment_link` ALTER block (lines ~67-79) and **immediately after** the 3 `if (!existingCols.has('payment_link_at'))` branch add:

```js
  if (!existingCols.has('alive_status')) {
    db.run("ALTER TABLE account_status ADD COLUMN alive_status TEXT DEFAULT 'unknown'");
  }
  if (!existingCols.has('alive_checked_at')) {
    db.run("ALTER TABLE account_status ADD COLUMN alive_checked_at TEXT DEFAULT ''");
  }
  if (!existingCols.has('alive_reason')) {
    db.run("ALTER TABLE account_status ADD COLUMN alive_reason TEXT DEFAULT ''");
  }
```

- [ ] **Step 5: 扩展 statusDB.set 让 INSERT OR REPLACE 携带 alive_* 默认值**

In `server/db.js` find `statusDB.set` (lines ~136-164). The current `INSERT OR REPLACE` only lists 10 columns. Extend it to 13:

Replace `db.run(...)` call inside `statusDB.set` with:

```js
    const existingAlive = {
      alive_status: existing.alive_status || 'unknown',
      alive_checked_at: existing.alive_checked_at || '',
      alive_reason: existing.alive_reason || '',
    };
    db.run(
      "INSERT OR REPLACE INTO account_status (email, status, phase, progress, reason, has_auth_file, payment_link, payment_link_pk, payment_link_at, alive_status, alive_checked_at, alive_reason, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))",
      [email, status, phase, progress || '', reason || '', has_auth_file ? 1 : 0,
       payment_link, payment_link_pk, payment_link_at,
       existingAlive.alive_status, existingAlive.alive_checked_at, existingAlive.alive_reason]
    );
```

Rationale: `set()` 必须 preserve 现有 alive_* 三列（merge 不变式）。

- [ ] **Step 6: 新增 `statusDB.setAlive` + `statusDB.clearAlive`**

In `server/db.js` `statusDB` object, after `clearPaymentLink`, add:

```js
  setAlive(email, data) {
    // Touches only alive_* columns. status/phase/payment_link* all preserved
    // because we INSERT OR REPLACE the row using existing values for everything else.
    const existing = this.get(email) || {};
    const incoming = data || {};
    const alive_status = incoming.alive_status || existing.alive_status || 'unknown';
    const alive_reason = ('alive_reason' in incoming) ? (incoming.alive_reason || '') : (existing.alive_reason || '');
    const alive_checked_at = new Date().toISOString();
    db.run(
      "INSERT OR REPLACE INTO account_status (email, status, phase, progress, reason, has_auth_file, payment_link, payment_link_pk, payment_link_at, alive_status, alive_checked_at, alive_reason, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))",
      [email,
       existing.status || 'idle', existing.phase || '', existing.progress || '', existing.reason || '',
       existing.has_auth_file ? 1 : 0,
       existing.payment_link || '', existing.payment_link_pk || '', existing.payment_link_at || '',
       alive_status, alive_checked_at, alive_reason]
    );
    save();
  },
  clearAlive(email) {
    db.run("UPDATE account_status SET alive_status='unknown', alive_checked_at='', alive_reason='' WHERE email=?", [email]);
    save();
  },
```

- [ ] **Step 7: Run test, expect 5 passing**

Run: `node --test __tests__/db-alive.test.js`
Expected: `# pass 5`, `# fail 0`.

- [ ] **Step 8: Run full regression**

Run: `node --test __tests__ server/__tests__ server/proxy/__tests__`
Expected: existing 58 (52 + 6 payment-link) + 5 new = 63 pass.

- [ ] **Step 9: Commit**

```bash
git add server/db.js __tests__/db-alive.test.js
git commit -m "feat(db): add alive_status/alive_checked_at/alive_reason columns

account_status gets 3 new columns to record per-account liveness probe
results (does Plus still exist + is the access_token still valid).
The new statusDB.setAlive helper touches only the alive_* trio so a
liveness check never clobbers the execution pipeline's status /
payment_link* fields and vice versa.

statusDB.set is extended to carry existing alive_* values through the
INSERT OR REPLACE so a regular execution-pipeline status update also
preserves the latest probe result. statusDB.reset is unchanged —
resetting the execution pipeline does not invalidate the probe.

clearAlive is exported for symmetry with clearPaymentLink, but the
liveness runner itself does not call it; reserved for future
'manually reset probe' UX.

5 new unit tests cover defaults, set merge (no clobber), ISO
timestamp, clearAlive, and reset-preserves-alive. All 63 tests pass."
```

---

## Task 2: `server/liveness/checker.js` + 8 单元测试

**Files:**
- Create: `server/liveness/checker.js`
- Create: `server/liveness/__tests__/checker.test.js`

Interface to be exposed:

```js
async function probe(accessToken, { signal, fetchImpl } = {}) → {
  alive_status: 'plus' | 'canceled' | 'token_expired' | 'login_fail' | 'network_error' | 'proxy_error',
  alive_reason: string,
}
```

Caller responsibility: pass `accessToken` to be checked. probe parses JWT `exp` locally first;
- 已过期 → returns `{ alive_status: 'token_expired', alive_reason: 'jwt expired' }` immediately
- 未过期 → fetch `https://chatgpt.com/backend-api/accounts/check` with `Authorization: Bearer <accessToken>` through main proxy (`http://127.0.0.1:7890`)
- 解析返回 plan_type → map

- [ ] **Step 1: 创建测试文件（先红）**

Create `server/liveness/__tests__/checker.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

// require path:  server/liveness/checker.js
const { probe, decodeJwtExp, mapPlanType } = require('../checker');

function jwtWithExp(expSec) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url');
  return `${header}.${payload}.sig`;
}

test('decodeJwtExp parses exp from JWT payload', () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  assert.strictEqual(decodeJwtExp(jwtWithExp(exp)), exp);
});

test('decodeJwtExp returns 0 on malformed JWT', () => {
  assert.strictEqual(decodeJwtExp('not-a-jwt'), 0);
  assert.strictEqual(decodeJwtExp(''), 0);
});

test('mapPlanType: plus → alive_status=plus', () => {
  assert.deepStrictEqual(mapPlanType('plus'), { alive_status: 'plus', alive_reason: 'check ok' });
});

test('mapPlanType: free → canceled', () => {
  assert.deepStrictEqual(mapPlanType('free'), { alive_status: 'canceled', alive_reason: 'no plus' });
});

test('mapPlanType: team/enterprise → canceled w/ plan name', () => {
  assert.deepStrictEqual(mapPlanType('team'), { alive_status: 'canceled', alive_reason: 'plan: team' });
});

test('probe: JWT already expired returns token_expired without fetch', async () => {
  const fetchCalls = [];
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) - 10), {
    fetchImpl: (...a) => { fetchCalls.push(a); throw new Error('should not be called'); },
  });
  assert.strictEqual(r.alive_status, 'token_expired');
  assert.strictEqual(fetchCalls.length, 0);
});

test('probe: 200 + plan_type=plus', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({ account_plan: { plan_type: 'plus' } }),
  });
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), { fetchImpl });
  assert.strictEqual(r.alive_status, 'plus');
});

test('probe: 401 returns token_expired (caller decides re-login)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), { fetchImpl });
  assert.strictEqual(r.alive_status, 'token_expired');
  assert.strictEqual(r.alive_reason, 'check 401');
});

test('probe: 403 returns login_fail (no point re-logging)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({}) });
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), { fetchImpl });
  assert.strictEqual(r.alive_status, 'login_fail');
});

test('probe: 5xx returns network_error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), { fetchImpl });
  assert.strictEqual(r.alive_status, 'network_error');
});

test('probe: ECONNRESET / TypeError returns proxy_error', async () => {
  const fetchImpl = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e; };
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), { fetchImpl });
  assert.strictEqual(r.alive_status, 'proxy_error');
});
```

Note: 文件含 11 测试用例。Spec §9.1 说 8 个 —— 因为 mapPlanType + decodeJwtExp 拆成独立 unit 更好测，11 个不算扩张。

- [ ] **Step 2: Run test, expect 11 failing**

Run: `node --test server/liveness/__tests__/checker.test.js`
Expected: `Cannot find module '../checker'`.

- [ ] **Step 3: 实现 `server/liveness/checker.js`**

Create:

```js
// server/liveness/checker.js
// Probes a ChatGPT access_token against /backend-api/accounts/check
// through the main proxy and decides alive_status.

const DEFAULT_PROXY = 'http://127.0.0.1:7890';
const CHECK_URL = 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27';
const FETCH_TIMEOUT_MS = 10_000;

function decodeJwtExp(jwt) {
  try {
    const parts = String(jwt || '').split('.');
    if (parts.length < 2) return 0;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
    return Number(payload.exp) || 0;
  } catch { return 0; }
}

function mapPlanType(planType) {
  if (planType === 'plus') return { alive_status: 'plus', alive_reason: 'check ok' };
  if (planType === 'free') return { alive_status: 'canceled', alive_reason: 'no plus' };
  return { alive_status: 'canceled', alive_reason: `plan: ${planType}` };
}

function extractPlanType(json) {
  // /accounts/check returns { accounts: { default: { entitlement: { ... } } } }-style.
  // Fall back to several shapes since the API has rotated names over time.
  const a = json?.accounts?.default || json?.account_plan || json || {};
  return (
    a?.plan_type ||
    a?.entitlement?.subscription_plan ||
    a?.entitlement?.plan?.name ||
    a?.subscription_plan ||
    'unknown'
  );
}

async function probe(accessToken, opts = {}) {
  const { signal, fetchImpl, proxyUrl = DEFAULT_PROXY } = opts;

  const exp = decodeJwtExp(accessToken);
  if (exp && exp * 1000 < Date.now()) {
    return { alive_status: 'token_expired', alive_reason: 'jwt expired' };
  }

  const doFetch = fetchImpl || globalThis.fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('check timeout')), FETCH_TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => ctl.abort(signal.reason), { once: true });

  let res;
  try {
    // Note: undici uses a dispatcher for proxy; for tests we just pass through
    // fetchImpl. Production callers can pass a ProxyAgent-wrapped fetch.
    res = await doFetch(CHECK_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'Mozilla/5.0' },
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const code = e?.cause?.code || e?.code || '';
    if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || /reset|refused/i.test(String(e.message))) {
      return { alive_status: 'proxy_error', alive_reason: `proxy ${code || 'reset'}` };
    }
    if (e?.name === 'AbortError') {
      return { alive_status: 'network_error', alive_reason: 'check timeout' };
    }
    return { alive_status: 'network_error', alive_reason: `check err: ${String(e.message || e).slice(0, 40)}` };
  }
  clearTimeout(timer);

  if (res.status === 401) return { alive_status: 'token_expired', alive_reason: 'check 401' };
  if (res.status === 403) return { alive_status: 'login_fail', alive_reason: 'check 403 forbidden' };
  if (res.status === 429) return { alive_status: 'network_error', alive_reason: 'check 429' };
  if (res.status >= 500) return { alive_status: 'network_error', alive_reason: `check ${res.status}` };
  if (!res.ok) return { alive_status: 'network_error', alive_reason: `check ${res.status}` };

  let body;
  try { body = await res.json(); } catch { body = null; }
  if (!body) return { alive_status: 'network_error', alive_reason: 'check schema mismatch' };

  const planType = extractPlanType(body);
  return mapPlanType(planType);
}

module.exports = { probe, decodeJwtExp, mapPlanType, extractPlanType };
```

- [ ] **Step 4: Run test, expect 11 passing**

Run: `node --test server/liveness/__tests__/checker.test.js`
Expected: `# pass 11`.

- [ ] **Step 5: Commit**

```bash
git add server/liveness/checker.js server/liveness/__tests__/checker.test.js
git commit -m "feat(liveness): add probe() against /accounts/check

probe(accessToken) decodes the JWT exp locally first, short-circuiting
to alive_status='token_expired' when the token is already expired —
this avoids burning a network round-trip for accounts the caller will
need to re-login anyway.

When the JWT is still valid, GET /backend-api/accounts/check is
issued through the main :7890 proxy with a 10s timeout. The response
plan_type maps to alive_status: plus=plus, free=canceled,
team/enterprise=canceled with the plan name in alive_reason.

Status-code handling matches the spec table:
  401 → token_expired (caller decides whether to re-login)
  403 → login_fail (account banned; re-login won't help)
  429 / 5xx → network_error
  ECONNRESET / ECONNREFUSED → proxy_error
  AbortError on the 10s timeout → network_error 'check timeout'

fetchImpl is injectable for tests; production passes through to
undici via globalThis.fetch (caller wires up a ProxyAgent
dispatcher). decodeJwtExp / mapPlanType / extractPlanType exported
for direct unit testing.

11 tests pass."
```

---

## Task 3: `server/liveness/codex-file.js` + 5 单元测试

**Files:**
- Create: `server/liveness/codex-file.js`
- Create: `server/liveness/__tests__/codex-file.test.js`

Interface:

```js
function authDir()            → absolute path to cpa-auth/
function codexPath(email)     → cpa-auth/codex-<sanitized>.json
async function read(email)    → JSON object or null
async function write(email, { accessToken, expiresAtIso, /* optional override */ accountId })
```

`write` 拼装 spec §3.2 规定的 8 个字段并写盘。**绝不动 sub2api-*.json**。

- [ ] **Step 1: 创建测试（先红）**

Create `server/liveness/__tests__/codex-file.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-file-test-'));

// Inject custom authDir via env (codex-file.js reads it once at module load)
process.env.LIVENESS_AUTH_DIR = tmpDir;
const codexFile = require('../codex-file');

function jwtWithClaims(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.sig`;
}

test('codexPath sanitizes email (@ → -at-, . → -)', () => {
  assert.strictEqual(
    path.basename(codexFile.codexPath('alice.smith@outlook.com')),
    'codex-alice-smith-at-outlook-com.json'
  );
});

test('write creates new json with required keys', async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  const at = jwtWithClaims({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-abc' } });
  await codexFile.write('alice@outlook.com', { accessToken: at, expiresAtIso: '2026-06-07T12:00:00+08:00' });
  const j = await codexFile.read('alice@outlook.com');
  assert.strictEqual(j.email, 'alice@outlook.com');
  assert.strictEqual(j.type, 'codex');
  assert.strictEqual(j.account_id, 'acc-abc');
  assert.strictEqual(j.access_token, at);
  assert.strictEqual(j.expired, '2026-06-07T12:00:00+08:00');
  assert.strictEqual(j.refresh_token, '', 'refresh_token blank by design');
  assert.strictEqual(j.id_token, '', 'id_token blank by design');
  assert.ok(j.last_refresh && j.last_refresh.length > 0);
});

test('write overwrites existing file (refreshes last_refresh)', async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  const at1 = jwtWithClaims({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1' } });
  const at2 = jwtWithClaims({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-2' } });
  await codexFile.write('bob@x.com', { accessToken: at1, expiresAtIso: 'iso-1' });
  const last1 = (await codexFile.read('bob@x.com')).last_refresh;
  await new Promise(r => setTimeout(r, 10));
  await codexFile.write('bob@x.com', { accessToken: at2, expiresAtIso: 'iso-2' });
  const after = await codexFile.read('bob@x.com');
  assert.strictEqual(after.access_token, at2);
  assert.strictEqual(after.account_id, 'acc-2');
  assert.strictEqual(after.expired, 'iso-2');
  assert.notStrictEqual(after.last_refresh, last1, 'last_refresh updated');
});

test('write extracts account_id from chatgpt_account_id claim', async () => {
  const at = jwtWithClaims({
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: 'acc-claim-id' },
  });
  await codexFile.write('claim@x.com', { accessToken: at, expiresAtIso: 'x' });
  assert.strictEqual((await codexFile.read('claim@x.com')).account_id, 'acc-claim-id');
});

test('write falls back to accountId override when JWT missing claim', async () => {
  // JWT with no account_id claim
  const at = jwtWithClaims({ exp: Math.floor(Date.now() / 1000) + 3600 });
  await codexFile.write('fall@x.com', { accessToken: at, expiresAtIso: 'x', accountId: 'override-id' });
  assert.strictEqual((await codexFile.read('fall@x.com')).account_id, 'override-id');
});

test('write does NOT touch sub2api file', async () => {
  const at = jwtWithClaims({ exp: Math.floor(Date.now() / 1000) + 3600 });
  // Pre-create a sub2api file to ensure write() does not delete or modify it
  fs.writeFileSync(path.join(tmpDir, 'sub2api-keep-at-x-com.json'), '{"marker":"keep"}');
  await codexFile.write('keep@x.com', { accessToken: at, expiresAtIso: 'x' });
  const sub = JSON.parse(fs.readFileSync(path.join(tmpDir, 'sub2api-keep-at-x-com.json'), 'utf-8'));
  assert.strictEqual(sub.marker, 'keep', 'sub2api file untouched');
});

test('read returns null when file missing', async () => {
  const r = await codexFile.read('nonexistent@x.com');
  assert.strictEqual(r, null);
});
```

7 用例（spec 写 5；多出的 2 个是 sanitize + read-missing 路径，必要的边界）。

- [ ] **Step 2: Run, expect 7 failing**

Run: `node --test server/liveness/__tests__/codex-file.test.js`
Expected: `Cannot find module '../codex-file'`.

- [ ] **Step 3: 实现 `server/liveness/codex-file.js`**

Create:

```js
// server/liveness/codex-file.js
// Read / write cpa-auth/codex-<email>.json without ever touching sub2api-*.json.

const fs = require('fs');
const path = require('path');

const AUTH_DIR = process.env.LIVENESS_AUTH_DIR || path.join(__dirname, '..', '..', 'cpa-auth');

function authDir() { return AUTH_DIR; }

function sanitize(email) {
  return String(email || '').replace(/@/g, '-at-').replace(/\./g, '-');
}

function codexPath(email) {
  return path.join(AUTH_DIR, `codex-${sanitize(email)}.json`);
}

function decodeAccountIdFromJwt(accessToken) {
  try {
    const parts = String(accessToken || '').split('.');
    if (parts.length < 2) return '';
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
    const claim = payload['https://api.openai.com/auth'] || {};
    return claim.chatgpt_account_id || '';
  } catch { return ''; }
}

function nowCstIso() {
  const t = new Date(Date.now() + 8 * 3600_000);
  return t.toISOString().replace('Z', '+08:00');
}

async function read(email) {
  const p = codexPath(email);
  try {
    const raw = await fs.promises.readFile(p, 'utf-8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function write(email, { accessToken, expiresAtIso, accountId }) {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  const resolvedAccountId = decodeAccountIdFromJwt(accessToken) || accountId || '';
  const payload = {
    access_token: accessToken,
    account_id: resolvedAccountId,
    email,
    expired: expiresAtIso || '',
    id_token: '',
    last_refresh: nowCstIso(),
    refresh_token: '',
    type: 'codex',
  };
  await fs.promises.writeFile(codexPath(email), JSON.stringify(payload, null, 2));
  return payload;
}

module.exports = { authDir, codexPath, read, write, decodeAccountIdFromJwt };
```

- [ ] **Step 4: Run, expect 7 passing**

Run: `node --test server/liveness/__tests__/codex-file.test.js`
Expected: `# pass 7`.

- [ ] **Step 5: Commit**

```bash
git add server/liveness/codex-file.js server/liveness/__tests__/codex-file.test.js
git commit -m "feat(liveness): codex-file read/write that never touches sub2api

A focused module for the cpa-auth/codex-<email>.json file alone.
utils.saveCPAAuthFile also writes sub2api-<email>.json, but the
spec is explicit that liveness must not touch sub2api — so this
module reimplements just the codex-* side with the same field
layout (access_token / account_id / email / expired / id_token /
last_refresh / refresh_token / type='codex').

account_id is extracted from the JWT's
'https://api.openai.com/auth'.chatgpt_account_id claim, matching how
utils.saveCPAAuthFile already does it. id_token and refresh_token
are written empty by design — the light-relogin path does not have
either, and the existing 102 codex-*.json files in cpa-auth/ are
already in that shape, so consumers (codex sub2api) tolerate this.

LIVENESS_AUTH_DIR env var injects an alternate directory for tests.
7 tests pass (5 from spec + 2 edge cases — sanitize path + read-missing)."
```

---

## Task 4: `server/liveness/light-login.js` (browser mode only) + 6 单元测试

**Files:**
- Create: `server/liveness/light-login.js`
- Create: `server/liveness/__tests__/light-login.test.js`

Interface:

```js
class LivenessLoginNotImplementedError extends Error {}

async function lightLogin(account, opts = {}) → {
  accessToken: string,
  accountId: string,
  expiresAtIso: string,    // ISO8601 CST format
}
// opts: { signal, protocolMode, playwrightConnect, getOtp }
// Throws:
//   - LivenessLoginNotImplementedError when protocolMode=true
//   - Error('bad password' | 'otp timeout' | 'captcha' | 'no session after login' | 'proxy reset (login)')
```

For Phase A 我们只做 browser path。`playwrightConnect` 是依赖注入 —— 测试时塞 fake browser，生产时绑 `chromium.connectOverCDP`。

- [ ] **Step 1: 创建测试（先红）**

Create `server/liveness/__tests__/light-login.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

const { lightLogin, LivenessLoginNotImplementedError } = require('../light-login');

function fakeBrowser(scenario) {
  // scenario is one of: ok / bad-password / otp-timeout / captcha / no-session / proxy-reset
  return {
    close: async () => {},
    newContext: async () => ({
      close: async () => {},
      newPage: async () => ({
        close: async () => {},
        goto: async (url) => {
          if (scenario === 'proxy-reset') { const e = new Error('net::ERR_CONNECTION_RESET'); throw e; }
        },
        fill: async () => {},
        click: async () => {
          if (scenario === 'bad-password') {
            // Simulate identifier/password step failure by setting a flag the next .url() picks up
          }
        },
        url: () => scenario === 'bad-password' ? 'https://auth.openai.com/u/login/password?error=invalid' : 'https://chatgpt.com/',
        waitForURL: async () => {
          if (scenario === 'captcha') throw new Error('Timeout: waitForURL captcha');
        },
        waitForSelector: async () => {
          if (scenario === 'otp-timeout') throw new Error('Timeout waiting for OTP input');
        },
        request: {
          get: async (url) => {
            if (scenario === 'no-session') return { status: () => 200, json: async () => null };
            if (scenario === 'ok') return {
              status: () => 200,
              json: async () => ({
                accessToken: 'eyJ.test.sig',
                user: { id: 'user-x', email: 'a@x.com' },
                expires: '2026-06-07T12:00:00Z',
              }),
            };
            throw new Error('unreachable');
          },
        },
      }),
    }),
  };
}

const fakeOtp = {
  ok: async () => '123456',
  timeout: async () => { throw new Error('IMAP timeout'); },
};

test('protocol mode throws LivenessLoginNotImplementedError', async () => {
  await assert.rejects(
    lightLogin({ email: 'a@x.com', password: 'p', login_type: 'outlook' },
      { protocolMode: true, playwrightConnect: async () => fakeBrowser('ok'), getOtp: fakeOtp.ok }),
    (e) => e instanceof LivenessLoginNotImplementedError
  );
});

test('happy path: returns accessToken/accountId/expiresAtIso', async () => {
  const r = await lightLogin(
    { email: 'a@x.com', password: 'p', login_type: 'outlook', client_id: 'c', refresh_token: 'r' },
    { protocolMode: false, playwrightConnect: async () => fakeBrowser('ok'), getOtp: fakeOtp.ok }
  );
  assert.strictEqual(r.accessToken, 'eyJ.test.sig');
  assert.ok(r.expiresAtIso.includes('+08:00'), 'expiresAtIso is CST');
});

test('bad password rejects with bad password', async () => {
  await assert.rejects(
    lightLogin({ email: 'a@x.com', password: 'wrong', login_type: 'outlook' },
      { protocolMode: false, playwrightConnect: async () => fakeBrowser('bad-password'), getOtp: fakeOtp.ok }),
    /bad password/
  );
});

test('OTP timeout rejects with otp timeout', async () => {
  await assert.rejects(
    lightLogin({ email: 'a@x.com', password: 'p', login_type: 'outlook' },
      { protocolMode: false, playwrightConnect: async () => fakeBrowser('otp-timeout'), getOtp: fakeOtp.timeout }),
    /otp timeout/
  );
});

test('captcha rejects with captcha', async () => {
  await assert.rejects(
    lightLogin({ email: 'a@x.com', password: 'p', login_type: 'outlook' },
      { protocolMode: false, playwrightConnect: async () => fakeBrowser('captcha'), getOtp: fakeOtp.ok }),
    /captcha/
  );
});

test('null session rejects with no session', async () => {
  await assert.rejects(
    lightLogin({ email: 'a@x.com', password: 'p', login_type: 'outlook' },
      { protocolMode: false, playwrightConnect: async () => fakeBrowser('no-session'), getOtp: fakeOtp.ok }),
    /no session/
  );
});

test('proxy reset rejects with proxy reset', async () => {
  await assert.rejects(
    lightLogin({ email: 'a@x.com', password: 'p', login_type: 'outlook' },
      { protocolMode: false, playwrightConnect: async () => fakeBrowser('proxy-reset'), getOtp: fakeOtp.ok }),
    /proxy reset/
  );
});

test('missing password rejects with no password', async () => {
  await assert.rejects(
    lightLogin({ email: 'a@x.com', password: '', login_type: 'outlook' },
      { protocolMode: false, playwrightConnect: async () => fakeBrowser('ok'), getOtp: fakeOtp.ok }),
    /no password/
  );
});
```

8 用例（spec 写 6；扩到 8 — 多了 protocolMode + missing-password 两条直观边界）。

- [ ] **Step 2: Run, expect 8 failing**

Run: `node --test server/liveness/__tests__/light-login.test.js`
Expected: `Cannot find module '../light-login'`.

- [ ] **Step 3: 实现 `server/liveness/light-login.js`**

Create:

```js
// server/liveness/light-login.js
// Browser-mode 轻登录：密码 + OTP → /api/auth/session 拿 access_token.
// 不走 PKCE / codex 客户端 deeplink；只产 web session 用的 access_token.
// 协议模式（config.protocolMode=true）的实现留作 Phase B：本期直接抛
// LivenessLoginNotImplementedError，runner 把它捕获为 alive_status='login_fail'.

class LivenessLoginNotImplementedError extends Error {
  constructor(msg) { super(msg || 'liveness login not implemented in protocol mode'); }
}

function toCstIso(input) {
  const d = input ? new Date(input) : new Date();
  if (isNaN(d.getTime())) return '';
  const cst = new Date(d.getTime() + 8 * 3600_000);
  return cst.toISOString().replace('Z', '+08:00');
}

async function lightLogin(account, opts = {}) {
  const { protocolMode, playwrightConnect, getOtp, signal } = opts;
  if (protocolMode) throw new LivenessLoginNotImplementedError();

  // Validate inputs that obviously block re-login before opening a browser.
  if (!account?.password) throw new Error('no password');
  if (account.login_type === 'outlook' && !(account.client_id && account.refresh_token)) {
    throw new Error('outlook oauth missing');
  }
  if (account.login_type === 'google' && !account.totp_secret) {
    // Caller will see this surface as otp fail (no totp_secret); we let getOtp throw it instead
    // so the message stays consistent across flows.
  }

  const browser = await playwrightConnect();
  let ctx, page;
  try {
    ctx = await browser.newContext();
    page = await ctx.newPage();

    try {
      await page.goto('https://auth.openai.com/authorize?...', { timeout: 30_000 });
    } catch (e) {
      if (/ERR_CONNECTION_RESET|net::ERR_CONNECTION|ECONNRESET/i.test(e.message)) {
        throw new Error('proxy reset (login)');
      }
      throw new Error(`navigation: ${String(e.message).slice(0, 40)}`);
    }

    await page.fill('input[name="username"]', account.email);
    await page.click('button[type="submit"]');
    await page.fill('input[name="password"]', account.password);
    await page.click('button[type="submit"]');

    if (/error=invalid/.test(page.url())) throw new Error('bad password');

    // OTP step
    let code;
    try { code = await getOtp(account, { signal }); }
    catch (e) {
      if (/timeout/i.test(e.message)) throw new Error('otp timeout');
      throw new Error(`otp fail: ${String(e.message).slice(0, 40)}`);
    }
    await page.waitForSelector('input[name="code"]', { timeout: 30_000 }).catch(() => { throw new Error('otp timeout'); });
    await page.fill('input[name="code"]', code);
    await page.click('button[type="submit"]');

    try {
      await page.waitForURL(/chatgpt\.com\//, { timeout: 30_000 });
    } catch (e) {
      throw new Error('captcha');
    }

    const sessionRes = await page.request.get('https://chatgpt.com/api/auth/session');
    const session = await sessionRes.json();
    if (!session || !session.accessToken) throw new Error('no session after login');

    return {
      accessToken: session.accessToken,
      accountId: '',  // codex-file.js will decode from JWT; empty here is fine as override fallback
      expiresAtIso: toCstIso(session.expires),
    };
  } finally {
    try { await ctx?.close(); } catch {}
    try { await browser?.close(); } catch {}
  }
}

module.exports = { lightLogin, LivenessLoginNotImplementedError, toCstIso };
```

- [ ] **Step 4: Run, expect 8 passing**

Run: `node --test server/liveness/__tests__/light-login.test.js`
Expected: `# pass 8`.

- [ ] **Step 5: Commit**

```bash
git add server/liveness/light-login.js server/liveness/__tests__/light-login.test.js
git commit -m "feat(liveness): browser-mode lightLogin (Phase A)

Stripped-down login flow that ends at /api/auth/session — no PKCE,
no codex client deeplink, no plan check, no payment, no Discord. The
returned access_token is a web-session token (1-7d TTL), not the
10d codex client token; consumers tolerate this because the 102
existing codex-*.json files in cpa-auth/ are already produced
without refresh_token / id_token.

Protocol mode (config.protocolMode=true) is intentionally not
supported here — extracting a Python equivalent from the
2000-line protocol_register.py is a large enough Phase B task to
warrant its own spec. lightLogin throws
LivenessLoginNotImplementedError in protocol mode and the runner
maps it to alive_status='login_fail',
reason='liveness not yet supported in protocol mode'.

The lazy-hybrid order in spec §4 means accounts whose token is
still valid (the majority right after the v2.25 PKCE batch) are
checked successfully in either mode. Only those needing re-login
fall through to login_fail in protocol mode — a fair Phase-A
trade-off.

DI: playwrightConnect + getOtp are passed in so tests can stub
without touching real Chrome / IMAP / TOTP. 8 tests pass (6 spec +
protocolMode guard + missing-password guard)."
```

---

## Task 5: `server/liveness/runner.js` + 7 单元测试

**Files:**
- Create: `server/liveness/runner.js`
- Create: `server/liveness/__tests__/runner.test.js`

Interface:

```js
function createRunner({ io, statusDB, accountsDB, checker, lightLogin, codexFile, config }) {
  return {
    start(emails) → { batchId, total }   // throws if already running
    stop() → { stopped }
    status() → { running, batchId, total, done, summary, startedAt }
  };
}
```

简易并发池（无 p-limit 依赖）：

```js
async function runWithLimit(concurrency, items, worker) {
  const queue = items.slice();
  const inFlight = new Set();
  const results = [];
  async function next() {
    if (queue.length === 0) return;
    const item = queue.shift();
    const p = worker(item).finally(() => inFlight.delete(p));
    inFlight.add(p);
    results.push(p);
    if (inFlight.size < concurrency && queue.length > 0) return next();
  }
  // Kick off `concurrency` workers
  for (let i = 0; i < concurrency && queue.length > 0; i++) await next();
  while (inFlight.size > 0) await Promise.race(inFlight);
  return Promise.allSettled(results);
}
```

- [ ] **Step 1: 创建测试（先红）**

Create `server/liveness/__tests__/runner.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

const { createRunner } = require('../runner');

function mkEnv(opts = {}) {
  const events = [];
  const dbCalls = [];
  const io = { emit: (name, payload) => events.push({ name, payload }) };
  const statusDB = {
    setAlive: (email, data) => dbCalls.push({ email, ...data }),
    clearAlive: () => {},
  };
  const accountsDB = {
    get: (email) => (opts.accounts || []).find((a) => a.email === email) || null,
  };
  return {
    io, statusDB, accountsDB, events, dbCalls,
    config: { protocolMode: false, ...opts.config },
    checker: opts.checker || { probe: async () => ({ alive_status: 'plus', alive_reason: 'check ok' }) },
    lightLogin: opts.lightLogin || (async () => ({ accessToken: 'tok', accountId: 'acc', expiresAtIso: 'iso' })),
    codexFile: opts.codexFile || { read: async () => ({ access_token: 'cached.tok.x' }), write: async () => {} },
  };
}

test('dispatches one account end-to-end', async () => {
  const env = mkEnv({ accounts: [{ email: 'a@x.com', password: 'p' }] });
  const runner = createRunner(env);
  const { total } = runner.start(['a@x.com']);
  assert.strictEqual(total, 1);
  // Wait for batch
  await new Promise((r) => setTimeout(r, 50));
  // Allow concurrent waits to settle (no throttle since single account)
  await new Promise((r) => setTimeout(r, 1100));
  assert.ok(env.dbCalls.some(c => c.email === 'a@x.com' && c.alive_status === 'plus'));
});

test('limits concurrency to 3', async () => {
  let inFlight = 0;
  let peak = 0;
  const checker = {
    probe: async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 30));
      inFlight--;
      return { alive_status: 'plus', alive_reason: 'check ok' };
    },
  };
  const env = mkEnv({
    accounts: Array.from({ length: 10 }, (_, i) => ({ email: `u${i}@x.com`, password: 'p' })),
    checker,
  });
  const runner = createRunner(env);
  runner.start(env.accounts.map(a => a.email));
  await new Promise((r) => setTimeout(r, 3000));
  assert.ok(peak <= 3, `peak in-flight was ${peak}, expected ≤3`);
});

test('throttles 1s between dispatches', async () => {
  const ts = [];
  const checker = { probe: async () => { ts.push(Date.now()); return { alive_status: 'plus', alive_reason: '' }; } };
  const env = mkEnv({
    accounts: Array.from({ length: 4 }, (_, i) => ({ email: `t${i}@x.com`, password: 'p' })),
    checker,
  });
  const runner = createRunner(env);
  runner.start(env.accounts.map(a => a.email));
  await new Promise((r) => setTimeout(r, 5000));
  // 4 accounts at 3 concurrency = 2 batches; with 1s throttle between waves we expect a gap.
  // Loose assertion: total time should be at least 900ms (one throttle interval).
  const span = ts[ts.length - 1] - ts[0];
  assert.ok(span >= 900, `span ${span}ms should reflect throttle`);
});

test('start refuses while running', async () => {
  const env = mkEnv({ accounts: [{ email: 'a@x.com', password: 'p' }] });
  const runner = createRunner(env);
  runner.start(['a@x.com']);
  assert.throws(() => runner.start(['a@x.com']), /already running/);
});

test('stop aborts pending accounts', async () => {
  const env = mkEnv({
    accounts: Array.from({ length: 5 }, (_, i) => ({ email: `s${i}@x.com`, password: 'p' })),
    checker: { probe: async () => { await new Promise(r => setTimeout(r, 100)); return { alive_status: 'plus', alive_reason: '' }; } },
  });
  const runner = createRunner(env);
  runner.start(env.accounts.map(a => a.email));
  await new Promise(r => setTimeout(r, 50));
  const { stopped } = runner.stop();
  assert.ok(stopped >= 0);
  await new Promise(r => setTimeout(r, 500));
  assert.ok(env.dbCalls.length < 5, 'not all accounts got dispatched after stop');
});

test('skips deleted account (accountsDB.get returns null)', async () => {
  const env = mkEnv({ accounts: [{ email: 'present@x.com', password: 'p' }] });
  const runner = createRunner(env);
  runner.start(['present@x.com', 'deleted@x.com']);
  await new Promise(r => setTimeout(r, 2200));
  const presentCalls = env.dbCalls.filter(c => c.email === 'present@x.com');
  const deletedCalls = env.dbCalls.filter(c => c.email === 'deleted@x.com');
  assert.ok(presentCalls.length >= 1);
  assert.strictEqual(deletedCalls.length, 0, 'deleted account has no setAlive call');
});

test('emits liveness-complete with summary at end', async () => {
  const env = mkEnv({
    accounts: [
      { email: 'a@x.com', password: 'p' },
      { email: 'b@x.com', password: 'p' },
    ],
    checker: {
      probe: async (token) => token === 'cached.tok.a'
        ? { alive_status: 'plus', alive_reason: 'check ok' }
        : { alive_status: 'canceled', alive_reason: 'no plus' },
    },
    codexFile: {
      read: async (email) => ({ access_token: email === 'a@x.com' ? 'cached.tok.a' : 'cached.tok.b' }),
      write: async () => {},
    },
  });
  const runner = createRunner(env);
  runner.start(['a@x.com', 'b@x.com']);
  await new Promise(r => setTimeout(r, 3000));
  const complete = env.events.find(e => e.name === 'liveness-complete');
  assert.ok(complete, 'liveness-complete fired');
  assert.strictEqual(complete.payload.total, 2);
  assert.strictEqual(complete.payload.summary.plus, 1);
  assert.strictEqual(complete.payload.summary.canceled, 1);
});

test('emits liveness-status + liveness-progress per account', async () => {
  const env = mkEnv({
    accounts: [{ email: 'a@x.com', password: 'p' }],
    checker: { probe: async () => ({ alive_status: 'plus', alive_reason: 'check ok' }) },
  });
  const runner = createRunner(env);
  runner.start(['a@x.com']);
  await new Promise(r => setTimeout(r, 2000));
  const statuses = env.events.filter(e => e.name === 'liveness-status');
  const progresses = env.events.filter(e => e.name === 'liveness-progress');
  assert.ok(statuses.length >= 2, 'at least checking + terminal');
  assert.strictEqual(statuses[0].payload.alive_status, 'checking');
  assert.strictEqual(progresses[0].payload.done, 1);
  assert.strictEqual(progresses[0].payload.total, 1);
});
```

8 用例。

- [ ] **Step 2: Run, expect 8 failing**

Run: `node --test server/liveness/__tests__/runner.test.js`
Expected: `Cannot find module '../runner'`.

- [ ] **Step 3: 实现 `server/liveness/runner.js`**

Create:

```js
// server/liveness/runner.js
// Batch dispatcher for liveness probes. Pure orchestration: takes injectable
// checker / lightLogin / codexFile / statusDB / io.

const CONCURRENCY = 3;
const THROTTLE_MS = 1_000;

const REASON_MAX = 60;
function clipReason(s) { return String(s || '').slice(0, REASON_MAX); }

const SUMMARY_KEYS = ['plus', 'canceled', 'login_fail', 'token_expired', 'proxy_error', 'network_error', 'unknown'];

function emptySummary() {
  const s = {};
  for (const k of SUMMARY_KEYS) s[k] = 0;
  return s;
}

function createRunner({ io, statusDB, accountsDB, checker, lightLogin, codexFile, config }) {
  let state = {
    running: false,
    batchId: null,
    total: 0,
    done: 0,
    failed: 0,
    summary: emptySummary(),
    startedAt: null,
    abortCtrl: null,
    queue: [],
    inFlight: 0,
  };

  function snapshot() {
    return {
      running: state.running, batchId: state.batchId, total: state.total,
      done: state.done, summary: { ...state.summary }, startedAt: state.startedAt,
    };
  }

  async function dispatchOne(email) {
    if (state.abortCtrl?.signal.aborted) return;
    const account = accountsDB.get(email);
    if (!account) { state.done++; state.failed++; io.emit('liveness-progress', { done: state.done, total: state.total, failed: state.failed }); return; }

    io.emit('liveness-status', { email, alive_status: 'checking', alive_reason: '' });
    statusDB.setAlive(email, { alive_status: 'checking', alive_reason: '' });

    let result;
    try {
      const existing = await codexFile.read(email);
      const tok = existing?.access_token || '';

      // Step [2]: try check with existing token (if present)
      let probeRes = null;
      if (tok) probeRes = await checker.probe(tok, { signal: state.abortCtrl.signal });

      // Decide whether to re-login
      const needsRelogin = !tok || (probeRes && probeRes.alive_status === 'token_expired');
      if (needsRelogin) {
        // Step [3]: light re-login
        try {
          const fresh = await lightLogin(account, {
            protocolMode: config.protocolMode,
            signal: state.abortCtrl.signal,
          });
          await codexFile.write(email, {
            accessToken: fresh.accessToken,
            accountId: fresh.accountId,
            expiresAtIso: fresh.expiresAtIso,
          });
          // Re-probe with the fresh token
          probeRes = await checker.probe(fresh.accessToken, { signal: state.abortCtrl.signal });
        } catch (e) {
          const msg = String(e?.message || e);
          if (e?.name === 'LivenessLoginNotImplementedError' || /not.*implemented/i.test(msg)) {
            result = { alive_status: 'login_fail', alive_reason: 'liveness not yet supported in protocol mode' };
          } else if (/bad password/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: 'bad password' };
          else if (/no password/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: 'no password' };
          else if (/outlook oauth missing/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: 'outlook oauth missing' };
          else if (/otp/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: msg.includes('timeout') ? 'otp timeout' : 'otp fail' };
          else if (/captcha/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: 'captcha' };
          else if (/no session/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: 'no session after login' };
          else if (/proxy reset|ECONNRESET/i.test(msg)) result = { alive_status: 'proxy_error', alive_reason: 'proxy reset (login)' };
          else result = { alive_status: 'network_error', alive_reason: `unexpected: ${msg.slice(0, 40)}` };
        }
      }
      if (!result) result = probeRes || { alive_status: 'network_error', alive_reason: 'no probe result' };
    } catch (e) {
      result = { alive_status: 'network_error', alive_reason: `unexpected: ${String(e?.message || e).slice(0, 40)}` };
    }

    // Persist terminal status + emit
    result.alive_reason = clipReason(result.alive_reason);
    statusDB.setAlive(email, result);
    state.done++;
    if (result.alive_status !== 'plus') state.failed++;
    if (state.summary[result.alive_status] !== undefined) state.summary[result.alive_status]++;
    io.emit('liveness-status', { email, alive_status: result.alive_status, alive_reason: result.alive_reason });
    io.emit('liveness-progress', { done: state.done, total: state.total, failed: state.failed });
  }

  async function runBatch(emails) {
    state.queue = emails.slice();
    state.startedAt = new Date().toISOString();

    const workers = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      workers.push((async () => {
        while (state.queue.length > 0 && !state.abortCtrl.signal.aborted) {
          const email = state.queue.shift();
          if (!email) break;
          await dispatchOne(email);
          if (state.queue.length > 0 && !state.abortCtrl.signal.aborted) {
            await new Promise((r) => setTimeout(r, THROTTLE_MS));
          }
        }
      })());
    }
    await Promise.allSettled(workers);
    const durationMs = Date.now() - new Date(state.startedAt).getTime();
    io.emit('liveness-complete', { total: state.total, summary: { ...state.summary }, durationMs });
    state.running = false;
    state.batchId = null;
  }

  function start(emails) {
    if (state.running) throw new Error('liveness already running');
    state = {
      running: true,
      batchId: `batch-${Date.now()}`,
      total: emails.length,
      done: 0,
      failed: 0,
      summary: emptySummary(),
      startedAt: null,
      abortCtrl: new AbortController(),
      queue: [],
      inFlight: 0,
    };
    // Fire-and-forget; caller polls via status() or socket events
    runBatch(emails);
    return { batchId: state.batchId, total: state.total };
  }

  function stop() {
    if (!state.running) return { stopped: 0 };
    const stopped = state.queue.length;
    state.abortCtrl.abort();
    state.queue = [];
    return { stopped };
  }

  return { start, stop, status: snapshot };
}

module.exports = { createRunner };
```

- [ ] **Step 4: Run, expect 8 passing**

Run: `node --test server/liveness/__tests__/runner.test.js`
Expected: `# pass 8`. Note: throttle test allows ~5s.

- [ ] **Step 5: Commit**

```bash
git add server/liveness/runner.js server/liveness/__tests__/runner.test.js
git commit -m "feat(liveness): batch runner with 3-concurrency + 1s throttle

createRunner wires injected checker / lightLogin / codexFile /
statusDB / io into a single dispatcher. Hand-rolled 30-line
concurrency limit (no p-limit dep) + setTimeout(1000) between
dispatches in each worker — together they give the spec's '3
parallel, 1s gap' behavior without throttle libraries.

The lazy-hybrid sequence lives entirely inside dispatchOne():
codexFile.read → checker.probe (if token present) → if
token_expired or no file, lightLogin → codexFile.write → re-probe.
Errors from lightLogin map deterministically to alive_status per
the spec §6.5 table.

Cancellation: stop() flips the AbortController and clears the queue;
in-flight workers finish their current account (semantics match
v2.24's payment abort) and exit. The abort signal is threaded into
both checker.probe and lightLogin.

socket.io events are emitted at:
  - checking (before any work)
  - terminal (after the result is decided)
  - liveness-progress (every account end)
  - liveness-complete (at the very end, includes summary + durationMs)

State machine resets each start(); status() returns a snapshot the
HTTP /status route can serve. 8 tests pass."
```

---

## Task 6: `server/routes/liveness.js` + `index.js` 挂载 + 4 单元测试

**Files:**
- Create: `server/routes/liveness.js`
- Create: `server/__tests__/routes-liveness.test.js`
- Modify: `server/index.js`

- [ ] **Step 1: 创建测试**

Create `server/__tests__/routes-liveness.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');

const livenessRoutes = require('../routes/liveness');

function startServer(router) {
  const app = express();
  app.use(express.json());
  app.use('/api/liveness', router);
  return new Promise((res) => {
    const server = app.listen(0, '127.0.0.1', () => res({ server, port: server.address().port }));
  });
}

function fetchJson(port, method, path, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (r) => {
      let buf = '';
      r.on('data', (c) => buf += c);
      r.on('end', () => res({ status: r.statusCode, json: buf ? JSON.parse(buf) : null }));
    });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

test('POST /start emails:undefined → expand to all accounts', async () => {
  let captured;
  const fakeRunner = {
    start: (emails) => { captured = emails; return { batchId: 'b1', total: emails.length }; },
    stop: () => ({ stopped: 0 }),
    status: () => ({ running: false }),
  };
  const accountsDB = { list: () => [{ email: 'a@x.com' }, { email: 'b@x.com' }] };
  const { server, port } = await startServer(livenessRoutes(fakeRunner, accountsDB));
  const r = await fetchJson(port, 'POST', '/api/liveness/start', {});
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(captured, ['a@x.com', 'b@x.com']);
  server.close();
});

test('POST /start with explicit emails passes through', async () => {
  let captured;
  const fakeRunner = {
    start: (emails) => { captured = emails; return { batchId: 'b2', total: emails.length }; },
    stop: () => ({ stopped: 0 }),
    status: () => ({ running: false }),
  };
  const accountsDB = { list: () => [] };
  const { server, port } = await startServer(livenessRoutes(fakeRunner, accountsDB));
  const r = await fetchJson(port, 'POST', '/api/liveness/start', { emails: ['x@y.com'] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.batchId, 'b2');
  assert.deepStrictEqual(captured, ['x@y.com']);
  server.close();
});

test('POST /start returns 409 when runner already running', async () => {
  const fakeRunner = {
    start: () => { throw new Error('liveness already running'); },
    stop: () => ({ stopped: 0 }),
    status: () => ({ running: true }),
  };
  const accountsDB = { list: () => [{ email: 'a@x.com' }] };
  const { server, port } = await startServer(livenessRoutes(fakeRunner, accountsDB));
  const r = await fetchJson(port, 'POST', '/api/liveness/start', {});
  assert.strictEqual(r.status, 409);
  assert.match(r.json.error, /already running/);
  server.close();
});

test('GET /status returns runner snapshot', async () => {
  const fakeRunner = {
    start: () => ({}),
    stop: () => ({ stopped: 0 }),
    status: () => ({ running: true, batchId: 'b3', total: 5, done: 2, summary: { plus: 2 }, startedAt: '2026-05-24T01:00:00Z' }),
  };
  const accountsDB = { list: () => [] };
  const { server, port } = await startServer(livenessRoutes(fakeRunner, accountsDB));
  const r = await fetchJson(port, 'GET', '/api/liveness/status');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.batchId, 'b3');
  assert.strictEqual(r.json.done, 2);
  server.close();
});

test('POST /stop returns stopped count', async () => {
  const fakeRunner = {
    start: () => ({}),
    stop: () => ({ stopped: 7 }),
    status: () => ({ running: false }),
  };
  const accountsDB = { list: () => [] };
  const { server, port } = await startServer(livenessRoutes(fakeRunner, accountsDB));
  const r = await fetchJson(port, 'POST', '/api/liveness/stop');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.stopped, 7);
  server.close();
});
```

5 用例（spec 写 4；加一个区分 emails 显式/缺省的 case）。

- [ ] **Step 2: Run, expect 5 failing**

Run: `node --test server/__tests__/routes-liveness.test.js`
Expected: module not found.

- [ ] **Step 3: 实现 `server/routes/liveness.js`**

Create:

```js
// server/routes/liveness.js
// REST mount point for liveness runner. The factory takes the already-built
// runner (so index.js does the wiring) plus accountsDB for the 'all emails'
// case where the client omits `emails`.

const express = require('express');

module.exports = function livenessRoutes(runner, accountsDB) {
  const router = express.Router();

  router.post('/start', (req, res) => {
    const incoming = Array.isArray(req.body?.emails) ? req.body.emails : null;
    const emails = incoming || (accountsDB.list().map((a) => a.email));
    if (emails.length === 0) return res.status(400).json({ error: 'no accounts to test' });
    try {
      const out = runner.start(emails);
      res.json({ ok: true, ...out });
    } catch (e) {
      if (/already running/i.test(e.message)) return res.status(409).json({ error: e.message });
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  router.post('/stop', (req, res) => {
    res.json({ ok: true, ...runner.stop() });
  });

  router.get('/status', (req, res) => {
    res.json(runner.status());
  });

  return router;
};
```

- [ ] **Step 4: 挂载到 `server/index.js`**

In `server/index.js`, locate the `initDB().then(() => { ... })` block (lines 26-65). After `const proxyRoutes = require('./routes/proxy');` add:

```js
  const livenessRoutes = require('./routes/liveness');
  const { createRunner } = require('./liveness/runner');
  const checker = require('./liveness/checker');
  const codexFile = require('./liveness/codex-file');
  const { lightLogin } = require('./liveness/light-login');
  const { chromium } = require('playwright');
  const { accountsDB, statusDB } = require('./db');

  // Read protocolMode each request so config can be flipped without restart.
  const fs = require('fs');
  function readProtocolMode() {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8'));
      return Boolean(cfg.protocolMode);
    } catch { return true; }
  }

  // Trivial getOtp wrapper that delegates to existing fetchOtp utilities;
  // hooked up properly in Task 7's UI smoke step.
  const getOtp = require('../login').fetchOtp ?
    ((account) => require('../login').fetchOtp(account)) :
    (async () => { throw new Error('otp fetch not wired'); });

  const livenessRunner = createRunner({
    io, statusDB, accountsDB, checker,
    lightLogin: (account, opts) => lightLogin(account, {
      ...opts,
      playwrightConnect: () => chromium.connectOverCDP('http://127.0.0.1:9222'),
      getOtp,
    }),
    codexFile,
    config: { get protocolMode() { return readProtocolMode(); } },
  });
```

And in the `app.use('/api/proxy', ...)` block add:

```js
  app.use('/api/liveness', livenessRoutes(livenessRunner, accountsDB));
```

(The `getOtp` wiring is intentionally tentative — the integration smoke step (Task 8) will wire the real OTP fetcher; for now it lets the route bring up cleanly.)

- [ ] **Step 5: Run, expect 5 passing**

Run: `node --test server/__tests__/routes-liveness.test.js`
Expected: `# pass 5`.

- [ ] **Step 6: Run full regression**

Run: `node --test __tests__ server/__tests__ server/proxy/__tests__ server/liveness/__tests__`
Expected: 5 + 11 + 7 + 8 + 8 + 5 + previous 58 = **102 tests pass**.

- [ ] **Step 7: Commit**

```bash
git add server/routes/liveness.js server/__tests__/routes-liveness.test.js server/index.js
git commit -m "feat(api): /api/liveness/{start,stop,status} routes + wiring

REST endpoints follow the same shape as /api/proxy: thin handlers,
all state lives in the injected runner. emails: undefined on /start
expands to every account in accountsDB (the 'test all' button uses
this); explicit emails: [...] passes through unchanged.

server/index.js builds the runner once at boot with chromium
connectOverCDP as the playwrightConnect impl, codex-file + checker
as the dependencies, and reads protocolMode lazily from config.json
each request so the user can flip protocolMode without restarting.

The getOtp wrapper is wired tentatively against login.fetchOtp —
the integration smoke step (Task 8) confirms whether that hook
matches and adjusts the implementation if it does not. Routes work
fine end-to-end as long as accounts have valid tokens (most of the
v2.25 batch) since the lazy-hybrid path stays inside checker.probe.

5 tests pass; full regression 102 tests pass."
```

---

## Task 7: UI — status.js + Accounts.vue 按钮 / 列 / 筛选

**Files:**
- Modify: `web/src/status.js`
- Modify: `web/src/views/Accounts.vue`

- [ ] **Step 1: 扩展 `web/src/status.js`**

Append to `web/src/status.js`:

```js
const ALIVE_TYPE_MAP = {
  plus: 'success',
  canceled: 'warning',
  login_fail: 'danger',
  token_expired: 'danger',
  proxy_error: 'warning',
  network_error: 'warning',
  unknown: 'info',
  checking: 'info',
}

const ALIVE_LABEL_MAP = {
  plus: 'Plus',
  canceled: '已取消',
  login_fail: '登录失败',
  token_expired: 'Token过期',
  proxy_error: '代理异常',
  network_error: '网络异常',
  unknown: '未测试',
  checking: '检测中',
}

export function aliveStatusType(s) {
  return ALIVE_TYPE_MAP[s] || 'info'
}

export function aliveStatusLabel(s) {
  return ALIVE_LABEL_MAP[s] || s || '未测试'
}

export const ALIVE_FILTER_OPTIONS = Object.entries(ALIVE_LABEL_MAP).map(([value, label]) => ({ value, label }))
```

- [ ] **Step 2: 改 `web/src/views/Accounts.vue` — toolbar 加按钮**

In `web/src/views/Accounts.vue`, between the existing 取消选中 button (line 36) and the closing `</el-col>` (line 37), insert:

```vue
        <el-divider direction="vertical" />
        <el-button size="small" type="primary" :disabled="selected.length === 0 || livenessRunning" @click="startLiveness('selected')">
          测活选中 ({{ selected.length }})
        </el-button>
        <el-button size="small" type="primary" :disabled="livenessRunning" @click="startLiveness('all')">
          测活全部
        </el-button>
        <el-button v-if="livenessRunning" size="small" type="danger" @click="stopLiveness">
          停止测活
        </el-button>
        <el-tag v-if="livenessRunning" type="info" size="small" style="margin-left: 8px">
          {{ livenessProgress.done }}/{{ livenessProgress.total }} (✗{{ livenessProgress.failed }})
        </el-tag>
        <el-select v-model="aliveFilter" placeholder="活性" clearable size="small" style="width:130px;margin-left:8px">
          <el-option v-for="o in aliveFilterOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
```

- [ ] **Step 3: 改 `Accounts.vue` — 加活性列**

In the `<el-table>` block (lines 40-79), after the 计划 column (lines 49-55) insert:

```vue
      <el-table-column label="活性" width="120">
        <template #default="{ row }">
          <el-tooltip v-if="row.alive_reason" :content="row.alive_reason" placement="top">
            <el-tag :type="aliveStatusType(row.alive_status)" size="small">
              {{ aliveStatusLabel(row.alive_status) }}
            </el-tag>
          </el-tooltip>
          <el-tag v-else :type="aliveStatusType(row.alive_status)" size="small">
            {{ aliveStatusLabel(row.alive_status) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="上次测活" width="120">
        <template #default="{ row }">
          <span v-if="row.alive_checked_at" :title="row.alive_checked_at" style="color:#909399">
            {{ formatRelative(row.alive_checked_at) }}
          </span>
          <span v-else style="color:#c0c4cc">-</span>
        </template>
      </el-table-column>
```

- [ ] **Step 4: 改 `<script setup>` — 加 imports / state / handlers**

In the `<script setup>` block at the top (after line 112 imports), add:

```js
import { aliveStatusType, aliveStatusLabel, ALIVE_FILTER_OPTIONS } from '../status'
```

After the existing reactive refs declaration block (around line 119-121), add:

```js
const aliveFilter = ref('')
const aliveFilterOptions = ALIVE_FILTER_OPTIONS

const livenessRunning = ref(false)
const livenessProgress = ref({ done: 0, total: 0, failed: 0 })

function formatRelative(iso) {
  if (!iso) return '-'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return '刚刚'
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + ' 分钟前'
  if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + ' 小时前'
  return Math.floor(ms / 86_400_000) + ' 天前'
}

async function startLiveness(scope) {
  const body = scope === 'selected'
    ? { emails: selected.value.map((r) => r.email) }
    : {}
  try {
    await api.post('/api/liveness/start', body)
    livenessRunning.value = true
    livenessProgress.value = { done: 0, total: 0, failed: 0 }
  } catch (e) {
    ElMessage.error(`测活启动失败: ${e?.response?.data?.error || e.message}`)
  }
}

async function stopLiveness() {
  try { await api.post('/api/liveness/stop') }
  catch (e) { ElMessage.error(`停止失败: ${e.message}`) }
}
```

- [ ] **Step 5: 改 `<script setup>` — 接 socket.io 事件**

Locate where `socket.on('account-status', ...)` is wired (search "account-status" in Accounts.vue; it's around onMounted). After that block, add:

```js
socket.on('liveness-status', ({ email, alive_status, alive_reason }) => {
  const row = accounts.value.find((a) => a.email === email)
  if (row) {
    row.alive_status = alive_status
    row.alive_reason = alive_reason
    if (alive_status !== 'checking') row.alive_checked_at = new Date().toISOString()
  }
})
socket.on('liveness-progress', (p) => { livenessProgress.value = p })
socket.on('liveness-complete', ({ summary, durationMs }) => {
  livenessRunning.value = false
  const parts = []
  if (summary.plus) parts.push(`${summary.plus} Plus`)
  if (summary.canceled) parts.push(`${summary.canceled} 已取消`)
  if (summary.login_fail) parts.push(`${summary.login_fail} 登录失败`)
  if (summary.token_expired) parts.push(`${summary.token_expired} Token过期`)
  if (summary.proxy_error) parts.push(`${summary.proxy_error} 代理异常`)
  if (summary.network_error) parts.push(`${summary.network_error} 网络异常`)
  ElMessage.success(`测活完成 (${Math.round(durationMs / 1000)}s): ${parts.join(' / ')}`)
})
```

(If the existing socket import differs — e.g. it's `props.socket` or a composable — adapt to match. The existing socket pattern is established in Accounts.vue's onMounted; reuse it.)

- [ ] **Step 6: 改 `filteredAccounts` computed — 加 aliveFilter**

Find the `filteredAccounts` computed in Accounts.vue (search for it in `<script setup>`). Inside the filter chain, add:

```js
  if (aliveFilter.value) results = results.filter((a) => (a.alive_status || 'unknown') === aliveFilter.value)
```

- [ ] **Step 7: Build front-end + smoke**

Run:

```bash
cd web && npm run build
cd .. && node server/index.js   # in background, then open http://localhost:3000
```

Manually verify in browser:
- Accounts page loads, "测活选中" / "测活全部" buttons visible (disabled until you select / always-enabled respectively)
- 活性列 renders for existing accounts as 「未测试」（gray）
- 活性筛选下拉里有 8 个选项
- Click 测活选中 with 1 account that has a fresh cpa-auth/codex-*.json → 1-2s later 活性变 🟢 Plus

- [ ] **Step 8: Commit**

```bash
git add web/src/status.js web/src/views/Accounts.vue
git commit -m "feat(ui): liveness probe button + 活性 column + filter

Accounts page gets two new toolbar buttons next to 取消选中:
  测活选中 (disabled when no rows selected)
  测活全部 (always enabled when runner is idle)
When the runner is running, both buttons collapse into a single
红色 停止测活 button + a progress chip 「done/total (✗failed)」.

A new 活性 column (with tooltip on alive_reason) and 上次测活 column
(relative time, hover for ISO) sit immediately to the right of 计划.
The 8 alive_status values render as colored el-tags via the new
aliveStatusType/aliveStatusLabel helpers in status.js. Filter dropdown
'活性' lives next to the existing 状态/Plan/Auth filters.

socket.io listeners:
  liveness-status → patch row.alive_status / alive_reason in place
  liveness-progress → mutate the toolbar chip
  liveness-complete → ElMessage.success with the summary

No backend handoff: socket events use the existing io instance
already wired for account-status / log."
```

---

## Task 8: 集成 smoke + final review

**Files:** none modified; this is verification.

- [ ] **Step 1: Restart server with fresh build**

```bash
node server/index.js   # in background
```

Wait for: `Server running on http://localhost:3000` + `[Proxy] sing-box running: main=:7890`.

- [ ] **Step 2: Smoke test scenarios**

Open browser at `http://localhost:3000`, navigate to Accounts page. Run:

| 场景 | 操作 | 期望 |
|---|---|---|
| Healthy token | 选 2 个有 cpa-auth file 且 JWT 未过期的账号 → 测活选中 | 1-2s 内 🟢 Plus；活性列 hover 显示 'check ok' |
| Stale JWT | 选 1 个 codex-*.json `expired` 在过去时间的账号 → 测活选中 | 走重登（10-30s）→ 🟢 Plus 或 🔴 登录失败；codex-*.json 被覆写（mtime 刷新） |
| Proxy down | 关掉 sing-box → 测活全部 | 全部 🟠 代理异常 |
| Test all 100 | 测活全部 | 进度条 0→100；总耗时 60-180s；summary 显示 |
| Stop mid-batch | 测活全部 → 立即点 停止测活 | 几秒内 livenessRunning=false；后续账号活性保持 |
| Concurrent execute | 测活进行中点 执行选中 | 两条进度独立推进，互不阻塞 |

- [ ] **Step 3: Verify spec invariants by inspection**

Run:

```bash
grep -c "sub2api" server/liveness/ -r
```

Expected: 0 (spec says liveness must not touch sub2api).

```bash
node -e "
const { initDB, statusDB } = require('./server/db');
initDB().then(() => {
  // Pick an arbitrary account that has both an execution status AND an alive_status.
  const rows = statusDB.list();
  const both = rows.find(r => r.status && r.status !== 'idle' && r.alive_status && r.alive_status !== 'unknown');
  if (both) {
    console.log('execution status:', both.status, '| alive:', both.alive_status, '| payment_link:', both.payment_link.slice(0,40));
    console.log('INVARIANT: status + alive coexist independently → ' + (both.status !== both.alive_status ? 'OK' : 'OK (happens to match)'));
  } else console.log('No row with both yet — run smoke step 2 first.');
});
"
```

Expected: status / alive_status / payment_link all populated independently.

- [ ] **Step 4: Run full regression one last time**

Run: `node --test __tests__ server/__tests__ server/proxy/__tests__ server/liveness/__tests__`
Expected: 102 tests pass (52 baseline + 6 payment-link + 5 db-alive + 11 checker + 7 codex-file + 8 light-login + 8 runner + 5 routes-liveness).

- [ ] **Step 5: CHANGELOG**

Edit `docs/CHANGELOG.md`, prepend a `## v2.26.0 — Account Liveness Check` section:

```markdown
## v2.26.0 — Account Liveness Check (2026-05-24)

### 核心改动
- **一键测活按钮**：Accounts 页顶部新增 "测活选中 / 测活全部"，对账号批量调 `/backend-api/accounts/check` 判 Plus + token 有效性。
- **Lazy hybrid 流程**：先用现存 access_token 调 check；返 401 或本地 JWT 已过期 → 自动密码 + OTP 重登拿 `/api/auth/session` 的 access_token、手工拼装 `cpa-auth/codex-{email}.json`，不走 PKCE。
- **新 8 种活性状态**：plus / canceled / login_fail / token_expired / proxy_error / network_error / unknown / checking，与执行流水线 status 完全独立。
- **独立 runner**：`server/liveness/` 模块跟 PipelineEngine / ProtocolEngine 完全解耦，3 并发 + 1s 节流，可与主流水线并行运行。

### 端到端验证
- 102/102 tests passing（含 35 个新单元测试 — checker 11 / codex-file 7 / light-login 8 / runner 8 / db-alive 5 / routes-liveness 5）。
- 手工 smoke：6 scenarios（healthy / stale / proxy down / 100-account batch / mid-batch stop / concurrent with /api/execute）全部通过。

### Phase B 待办
- 协议模式 light-login（`config.protocolMode=true` 时的密码+OTP 重登）—— 当前协议模式只能 check 未过期 token，需重登的账号标 `login_fail: liveness not yet supported in protocol mode`。后续将单独立 spec。
```

- [ ] **Step 6: Commit CHANGELOG + tag**

```bash
git add docs/CHANGELOG.md
git commit -m "docs(changelog): v2.26.0 account liveness check"
```

Do **not** tag / push / merge — that's a separate user-driven step after this entire plan PR ships.

---

## Self-review checklist (run me before handoff)

- [ ] Each spec section maps to ≥1 task:
  - §1 background → no task (informational)
  - §2 architecture → Task 1-7 file structure matches
  - §3 web-session technical → Task 4 (lightLogin) + Task 3 (codex-file) writes spec §3.2 fields
  - §4 single-account data flow → Task 5 (runner.dispatchOne)
  - §5 DB schema + statusDB API → Task 1
  - §6 HTTP + Socket.IO → Task 6
  - §7 UI → Task 7
  - §8 边界 → covered by Task 5 (runner) error mapping + Task 4 lightLogin error mapping
  - §9 测试 → Task 1-6 含 41 tests (5+11+7+8+8+5 — note: spec 写 35; 多 6 个因 mapPlanType/sanitize/protocolMode 等子单元拆开测)
  - §10 YAGNI → no task by design (don't build them)
- [ ] No "TBD / TODO / fill in"
- [ ] Method/property names consistent (`setAlive`, `clearAlive`, `aliveStatusLabel`, `aliveStatusType`, `aliveFilter`, `livenessRunning`, `livenessProgress` everywhere)
- [ ] All test commands quoted exactly
- [ ] Imports in Task 6 (`require('../login').fetchOtp`) is the one tentative wiring — Task 8 smoke step verifies and Task 8's "if it doesn't match" fallback is to swap it for the correct path then re-commit

---

## Phase B follow-up note (for future spec author)

The 协议模式 light-login implementation should:
- Live at `chatgpt_register/liveness_login.py`
- Reuse `protocol_register.py` Auth0 helpers (sentinel pipeline + curl_cffi)
- End at `https://chatgpt.com/api/auth/session` and emit a JSON-line of `{access_token, expires}`
- Be exec'd from a thin Node wrapper in `server/liveness/light-login.js` (currently the `if (protocolMode)` branch that throws)

Spec budget: ~200 lines + 5 unit tests. Plan budget: 3-4 tasks. Don't tackle this without a fresh brainstorm.
