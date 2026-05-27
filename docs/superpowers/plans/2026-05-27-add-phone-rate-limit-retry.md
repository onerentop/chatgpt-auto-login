# Add-Phone rate-limit / fraud / VoIP 自动换号 retry + smscloud 延迟 cancel 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复协议模式 add-phone 在 OpenAI 返 rate_limit_exceeded / fraud_guard / voip_phone_disallowed 时短路 fail 的 bug，让 `_finalizePhoneVerify` 走满 MAX_ATTEMPTS=3 换号 retry；同时为 smscloud cancelOrder <2 分钟限制提供后台延迟 cancel 兜底。

**Architecture:** 三处改动：(a) `_finalizePhoneVerify` rate-limited 分支 `return` 改 `continue`；(b) `smscloud-provider.cancelOrder` 返 `{ deferred }` 而非抛错；(c) 新模块 `smscloud-deferred-cancel.js` 提供 in-memory queue + 30s tick worker，下单 ≥125s 后重试 cancel。`server/index.js` 启动时 start，SIGINT/SIGTERM 时 stop。

**Tech Stack:** Node.js (CommonJS) + node:test。无外部新依赖。

**Spec:** `docs/superpowers/specs/2026-05-27-add-phone-rate-limit-retry-design.md`

---

## File Structure

- **Create:** `server/smscloud-deferred-cancel.js` —— in-memory queue + worker
- **Create:** `server/__tests__/smscloud-deferred-cancel.test.js` —— queue/worker 单测
- **Create:** `__tests__/protocol-engine-add-phone-retry.test.js` —— `_finalizePhoneVerify` retry 行为集成测试
- **Modify:** `server/smscloud-provider.js:65-67` —— `cancelOrder` 返 result obj
- **Modify:** `server/__tests__/smscloud-provider.test.js` —— 加 3 个 cancelOrder 用例
- **Modify:** `protocol-engine.js:230-236, 298-316, 330` —— smscloud releaseFn 用 deferred-cancel + rate-limited 分支 continue + lastReason 兜底
- **Modify:** `server/index.js:36+, 133-155` —— wire-up start/stop
- **Modify:** `docs/CHANGELOG.md` —— v2.44.1 节
- **Modify:** `package.json:3` —— version `1.0.0` 保持（仓库 version 字段从来未跟 CHANGELOG 版本号同步，照旧不改）

---

## Task 1: smscloud-deferred-cancel 模块（TDD）

**Files:**
- Create: `server/smscloud-deferred-cancel.js`
- Test: `server/__tests__/smscloud-deferred-cancel.test.js`

依赖：无。

### Step 1: 写 4 个失败测试

- [ ] **Step 1.1: 写测试**

Create `server/__tests__/smscloud-deferred-cancel.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

function freshModule() {
  delete require.cache[require.resolve('../smscloud-deferred-cancel')];
  delete require.cache[require.resolve('../smscloud-provider')];
  return require('../smscloud-deferred-cancel');
}

test('enqueue + tick: 未到 125s 不调 cancelOrder', async () => {
  const mod = freshModule();
  const smscloud = require('../smscloud-provider');
  let calls = 0;
  const origCancel = smscloud.cancelOrder;
  smscloud.cancelOrder = async () => { calls++; return { ok: true }; };
  try {
    mod.enqueue({ apiKey: 'k', baseUrl: 'b', orderNo: '1', takenAtMs: Date.now() });
    await mod._tickOnce();
    assert.strictEqual(calls, 0, 'should not cancel yet');
    assert.strictEqual(mod._queueForTest().size, 1);
  } finally { smscloud.cancelOrder = origCancel; }
});

test('enqueue + tick: 到 125s 后调 cancelOrder 并出队', async () => {
  const mod = freshModule();
  const smscloud = require('../smscloud-provider');
  let calls = 0;
  const origCancel = smscloud.cancelOrder;
  smscloud.cancelOrder = async (orderNo) => { calls++; assert.strictEqual(orderNo, '2'); return { ok: true }; };
  try {
    mod.enqueue({ apiKey: 'k', baseUrl: 'b', orderNo: '2', takenAtMs: Date.now() - 130_000 });
    await mod._tickOnce();
    assert.strictEqual(calls, 1);
    assert.strictEqual(mod._queueForTest().size, 0);
  } finally { smscloud.cancelOrder = origCancel; }
});

test('enqueue + tick: cancel 失败重试 3 次后丢弃', async () => {
  const mod = freshModule();
  const smscloud = require('../smscloud-provider');
  let calls = 0;
  const origCancel = smscloud.cancelOrder;
  smscloud.cancelOrder = async () => { calls++; throw new Error('boom'); };
  try {
    mod.enqueue({ apiKey: 'k', baseUrl: 'b', orderNo: '3', takenAtMs: Date.now() - 130_000 });
    await mod._tickOnce();
    await mod._tickOnce();
    await mod._tickOnce();
    assert.strictEqual(calls, 3);
    assert.strictEqual(mod._queueForTest().size, 0, 'dropped after 3 retries');
  } finally { smscloud.cancelOrder = origCancel; }
});

test('enqueue: 同 orderNo 去重', async () => {
  const mod = freshModule();
  mod.enqueue({ apiKey: 'k', baseUrl: 'b', orderNo: '4', takenAtMs: 1000 });
  mod.enqueue({ apiKey: 'k', baseUrl: 'b', orderNo: '4', takenAtMs: 2000 });
  assert.strictEqual(mod._queueForTest().size, 1);
  // 保留较早 takenAtMs (1000)，避免推迟 cancel 时间
  assert.strictEqual(mod._queueForTest().get('4').takenAtMs, 1000);
});
```

