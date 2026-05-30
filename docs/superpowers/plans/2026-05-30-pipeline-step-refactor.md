# 激活流水线步骤化重构 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把三套激活引擎（PayPal-browser / PayPal-protocol / GoPay）抽到一套共享的步骤管线，提供步骤可视化、per-step checkpoint 恢复、每步日志，且**逻辑零删减**。

**Architecture:** 新增 `server/pipeline/`（Step 契约 + AccountContext + PipelineRunner），三引擎退化成"装配 + 资源生命周期"的薄壳；每个 step 的 `run()` 从现有引擎**逐行搬运**，靠特征化测试与每期 diff-review 守住行为等价。

**Tech Stack:** Node.js（CommonJS）、`node:test`、`sql.js`(WASM SQLite)、Socket.IO、Vue 3 + Element Plus、Python(`curl_cffi`) 子进程。

> **第一硬约束（贯穿全程）：逻辑零删减。** migration 任务（P1–P3）的"代码"即现有引擎在指定 `file:line` 的原文——任务要求把那段代码**原样搬运**进 step，不得合并/简化/删分支。疑似冗余标 `SUSPECT_DEAD` 上报，确认前保留。每期末有 diff-review 闸门。

参考 spec：`docs/superpowers/specs/2026-05-30-pipeline-step-refactor-design.md`

---

## 文件结构

| 文件 | 职责 | 阶段 |
|---|---|---|
| `server/pipeline/step.js` | Step 契约 + `defineStep()` 校验器 | P0 |
| `server/pipeline/context.js` | `AccountContext` —— 单账号一次运行的状态 + checkpoint 读写 + 日志归属 | P0 |
| `server/pipeline/runner.js` | `PipelineRunner` —— 账号循环 / 按序跑步 / skip / step-status 事件 / 持久化 / abort | P0 |
| `server/pipeline/index.js` | `buildPipeline({login, payment})` → 有序 Step[] | P0(骨架) / P1-P3(填充) |
| `server/db.js` | 新增 `account_step_state` 表 + `stepStateDB` API | P0 |
| `server/pipeline/steps/login.js` | LOGIN（注入 browserLogin/protocolLogin 策略） | P1/P2 |
| `server/pipeline/steps/plan-check.js` | 套餐检查（共享） | P1 |
| `server/pipeline/steps/paypal-fetch.js` | PayPal 取支付链接 | P1 |
| `server/pipeline/steps/paypal-verify.js` | PayPal Stripe $0 验证 | P1 |
| `server/pipeline/steps/paypal-pay.js` | PayPal Chrome+PayPal+短信（复用 `payment.js`） | P1 |
| `server/pipeline/steps/paypal-pkce.js` | PayPal PKCE / add-phone / 写凭证 | P1 |
| `server/pipeline/steps/gopay-register.js` | GoPay 钱包注册（Phase 4） | P3 |
| `server/pipeline/steps/gopay-pay.js` | GoPay 拿 snap+付款（Phase 3+5）+ 验证 Plus | P3 |
| `protocol-engine.js` / `server/engine.js` / `server/gopay-engine.js` | 退化成薄壳，构造 pipeline + 持有资源 | P1/P2/P3 |
| `gopay_activate.py` | 拆 `register` / `pay` 两入口（phase 函数体不改） | P3 |
| `web/src/components/AccountStepDrawer.vue` | 纵向 stepper + 每步日志 + 重试按钮 | P4 |
| `server/routes/execute.js` / `accounts.js` | 新增 `retry-step` / `:email/steps` 路由 | P4 |
| `docs/superpowers/plans/inventory/*.md` | 每个引擎的行为清单/可追溯映射表 | P1/P2/P3 |

> **测试约定**（全仓库一致）：`node:test`，DB 测试用 `path.join` 劫持把 `data.db` 指向临时文件（见 `server/__tests__/db-atomic.test.js` 头部）。跑全部：`npm test`。跑单文件：`node --test "server/__tests__/xxx.test.js"`。

---

# 阶段 P0 —— 引擎无关的步骤管线内核（greenfield，可独立验证）

P0 不碰任何引擎，只建可单测的内核：DB 表 + Step 契约 + Context + Runner。交付物：一套用 fake step 即可验证 skip/恢复/事件/持久化的 runner。

## Task 0.1: `account_step_state` 表 + `stepStateDB` API

**Files:**
- Modify: `server/db.js:17-46`（在 `account_status` 建表块后追加新表）、`server/db.js:365` 附近（新增 `stepStateDB`）、`server/db.js:456`（`module.exports`）
- Test: `server/__tests__/step-state-db.test.js`

- [ ] **Step 1: 写失败测试**

```js
// server/__tests__/step-state-db.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stepstate-test-'));
const fakeDb = path.join(tmpDir, 'data.db');
const realPath = require('path');
const origJoin = realPath.join;
realPath.join = function (...args) {
  if (args[args.length - 1] === 'data.db') return fakeDb;
  return origJoin.apply(this, args);
};
const { initDB, stepStateDB, save } = require('../db');
realPath.join = origJoin;

test('setup', async () => { await initDB(); await save.flush(); });

test('set + get a step row', async () => {
  stepStateDB.set('a@x.com', 'login', { status: 'success', startedAt: 't1', finishedAt: 't2' });
  await save.flush();
  const row = stepStateDB.get('a@x.com', 'login');
  assert.strictEqual(row.status, 'success');
  assert.strictEqual(row.started_at, 't1');
  assert.strictEqual(row.finished_at, 't2');
});

test('set merges — updating status keeps prior started_at', async () => {
  stepStateDB.set('a@x.com', 'pay', { status: 'running', startedAt: 's1' });
  stepStateDB.set('a@x.com', 'pay', { status: 'failed', reason: 'boom', finishedAt: 'f1' });
  await save.flush();
  const row = stepStateDB.get('a@x.com', 'pay');
  assert.strictEqual(row.status, 'failed');
  assert.strictEqual(row.reason, 'boom');
  assert.strictEqual(row.started_at, 's1', 'started_at preserved across merge');
});

test('list returns all steps for an email', async () => {
  const rows = stepStateDB.list('a@x.com');
  assert.ok(rows.length >= 2);
  assert.ok(rows.every(r => r.email === 'a@x.com'));
});

test('get returns null for missing', () => {
  assert.strictEqual(stepStateDB.get('a@x.com', 'nope'), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test "server/__tests__/step-state-db.test.js"`
