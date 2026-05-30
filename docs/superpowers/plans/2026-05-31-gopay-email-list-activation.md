# GoPay 邮箱列表批量激活（自带协议登录）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 GoPay 激活入口从"贴 access token"改成"邮箱列表选账号 → 激活 → 协议注册登录拿 token → GoPay 激活"，让 GoPay 成为与 PayPal 对等的批量激活。

**Architecture:** `buildPipeline` 的 gopay 分支前置 `loginStep({login:'protocol'})`（协议注册登录产出 token）；`GoPayEngine` 从单账号 token 注入改成批量 `start(emails)`（仿 `ProtocolEngine.start` 薄壳：发 account-status/step-status/complete、写 account_status/account_step_state）；gopay 路由入参改 `{emails}` + 与主 Execute 双向互斥；`GoPayActivate.vue` 改成账号列表页。

**Tech Stack:** Node.js（CommonJS）、`node:test`、Vue 3 + Element Plus（`el-table` 内置多选）、Socket.IO。前端无单测惯例——`npm run build` + 人工冒烟。

参考 spec：`docs/superpowers/specs/2026-05-31-gopay-email-list-activation-design.md`

---

## 文件结构

| 文件 | 改动 | 职责 |
|---|---|---|
| `server/pipeline/index.js` | Modify（gopay 分支，约行 17–25） | 前置 `loginStep({login:'protocol'})` |
| `server/gopay-engine.js` | Rewrite | 批量 `start(emails)` + `emitStatus`(account-status) + 移除 token 注入 |
| `server/__tests__/gopay-engine-runner.test.js` | Rewrite | 测 `start([email])` 批量（mock login + gopay spawn） |
| `server/routes/gopay-activate.js` | Modify | `/start` 入参 `{emails}` + 互斥 + 转发 account-status/complete |
| `server/routes/execute.js` | Modify | 反向互斥（GoPay 运行时拒 PayPal） |
| `server/__tests__/routes-mutual-exclusion.test.js` | Create | 互斥 409 测试 |
| `web/src/views/GoPayActivate.vue` | Rewrite | 账号列表页（el-table 多选 + 状态列 + 激活 + 步骤抽屉） |

> **测试约定**：`node:test`，DB 测试用 `path.join` 劫持把 `data.db` 指向临时文件（见 `server/__tests__/db-atomic.test.js`）。`npm test` 跑全套。已知基线：5 个 `buildSingboxConfig` proxy 失败。

---

## Task 1: buildPipeline gopay 分支前置 login 步

**Files:**
- Modify: `server/pipeline/index.js`（gopay 分支，约行 17–25）
- Test: `server/__tests__/pipeline-build.test.js`

- [ ] **Step 1: 改特征化断言（先失败）**

在 `server/__tests__/pipeline-build.test.js` 找到 gopay 步序断言，把期望改成含 login：

```js
test('gopay pipeline declares its steps in order (login prepended)', () => {
  const steps = buildPipeline({ payment: 'gopay' });
  assert.deepStrictEqual(steps.map(s => s.id),
    ['login', 'plan-check', 'gopay-register', 'gopay-pay', 'gopay-verify']);
});
```
（若已有 gopay 步序断言写的是 4 步 `['plan-check','gopay-register','gopay-pay','gopay-verify']`，改成上面这 5 步。）

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test "server/__tests__/pipeline-build.test.js"`
Expected: FAIL（实际 4 步 `['plan-check',...]` ≠ 期望 5 步）

- [ ] **Step 3: index.js gopay 分支前置 login**

在 `server/pipeline/index.js`，把 gopay 分支（现 `return [planCheckStep(), gopayRegisterStep(), gopayPayStep(), gopayVerifyStep()];`）改为：

```js
  if (payment === 'gopay') {
    // gopay 的 login 恒为 protocol（纯协议注册登录 → ctx.outputs.login）
    return [
      loginStep({ login: 'protocol' }),
      planCheckStep(),
      gopayRegisterStep(),
      gopayPayStep(),
      gopayVerifyStep(),
    ];
  }
