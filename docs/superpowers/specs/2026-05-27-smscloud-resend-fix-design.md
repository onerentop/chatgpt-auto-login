# smscloud 复用号 resend 修复设计

> 日期：2026-05-27
> 作用域：v2.45.0 引入的 smscloud 一号多绑 cache hit 路径漏调 `resend` 接口导致拿到旧 OTP 的 bug 修复

## 1. 背景

v2.45.0 (`docs/superpowers/specs/2026-05-27-smscloud-phone-cache-design.md`) 实现 smscloud 接码方号本地缓存，cache hit 时跳过 `takeOrder` 直接复用同一 orderNo。

设计假设 (Q1 in brainstorming) 是"同 orderNo 在 20min 内可多次拿不同 SMS"。该假设方向正确，但**实施路径错了**：

smscloud 官方 API 文档（`https://smscloud.sbs/docx/#/`）显示：

- `GET /public/sms/orders/sync/{id}` 接口描述："查询当前短信订单**最新**验证码" —— 返回的是 latest-cached SMS，不是"流式 pop 下一条"
- `GET /public/sms/orders/resend/{id}` 接口描述："**请求上游平台继续接收下一条短信验证码**" —— 显式 advance 上游 channel 到下一条
- `GET /public/sms/orders` 列表响应字段 `canGetAnotherSms: boolean` —— 平台对单订单有最大接码次数限制

因此 v2.45.0 的复用路径有 bug：

1. 账号 A：takeOrder → orderNo X → OpenAI 发 OTP1 → smscloud 推 OTP1 给订单 X → sync 拿 OTP1 → 绑定 OK
2. 账号 B：cache hit 复用 orderNo X → OpenAI 发 OTP2 → **未调 resend，smscloud 上游 channel 仍指向 OTP1** → sync 拿到的还是 OTP1（latest cache 未更新） → OpenAI 验证 invalid_code → fail

线上未跑过真实双账号场景，bug 隐而未发。

## 2. 决定

- **D1**：cache hit (`acq.reused === true`) 时调用 `smscloud.resendSms(orderNo, apiKey, baseUrl)`，通知平台 advance 上游 channel；cache miss (`acq.reused === false`) 不调（新订单默认 ready）。
- **D2**：resend 失败 → `smscloudPool.markRejected(orderNo)` + `smscloudPool.releaseBinding(...)` + **在 smscloud branch 内部循环重 acquire**（`MAX_ACQUIRE_TRIES = 3`）。`acquirePhone` SQL `WHERE status='active'` 已自动跳过 markRejected 的 entry，下次 iteration 要么命中其他 active cache entry（继续 resend）要么 cache miss 走 takeOrder（`reused=false` 立即 break）。**不**返 `{}` 让外层 retry —— 因 `_finalizePhoneVerify:308-310` 在 `!phone && !lastReason` 时短路成 `phonePoolEmpty: true`，attempt 1 的 acquire 失败不进 attempt 2/3。改外层语义会影响 zhusms/local 路径，超 spec 范围。
- **D3**：不主动调 `/public/sms/orders` 查 `canGetAnotherSms` —— resend 失败作为隐式信号，YAGNI。
- **D4**：不引入 `finishOrder` 调用（仍 dead code）。
- **D5**：不动 `smscloud_phone_cache` schema。
- **D6**：不动 `protocol_phone_verify.py`（Python 仍按 sync poll，不感知 resend）。

## 3. 改动范围

### 3.1 `server/smscloud-provider.js` 加 `resendSms`

在现有 `cancelOrder` / `finishOrder` 风格之后追加：

```js
async function resendSms(orderNo, apiKey, baseUrl) {
  await _get(`${baseUrl || DEFAULT_BASE_URL}/public/sms/orders/resend/${orderNo}`, apiKey);
}
```

并加入 `module.exports`。错误透传（`_get` 抛 Error 已含 `_smscloudCode` 字段）。返 `undefined`（约定调用方只看是否抛错，data 为 `{}`）。

### 3.2 `protocol-engine.js _acquirePhoneForProtocol` smscloud branch

定位 `const acq = await smscloudPool.acquirePhone(...)` 调用点，包成 `MAX_ACQUIRE_TRIES = 3` 内部循环：

