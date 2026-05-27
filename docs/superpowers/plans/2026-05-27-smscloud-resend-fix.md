# smscloud 复用号 resend 修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 v2.45.0 复用号路径漏调 `resend` 接口导致 OpenAI 拿到过期 OTP 的 bug。

**Architecture:** `server/smscloud-provider.js` 加 `resendSms(orderNo, apiKey, baseUrl)`。`protocol-engine.js _acquirePhoneForProtocol` smscloud branch 在 `acq.reused === true` 时调 resend；失败则 markRejected + releaseBinding + return `{}` 让外层 retry 拿新号。

**Tech Stack:** Node.js (CommonJS) + node:test。无新依赖。

**Spec:** `docs/superpowers/specs/2026-05-27-smscloud-resend-fix-design.md`

---

## File Structure

- **Modify:** `server/smscloud-provider.js` —— 加 `resendSms` 函数 + 导出
- **Modify:** `server/__tests__/smscloud-provider.test.js` —— 追加 2 测（成功 / 失败抛错）
- **Modify:** `protocol-engine.js` —— smscloud branch acquire 后插 resend 处理（acq.reused === true 路径）
- **Modify:** `__tests__/protocol-engine-smscloud-cache.test.js` —— SC1 改造（加 resendSms mock + 计数断言）+ 新增 SC3 用例
- **Modify:** `docs/CHANGELOG.md` —— v2.45.1 节

---

## Task 1: smscloud-provider 加 resendSms（TDD）

**Files:**
- Modify: `server/smscloud-provider.js`
- Modify: `server/__tests__/smscloud-provider.test.js` (追加)

依赖：无（独立加 API）。

- [ ] **Step 1: 在 test 文件末尾追加 2 失败测试**

```js
test('resendSms: 200 success 不抛错', async () => {
  const restore = mockFetch(async (url) => {
    assert.ok(url.includes('/public/sms/orders/resend/order-x'));
    return { ok: true, json: async () => ({ code: 0, data: {} }) };
  });
  try {
    delete require.cache[require.resolve('../smscloud-provider')];
    const smscloud = require('../smscloud-provider');
    await smscloud.resendSms('order-x', 'key', null);  // 不抛
  } finally { restore(); }
});

test('resendSms: code !== 0 抛错带 _smscloudCode', async () => {
  const restore = mockFetch(async () => ({
    ok: true,
    json: async () => ({ code: 1001, message: 'cannot get another sms' }),
  }));
  try {
    delete require.cache[require.resolve('../smscloud-provider')];
    const smscloud = require('../smscloud-provider');
    await assert.rejects(
      smscloud.resendSms('order-y', 'key', null),
      (e) => e.message.includes('cannot get another sms') && e._smscloudCode === '1001'
    );
  } finally { restore(); }
});
```

- [ ] **Step 2: 跑测试确认 2 个新 FAIL，旧用例全 PASS**

Run: `node --test server/__tests__/smscloud-provider.test.js`
Expected: 旧用例（9 个 v2.44.1 + v2.45.0 累计）pass，新 2 个 fail（`smscloud.resendSms is not a function`）

- [ ] **Step 3: 实现 resendSms**

打开 `server/smscloud-provider.js`，在 `finishOrder` 函数之后、`getBalance` 之前插入：

```js
async function resendSms(orderNo, apiKey, baseUrl) {
  await _get(`${baseUrl || DEFAULT_BASE_URL}/public/sms/orders/resend/${orderNo}`, apiKey);
}
```

`module.exports` 加入 `resendSms`：

```js
module.exports = {
  takeOrder, pollOrderSms, cancelOrder, finishOrder, resendSms, getBalance,
  listServices, listCountries,
  _DEFAULT_BASE_URL: DEFAULT_BASE_URL,
};
```

- [ ] **Step 4: 跑测试全 PASS**

Run: `node --test server/__tests__/smscloud-provider.test.js`
Expected: 全 pass

- [ ] **Step 5: 提交**

```bash
git add server/smscloud-provider.js server/__tests__/smscloud-provider.test.js
git commit -m "feat(smscloud): 加 resendSms 接口供 cache 复用号 advance 上游 channel"
```