Expected: FAIL（`stepStateDB` 未定义 / 表不存在）

- [ ] **Step 3: 建表** —— 在 `server/db.js` 的 `db.run(\`...\`)` 建表块内（`execution_logs` 表之后、约 `server/db.js:54`）追加：

```sql
    CREATE TABLE IF NOT EXISTS account_step_state (
      email       TEXT NOT NULL,
      step_id     TEXT NOT NULL,
      status      TEXT DEFAULT 'pending',
      reason      TEXT DEFAULT '',
      started_at  TEXT DEFAULT '',
      finished_at TEXT DEFAULT '',
      updated_at  TEXT DEFAULT '',
      PRIMARY KEY (email, step_id)
    );
```

- [ ] **Step 4: 加 `stepStateDB`** —— 在 `server/db.js` 的 `logsDB`（约 `:365`）之后、`module.exports` 之前追加：

```js
const stepStateDB = {
  get(email, stepId) {
    const stmt = db.prepare("SELECT * FROM account_step_state WHERE email=? AND step_id=?");
    stmt.bind([email, stepId]);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row;
  },
  list(email) {
    const stmt = db.prepare("SELECT * FROM account_step_state WHERE email=? ORDER BY started_at");
    stmt.bind([email]);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  },
  set(email, stepId, data) {
    const existing = this.get(email, stepId) || {};
    const incoming = data || {};
    const status      = 'status'     in incoming ? (incoming.status || 'pending') : (existing.status || 'pending');
    const reason      = 'reason'     in incoming ? (incoming.reason || '')        : (existing.reason || '');
    const started_at  = 'startedAt'  in incoming ? (incoming.startedAt || '')     : (existing.started_at || '');
    const finished_at = 'finishedAt' in incoming ? (incoming.finishedAt || '')    : (existing.finished_at || '');
    db.run(
      "INSERT OR REPLACE INTO account_step_state (email, step_id, status, reason, started_at, finished_at, updated_at) VALUES (?,?,?,?,?,?,datetime('now'))",
      [email, stepId, status, reason, started_at, finished_at]
    );
    save();
  },
  reset(email) { db.run("DELETE FROM account_step_state WHERE email=?", [email]); save(); },
};
```

并把 `stepStateDB` 加入导出（`server/db.js:456`）：

```js
module.exports = { initDB, accountsDB, statusDB, logsDB, stepStateDB, livenessLogsDB, proxyDB, save, getRawDb: () => db };
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test "server/__tests__/step-state-db.test.js"`
Expected: PASS（4 测试）

- [ ] **Step 6: 回归全套 + 提交**

```bash
npm test
git add server/db.js server/__tests__/step-state-db.test.js
git commit -m "feat(pipeline): account_step_state 表 + stepStateDB API (P0)"
```

## Task 0.2: Step 契约 `defineStep()`

**Files:**
- Create: `server/pipeline/step.js`
- Test: `server/__tests__/pipeline-step.test.js`

- [ ] **Step 1: 写失败测试**

```js
// server/__tests__/pipeline-step.test.js
const test = require('node:test');
const assert = require('node:assert');
const { defineStep } = require('../../server/pipeline/step');

test('valid step passes through with default shouldSkip', () => {
  const s = defineStep({ id: 'login', label: '登录', run: async () => ({ ok: true }) });
  assert.strictEqual(s.id, 'login');
  assert.strictEqual(s.label, '登录');
  assert.strictEqual(typeof s.shouldSkip, 'function');
  assert.strictEqual(s.shouldSkip({}), false);
});

test('missing id throws', () => {
  assert.throws(() => defineStep({ label: 'x', run: async () => {} }), /id required/);
});

test('missing run throws', () => {
  assert.throws(() => defineStep({ id: 'x', label: 'x' }), /run\(\) required/);
});

test('custom shouldSkip preserved', () => {
  const s = defineStep({ id: 'x', label: 'x', shouldSkip: () => true, run: async () => {} });
  assert.strictEqual(s.shouldSkip({}), true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test "server/__tests__/pipeline-step.test.js"`
Expected: FAIL（找不到模块）

- [ ] **Step 3: 实现**

```js
// server/pipeline/step.js
// Step 契约：纯对象 { id, label, shouldSkip?, run }
//   shouldSkip(ctx) -> boolean        命中有效 checkpoint 则跳过（默认不跳）
//   run(ctx)        -> Promise<{ ok, status?, reason?, output? }>
function defineStep(step) {
  if (!step || typeof step.id !== 'string' || !step.id) throw new Error('Step.id required');
  if (typeof step.label !== 'string' || !step.label) throw new Error(`Step ${step.id}: label required`);
  if (typeof step.run !== 'function') throw new Error(`Step ${step.id}: run() required`);
  return {
    id: step.id,
    label: step.label,
    shouldSkip: typeof step.shouldSkip === 'function' ? step.shouldSkip : () => false,
    run: step.run,
  };
}

module.exports = { defineStep };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test "server/__tests__/pipeline-step.test.js"`
Expected: PASS（4 测试）

- [ ] **Step 5: 提交**

```bash
git add server/pipeline/step.js server/__tests__/pipeline-step.test.js
git commit -m "feat(pipeline): Step 契约 defineStep (P0)"
```

## Task 0.3: `AccountContext`

**Files:**
- Create: `server/pipeline/context.js`
- Test: `server/__tests__/pipeline-context.test.js`

- [ ] **Step 1: 写失败测试**