- [ ] **Step 1.2: 跑测试，确认 4 个全 FAIL**

Run: `node --test server/__tests__/smscloud-deferred-cancel.test.js`
Expected: 4 个失败（模块不存在）

### Step 2: 实现模块

- [ ] **Step 2.1: 创建模块文件**

Create `server/smscloud-deferred-cancel.js`:

```js
// v2.44.1 — smscloud cancelOrder 延迟兜底
// smscloud 平台要求 "下单 ≥2 分钟" 才能 cancel。OpenAI rate-limited 等场景
// 秒级 fail，直接 cancel 会被平台拒。本模块把 cancel 任务排进 in-memory queue，
// 后台 worker 每 30s 扫描，到 takenAtMs + 125s 后尝试 cancel；失败重试 3 次。
// 进程死掉时 queue 丢失 —— smscloud 平台端最终自然 timeout。

const READY_DELAY_MS = 125_000;
const TICK_INTERVAL_MS = 30_000;
const MAX_ATTEMPTS = 3;

const _queue = new Map();  // orderNo -> { apiKey, baseUrl, orderNo, takenAtMs, attempts }
let _timer = null;

function enqueue({ apiKey, baseUrl, orderNo, takenAtMs }) {
  if (!orderNo) return;
  if (_queue.has(orderNo)) return;
  _queue.set(orderNo, { apiKey, baseUrl, orderNo, takenAtMs, attempts: 0 });
  console.log(`[smscloud-deferred-cancel] enqueued orderNo=${orderNo} takenAtMs=${takenAtMs}`);
}

async function _tickOnce() {
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

function start() {
  if (_timer) return;
  _timer = setInterval(() => { _tickOnce().catch(() => {}); }, TICK_INTERVAL_MS);
  _timer.unref?.();
  console.log(`[smscloud-deferred-cancel] started, tick=${TICK_INTERVAL_MS}ms`);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { enqueue, start, stop, _tickOnce, _queueForTest: () => _queue };
```

- [ ] **Step 2.2: 跑测试，确认 4 个全 PASS**

Run: `node --test server/__tests__/smscloud-deferred-cancel.test.js`
Expected: 4/4 pass

- [ ] **Step 2.3: 提交**

```bash
git add server/smscloud-deferred-cancel.js server/__tests__/smscloud-deferred-cancel.test.js
git commit -m "feat(smscloud): 加 deferred-cancel queue 兜底 <2 分钟 cancel 限制"
```

---

## Task 2: smscloud-provider.cancelOrder 改返 result obj

**Files:**
- Modify: `server/smscloud-provider.js:65-67`
- Modify: `server/__tests__/smscloud-provider.test.js` (追加)

依赖：无。

- [ ] **Step 1: 追加 3 个失败测试**

In `server/__tests__/smscloud-provider.test.js` 末尾追加：