```js
const MAX_ACQUIRE_TRIES = 3;  // 内层循环上限：cache 中失败 entry 不死循环。reused=false 命中即 break，takeOrder 上限实际仍为 1/attempt
let acq = null;
for (let i = 0; i < MAX_ACQUIRE_TRIES; i++) {
  acq = await smscloudPool.acquirePhone(getRawDb(), email, max, EXPIRY_MS, excludePhones, takeOrderFn);
  if (!acq.reused) break;  // 新取号无需 resend，订单默认 ready
  try {
    await smscloud.resendSms(acq.orderNo, acq.apiKey, acq.baseUrl);
    console.log(`[protocol] smscloud resend SMS for orderNo=${acq.orderNo}`);
    break;
  } catch (e) {
    console.log(`[protocol] smscloud resend failed for ${acq.orderNo}: ${e?.message?.slice(0, 80)}, marking rejected`);
    smscloudPool.markRejected(getRawDb(), acq.orderNo);
    smscloudPool.releaseBinding(getRawDb(), acq.orderNo, email, acq.phone);
    try { save(); } catch {}
    acq = null;
    // 继续下一 iteration —— acquire SQL `WHERE status='active'` 已自动跳过 markRejected 的 entry
  }
}
if (!acq) {
  console.log(`[protocol] smscloud acquire exhausted after ${MAX_ACQUIRE_TRIES} tries`);
  return {};
}
try { save(); } catch {}
console.log(`[protocol] smscloud ${acq.reused ? '复用' : '新取'}号 ${acq.phone} (orderNo=${acq.orderNo}, bindings=${acq.bindings_used})`);
return { phone: acq.phone, smsConfig: { ... }, releaseFn: ..., meta: { ... } };
```

注：
- 现有 acquire 后的日志 `[protocol] smscloud ${acq.reused ? '复用' : '新取'}号 ...`（v2.45.0 line 228）保留位置不变，紧跟在循环 break 之后
- `_finalizePhoneVerify` 外层 retry loop 行为不变：smscloud branch 全 3 try 失败才返 `{}`，与 cache 完全空 / smscloud 服务不可用同语义
- markRejected 让该 cache entry `status='rejected'`，由 `smscloud-deferred-cancel` worker（v2.45.0 §3.5）兜底调 cancelOrder + 删 row
- excludePhones 不需要额外管理：rejected entry SQL 自动跳过

### 3.3 测试改动

#### `server/__tests__/smscloud-provider.test.js` 追加

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

#### `__tests__/protocol-engine-smscloud-cache.test.js` SC1 改造 + 新 SC3

**SC1 改造**：在现有 takeOrder mock 之外加 resendSms mock 计数：

```js
let takeOrderCalls = 0;
let resendCalls = [];
const origTake = smscloud.takeOrder;
const origResend = smscloud.resendSms;
smscloud.takeOrder = async () => { takeOrderCalls++; return { order_no: 'OO1', phone: '+15550001111', raw: {} }; };
smscloud.resendSms = async (orderNo) => { resendCalls.push(orderNo); };
try {
  // 账号 1 新取号
  const r1 = await engine._finalizePhoneVerify({}, { email: 'u1@x.com' });
  assert.ok(r1.tokens);
  // 账号 2 复用
  const r2 = await engine._finalizePhoneVerify({}, { email: 'u2@x.com' });
  assert.ok(r2.tokens);
  assert.strictEqual(takeOrderCalls, 1, 'takeOrder only called once (cache reused)');
  assert.deepStrictEqual(resendCalls, ['OO1'], 'resendSms called exactly once for account 2 reuse');
  // 现有 bindings_used = 2 断言保留
} finally {
  smscloud.takeOrder = origTake;
  smscloud.resendSms = origResend;
  ...
}
```