```js
// server/__tests__/pipeline-context.test.js
const test = require('node:test');
const assert = require('node:assert');
const { AccountContext } = require('../../server/pipeline/context');

function fakeDeps() {
  const store = {};
  return {
    statusDB: { get: (e) => store[e] || null, set: (e, d) => { store[e] = { ...(store[e] || {}), ...d }; } },
    logged: [],
    log(email, stepId, msg) { this.logged.push({ email, stepId, msg }); },
  };
}

test('exposes account fields', () => {
  const ctx = new AccountContext({ email: 'a@x.com', password: 'p' }, fakeDeps());
  assert.strictEqual(ctx.email, 'a@x.com');
  assert.strictEqual(ctx.account.password, 'p');
});

test('getPersisted reads statusDB', () => {
  const deps = fakeDeps();
  deps.statusDB.set('a@x.com', { last_access_token: 'tok' });
  const ctx = new AccountContext({ email: 'a@x.com' }, deps);
  assert.strictEqual(ctx.getPersisted().last_access_token, 'tok');
});

test('log routes through deps.log with currentStepId', () => {
  const deps = fakeDeps();
  const ctx = new AccountContext({ email: 'a@x.com' }, deps);
  ctx.currentStepId = 'login';
  ctx.log('hello');
  assert.deepStrictEqual(deps.logged[0], { email: 'a@x.com', stepId: 'login', msg: 'hello' });
});

test('outputs + flags are mutable bags', () => {
  const ctx = new AccountContext({ email: 'a@x.com' }, fakeDeps());
  ctx.outputs.login = { accessToken: 't' };
  ctx.flags.alreadyPlus = true;
  assert.strictEqual(ctx.outputs.login.accessToken, 't');
  assert.strictEqual(ctx.flags.alreadyPlus, true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test "server/__tests__/pipeline-context.test.js"`
Expected: FAIL（找不到模块）

- [ ] **Step 3: 实现**

```js
// server/pipeline/context.js
// AccountContext —— 单账号一次运行的状态容器 + checkpoint 读写 + 日志归属。
// deps: { statusDB, stepStateDB, logsDB, save, proxyMgr, resources, log(email, stepId, msg) }
class AccountContext {
  constructor(account, deps) {
    this.account = account;          // { email, password, client_id, refresh_token, login_type }
    this.email = account.email;
    this.deps = deps;
    this.currentStepId = '';
    this.outputs = {};               // step.id -> 该步产物（本次运行内存态）
    this.flags = {};                 // 跨步标志，如 alreadyPlus
  }
  getPersisted() { return this.deps.statusDB.get(this.email) || {}; }
  setStatus(data) { this.deps.statusDB.set(this.email, data); }
  log(msg) { if (this.deps.log) this.deps.log(this.email, this.currentStepId, msg); }
}

module.exports = { AccountContext };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test "server/__tests__/pipeline-context.test.js"`
Expected: PASS（4 测试）

- [ ] **Step 5: 提交**

```bash
git add server/pipeline/context.js server/__tests__/pipeline-context.test.js
git commit -m "feat(pipeline): AccountContext (P0)"
```

## Task 0.4: `PipelineRunner`（内核：skip / 恢复点 / step-status / 持久化 / abort）

**Files:**
- Create: `server/pipeline/runner.js`
- Test: `server/__tests__/pipeline-runner.test.js`

- [ ] **Step 1: 写失败测试**

```js
// server/__tests__/pipeline-runner.test.js
const test = require('node:test');
const assert = require('node:assert');
const { PipelineRunner } = require('../../server/pipeline/runner');
const { AccountContext } = require('../../server/pipeline/context');
const { defineStep } = require('../../server/pipeline/step');

function harness() {
  const stepRows = {};                 // `${email}|${id}` -> last patch
  const events = [];
  const deps = {
    statusDB: { get: () => null, set: () => {} },
    stepStateDB: { set: (email, id, patch) => { stepRows[`${email}|${id}`] = { ...(stepRows[`${email}|${id}`]||{}), ...patch }; } },
    log: () => {},
  };
  const runner = new PipelineRunner(deps);
  runner.on('step-status', (e) => events.push(e));
  return { runner, deps, events, stepRows };
}

test('runs all steps in order, emits running+success, records done', async () => {
  const { runner, deps, events } = harness();
  const order = [];
  const steps = [
    defineStep({ id: 's1', label: 'S1', run: async () => { order.push('s1'); return { ok: true }; } }),
    defineStep({ id: 's2', label: 'S2', run: async () => { order.push('s2'); return { ok: true }; } }),
  ];
  const ctx = new AccountContext({ email: 'a@x.com' }, deps);
  const res = await runner._runAccount(ctx, steps);
  assert.deepStrictEqual(order, ['s1', 's2']);
  assert.strictEqual(res.completed, true);
  assert.deepStrictEqual(events.map(e => `${e.stepId}:${e.status}`),
    ['s1:running', 's1:success', 's2:running', 's2:success']);
});

test('shouldSkip true → skipped, run not called (auto-resume)', async () => {
  const { runner, deps, events } = harness();
  let ran = false;
  const steps = [
    defineStep({ id: 's1', label: 'S1', shouldSkip: () => true, run: async () => { ran = true; return { ok: true }; } }),
    defineStep({ id: 's2', label: 'S2', run: async () => ({ ok: true }) }),
  ];
  const ctx = new AccountContext({ email: 'a@x.com' }, deps);
  await runner._runAccount(ctx, steps);
  assert.strictEqual(ran, false);
  assert.ok(events.some(e => e.stepId === 's1' && e.status === 'skipped'));
});

test('failure (ok:false) stops pipeline, downstream not run', async () => {
  const { runner, deps, events } = harness();
  let s3ran = false;
  const steps = [
    defineStep({ id: 's1', label: 'S1', run: async () => ({ ok: true }) }),
    defineStep({ id: 's2', label: 'S2', run: async () => ({ ok: false, reason: 'boom' }) }),
    defineStep({ id: 's3', label: 'S3', run: async () => { s3ran = true; return { ok: true }; } }),
  ];
  const ctx = new AccountContext({ email: 'a@x.com' }, deps);
  const res = await runner._runAccount(ctx, steps);
  assert.strictEqual(s3ran, false);
  assert.strictEqual(res.stoppedAt, 's2');
  assert.ok(events.some(e => e.stepId === 's2' && e.status === 'failed' && e.reason === 'boom'));
});

test('thrown error → failed with message, stops', async () => {
  const { runner, deps, events } = harness();
  const steps = [
    defineStep({ id: 's1', label: 'S1', run: async () => { throw new Error('kaboom'); } }),
    defineStep({ id: 's2', label: 'S2', run: async () => ({ ok: true }) }),
  ];
  const ctx = new AccountContext({ email: 'a@x.com' }, deps);
  const res = await runner._runAccount(ctx, steps);
  assert.strictEqual(res.stoppedAt, 's1');
  assert.ok(events.some(e => e.stepId === 's1' && e.status === 'failed' && /kaboom/.test(e.reason)));
});

test('forceStepId re-runs that step even if shouldSkip true; valid upstream still skipped', async () => {
  const { runner, deps } = harness();
  const calls = [];
  const steps = [
    defineStep({ id: 's1', label: 'S1', shouldSkip: () => true, run: async () => { calls.push('s1'); return { ok: true }; } }),
    defineStep({ id: 's2', label: 'S2', shouldSkip: () => true, run: async () => { calls.push('s2'); return { ok: true }; } }),
  ];
  const ctx = new AccountContext({ email: 'a@x.com' }, deps);
  await runner._runAccount(ctx, steps, { forceStepId: 's2' });
  assert.deepStrictEqual(calls, ['s2'], 's1 stayed skipped, s2 forced to run');
});

test('stopFlag halts before next step', async () => {
  const { runner, deps } = harness();
  const calls = [];
  const steps = [
    defineStep({ id: 's1', label: 'S1', run: async () => { calls.push('s1'); runner.stopFlag = true; return { ok: true }; } }),
    defineStep({ id: 's2', label: 'S2', run: async () => { calls.push('s2'); return { ok: true }; } }),
  ];
  const ctx = new AccountContext({ email: 'a@x.com' }, deps);
  await runner._runAccount(ctx, steps);
  assert.deepStrictEqual(calls, ['s1']);
});

test('output is stashed on ctx.outputs', async () => {
  const { runner, deps } = harness();
  const steps = [
    defineStep({ id: 's1', label: 'S1', run: async () => ({ ok: true, output: { token: 't' } }) }),
  ];
  const ctx = new AccountContext({ email: 'a@x.com' }, deps);
  await runner._runAccount(ctx, steps);
  assert.strictEqual(ctx.outputs.s1.token, 't');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test "server/__tests__/pipeline-runner.test.js"`