---

## Task 2: protocol-engine 复用号路径调 resend + 集成测试

**Files:**
- Modify: `protocol-engine.js:207-250` smscloud branch
- Modify: `__tests__/protocol-engine-smscloud-cache.test.js` —— SC1 改造 + 加 SC3

依赖：Task 1 完成（`smscloud.resendSms` 可调）。

- [ ] **Step 1: 改 SC1 测试加 resendSms mock + 计数断言（先改测试，验证测试本身能跑通）**

打开 `__tests__/protocol-engine-smscloud-cache.test.js` SC1 用例。当前 mock 是：

```js
const origTake = smscloud.takeOrder;
smscloud.takeOrder = async () => {
  takeOrderCalls++;
  return { order_no: 'OO1', phone: '+15550001111', raw: {} };
};
```

改为：

```js
const origTake = smscloud.takeOrder;
const origResend = smscloud.resendSms;
let resendCalls = [];
smscloud.takeOrder = async () => {
  takeOrderCalls++;
  return { order_no: 'OO1', phone: '+15550001111', raw: {} };
};
smscloud.resendSms = async (orderNo) => { resendCalls.push(orderNo); };
```

末尾 finally 块加 `smscloud.resendSms = origResend;`。

主断言区（`assert.strictEqual(takeOrderCalls, 1, ...)` 之后）加：

```js
      assert.deepStrictEqual(resendCalls, ['OO1'], 'resendSms called once for account 2 reuse');
```

- [ ] **Step 2: 在 SC2 用例 finally 之前同样还原 resendSms（避免 mock 漏）**

SC2 测试现有 `smscloud.takeOrder = async () => {...}` 设置后不动 resendSms。这意味着 SC2 跑 attempt 1 rate-limited 时不应触发 resend（cache miss 路径，attempt 1 是新取号）；attempt 2 也是新取号（OO1 markRejected → cache miss → takeOrder OO2）。所以 SC2 不需要 mock resendSms（保留原函数）。**不动 SC2**。

- [ ] **Step 3: 加 SC3 用例（resend 失败 → markRejected + retry 新号）**

在 `__tests__/protocol-engine-smscloud-cache.test.js` 文件末尾追加：

```js
test('SC3 resend 失败 → cache entry markRejected + retry 拿新号', async () => {
  setupCfg();
  try {
    const { engine, rawDb, protoMod } = await freshEngine();
    delete require.cache[require.resolve('../server/smscloud-provider')];
    const smscloud = require('../server/smscloud-provider');
    const origTake = smscloud.takeOrder, origResend = smscloud.resendSms;
    let takeCalls = 0;
    smscloud.takeOrder = async () => {
      takeCalls++;
      return { order_no: 'OO' + takeCalls, phone: '+1555' + String(takeCalls).padStart(7, '0'), raw: {} };
    };
    let resendCalls = 0;
    smscloud.resendSms = async () => { resendCalls++; throw new Error('cannot get another sms'); };

    const orig = protoMod.__runProtocolPhoneVerify;
    protoMod.__setRunProtocolPhoneVerify(async () => ({ status: 'ok', tokens: { access_token: 'tok' } }));

    try {
      // 账号 1 新取号 OO1
      const r1 = await engine._finalizePhoneVerify({}, { email: 'u1@x.com' });
      assert.ok(r1.tokens);
      assert.strictEqual(takeCalls, 1);
      assert.strictEqual(resendCalls, 0, '新取号不调 resend');
      // 账号 2 复用 OO1 → resend 失败 → markRejected → attempt 2 拿新号 OO2
      const r2 = await engine._finalizePhoneVerify({}, { email: 'u2@x.com' });
      assert.ok(r2.tokens);
      assert.strictEqual(takeCalls, 2, '复用失败后拿新号');
      assert.strictEqual(resendCalls, 1, 'resend 调一次（仅复用 attempt）');
      const rejected = rawDb.exec("SELECT order_no FROM smscloud_phone_cache WHERE status='rejected'");
      assert.deepStrictEqual(rejected[0].values.map(v => v[0]), ['OO1'], 'OO1 status=rejected');
      try { await require('../server/db').save?.flush?.(); } catch {}
    } finally {
      smscloud.takeOrder = origTake;
      smscloud.resendSms = origResend;
      protoMod.__setRunProtocolPhoneVerify(orig);
    }
  } finally { restoreCfg(); }
});
```