**新 SC3 用例**：resend 失败路径

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
      assert.strictEqual(resendCalls, 1, 'resend 调一次');
      // OO1 status='rejected'
      const rejected = rawDb.exec("SELECT order_no FROM smscloud_phone_cache WHERE status='rejected'");
      assert.deepStrictEqual(rejected[0].values.map(v => v[0]), ['OO1']);
      try { await require('../server/db').save?.flush?.(); } catch {}
    } finally {
      smscloud.takeOrder = origTake;
      smscloud.resendSms = origResend;
      protoMod.__setRunProtocolPhoneVerify(orig);
    }
  } finally { restoreCfg(); }
});
```

## 4. 不在范围

- 不动 `protocol_phone_verify.py`（Python sync poll 路径保留）
- 不动 deferred-cancel（rejected entry 由它兜底 cancelOrder + 删 row 不变）
- 不动 `smscloud_phone_cache` schema
- 不动 `acquirePhone` / `markRejected` / `releaseBinding` 等 smscloud-pool API
- 不主动调 `/public/sms/orders` 列表查 `canGetAnotherSms`
- 不引入 `finishOrder` 调用
- 不动 zhusms / local provider
- 不动 PipelineEngine（浏览器模式）

## 5. 风险 / 边界

- **R1（resend 计费）**：smscloud 文档未明确 resend 是否扣钻石。从字面 "请求上游平台继续接收下一条短信验证码" 看应不扣（仅 advance state），takeOrder 时已扣全订单费用。若实际扣费，"复用省钱"的前提仍部分成立（少 1 次 takeOrder + N 次 resend < N 次 takeOrder），整体仍优于 v2.44.x。本 spec 不保证。
- **R2（resend 与 OpenAI 发 OTP 时序）**：当前实现是 acquire 阶段（OpenAI add-phone 调用前）调 resend。OpenAI 在我们 spawn Python `protocol_phone_verify.py` 后才发 POST `/api/accounts/add-phone/send` 触发 SMS。所以顺序是：resend → spawn Python → Python POST add-phone/send → OpenAI 推 OTP → smscloud 上游 channel 收 OTP → Python poll sync 拿新 OTP。时序正确。
- **R3（resend 失败语义模糊）**：失败原因可能是 (a) 平台限流 (b) order 已过期 (c) `canGetAnotherSms=false` (d) 网络。一律 markRejected 是保守策略 —— 即使是临时 (d)，下次同账号 retry attempt 重 acquire 拿新号，本号不再复用。**轻微浪费**：临时网络抖动会让一个本可用号被永久 mark rejected。可接受。
- **R4（excludePhones 未含 rejected 号）**：spec §3.2 已分析 —— markRejected 让 acquire SQL `WHERE status='active'` 自动跳过，excludePhones 不需重复屏蔽，外层 retry loop 行为正确。
- **R5（同 attempt 内 resend 失败 → 内层 retry 又 acquire 同 entry？）**：不会。resend 失败前 markRejected，下一 iteration acquire SQL `WHERE status='active'` 已跳过该 entry；即使刚 markRejected 还没 save() 落盘到 cache，同进程内查 `getRawDb()` 看到的是 in-memory 状态，已 mark。
- **R6（v2.45.0 测试 SC1 现有 assertion bindings_used=2 不冲突）**：本 spec 仅给 resend mock 加计数，SC1 现有 `account 1 success` / `account 2 success` / `takeOrderCalls=1` / `bindings_used=2` 全部保留。
- **R7（内层循环上限 + cache 全 rejected 极端场景）**：`MAX_ACQUIRE_TRIES = 3` 防止 cache 多失败 entry 死循环。reused=false 立即 break，所以 takeOrder 实际仍为 1 次 / 外层 attempt。极端场景：smscloud 平台 IP/account-wide 限流让所有 active entry resend 都失败，内层 3 次会快速消耗 3 个 entry + 3 次 markRejected，但当 cache 内 active entry 用完，下一 iteration acquire 自然走 takeOrder 路径拿新号（reused=false break）。优雅降级。

## 6. 验收

- 跑 smscloud 配置下连续激活 2 个账号：
  - 第 1 个日志 `smscloud 新取号 +XXX`，**无** `smscloud resend SMS` 行
  - 第 2 个日志含 `smscloud resend SMS for orderNo=YYY` 紧跟 `smscloud 复用号 +XXX`，OpenAI 验证通过（不再 invalid_code）
- 模拟 `canGetAnotherSms=false` 的账号触发：日志含 `smscloud resend failed ... marking rejected`，下个 attempt 拿新号成功
- `npm test` 新增 2 个 smscloud-provider 单测 + 1 个 protocol-engine 集成 + SC1 改造全绿，无回归