Expected: FAIL（找不到模块）

- [ ] **Step 3: 实现**

```js
// server/pipeline/runner.js
const { EventEmitter } = require('events');

// PipelineRunner —— 跑一个账号的 Step[]：按序、跳过命中 checkpoint 的步、
// 第一个不可跳的步=恢复点、失败即停、发 step-status、落 stepStateDB。
// deps: { statusDB, stepStateDB, logsDB, save, log, proxyMgr, resources }
class PipelineRunner extends EventEmitter {
  constructor(deps) {
    super();
    this.deps = deps;
    this.stopFlag = false;
    this._activeCtx = null;   // LogCapture handler 读它拿 currentStepId
  }

  // opts.forceStepId: 手动单步重试 —— 强制该步即使 shouldSkip 也跑（上游有效 checkpoint 仍跳过 = 自动回补）
  async _runAccount(ctx, steps, opts = {}) {
    this._activeCtx = ctx;
    const forceId = opts.forceStepId || null;
    for (let i = 0; i < steps.length; i++) {
      if (this.stopFlag) return { stoppedAt: ctx.currentStepId, aborted: true };
      const step = steps[i];
      ctx.currentStepId = step.id;
      const forced = step.id === forceId;
      if (!forced && step.shouldSkip(ctx)) {
        this._recordStep(ctx, step, 'skipped');
        continue;
      }
      this._recordStep(ctx, step, 'running');
      let result;
      try {
        result = await step.run(ctx);
      } catch (e) {
        this._recordStep(ctx, step, 'failed', e.message);
        return { stoppedAt: step.id, reason: e.message };
      }
      if (result && result.ok === false) {
        this._recordStep(ctx, step, 'failed', result.reason || '');
        return { stoppedAt: step.id, reason: result.reason };
      }
      if (result && result.output) ctx.outputs[step.id] = result.output;
      this._recordStep(ctx, step, 'success');
    }
    return { completed: true };
  }

  _recordStep(ctx, step, status, reason = '') {
    const now = new Date().toISOString();
    const patch = { status, reason };
    if (status === 'running') patch.startedAt = now;
    if (status === 'success' || status === 'failed' || status === 'skipped') patch.finishedAt = now;
    try { this.deps.stepStateDB.set(ctx.email, step.id, patch); } catch {}
    this.emit('step-status', { email: ctx.email, stepId: step.id, label: step.label, status, reason });
  }
}

module.exports = { PipelineRunner };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test "server/__tests__/pipeline-runner.test.js"`
Expected: PASS（7 测试）

- [ ] **Step 5: 回归全套 + 提交**

```bash
npm test
git add server/pipeline/runner.js server/__tests__/pipeline-runner.test.js
git commit -m "feat(pipeline): PipelineRunner 内核 + step-status 事件 (P0)"
```

## Task 0.5: `buildPipeline` 骨架（占位策略，后续阶段填充）

**Files:**
- Create: `server/pipeline/index.js`
- Test: `server/__tests__/pipeline-build.test.js`

- [ ] **Step 1: 写失败测试**

```js
// server/__tests__/pipeline-build.test.js
const test = require('node:test');
const assert = require('node:assert');
const { buildPipeline } = require('../../server/pipeline');

test('paypal pipeline declares the 6 user-facing steps in order', () => {
  const steps = buildPipeline({ login: 'protocol', payment: 'paypal' });
  assert.deepStrictEqual(steps.map(s => s.id),
    ['login', 'plan-check', 'paypal-fetch', 'paypal-verify', 'paypal-pay', 'paypal-pkce']);
});

test('gopay pipeline declares its 5 steps in order', () => {
  const steps = buildPipeline({ login: 'protocol', payment: 'gopay' });
  assert.deepStrictEqual(steps.map(s => s.id),
    ['login', 'plan-check', 'gopay-register', 'gopay-pay', 'gopay-verify']);
});

test('every step satisfies the contract', () => {
  for (const combo of [{ login: 'protocol', payment: 'paypal' }, { login: 'browser', payment: 'paypal' }, { login: 'protocol', payment: 'gopay' }]) {
    for (const s of buildPipeline(combo)) {
      assert.ok(s.id && s.label && typeof s.run === 'function' && typeof s.shouldSkip === 'function', `bad step ${s.id}`);
    }
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test "server/__tests__/pipeline-build.test.js"`
Expected: FAIL（找不到模块）