- [ ] **Step 4: 跑测试确认 SC1 改造 FAIL（resendCalls 期望 ['OO1'] 实际 []）+ SC3 FAIL**

Run: `node --test "__tests__/protocol-engine-smscloud-cache.test.js"`
Expected: SC2 pass, SC1 改造 fail（resend 还没调），SC3 fail（无 resend 路径）

- [ ] **Step 5: 改 protocol-engine.js smscloud branch**

找 `protocol-engine.js:224-226`：

```js
        const acq = await smscloudPool.acquirePhone(getRawDb(), email, max, EXPIRY_MS, excludePhones, takeOrderFn);
        try { save(); } catch {}
        console.log(`[protocol] smscloud ${acq.reused ? '复用' : '新取'}号 ${acq.phone} (orderNo=${acq.orderNo}, bindings=${acq.bindings_used})`);
```

替换为：

```js
        const acq = await smscloudPool.acquirePhone(getRawDb(), email, max, EXPIRY_MS, excludePhones, takeOrderFn);
        if (acq.reused) {
          try {
            await smscloud.resendSms(acq.orderNo, acq.apiKey, acq.baseUrl);
            console.log(`[protocol] smscloud resend SMS for orderNo=${acq.orderNo}`);
          } catch (e) {
            console.log(`[protocol] smscloud resend failed for ${acq.orderNo}: ${e?.message?.slice(0, 80)}, marking rejected`);
            smscloudPool.markRejected(getRawDb(), acq.orderNo);
            smscloudPool.releaseBinding(getRawDb(), acq.orderNo, email, acq.phone);
            try { save(); } catch {}
            return {};
          }
        }
        try { save(); } catch {}
        console.log(`[protocol] smscloud ${acq.reused ? '复用' : '新取'}号 ${acq.phone} (orderNo=${acq.orderNo}, bindings=${acq.bindings_used})`);
```

注意：日志顺序是 "先 resend 日志，再复用/新取号 日志"（保留 v2.45.0 line 226 现有行不动）。

- [ ] **Step 6: 跑集成测试 SC1/SC2/SC3 全 PASS**

Run: `node --test "__tests__/protocol-engine-smscloud-cache.test.js"`
Expected: 3/3 pass

- [ ] **Step 7: 跑全套 npm test 无回归**

Run: `npm test`
Expected: 全套 pass。预期总数 = v2.45.0 的 333 + 2 个新 smscloud-provider 单测 + 1 个新 SC3 = 336，pass 314，skip 22，fail 0

- [ ] **Step 8: 提交**

确认 `git status` config.json 不在 staged：

```bash
git status
git diff --cached config.json  # 应空
git add protocol-engine.js __tests__/protocol-engine-smscloud-cache.test.js
git commit -m "fix(protocol): smscloud cache hit 调 resend advance 上游 channel + resend 失败 markRejected"
```

---

## Task 3: CHANGELOG v2.45.1 + tag

**Files:**
- Modify: `docs/CHANGELOG.md`

依赖：Task 1 + Task 2 完成。

- [ ] **Step 1: 加 v2.45.1 节**

在 v2.45.0 节上方插入：