```js
test('cancelOrder: 成功返 { ok: true }', async () => {
  const restore = mockFetch(async (url) => {
    assert.ok(url.includes('/public/sms/orders/cancel/order-x'));
    return { ok: true, json: async () => ({ code: 0, data: null }) };
  });
  try {
    delete require.cache[require.resolve('../smscloud-provider')];
    const smscloud = require('../smscloud-provider');
    const r = await smscloud.cancelOrder('order-x', 'key', null);
    assert.deepStrictEqual(r, { ok: true });
  } finally { restore(); }
});

test('cancelOrder: <2 分钟 错误返 { ok:false, deferred:true } 不抛', async () => {
  const restore = mockFetch(async () => ({
    ok: true,
    json: async () => ({ code: 1, message: '取消号码需要在下单 2 分钟后操作' }),
  }));
  try {
    delete require.cache[require.resolve('../smscloud-provider')];
    const smscloud = require('../smscloud-provider');
    const r = await smscloud.cancelOrder('order-y', 'key', null);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.deferred, true);
    assert.match(r.reason, /2 ?分钟/);
  } finally { restore(); }
});

test('cancelOrder: 其他错误透传抛错', async () => {
  const restore = mockFetch(async () => ({
    ok: true,
    json: async () => ({ code: 1, message: 'order not found' }),
  }));
  try {
    delete require.cache[require.resolve('../smscloud-provider')];
    const smscloud = require('../smscloud-provider');
    await assert.rejects(
      smscloud.cancelOrder('order-z', 'key', null),
      (e) => e.message.includes('order not found')
    );
  } finally { restore(); }
});
```

- [ ] **Step 2: 跑测试，确认新 3 个 FAIL，旧的 PASS**

Run: `node --test server/__tests__/smscloud-provider.test.js`
Expected: 旧用例 pass，新 3 个 fail（cancelOrder 还在抛错 / 返 undefined）

- [ ] **Step 3: 改 cancelOrder 实现**

Edit `server/smscloud-provider.js:65-67`，从：

```js
async function cancelOrder(orderNo, apiKey, baseUrl) {
  await _get(`${baseUrl || DEFAULT_BASE_URL}/public/sms/orders/cancel/${orderNo}`, apiKey);
}
```

改为：

```js
async function cancelOrder(orderNo, apiKey, baseUrl) {
  try {
    await _get(`${baseUrl || DEFAULT_BASE_URL}/public/sms/orders/cancel/${orderNo}`, apiKey);
    return { ok: true };
  } catch (e) {
    const msg = e?.message || '';
    if (msg.includes('2 分钟') || msg.includes('2分钟')) {
      return { ok: false, deferred: true, reason: msg };
    }
    throw e;
  }
}
```

- [ ] **Step 4: 跑测试，确认全 PASS**

Run: `node --test server/__tests__/smscloud-provider.test.js`
Expected: 全部用例 pass

- [ ] **Step 5: 提交**

```bash
git add server/smscloud-provider.js server/__tests__/smscloud-provider.test.js
git commit -m "feat(smscloud): cancelOrder 区分 <2 分钟 deferred 错误"
```

---

## Task 3: protocol-engine `_finalizePhoneVerify` retry 修复

**Files:**
- Modify: `protocol-engine.js:230-236` —— smscloud releaseFn 接入 deferred-cancel
- Modify: `protocol-engine.js:298-316` —— rate-limited 分支 return → continue
- Modify: `protocol-engine.js:330` —— `phoneVerifyFail` 用 `lastReason` 兜底
- Test: `__tests__/protocol-engine-add-phone-retry.test.js`

依赖：Task 1 + Task 2 完成。

- [ ] **Step 1: 写集成测试**