- [ ] **Step 3: 实现骨架** —— 此刻 step 的 `run()` 还是占位（throw "not migrated yet"），P1-P3 逐个替换为真实实现。这样 `buildPipeline` 的"步序契约"先被测试锁定。

```js
// server/pipeline/index.js
const { defineStep } = require('./step');

// 占位 step：P1-P3 用真实模块替换。throw 确保未迁移的步不会被静默当成功。
function placeholder(id, label) {
  return defineStep({ id, label, run: async () => { throw new Error(`step ${id} not migrated yet`); } });
}

// P1-P3 完成后，这里改成 require('./steps/login') 等真实模块。
function buildPipeline({ login = 'protocol', payment = 'paypal' } = {}) {
  const loginStep = placeholder('login', '登录 + 获取 access token');   // 注入 login 策略在 P1/P2
  const planCheck = placeholder('plan-check', '套餐检查');
  if (payment === 'gopay') {
    return [
      loginStep,
      planCheck,
      placeholder('gopay-register', 'GoPay 钱包注册'),
      placeholder('gopay-pay', '拿 snap + 付款'),
      placeholder('gopay-verify', '验证 Plus'),
    ];
  }
  return [
    loginStep,
    planCheck,
    placeholder('paypal-fetch', '获取支付链接'),
    placeholder('paypal-verify', 'Stripe 验证 $0'),
    placeholder('paypal-pay', '支付'),
    placeholder('paypal-pkce', 'PKCE / 凭证'),
  ];
}

module.exports = { buildPipeline };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test "server/__tests__/pipeline-build.test.js"`
Expected: PASS（3 测试）

- [ ] **Step 5: 回归全套 + 提交**

```bash
npm test
git add server/pipeline/index.js server/__tests__/pipeline-build.test.js
git commit -m "feat(pipeline): buildPipeline 步序骨架 (P0)"
```

**P0 验收**：`npm test` 全绿；`server/pipeline/` 内核可用 fake step 完整验证 skip/恢复/事件/持久化；未碰任何引擎。

---

# 阶段 P1 —— 迁移 protocol 引擎（PayPal）到 runner

> **本阶段是 migration，第一硬约束生效。** 顺序固定：① 先建行为清单 → ② 写特征化测试 → ③ 逐 step 逐行搬运 → ④ ProtocolEngine 接 runner → ⑤ 全量回归 + diff-review。

## Task 1.1: protocol 引擎行为清单（可追溯映射表）

**Files:**
- Create: `docs/superpowers/plans/inventory/protocol-engine.md`

- [ ] **Step 1: 通读 `protocol-engine.js:549-1007`（`start()` 主循环）+ `_finalizePkce`(`:459-501`) + `_finalizePhoneVerify`(`:356-457`) + `_acquirePhoneForProtocol`(`:194-354`)，逐条登记**。表格列：`源 file:line | 现象/分支 | 去处 step.id | 备注`。必须覆盖（来自 spec §12.2，不得漏）：

```markdown
# protocol-engine 行为清单（迁移基线，逐行勾稽）

| 源 file:line | 现象/分支 | 去处 step | 备注 |
|---|---|---|---|
| protocol-engine.js:623-643 | cached-login fast-path（JWT exp+60s） | login.shouldSkip | |
| protocol-engine.js:649-656 | 每账号 proxy.rotate（hoisted 覆盖 cache-hit） | runner 账号循环 | |
| protocol-engine.js:659-708 | protocol login + TLS retry once + deactivated | login.run | |
| protocol-engine.js:687-690,701-703 | 代理打点 G1/T8 | login.run | |
| protocol-engine.js:710-724 | 登录后持久化 token | login.run 末尾 | |
| protocol-engine.js:726-741 | isPlusOrAbove → clear + PKCE/save | plan-check.run | |
| protocol-engine.js:744-809 | 取链接 3 retry + noJpProxy + no_link + cached-link 复用 | paypal-fetch | |
| protocol-engine.js:811-820 | 取链接后落库（verify 前） | paypal-fetch 末尾 | |
| protocol-engine.js:822-840 | Phase2.5 verify（verify_error/no_promo/is_free，discord 跳过） | paypal-verify | |
| protocol-engine.js:842-960 | 支付（chrome-error rotate retry / NOT_FREE_TRIAL / 5 分支） | paypal-pay | |
| protocol-engine.js:917-945 | 支付结果 success/aborted/notFreeTrial/status/error | paypal-pay | |
| protocol-engine.js:459-501 | PKCE refresh_token/needsPhone/no-RT | paypal-pkce | |
| protocol-engine.js:356-457 | add-phone 主流程 + 8 分支 | paypal-pkce（内部调用，逻辑不动） | |
| protocol-engine.js:194-354 | provider acquire（zhusms/smscloud/oapi/local） | paypal-pkce（内部调用，逻辑不动） | |
| protocol-engine.js:962-989 | 连续失败冷却 + 账号延迟 + 可中断 sleep | runner 账号循环 | |
```

> 遇到不确定是否仍被触达的分支，标 `SUSPECT_DEAD` 单列，**不删**，本阶段交付时上报。

- [ ] **Step 2: 提交清单**

```bash
git add docs/superpowers/plans/inventory/protocol-engine.md
git commit -m "docs(P1): protocol 引擎行为清单(迁移基线)"
```

## Task 1.2: 特征化测试 —— 锁定步序 + 跳过判据 + 终态可达

**Files:**
- Create: `server/__tests__/pipeline-protocol-characterization.test.js`

- [ ] **Step 1: 写测试**（用 fake 注入各 step 依赖，断言"给定 DB 前置态 → 恢复点/跳过集"与现有缓存语义一致）。覆盖：
  - cached-login（DB 有未过期 token）→ login skipped，恢复点= plan-check。
  - cached-link（DB status ∈ REUSE_STATUSES + payment_link 存在）→ paypal-fetch skipped。
  - cached-link 但 status ∉ REUSE → paypal-fetch 不 skip（强制重取）。
  - 每个终态 status（plus / plus_no_rt / no_link / no_promo / verify_error / no_jp_proxy / deactivated / phone_pool_empty / phone_verify_fail / aborted / error）在对应分支仍可被 emit。