```markdown
## v2.45.1 — 2026-05-27 — smscloud 复用号补调 resend

### 核心改动

- `server/smscloud-provider.js` 加 `resendSms(orderNo, apiKey, baseUrl)` 接口，对应 smscloud 文档 `/public/sms/orders/resend/{id}`（"请求上游平台继续接收下一条短信验证码"）。
- `protocol-engine.js _acquirePhoneForProtocol` smscloud branch 在 `acq.reused === true` 时调 resend advance 上游 channel；resend 失败 → `markRejected` 当前 cache entry + 撤本次 binding + return `{}` 让外层 `_finalizePhoneVerify` retry loop 拿新号。

### Bug 修复

- **v2.45.0 复用号路径拿到旧 OTP 导致 OpenAI 验证 invalid_code**：v2.45.0 设计假设"同 orderNo 反复 poll sync 能拿不同 SMS"，实际 `/orders/sync/{id}` 返"最新 cached SMS"语义；必须显式调 `/orders/resend/{id}` 才能让上游 channel advance 到下一条。本版本补回 resend 步。

### 端到端验证

- 跑 smscloud 配置下连续激活 2 个账号：第 1 个 `smscloud 新取号 +XXX`（无 resend 日志），第 2 个 `smscloud resend SMS for orderNo=...` + `smscloud 复用号 +XXX`，OpenAI 验证通过。
- 模拟 `canGetAnotherSms=false`：日志含 `smscloud resend failed ... marking rejected`，下个 attempt 拿新号成功。
- 单测 + 集成测试新增 3 个（2 smscloud-provider + 1 protocol-engine SC3）+ SC1 改造，`npm test` 全绿。

### 对照前版（v2.45.0）

- v2.45.0 引入 smscloud cache 复用号但漏 resend 步。本版仅补 resend 调用 + 失败 fallback；不动 cache schema / acquire 逻辑 / saturate 分支。
- `protocol_phone_verify.py` 不变 —— Python 仍按 sync poll，resend 由 JS 侧（acquire 阶段）调。
```

- [ ] **Step 2: 提交 + tag**

```bash
git add docs/CHANGELOG.md
git commit -m "docs: CHANGELOG v2.45.1"
git tag v2.45.1
git tag --list 'v2.45*'
git log --oneline -5
```

不 push。

---

## Self-Review

- **Spec coverage**：
  - spec D1（cache hit 调 resend）→ Task 2 Step 5 `if (acq.reused) { await smscloud.resendSms ... }` ✓
  - spec D2（失败 markRejected + return {}）→ Task 2 Step 5 catch 分支 ✓
  - spec D3（不查 canGetAnotherSms）→ 范围内不实现 ✓
  - spec D4（不引入 finishOrder）→ Task 1 module.exports 不含 finishOrder 改动 ✓（保留现有）
  - spec D5（不动 schema）→ 范围内不改 ✓
  - spec D6（不动 protocol_phone_verify.py）→ 范围内不改 ✓
  - spec §3.3 测试 → Task 1 Step 1 + Task 2 Step 1/3 ✓
- **Placeholder scan**：无 TBD / TODO / "fill in" / "similar to" ✓
- **Type consistency**：
  - `resendSms(orderNo, apiKey, baseUrl)` 签名在 Task 1 实现 / Task 2 调用 / 测试 mock 三处一致 ✓
  - `acq.orderNo / acq.apiKey / acq.baseUrl / acq.phone` 字段命名与 v2.45.0 smscloud-pool.acquirePhone 返值一致 ✓
  - `smscloudPool.markRejected(db, orderNo)` / `smscloudPool.releaseBinding(db, orderNo, email, phone)` 签名与 v2.45.0 smscloud-pool.js 一致 ✓
  - 日志格式 `[protocol] smscloud resend SMS for orderNo=...` / `[protocol] smscloud resend failed for ... marking rejected` 在实现 + CHANGELOG 描述一致 ✓
- **SC1 改造保留现有断言**：Task 2 Step 1 只**加** resendSms mock + 计数断言，不动 takeOrderCalls / bindings_used 等现有断言 ✓
- **save.flush race 防御**：SC3 末尾 `try { await require('../server/db').save?.flush?.(); } catch {}` 与 v2.45.0 commit 48fe441 模式一致 ✓

---

## Execution Handoff

Plan 落到 `docs/superpowers/plans/2026-05-27-smscloud-resend-fix.md`。3 个 Task：

1. **Subagent-Driven（推荐）** —— 每 Task 派 implementer + spec/quality review，本会话串行 3 个 Task
2. **Inline Execution** —— 主体 Claude 逐 Task 执行

选哪个？