Create `__tests__/protocol-engine-add-phone-retry.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

// 备份并写一份最小 config.json 仅启用 phonePool
let _origCfg = null;
function setupCfg() {
  try { _origCfg = fs.readFileSync(CONFIG_PATH, 'utf-8'); } catch { _origCfg = null; }
  const merged = _origCfg ? JSON.parse(_origCfg) : {};
  merged.phonePool = Object.assign({}, merged.phonePool, {
    enabled: true,
    provider: 'smscloud',
    smscloud: { apiKey: 'k', baseUrl: 'b', serviceCode: 'tg', countryCode: 187 },
  });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
}
function restoreCfg() {
  if (_origCfg !== null) fs.writeFileSync(CONFIG_PATH, _origCfg);
  else try { fs.unlinkSync(CONFIG_PATH); } catch {}
}

test('attempt 1 rate-limited → attempt 2 success（换号 retry 走通）', async () => {
  setupCfg();
  try {
    delete require.cache[require.resolve('../protocol-engine')];
    const { ProtocolEngine } = require('../protocol-engine');
    const engine = new ProtocolEngine();

    // patch acquire 顺序返 +A, +B
    const acquired = [];
    engine._acquirePhoneForProtocol = async (provider, cfg, email, proxyUrl, excludePhones) => {
      acquired.push([...excludePhones]);
      const i = acquired.length;
      return { phone: ['+A','+B','+C'][i-1], smsConfig: {}, releaseFn: async () => {} };
    };

    // patch runProtocolPhoneVerify via导出的 setter
    const protoMod = require('../protocol-engine');
    const orig = protoMod.__runProtocolPhoneVerify;
    let call = 0;
    protoMod.__setRunProtocolPhoneVerify(async () => {
      call++;
      if (call === 1) return { status: 'rate-limited', detail: 'rate_limit_exceeded' };
      return { status: 'ok', tokens: { access_token: 'tok' } };
    });

    try {
      const r = await engine._finalizePhoneVerify({}, { email: 'a@b' });
      assert.ok(r.tokens, 'should return tokens on attempt 2');
      assert.deepStrictEqual(acquired[0], [], 'attempt 1 excludePhones empty');
      assert.deepStrictEqual(acquired[1], ['+A'], 'attempt 2 excludes +A');
    } finally { protoMod.__setRunProtocolPhoneVerify(orig); }
  } finally { restoreCfg(); }
});

test('3 次全 rate-limited → phoneVerifyFail=rate-limited（lastReason 兜底）', async () => {
  setupCfg();
  try {
    delete require.cache[require.resolve('../protocol-engine')];
    const { ProtocolEngine } = require('../protocol-engine');
    const engine = new ProtocolEngine();
    let i = 0;
    engine._acquirePhoneForProtocol = async () => ({ phone: '+P' + (++i), smsConfig: {}, releaseFn: async () => {} });
    const protoMod = require('../protocol-engine');
    const orig = protoMod.__runProtocolPhoneVerify;
    protoMod.__setRunProtocolPhoneVerify(async () => ({ status: 'rate-limited', detail: 'x' }));
    try {
      const r = await engine._finalizePhoneVerify({}, { email: 'a@b' });
      assert.strictEqual(r.phoneVerifyFail, 'rate-limited');
      assert.strictEqual(i, 3, 'should try 3 phones');
    } finally { protoMod.__setRunProtocolPhoneVerify(orig); }
  } finally { restoreCfg(); }
});

test('fraud-blocked / voip-blocked 同样 retry', async () => {
  setupCfg();
  try {
    delete require.cache[require.resolve('../protocol-engine')];
    const { ProtocolEngine } = require('../protocol-engine');
    const engine = new ProtocolEngine();
    let i = 0;
    engine._acquirePhoneForProtocol = async () => ({ phone: '+Q' + (++i), smsConfig: {}, releaseFn: async () => {} });
    const protoMod = require('../protocol-engine');
    const orig = protoMod.__runProtocolPhoneVerify;
    const seq = [
      { status: 'fraud-blocked' },
      { status: 'voip-blocked' },
      { status: 'ok', tokens: { access_token: 'tok' } },
    ];
    protoMod.__setRunProtocolPhoneVerify(async () => seq.shift());
    try {
      const r = await engine._finalizePhoneVerify({}, { email: 'a@b' });
      assert.ok(r.tokens);
      assert.strictEqual(i, 3);
    } finally { protoMod.__setRunProtocolPhoneVerify(orig); }
  } finally { restoreCfg(); }
});
```

**Note**：`runProtocolPhoneVerify` 是 protocol-engine.js 内的 module-level `let` 变量（line 97），通过现成的 `module.exports.__setRunProtocolPhoneVerify` (line 888) 暴露给测试 patch。本计划的测试代码已使用该 setter。

- [ ] **Step 2: 跑测试，确认 3 个 FAIL**

Run: `node --test "__tests__/protocol-engine-add-phone-retry.test.js"`
Expected: 3 个失败（其中第 1 个测试因 attempt 1 rate-limited 直接 fail 不会到 attempt 2）

- [ ] **Step 3: 改 `protocol-engine.js:298-316`**

把 line 298-316 整个 if 块从：