```js
// server/__tests__/pipeline-protocol-characterization.test.js
// 断言迁移后步序/跳过判据复现现有缓存语义。每个 it 对应行为清单一行。
// （具体注入桩按 1.3 各 step 的 shouldSkip 签名补全；此文件随 1.3 增量填充并保持全绿）
const test = require('node:test');
const assert = require('node:assert');
// ...（依赖 1.3 产出的 login.shouldSkip / paypal-fetch.shouldSkip 等；先写 cached-login 一例打桩）
test('cached-login: 未过期 token → login.shouldSkip=true', () => {
  const { loginStep } = require('../../server/pipeline/steps/login');
  const future = Math.floor(Date.now() / 1000) + 3600;
  // 构造一个 exp 在未来的假 JWT（header.payload.sig，payload base64url 含 {"exp":future}）
  const payload = Buffer.from(JSON.stringify({ exp: future })).toString('base64url');
  const ctx = { getPersisted: () => ({ last_access_token: `h.${payload}.s`, last_session_json: '{}' }), outputs: {}, flags: {} };
  assert.strictEqual(loginStep({ login: 'protocol' }).shouldSkip(ctx), true);
});
```

> 该文件随 1.3 逐 step 增量补齐用例；每加一个 step 就把对应清单行的 skip/终态断言补进来。

- [ ] **Step 2: 提交（先挂 cached-login 一例，随 1.3 扩充）**

```bash
git add server/__tests__/pipeline-protocol-characterization.test.js
git commit -m "test(P1): protocol 特征化测试骨架(随 step 迁移扩充)"
```

## Task 1.3: 逐 step 搬运（每个 step 一个子任务，TDD：先扩特征化测试→搬运→绿）

> 每个 step 文件导出一个工厂 `xxxStep(cfg) -> defineStep({...})`。`run(ctx)` 的函数体**逐行搬运**自行为清单指定的 `file:line`，把局部变量改成读/写 `ctx.outputs` / `ctx.getPersisted()`，把 `this.emitStatus(...)` 改成 `ctx.setStatus(...)` + runner 的 step-status（emitStatus 负载保持不变以兼容老 UI），`console.log(...)` **原样保留**（由 LogCapture 归属当前 step）。**不改任何分支、重试次数、status 串。**

每个子任务统一 5 步：
- [ ] **(a)** 在 `pipeline-protocol-characterization.test.js` 补该 step 的 shouldSkip / 终态断言（先失败）
- [ ] **(b)** 跑 `node --test ".../pipeline-protocol-characterization.test.js"` 确认失败
- [ ] **(c)** 创建 `server/pipeline/steps/<id>.js`，`run()` 从清单指定行**逐行搬运**
- [ ] **(d)** 跑该测试确认通过；对照行为清单逐行勾"已落点"
- [ ] **(e)** 提交：`git commit -m "refactor(P1): 迁移 <id> step(逐行搬运,行为不变)"`

子任务列表（每个按上面 5 步）：

- [ ] **1.3.1 `steps/login.js`** —— 搬运 `protocol-engine.js:623-724`（cached-login → protocol login → TLS retry → deactivated → 代理打点 → 持久化 token）。`shouldSkip`= cached-login 判据（`decodeJwtExp` + 60s）。注入 `cfg.login==='protocol'` 用 `runProtocolRegister`。
- [ ] **1.3.2 `steps/plan-check.js`** —— 搬运 `:726-741`。`run` 判 `isPlusOrAbove`；命中则置 `ctx.flags.alreadyPlus=true`、clear link/token，并直接走 PKCE 分支（调用 paypal-pkce 的内部逻辑或置标志让后 3 步 shouldSkip）。**保留 enableOAuth 分支**。
- [ ] **1.3.3 `steps/paypal-fetch.js`** —— 搬运 `:744-820`。`shouldSkip`= cached-link 判据（`REUSE_STATUSES` + payment_link）。保留 3 retry / noJpProxy / no_link / discord-vs-api 全分支 + 取链接后落库。
- [ ] **1.3.4 `steps/paypal-verify.js`** —— 搬运 `:822-840`。保留 discord 跳过、verify_error / no_promo / is_free 三分支。`ctx.flags.alreadyPlus` 时 shouldSkip=true。
- [ ] **1.3.5 `steps/paypal-pay.js`** —— 搬运 `:842-960`。保留 chrome-error rotate-retry / NOT_FREE_TRIAL / 5 结果分支；Chrome 启停句柄通过 `ctx.deps.resources` 提供（launchChrome/waitForCDP/killTree）。`ctx.flags.alreadyPlus` 时 shouldSkip=true。
- [ ] **1.3.6 `steps/paypal-pkce.js`** —— 搬运 `_finalizePkce`(`:459-501`)。**`_finalizePhoneVerify`(`:356-457`) 与 `_acquirePhoneForProtocol`(`:194-354`) 整体移到本 step 的私有函数，逻辑一行不改**（含 add-phone 8 分支、provider acquire、markRejected/deferred-cancel/markSaturated）。

> 1.3.2 的 already-Plus → 直接 PKCE 的控制流：用 `ctx.flags.alreadyPlus` 让 paypal-fetch/verify/pay 三步 `shouldSkip=true`，paypal-pkce 正常跑 —— 等价原 `continue`。在特征化测试里断言"alreadyPlus 时恢复点直达 paypal-pkce"。

## Task 1.4: ProtocolEngine 退化成薄壳，接 runner

**Files:**
- Modify: `protocol-engine.js`（`start()` 改为构造 runner + 账号循环委托）；保留 `stop()` 资源清理、LogCapture 接线、cooldown/delay（或上移 runner）。
- Modify: `server/routes/execute.js:51`（仍 `new ProtocolEngine()`，接口不变）