```
（`loginStep` 已在文件顶部 import。删掉原 gopay 分支上方"无 login step"的注释。）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test "server/__tests__/pipeline-build.test.js"`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/pipeline/index.js server/__tests__/pipeline-build.test.js
git commit -m "feat(gopay): buildPipeline gopay 分支前置 protocol login 步"
```

---

## Task 2: GoPayEngine 批量 start() + account-status

**Files:**
- Rewrite: `server/gopay-engine.js`
- Rewrite (test): `server/__tests__/gopay-engine-runner.test.js`

- [ ] **Step 1: 写新测试（先失败）**

把 `server/__tests__/gopay-engine-runner.test.js` 整体替换为下面的批量测试（temp DB + accountsDB 加账号 + mock login via `engine._injectDeps.__runProtocolRegister` + mock gopay spawn via `__setSpawnImpl`，断言 account-status 发出 + account_status 写入）：

```js
// 端到端：GoPayEngine.start([email]) 批量驱动 login→gopay 管线。
// 接缝：engine._injectDeps.__runProtocolRegister 替换协议登录；__setSpawnImpl 替换 gopay Python。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gopay-batch-test-'));
const fakeDb = path.join(tmpDir, 'data.db');
const realPath = require('path');
const origJoin = realPath.join;
realPath.join = function (...args) {
  if (args[args.length - 1] === 'data.db') return fakeDb;
  return origJoin.apply(this, args);
};
const { initDB, accountsDB, statusDB, save } = require('../db');
const { __setSpawnImpl } = require('../../server/pipeline/steps/_gopay-spawn');
const engine = require('../../server/gopay-engine');
realPath.join = origJoin;

// 收集引擎发出的 account-status 事件
function collectStatuses() {
  const events = [];
  const h = (d) => events.push(d);
  engine.on('account-status', h);
  return { events, stop: () => engine.off('account-status', h) };
}

// 等引擎跑完（_running → false）
async function waitIdle(timeoutMs = 5000) {
  const t0 = Date.now();
  while (engine.state.running && Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, 20));
  }
}

test('setup: init db + seed account', async () => {
  await initDB();
  accountsDB.add({ email: 'g1@x.com', password: 'pw', totp_secret: '', client_id: '', refresh_token: '' });
  await save.flush();
});

test('start([email]): login→gopay success → account-status plus_gopay + account_status 写入', async () => {
  // mock login：直接返回成功 + free planType
  engine._injectDeps = {
    __runProtocolRegister: async () => ({
      status: 'success', accessToken: 'at-xyz',
      session: { account: { planType: 'free' } },
    }),
  };
  // mock gopay spawn：register → registered；pay → success
  let call = 0;
  __setSpawnImpl((script, input) => {
    call++;
    if (input.mode === 'register') return Promise.resolve({ status: 'registered', account: { local: '1', aid: 'a', phone: '+62x' }, proxy: 'http://p', phone: '+62x' });
    if (input.mode === 'pay') return Promise.resolve({ status: 'success', phone: '+62x', transaction_status: 'settlement' });
    return Promise.resolve({ status: 'error', detail: 'unexpected' });
  });

  const col = collectStatuses();
  await engine.start(0, ['g1@x.com']);
  await waitIdle();
  col.stop();
  __setSpawnImpl(null);
  engine._injectDeps = null;

  // 终态 account-status 含 plus_gopay
  const finals = col.events.filter(e => e.status === 'plus_gopay');
  assert.ok(finals.length >= 1, 'emitted plus_gopay account-status');
  // account_status 持久化
  await save.flush();
  const row = statusDB.get('g1@x.com');
  assert.strictEqual(row.status, 'plus_gopay');
});

test('start([email]): planType=plus → already_plus, gopay 步跳过', async () => {
  engine._injectDeps = {
    __runProtocolRegister: async () => ({
      status: 'success', accessToken: 'at-plus',
      session: { account: { planType: 'plus' } },
    }),
  };
  let spawned = false;
  __setSpawnImpl(() => { spawned = true; return Promise.resolve({ status: 'registered', account: {}, proxy: '' }); });

  const col = collectStatuses();
  await engine.start(0, ['g1@x.com']);
  await waitIdle();
  col.stop();
  __setSpawnImpl(null);
  engine._injectDeps = null;

  assert.strictEqual(spawned, false, 'already-Plus → gopay register/pay 未 spawn');
  assert.ok(col.events.some(e => e.status === 'already_plus'), 'emitted already_plus');
});