```js
      if (result.status === 'rate-limited' || result.status === 'fraud-blocked' || result.status === 'voip-blocked') {
        // v2.40.4: OpenAI 返 fraud_guard / rate_limit_exceeded —— 该号在 OpenAI 那边
        // 已被 flag（可能多账号过用太多 SMS）。其他账号再 acquire 该号也会被拒。
        // 修复策略：把号标记 saturated（bindings_used → max），让 acquirePhone SQL 的
        // `WHERE bindings_used < max` 自动排除给所有后续账号用。本 attempt binding 保留。
        console.log(`[protocol] block-and-saturate ${result.status} for ${phone}: ${(result.detail || '').slice(0, 500)}`);
        if (provider === 'local') {
          try {
            const max = cfg.phonePool.maxBindingsPerPhone || 3;
            phonePool.markPhoneSaturated(getRawDb(), phone, max);
            save();
          } catch (e) { console.log(`[protocol] markPhoneSaturated err: ${e?.message}`); }
        } else {
          // zhusms: 订单释放（zhusms 用 cancelOrder 不消耗余额，号是接码方动态分配的）
          if (releaseFn) try { await releaseFn(); } catch {}
          try { save(); } catch {}
        }
        return { phoneVerifyFail: result.status };
      }
```

改为：

```js
      if (result.status === 'rate-limited' || result.status === 'fraud-blocked' || result.status === 'voip-blocked') {
        // v2.44.1: rate-limited / fraud-blocked / voip-blocked 现在走换号 retry。
        // local provider 保留 markPhoneSaturated（持久黑名单避免后续账号再选到）。
        // smscloud/zhusms 调 releaseFn 释放当前订单。retry 由外层 for-loop 接管。
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

- [ ] **Step 4: 改 `protocol-engine.js:330`**

从：

```js
    return { phoneVerifyFail: 'all-phones-rejected' };
```

改为：

```js
    return { phoneVerifyFail: lastReason || 'all-phones-rejected' };