- [ ] **Step 1: 把账号循环骨架（`:605-990` 的 for 外壳、cooldown、delay、summary、proxy rotate、LogCapture）改为 runner 驱动**，每账号 `buildPipeline({login:'protocol', payment:'paypal'})` → `runner._runAccount(ctx, steps)`。把 runner 的 `step-status` 转发为 `this.emit('account-status', ...)`（保持现有负载）+ 新 emit `step-status`。LogCapture 的 logHandler 改成读 `runner._activeCtx?.currentStepId` 作为 phase 落 `logsDB`。
- [ ] **Step 2: 跑 `npm test`** —— 特征化 + 现有 `protocol-phone-verify.test.js` 等全绿。
  Expected: PASS（全套）
- [ ] **Step 3: 手动冒烟**（可选，需环境）：`node server/index.js` 起服务，单账号跑一遍，确认 UI `account-status` 行为与重构前一致、`step-status` 有数据。
- [ ] **Step 4: 提交**

```bash
git add protocol-engine.js server/pipeline server/__tests__
git commit -m "refactor(P1): ProtocolEngine 接 runner，protocol(PayPal)迁移完成"
```

## Task 1.5: P1 diff-review 闸门

- [ ] **Step 1:** 对照 `inventory/protocol-engine.md` 逐行确认"去处 step"都已落点、无 `SUSPECT_DEAD` 被静默删除。把勾稽结果与任何 `SUSPECT_DEAD` 上报用户。
- [ ] **Step 2:** 用户确认无遗漏后进入 P2。

**P1 验收**：`npm test` 全绿；protocol 模式行为与重构前逐分支等价（行为清单全部勾稽）；`step-status` 落库可用。

---

# 阶段 P2 —— 迁移 browser 引擎（PayPal）

结构同 P1。差异：browser 引擎登录用 Playwright，迁移为 `steps/login.js` 的 `cfg.login==='browser'` 策略；其余 4 步**复用 P1 已迁移的 paypal-* step**（这正是解耦收益）。

## Task 2.1: browser 引擎行为清单

**Files:** Create: `docs/superpowers/plans/inventory/browser-engine.md`

- [ ] **Step 1:** 通读 `server/engine.js` 全 `start()` 循环，逐条登记，**重点标出与 protocol 的差异分支**（`cpa` phase、phone_pool 内联处理、登录方式、Chrome 全程持有）。每条映射到 step；browser 独有分支必须在合并后保留（spec §12.2）。
- [ ] **Step 2:** 提交清单。

## Task 2.2: 特征化测试（browser）

**Files:** Create: `server/__tests__/pipeline-browser-characterization.test.js`
- [ ] 锁定 browser 登录 step 的 shouldSkip + 终态可达 + `cpa`/phone_pool 分支保留。先失败。

## Task 2.3: 搬运 browser 登录策略 + 合并差异分支

- [ ] **2.3.1** `steps/login.js` 增 `cfg.login==='browser'` 分支：搬运 `server/engine.js` 登录段（cached-login + Playwright login + 持久化）。**不动已有 protocol 分支。**
- [ ] **2.3.2** 把 browser 独有的 `cpa`/phone_pool 分支并入对应 step（参照清单），**两侧独有逻辑都保留**。每子任务 TDD 5 步（同 1.3）。

## Task 2.4: PipelineEngine 退化成薄壳，接 runner

**Files:** Modify: `server/engine.js`、`server/routes/execute.js:51`（保持 `readProtocolMode() ? ProtocolEngine : PipelineEngine`）
- [ ] 账号循环委托 runner，`buildPipeline({login:'browser', payment:'paypal'})`。Chrome 全程持有的生命周期放进 `ctx.deps.resources` / 薄壳。
- [ ] 跑 `npm test` 全绿。
- [ ] 提交。

## Task 2.5: P2 diff-review 闸门
- [ ] 对照 `inventory/browser-engine.md` 勾稽 + 上报 `SUSPECT_DEAD`；用户确认后进 P3。

**P2 验收**：两 PayPal 引擎收敛到一套 runner + 一套 paypal-* step；`npm test` 全绿；两模式行为逐分支等价。

---

# 阶段 P3 —— 接入 GoPay（拆 Python 两入口 + 迁 DB/事件契约）

## Task 3.1: GoPay 行为清单

**Files:** Create: `docs/superpowers/plans/inventory/gopay-engine.md`
- [ ] 登记 `server/gopay-engine.js` + `gopay_activate.py main()`（Phase4→3→5）+ `_register_one` 换号语义（None=已注册重试 / NO_STOCK / RATE_LIMITED 不可重试 / dict 成功）+ redact + 600s timeout + abort。映射到 `gopay-register` / `gopay-pay` / `gopay-verify`。
- [ ] 提交清单。

## Task 3.2: 拆 `gopay_activate.py` 为 register / pay 两入口（phase 函数体不改）

**Files:** Modify: `gopay_activate.py`（仅改 `main()` 的入参分发与编排边界）；Test: `tests/test_gopay_entry_split.py`
- [ ] **Step 1:** 写 Python 单测（`unittest`）：mock `_register_one` / `_phase3_stripe` / `_phase5_pay`，断言 `mode:'register'` 只调 `_register_one` 并输出注册产物；`mode:'pay'` 调 `_phase3_stripe`(拿 fresh snap)→`_phase5_pay`，**3+5 背靠背、无中间持久化间隙**。先失败。
- [ ] **Step 2:** 跑 `py -3 -m unittest tests.test_gopay_entry_split` 确认失败。
- [ ] **Step 3:** 改 `main()`：读 `mode` 字段分发。`register` 入口= 现 Phase4 段（`gopay_activate.py:374-400` 一带）原样；`pay` 入口= 现 Phase3 段（`:402-407`）+ Phase5 段（`:410-411`）原样背靠背。`_register_one`/`_phase3_stripe`/`_phase5_pay` 函数体一行不改。保持 stdin-JSON / stdout-JSON-lines 协议。
- [ ] **Step 4:** 跑测试确认通过。
- [ ] **Step 5:** 提交。

## Task 3.3: 搬运 GoPay step（gopay-register / gopay-pay / gopay-verify）