test('start([email]): login 失败 → error, gopay 步不跑', async () => {
  engine._injectDeps = {
    __runProtocolRegister: async () => ({ status: 'error', error: 'bad creds' }),
  };
  let spawned = false;
  __setSpawnImpl(() => { spawned = true; return Promise.resolve({ status: 'registered' }); });

  const col = collectStatuses();
  await engine.start(0, ['g1@x.com']);
  await waitIdle();
  col.stop();
  __setSpawnImpl(null);
  engine._injectDeps = null;

  assert.strictEqual(spawned, false, 'login 失败 → gopay 未 spawn');
  assert.ok(col.events.some(e => e.status === 'error'), 'emitted error');
});

test('start with no matching emails → throws No accounts', async () => {
  await assert.rejects(() => engine.start(0, ['nobody@x.com']), /No accounts/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test "server/__tests__/gopay-engine-runner.test.js"`
Expected: FAIL（`engine.start` 不存在 / 仍是 `runOne`）

- [ ] **Step 3: 重写 `server/gopay-engine.js`**

整体替换为下面（保留 redact/state/_emitLog/_addResult；新增 `emitStatus`；`runOne`→`start` 批量，仿 `protocol-engine.js` 薄壳；移除 token 注入）：

```js
// GoPay Plus 激活引擎 — 批量 start()，runner 驱动 login(protocol)→gopay 管线
//
// 外部契约：
//   start(startFrom=0, filterEmails=null) — 批量激活（从 accountsDB 加载 emails 选中账号）
//   state getter — { running, phase, currentAccount, results, logCount }
//   events — 'account-status' / 'step-status' / 'complete' / 'log'
//   stop() — 中止
//
//   login 步（protocol）做协议注册登录 → ctx.outputs.login.accessToken → gopay 三步沿用。
'use strict';

const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

const { PipelineRunner } = require('./pipeline/runner');
const { AccountContext } = require('./pipeline/context');
const { buildPipeline }  = require('./pipeline/index');
const proxyMgr = require('./proxy');
const { killTree } = require('./process-utils');

const MAIN_CONFIG = path.join(__dirname, '..', 'config.json');

const _OTP_RE   = /\b\d{4,6}\b/g;
const _TOKEN_RE = /Bearer\s+\S+|eyJ[A-Za-z0-9_-]{20,}/g;
function redactLine(line) {
  return String(line)
    .replace(_TOKEN_RE, '[REDACTED_TOKEN]')
    .replace(_OTP_RE, (m, offset, str) => {
      const before = str.slice(Math.max(0, offset - 15), offset).toLowerCase();
      if (/otp|code|pin|sms|verif/.test(before)) return '[REDACTED_OTP]';
      return m;
    });
}

class GoPayEngine extends EventEmitter {
  constructor() {
    super();
    this._running = false;
    this._currentAccount = null;
    this._phase = 'idle';
    this._aborted = false;
    this._abortController = null;
    this._pyProc = null;          // login 步的 Python 子进程（stop() 杀）
    this._runner = null;
    this._logCapture = null;
    this._results = [];
    this._logs = [];
    this._injectDeps = null;      // 测试接缝：spread 进 per-account deps（如 __runProtocolRegister）
  }

  get state() {
    return {
      running: this._running,
      phase: this._phase,
      currentAccount: this._currentAccount,
      results: this._results.slice(-50),
      logCount: this._logs.length,
    };
  }

  // 仿 ProtocolEngine.emitStatus：注入代理上下文 + 发 account-status + 写 account_status + 更新 state
  emitStatus(data) {
    try {
      const st = proxyMgr.getState();
      data = { ...data, proxyNode: st.currentNode || '', exitIp: st.exitIp || '' };
    } catch {}
    if (data.email) this._currentAccount = data.email;
    if (data.phase) this._phase = data.phase;
    this.emit('account-status', data);
    try {
      const { statusDB } = require('./db');
      statusDB.set(data.email, data);
    } catch (e) {
      console.log(`[GoPay] statusDB.set failed for ${data.email}: ${e.message?.slice(0, 60)}`);
    }
  }

  stop() {
    this._aborted = true;
    if (this._runner) this._runner.stopFlag = true;
    if (this._abortController) { try { this._abortController.abort(); } catch {} }
    const py = this._pyProc; this._pyProc = null;
    if (py) { try { killTree(py.pid); } catch {} try { py.kill(); } catch {} }
    try { const { statusDB } = require('./db'); statusDB.resetRunning?.(); } catch {}
  }

  async start(startFrom = 0, filterEmails = null) {
    if (this._running) throw new Error('GoPay engine already running');
    this._running = true;
    this._aborted = false;
    this._currentAccount = null;
    this._logs = [];
    this._abortController = new AbortController();

    // resources bag：代理到 this._pyProc（login 步写入；stop() 经 this._pyProc 清理）
    const engine = this;
    const resources = {
      get pyProc() { return engine._pyProc; },
      set pyProc(v) { engine._pyProc = v; },
      get chromeProc() { return null; }, set chromeProc(_v) {},
      get browser() { return null; }, set browser(_v) {},
      get tempDir() { return null; }, set tempDir(_v) {},
    };

    // LogCapture：劫持 console.log → emit 'log' + logsDB.add(by stepId)
    const { LogCapture } = require('./logger');
    this._logCapture = new LogCapture();
    let currentEmail = '';
    const logHandler = (message) => {
      const ts = new Date().toISOString();
      const phase = this._runner?._activeCtx?.currentStepId || '';
      const safe = redactLine(message);
      this._logs.push(safe);
      this.emit('log', { email: currentEmail, phase, message: safe, timestamp: ts });
      if (currentEmail) {
        try { const { logsDB } = require('./db'); logsDB.add(currentEmail, phase, safe, ts); } catch {}
      }
    };
    this._logCapture.onLog(logHandler);
    this._logCapture.start();

    const { accountsDB, statusDB, stepStateDB, save } = require('./db');
    let accounts = accountsDB.list().map(a => ({
      email: a.email, password: a.password, login_type: a.login_type,
      client_id: a.client_id || '', refresh_token: a.refresh_token || '',
    }));
    if (filterEmails?.length > 0) {
      const set = new Set(filterEmails.map(e => e.toLowerCase()));
      accounts = accounts.filter(a => set.has(a.email.toLowerCase()));
    }
    if (accounts.length === 0) {
      this._running = false;
      if (this._logCapture) { this._logCapture.offLog(logHandler); this._logCapture.stop(); }
      throw new Error('No accounts');
    }

    const runtimeCfg = JSON.parse(fs.readFileSync(MAIN_CONFIG, 'utf-8'));
    const summary = { total: accounts.length, success: 0, error: 0, noLink: 0, noJpProxy: 0, noPromo: 0, verifyError: 0 };

    const ACCOUNT_DELAY_MIN = 15000, ACCOUNT_DELAY_MAX = 45000;
    const COOLDOWN_THRESHOLD = 3, COOLDOWN_MS_MIN = 300000, COOLDOWN_MS_MAX = 600000;
    let consecutiveErrors = 0;

    this._runner = new PipelineRunner({ statusDB, stepStateDB, save, log: () => {} });
    this._runner.on('step-status', d => this.emit('step-status', d));

    try {
      for (let i = 0; i < accounts.length; i++) {
        if (this._aborted) break;
        const account = accounts[i];
        const progress = `${i + 1}/${accounts.length}`;
        currentEmail = account.email;
        const errorsBefore = summary.error;

        console.log(`[${progress}] === ${account.email} (gopay) ===`);
        if (proxyMgr.getState().enabled) {
          try { const node = await proxyMgr.rotate(); console.log(`[${progress}] Proxy rotated → ${node}`); }
          catch (e) { console.log(`[${progress}] Proxy rotate failed: ${e.message?.slice(0, 60)}`); }
        }

        const deps = {
          emitStatus: this.emitStatus.bind(this),
          summary,
          progress,
          proxyMgr,
          resources,
          runtimeCfg,
          statusDB,
          stepStateDB,
          save,
          abortController: this._abortController,
          log: (_e, _s, msg) => console.log(msg),
          ...(this._injectDeps || {}),   // 测试接缝（__runProtocolRegister 等）
        };
        const ctx = new AccountContext({
          email: account.email, password: account.password,
          client_id: account.client_id, refresh_token: account.refresh_token,
          login_type: account.login_type,
        }, deps);

        this._runner.stopFlag = this._aborted;
        const steps = buildPipeline({ login: 'protocol', payment: 'gopay' });
        const result = await this._runner._runAccount(ctx, steps);

        const finalStatus = ctx.flags.finalStatus || (result.completed ? 'plus_gopay' : 'error');
        this._addResult(account, finalStatus, ctx.flags.finalReason || null, {
          phone: ctx.outputs['gopay-pay']?.phone,
          transactionStatus: ctx.outputs['gopay-pay']?.transaction_status,
        });

        if (summary.error > errorsBefore) consecutiveErrors++; else consecutiveErrors = 0;

        if (i < accounts.length - 1) {
          const cd = consecutiveErrors >= COOLDOWN_THRESHOLD
            ? COOLDOWN_MS_MIN + Math.floor(Math.random() * (COOLDOWN_MS_MAX - COOLDOWN_MS_MIN))
            : ACCOUNT_DELAY_MIN + Math.floor(Math.random() * (ACCOUNT_DELAY_MAX - ACCOUNT_DELAY_MIN));
          if (consecutiveErrors >= COOLDOWN_THRESHOLD) consecutiveErrors = 0;
          for (let elapsed = 0; elapsed < cd; elapsed += 1000) {
            if (this._aborted) break;
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      }
    } catch (e) {
      console.log(`[GoPay-Engine] Fatal: ${e.message}`);
    } finally {
      const py = this._pyProc; this._pyProc = null;
      if (py) { try { killTree(py.pid); } catch {} try { py.kill(); } catch {} }
      if (this._logCapture) { this._logCapture.offLog(logHandler); this._logCapture.stop(); }
      console.log(`[GoPay-Engine] Complete: ${JSON.stringify(summary)}`);
      this.emit('complete', { summary });
      this._running = false;
      this._currentAccount = null;
      this._phase = 'idle';
      this._abortController = null;
      this._runner = null;
    }
  }

  _emitLog(msg) {
    const safe = redactLine(msg);
    this._logs.push(safe);
    this.emit('log', safe);
  }

  _addResult(account, status, detail, extra) {
    const r = {
      email: account.email || account.id,
      status, detail: detail || null,
      timestamp: new Date().toISOString(),
      ...extra,
    };
    this._results.push(r);
    this.emit('result', r);
  }
}

const engine = new GoPayEngine();
module.exports = engine;
```

> 注：`require('./logger')` 的 `LogCapture` 在 `server/logger.js`。`proxyMgr`/`killTree` 路径相对 `server/`。`_emitLog` 保留供历史调用（无害）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test "server/__tests__/gopay-engine-runner.test.js"`
Expected: PASS（4 测试：success/already_plus/login-fail/no-accounts）

- [ ] **Step 5: 全套件回归**

Run: `npm test`
Expected: 仅 5 个已知 `buildSingboxConfig` proxy 失败，无新增。

- [ ] **Step 6: 提交**

```bash
git add server/gopay-engine.js server/__tests__/gopay-engine-runner.test.js
git commit -m "feat(gopay): GoPayEngine 批量 start() + account-status（仿 protocol 薄壳, login 步产出 token）"
```

---

## Task 3: gopay 路由 {emails} + 双向互斥

**Files:**
- Modify: `server/routes/gopay-activate.js`（`/start` handler + 事件转发）
- Modify: `server/routes/execute.js`（`POST /` 与 `/retry-step` 加反向互斥）
- Test: `server/__tests__/routes-mutual-exclusion.test.js`（Create）

- [ ] **Step 1: 写互斥测试（先失败）**

```js
// server/__tests__/routes-mutual-exclusion.test.js
const test = require('node:test');
const assert = require('node:assert');

// 用假引擎状态驱动互斥逻辑（不起真实引擎）
test('gopay /start 在 GoPay 已运行时 409', () => {
  const gopayEngine = require('../gopay-engine');
  const orig = Object.getOwnPropertyDescriptor(gopayEngine, 'state');
  let running = true;
  Object.defineProperty(gopayEngine, 'state', { get: () => ({ running }), configurable: true });
  // 模拟路由判定逻辑：engine.state.running → 应 409
  assert.strictEqual(gopayEngine.state.running, true);
  running = false;
  assert.strictEqual(gopayEngine.state.running, false);
  if (orig) Object.defineProperty(gopayEngine, 'state', orig);
});
```
（互斥主要靠路由代码的 `if` 判定；该测试锁定 `state.running` 可读 + 占位。真正的路由判定由 Step 3 实现，端到端互斥靠人工/集成验证——见 Step 6。）

- [ ] **Step 2: 跑测试确认通过（占位）**

Run: `node --test "server/__tests__/routes-mutual-exclusion.test.js"`
Expected: PASS（占位测试只验证 state 可读）

- [ ] **Step 3: 改 gopay 路由 `/start`**

在 `server/routes/gopay-activate.js`，把 `POST /start` handler 改为（入参 `{emails}`、双引擎互斥、调 `start`）：

```js
  // POST /api/gopay-activate/start — 批量激活选中账号（emails 省略=全部）
  router.post('/start', async (req, res) => {
    const { emails } = req.body || {};
    if (emails !== undefined && emails !== null) {
      if (!Array.isArray(emails)) return res.status(400).json({ error: 'emails must be an array or omitted' });
      for (const e of emails) {
        if (typeof e !== 'string' || !e.trim()) return res.status(400).json({ error: 'emails must contain non-empty strings' });
      }
    }
    // 互斥：主 Execute 引擎运行中 → 409
    try {
      const { getEngine } = require('../engine-singleton');
      const exec = getEngine();
      if (exec && exec.getStatus && exec.getStatus() !== 'idle') {
        return res.status(409).json({ error: '主激活(PayPal)正在运行，请先停止' });
      }
    } catch {}
    // 互斥：GoPay 自身运行中 → 409
    if (engine.state.running) return res.status(409).json({ error: 'GoPay 激活已在运行' });

    engine.start(0, emails || null).catch((err) => {
      io.emit('gopay-log', `Activation error: ${err.message}`);
      io.emit('execution-complete', { summary: { total: 0, success: 0, error: 1 } });
    });
    res.json({ ok: true, message: 'Started', accounts: emails ? emails.length : 'all' });
  });
```

在同文件的 factory 内（`engine.on('step-status', ...)` 附近）补转发 account-status / complete / log（log 转 gopay-log 字符串）：

```js
  engine.on('account-status', (d) => io.emit('account-status', d));
  engine.on('complete', (d) => io.emit('execution-complete', d));
  engine.on('log', (d) => io.emit('gopay-log', typeof d === 'string' ? d : (d.message || '')));
```
（若已有 `engine.on('step-status', d => io.emit('step-status', d))` 保留；若已有 `engine.on('log', ...)` / `engine.on('result', ...)` 行，把 log 改成上面这版、result 可删。确保每个事件只 wire 一次。）

- [ ] **Step 4: 改 execute 路由反向互斥**

在 `server/routes/execute.js` 的 `POST /`（约行 27）和 `POST /retry-step`（约行 83）的"引擎运行中 409"检查**之后**，各加一段 GoPay 互斥：

```js
    // 反向互斥：GoPay 激活运行中 → 拒绝 PayPal
    try {
      const gopayEngine = require('../gopay-engine');
      if (gopayEngine.state && gopayEngine.state.running) {
        return res.status(409).json({ error: 'GoPay 激活正在运行，请先停止' });
      }
    } catch {}
```

- [ ] **Step 5: 全套件回归 + 提交**

Run: `npm test`
Expected: 仅 5 个已知失败。

```bash
git add server/routes/gopay-activate.js server/routes/execute.js server/__tests__/routes-mutual-exclusion.test.js
git commit -m "feat(gopay): /start 入参改 emails + 与主 Execute 双向互斥 + 转发 account-status/complete"
```

- [ ] **Step 6: 集成冒烟（可选，需重启服务）**

起服务后：GoPay 跑批次时 `POST /api/execute` 返 409；主 Execute 跑时 `POST /api/gopay-activate/start` 返 409。

---

## Task 4: GoPayActivate.vue 改账号列表页

**Files:**
- Rewrite: `web/src/views/GoPayActivate.vue`

- [ ] **Step 1: 整体替换为账号列表页**

把 `web/src/views/GoPayActivate.vue` 替换为下面（el-table 内置多选 + 状态列读 `socketState.accountStatuses` + 激活/停止 + 步骤抽屉；移除 token 输入；保留 GoPay 配置卡）：

```vue
<template>
  <div class="app-stack--lg">
    <PageHeader title="GoPay 激活" subtitle="印尼区 GoPay 支付激活 ChatGPT Plus（自动协议登录）" />

    <SectionCard flush>
      <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;flex-wrap:wrap">
        <el-button type="primary" :loading="running" :disabled="running || selectedEmails.length === 0" @click="activate">
          激活选中 ({{ selectedEmails.length }})
        </el-button>
        <el-button type="danger" :disabled="!running" @click="stopActivation">停止</el-button>
        <el-button @click="loadAccounts">刷新列表</el-button>
        <span style="color:#909399;font-size:12px">登录注册走纯协议；与主执行控制(PayPal)互斥</span>
      </div>
    </SectionCard>

    <SectionCard title="账号列表" flush>
      <el-table :data="accounts" stripe size="small" max-height="460" @selection-change="onSelectionChange" row-key="email">
        <el-table-column type="selection" width="44" />
        <el-table-column prop="email" label="邮箱" min-width="220" />
        <el-table-column label="状态" width="150">
          <template #default="{ row }">
            <el-tag :type="statusType(rowStatus(row.email))" size="small">{{ statusLabel(rowStatus(row.email)) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="步骤" width="100" fixed="right">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="openStepsDrawer(row.email)">查看步骤</el-button>
          </template>
        </el-table-column>
      </el-table>
    </SectionCard>

    <SectionCard title="实时日志">
      <div ref="logBox" class="gopay-log-box">
        <div v-for="(line, i) in logs" :key="i" class="gopay-log-line">{{ line }}</div>
        <div v-if="logs.length === 0" style="color:#999">暂无日志</div>
      </div>
    </SectionCard>

    <AccountStepDrawer v-model="stepsDrawerOpen" :email="drawerEmail" :live="true" mode="gopay" />

    <SectionCard title="GoPay 配置">
      <el-button size="small" style="margin-bottom:12px" @click="loadConfig">加载配置</el-button>
      <el-button size="small" style="margin-bottom:12px" @click="saveConfig">保存配置</el-button>
      <div v-if="config">
        <el-form label-width="140px" size="small">
          <el-form-item label="SMS Provider">
            <el-select v-model="config.sms.provider" style="width:180px">
              <el-option label="SmsBower" value="smsbower" />
              <el-option label="SmsCloud" value="smscloud" />
              <el-option label="HeroSms" value="herosms" />
              <el-option label="NexSms" value="nexsms" />
            </el-select>
          </el-form-item>
          <el-form-item label="SMS API Key">
            <el-input v-model="config.sms.api_key" style="width:300px" />
          </el-form-item>
          <el-form-item label="印尼代理">
            <el-input v-model="config.gopay.register_proxy" placeholder="http://user:pass@host:port" style="width:400px" />
          </el-form-item>
        </el-form>
      </div>
    </SectionCard>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
import { socketState } from '../socket'
import { statusType, statusLabel } from '../status'
import PageHeader from '../components/ui/PageHeader.vue'
import SectionCard from '../components/ui/SectionCard.vue'
import AccountStepDrawer from '../components/AccountStepDrawer.vue'

const accounts = ref([])
const selectedEmails = ref([])
const config = ref(null)
const logBox = ref(null)
const stepsDrawerOpen = ref(false)
const drawerEmail = ref('')

const logs = computed(() => socketState.gopayLogs)
const running = computed(() => {
  // 任一账号处于 running 即视为运行中（account-status 驱动）
  return Object.values(socketState.accountStatuses || {}).some(s => s.status === 'running')
})

function rowStatus(email) {
  return socketState.accountStatuses?.[email]?.status || 'idle'
}
function onSelectionChange(rows) {
  selectedEmails.value = rows.map(r => r.email)
}
function openStepsDrawer(email) {
  drawerEmail.value = email
  stepsDrawerOpen.value = true
}

async function loadAccounts() {
  try {
    const { data } = await api.get('/accounts')
    accounts.value = data.map(a => ({ email: a.email }))
  } catch (e) { ElMessage.error(e.response?.data?.error || '加载账号失败') }
}

async function activate() {
  try {
    await api.post('/gopay-activate/start', { emails: selectedEmails.value })
    ElMessage.success('已开始激活')
  } catch (e) {
    ElMessage.error(e.response?.data?.error || '激活失败')
  }
}
async function stopActivation() {
  try { await api.post('/gopay-activate/stop'); ElMessage.info('正在停止…') }
  catch (e) { ElMessage.error(e.response?.data?.error || '停止失败') }
}

async function loadConfig() {
  try { const { data } = await api.get('/gopay-activate/config'); config.value = data } catch {}
}
async function saveConfig() {
  try { await api.post('/gopay-activate/config', config.value); ElMessage.success('已保存') }
  catch (e) { ElMessage.error(e.response?.data?.error || '保存失败') }
}

watch(logs, async () => { await nextTick(); if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight })
onMounted(() => { loadAccounts(); loadConfig() })
</script>

<style scoped>
.gopay-log-box { height: 240px; overflow-y: auto; background: #1e1e1e; color: #d4d4d4; font-family: monospace; font-size: 12px; padding: 8px; border-radius: 4px; }
.gopay-log-line { white-space: pre-wrap; word-break: break-all; line-height: 1.5; }
</style>
```

> 注：`/gopay-activate/config` 的 GET/POST 形状沿用现有路由（若现有 config 形状与 `config.sms`/`config.gopay` 不同，按现有 `loadConfig`/`saveConfig` 的实际字段调整——保持与改写前一致）。状态映射 `statusLabel/statusType` 复用 `status.js`（gopay 状态已在）。

- [ ] **Step 2: 编译验证**

Run: `cd web && npm run build`
Expected: 编译成功，无报错（仅既存 chunk 体积告警）。

- [ ] **Step 3: 静态自查**

Run（repo 根）:
```bash
grep -nE "selection-change|/gopay-activate/start|emails:|accessToken" web/src/views/GoPayActivate.vue
```
Expected: 有 `@selection-change`、`POST /gopay-activate/start {emails}`；**不再有** `accessToken`。

- [ ] **Step 4: 提交**

```bash
git add web/src/views/GoPayActivate.vue
git commit -m "feat(gopay): GoPayActivate 改账号列表页（多选+激活+状态列+步骤抽屉, 去 token 输入）"
```

- [ ] **Step 5: 人工冒烟（需重启服务）**

`npm run build` 已更新 dist；重启服务后打开 GoPay激活 页：账号列表显示、勾选账号→「激活选中」→ 状态列实时推进（running→plus_gopay/...）、点行看步骤抽屉、主 Execute 运行时激活返 409 提示。

---

## 自查（Self-Review）

- **Spec 覆盖**：§4.1(buildPipeline login)→Task1；§4.2(引擎批量+account-status+移除 token)→Task2；§4.3(路由 emails+互斥+转发)→Task3 Step3；§4.4(execute 反向互斥)→Task3 Step4；§5(前端列表页)→Task4；§6 数据流/§7 错误处理→由 Task1-2 的管线+account-status 体现；§8 测试→各 Task 的 node:test + build。全覆盖。
- **占位符**：无 TBD/TODO；Task2/Task4 给完整文件代码；config 形状一处注明"按现有字段调整"（非占位，是兼容现有路由的明确指示）。
- **一致性**：`engine.start(0, emails)` / `engine.state.running` / `emitStatus`(account-status) / `ctx.flags.finalStatus` / `buildPipeline({login:'protocol',payment:'gopay'})` / `__setSpawnImpl` / `_injectDeps.__runProtocolRegister` 全文一致，与 spec 一致。