```

- [ ] **Step 5: 改 `protocol-engine.js:230-236` smscloud releaseFn 接入 deferred-cancel**

在 smscloud branch 取号成功后捕获 `takenAtMs`，releaseFn 内对 cancelOrder 返 `deferred:true` 时 enqueue。把 line 213-237 的 try 块（含 `const order = await smscloud.takeOrder(...)` 到 releaseFn return）改为：

```js
      try {
        const smscloud = require('./server/smscloud-provider');
        const deferredCancel = require('./server/smscloud-deferred-cancel');
        const order = await smscloud.takeOrder(
          s.apiKey,
          s.baseUrl || 'https://smscloud.sbs/api/system',
          s.serviceCode,
          s.countryCode,
        );
        if (!order || !order.phone) return {};
        const takenAtMs = Date.now();
        const apiKey = s.apiKey;
        const baseUrl = s.baseUrl || 'https://smscloud.sbs/api/system';
        return {
          phone: order.phone,
          smsConfig: {
            provider: 'smscloud',
            order_no: order.order_no,
            api_key: apiKey,
            base_url: baseUrl,
          },
          releaseFn: async () => {
            try {
              const r = await smscloud.cancelOrder(order.order_no, apiKey, baseUrl);
              if (r && r.deferred) {
                deferredCancel.enqueue({ apiKey, baseUrl, orderNo: order.order_no, takenAtMs });
              }
            } catch (e) {
              console.log(`[protocol] smscloud cancelOrder failed: ${e?.message?.slice(0, 60)}`);
            }
          },
        };
      } catch (e) {
```

（catch 块保持原样不动。）

- [ ] **Step 6: 跑测试，确认 3 个 PASS**

Run: `node --test "__tests__/protocol-engine-add-phone-retry.test.js"`
Expected: 3/3 pass

- [ ] **Step 7: 跑全套 JS 测试，确认无回归**

Run: `npm test`
Expected: 全套 pass

- [ ] **Step 8: 提交**

```bash
git add protocol-engine.js __tests__/protocol-engine-add-phone-retry.test.js
git commit -m "fix(protocol): add-phone rate-limited/fraud/voip 走换号 retry 不再短路 fail"
```

---

## Task 4: server/index.js wire-up

**Files:**
- Modify: `server/index.js:36+, 133-155`

依赖：Task 1 完成。

- [ ] **Step 1: 在 `initDB().then(...)` 块内 start worker**

打开 `server/index.js`，在 line 36 `initDB().then(() => {` 之后、`const accountsRoutes = require('./routes/accounts');` 之前一行加：

```js
  require('./smscloud-deferred-cancel').start();
```

（与该块内现有 `const fs = require('fs');` 类似，本模块只在 db ready 后用得到，放这里语义清晰。）

- [ ] **Step 2: 在 gracefulShutdown 调 stop**

找到 line 149 `if (db.save?.flush) await db.save.flush();`，在它**前面**一行加：

```js
    require('./smscloud-deferred-cancel').stop();
```

- [ ] **Step 3: 启 server 烟测**

Run: `node server/index.js`（后台跑 5s 看启动日志）
Expected: 启动日志含 `[smscloud-deferred-cancel] started, tick=30000ms`，无 stack。Ctrl+C 后日志含 `[shutdown] received SIGINT, flushing…`，无残留 timer 阻塞退出。

- [ ] **Step 4: 提交**

```bash
git add server/index.js
git commit -m "feat(server): 启动 smscloud-deferred-cancel worker + SIGINT 清理"
```

---

## Task 5: CHANGELOG

**Files:**
- Modify: `docs/CHANGELOG.md`

依赖：Task 1-4 完成。

- [ ] **Step 1: 在 CHANGELOG 顶部追加 v2.44.1 节**

打开 `docs/CHANGELOG.md`，找到现有 v2.44.0 节标题（如 `## v2.44.0 — ...`），在其**上方**插入：

```markdown
## v2.44.1 — 2026-05-27 — 协议模式 add-phone rate-limited 换号 retry

### 核心改动

- `protocol-engine.js _finalizePhoneVerify`：rate-limited / fraud-blocked / voip-blocked 三个 status 从"一次性 fail"改为"换号 retry"，复用现有 `triedPhones` + `MAX_ATTEMPTS=3` 框架。最终 fail 时 `phoneVerifyFail` 反映 lastReason 而非通用 `all-phones-rejected`。
- `server/smscloud-provider.js cancelOrder`：检测"取消号码需要在下单 2 分钟后操作"中文消息返 `{ ok:false, deferred:true }`，不再抛错。其他错误透传。
- 新增 `server/smscloud-deferred-cancel.js`：in-memory queue + 30s tick worker，下单 ≥125s 后重试 cancel；max 3 attempts 后丢弃。`server/index.js` 启动 start、SIGINT/SIGTERM stop。
- smscloud 取号闭包在 releaseFn 内调 cancelOrder，看到 `deferred:true` 自动 enqueue 到 deferred 队列。

### 端到端验证

- 协议模式 attempt 1 rate-limited 后日志出现 `attempt 2/3 (...)` 走新号，不再直接 phone_verify_fail。
- smscloud rate-limited 场景看到 `[smscloud-deferred-cancel] enqueued orderNo=...`，2-3 分钟后 `cancelled orderNo=... ok`。
- 单元测试新增 10 个（4 deferred-cancel + 3 cancelOrder + 3 protocol-engine retry）全绿。

### 对照前版（v2.44.0）

- `_finalizePhoneVerify` rate-limited 分支注释里"该号在 OpenAI 那边已被 flag，立刻 break + markSaturated"的设计假设已不成立 —— 实际线上 rate-limited 主要由账号/IP 级频率限制触发，换号能继续。本版调整。
```

- [ ] **Step 2: 提交**

```bash
git add docs/CHANGELOG.md
git commit -m "docs: CHANGELOG v2.44.1"
```

- [ ] **Step 3: 打 tag**

```bash
git tag v2.44.1
```

（不 push，由用户决定。）

---

## Self-Review 检查

- **Spec coverage**：spec §3.1-3.5 全部映射到 Task 1-4；spec §4 不在范围（PipelineEngine / web UI / config.json）保留不动 ✓
- **Placeholder scan**：无 TBD / TODO / "fill in" / "similar to" ✓
- **Type consistency**：所有方法名 `cancelOrder` / `enqueue` / `start` / `stop` / `_tickOnce` / `_queueForTest` / `_finalizePhoneVerify` / `_acquirePhoneForProtocol` 全程一致 ✓
- **Caveat**：Task 3 Step 1 测试用例对 `runProtocolPhoneVerify` 的 monkey-patch 路径需在实施时按 protocol-engine.js require 实际位置调整 —— plan 已显式标注此 caveat，由 implementer 处理 ✓

---

## Execution Handoff

Plan 完毕并落到 `docs/superpowers/plans/2026-05-27-add-phone-rate-limit-retry.md`。两种执行方式：

1. **Subagent-Driven（推荐）** —— 每个 Task 派 implementer subagent，两轮 review，自动迭代
2. **Inline Execution** —— 本会话内逐 Task 执行，checkpoint 处给你看

你选哪个？