- [ ] **3.3.1 `steps/gopay-register.js`** —— spawn `gopay_activate.py` register 入口；`shouldSkip`= 注册产物已持久化；输出钱包 account/phone 到 `ctx.outputs`。逐行参照 `gopay-engine.js:133-190`(`_spawnPython`) 搬运 spawn 协议（含 redact、timeout、abort）。
- [ ] **3.3.2 `steps/gopay-pay.js`** —— spawn `pay` 入口（输入注册产物 + access_token）；含 verify Plus 收尾。`shouldSkip`= 仅"已付款成功"。
- [ ] **3.3.3 `steps/gopay-verify.js`** —— 现 `verify_plus` 段（planType 复查）。
- [ ] 每子任务 TDD 5 步 + 特征化断言"register 成功 / pay 失败重试只重跑 pay、不重注册"。

## Task 3.4: GoPayEngine 迁 DB/事件契约 + buildPipeline 接真实 step

**Files:** Modify: `server/gopay-engine.js`（弃内存 `_results/_logs`，写 `statusDB`+`stepStateDB`，改发 `account-status`/`step-status`）、`server/pipeline/index.js`（gopay 分支换真实 step + login 用 protocol 策略，`login.shouldSkip` 兼容"外部已传 token"）、`server/routes/gopay-activate.js`（route 保留，内部走 runner）
- [ ] 跑 `npm test` 全绿。
- [ ] 提交。

## Task 3.5: P3 diff-review 闸门
- [ ] 对照 `inventory/gopay-engine.md` 勾稽 + 上报 `SUSPECT_DEAD`；用户确认后进 P4。

**P3 验收**：三路全在一套 runner；GoPay 落库 + 每步日志 + 可从失败步继续；Python `npm run test:py` + `npm test` 全绿。

---

# 阶段 P4 —— 前端可视化（抽屉 stepper + Execute 实时 + 单步重试）

## Task 4.1: 后端 API —— `:email/steps` + `retry-step`

**Files:** Modify: `server/routes/accounts.js`（加 `GET /:email/steps`）、`server/routes/execute.js`（加 `POST /retry-step`）；Test: `server/__tests__/routes-steps.test.js`
- [ ] **Step 1:** 写 supertest 风格测试（参照 `health-endpoint.test.js`）：`GET /api/accounts/a@x.com/steps` 返回 `{ steps:[{stepId,label,status,reason,startedAt,finishedAt, logs:[...]}] }`（步状态来自 `stepStateDB.list`，日志来自 `logsDB` 按 `email+phase=stepId`）。先失败。
- [ ] **Step 2:** 跑确认失败。
- [ ] **Step 3:** 实现 `GET /:email/steps`（聚合 `stepStateDB.list` + `logsDB`）；`POST /execute/retry-step {email, stepId}` → 校验 engine idle → `runner` 以 `{forceStepId: stepId}` 跑单账号（`filterEmails:[email]`）。
- [ ] **Step 4:** 跑确认通过。
- [ ] **Step 5:** 提交。

## Task 4.2: socket `step-status` 前端 store

**Files:** Modify: `web/src/socket.js`（监听 `step-status`）、Create: `web/src/stores/stepStore.js`（`email -> {stepId -> {status,reason}}`）
- [ ] 实现 + 在 `web/src/socket.js` 把 `step-status` 写入 store。手动验证（前端无单测惯例）。提交。

## Task 4.3: `AccountStepDrawer.vue`

**Files:** Create: `web/src/components/AccountStepDrawer.vue`
- [ ] 纵向 stepper（Element Plus `el-steps` direction=vertical 或自绘）：渲染该账号 `GET /:email/steps` + 实时 `stepStore` 合并态；每步 icon（pending/running/success/error/skipped）+ label，可展开看 `logs`，失败步显示「重试这一步」→ `POST /execute/retry-step`。提交。

## Task 4.4: 挂载入口（Accounts / Results / Execute / GoPay）

**Files:** Modify: `web/src/views/Accounts.vue`、`Results.vue`（行点击开抽屉）、`Execute.vue`（当前账号实时 stepper）、`GoPayActivate.vue`（切共享抽屉）
- [ ] 各视图接入 `AccountStepDrawer`；`web/dist` 重新 `cd web && npm run build`。手动冒烟。提交。

**P4 验收**：账号抽屉可看 6/5 步状态 + 每步日志 + 单步重试；Execute 实时推进；GoPay 用同一抽屉。

---

# 阶段 P5 —— 清理

## Task 5.1: 删除被上移的重复死代码

**Files:** Modify: `protocol-engine.js` / `server/engine.js` / `server/gopay-engine.js`
- [ ] **Step 1:** 仅删除"已确证迁移完成且无人再调用"的旧主循环残留 —— 依据三份 inventory 的勾稽结果，且 `SUSPECT_DEAD` 已经用户裁决。**不删任何未确认项。**
- [ ] **Step 2:** 跑 `npm test` 全绿。
- [ ] **Step 3:** 提交：`git commit -m "refactor(P5): 删除已迁移的重复主循环残留"`

## Task 5.2: CHANGELOG

**Files:** Modify: `docs/CHANGELOG.md`
- [ ] 追加新版本节（核心改动 / 端到端验证 / 对照前版），引用本 spec 与 plan 文件名。提交。

**P5 验收**：三引擎退化为薄壳；无重复主循环；CHANGELOG 记录在案。

---

## 自查（Self-Review）

- **Spec 覆盖**：①模块化解耦→P0-P3 共享 runner/step；②步骤可视化→P4 抽屉+Execute；③失败从失败步继续→runner shouldSkip(自动)+forceStepId(手动)+stepStateDB；④每步日志→logHandler 按 currentStepId 落 `logsDB.phase`；⑤GoPay 对等→P3 拆 Python+迁 DB；⑥逻辑零删减→每期 inventory+特征化+diff-review 闸门。全覆盖。
- **类型一致**：`stepStateDB.set(email,stepId,{status,reason,startedAt,finishedAt})` / `get→{status,reason,started_at,finished_at}`（snake_case 读）/ `step-status` 事件 `{email,stepId,label,status,reason}` / `buildPipeline({login,payment})` —— 全篇一致。
- **占位**：P1-P3 的"逐行搬运"非占位，是对 `file:line` 原文的明确搬运指令（zero-logic-loss 要求如此）；特征化测试随 step 增量补齐已注明。
```
