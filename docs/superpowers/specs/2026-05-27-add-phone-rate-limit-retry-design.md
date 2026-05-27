# Add-Phone rate-limit / fraud / VoIP 自动换号 retry + smscloud 延迟 cancel 设计

> 日期：2026-05-27
> 作用域：协议模式 `_finalizePhoneVerify` retry 行为修正 + smscloud cancelOrder <2 分钟限制兜底

## 1. 背景

v2.40.4 把 protocol 模式 add-phone 的三种"号在 OpenAI 那边被 flag"结果归到 `block-and-saturate` 分支：
- `rate-limited`（OpenAI 返 `rate_limit_exceeded`，"You've made too many phone verification requests"）
- `fraud-blocked`（OpenAI 返 `fraud_guard` 类，"phone numbers similar to yours suspicious"）
- `voip-blocked`（OpenAI 返 `voip_phone_disallowed`）

当时的判断（写在 `protocol_phone_verify.py:32` 注释和 `protocol-engine.js:299-302` 注释里）是"换号也拒，立刻 break + markSaturated"。

线上反例（2026-05-26 19:40 protocol 日志）：
```
[protocol] add-phone (attempt 1/3): +601168242536 (provider=smscloud)
verify: phone-start status=400 body={"error":{"message":"You've made too many phone verification requests..."}}
[protocol] block-and-saturate rate-limited for +601168242536: rate_limit_exceeded
[protocol] smscloud cancelOrder failed: 取消号码需要在下单 2 分钟后操作
[1/1] add-phone failed: rate-limited, status=phone_verify_fail
```

观察到两个独立问题：

**Bug A — retry 短路**：日志显示 `attempt 1/3` 但 attempt 2/3 永远不会出现。`_finalizePhoneVerify` rate-limited 分支末尾是 `return { phoneVerifyFail }`，而隔壁 `phone-rejected` 分支是 `continue`。账号被这一个号毁掉。

**Bug B — smscloud cancel 失效**：smscloud 平台要求"下单 ≥2 分钟"才允许 cancel。OpenAI 限流在 phone-start 阶段秒级返回 400，cancelOrder 必然 < 2 分钟，永远失败 → 号订单不会释放，平台端要么 timeout 自动 expire，要么继续扣费。

## 2. 决定

- **Decision-1**：rate-limited / fraud-blocked / voip-blocked 三种 status 均走 retry，不再一次性 fail。逻辑等同 `phone-rejected`：accumulate triedPhones（已有 `triedPhones.push(phone)` at `protocol-engine.js:280`，无需重复）+ `continue`。
- **Decision-2**：retry 无 cooldown，不切 provider。3 次 attempt 全 rate-limited 才落 `phoneVerifyFail`，最终状态保持 `phone_verify_fail`（不新增 status code）。
- **Decision-3**：smscloud cancelOrder 检测"2 分钟"错误时不抛错，转入 module-level deferred-cancel queue，后台 worker 在下单 ≥125s 后重试 cancel。
- **Decision-4**：deferred-cancel queue 是 in-memory + fire-and-forget，进程重启丢失视为可接受损失（smscloud 平台侧最终也会 timeout 释放订单）。
- **Decision-5**：local provider 的 `markPhoneSaturated` 仍保留 —— rate-limited 号在 attempt 内 release + 加入持久黑名单，避免后续账号再选到。

## 3. 改动范围

### 3.1 `protocol-engine.js` `_finalizePhoneVerify`（核心修复）

`protocol-engine.js:298-316` rate-limited / fraud-blocked / voip-blocked 分支：

- 现有逻辑保留：日志 `block-and-saturate`、`provider === 'local'` 走 `markPhoneSaturated`、否则走 `releaseFn`、`save()`。
- **末尾的 `return { phoneVerifyFail: result.status }` 改成 `lastReason = result.status; continue;`**。
- attempt loop 自然结束（i.e. `MAX_ATTEMPTS` 全失败）后，`return { phoneVerifyFail: 'all-phones-rejected' }`（line 330 现有）已能正确兜底；但为了让日志有意义，把 line 330 改成 `return { phoneVerifyFail: lastReason || 'all-phones-rejected' }`，使最终 status 反映最后一次的真实原因（rate-limited / fraud-blocked / voip-blocked / phone-rejected-by-openai）。

无需改 `triedPhones.push`（已在 line 280 acquire 后立刻 push）。无需改 `_acquirePhoneForProtocol` 签名 / 调用方。

### 3.2 `server/smscloud-deferred-cancel.js`（新文件）

模块导出：
- `enqueue({ apiKey, baseUrl, orderNo, takenAtMs })` —— 加入 in-memory `Map<orderNo, entry>`，去重
- `_tickOnce()` —— 单次扫描尝试 cancel 到期项（`Date.now() >= takenAtMs + 125_000`），失败重试上限 3，超限丢弃 + warn 日志
- `start()` / `stop()` —— 启动/停止 `setInterval`（30s）；模块加载时不自动 start，由 `server/index.js` 显式调（与现有 logger / db 启动顺序一致）
- `_queueForTest()` —— 测试用，导出 Map 引用

`stop()` 清掉 timer 即可，不 flush 残余（fire-and-forget 设计）。

### 3.3 `server/smscloud-provider.js` `cancelOrder` 改造

`cancelOrder(orderNo, apiKey, baseUrl)` 当前直接 `await _get(...)`，错误从 `_get` 内部抛 `Error(j.message)`。

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

调用方（`protocol-engine.js` `_acquirePhoneForProtocol` smscloud branch 的 `releaseFn` 闭包）感知 `deferred === true` 时调 `smscloudDeferredCancel.enqueue({ apiKey, baseUrl, orderNo, takenAtMs })`。

`takenAtMs` 在 `_acquirePhoneForProtocol` smscloud branch 取号成功后立即 `Date.now()` 捕获，闭包持有。

### 3.4 `server/index.js` 启动 deferred-cancel worker

在 db / logger 初始化之后、HTTP 监听之前调 `smscloudDeferredCancel.start()`；SIGINT/SIGTERM 处理（v2.30）追加一行 `smscloudDeferredCancel.stop()`，在 save.flush 之前。

### 3.5 测试

#### `server/__tests__/smscloud-deferred-cancel.test.js`（新）

用 `node --test` + fake clock（`MockTimers`）：
- enqueue 一条 `takenAtMs = now`，stub `smscloudProvider.cancelOrder` 计数；`_tickOnce` 立即调用 → 不触发 cancel（未到 125s）；advance timer 130s → 触发 cancel 1 次；queue 清空。
- enqueue 一条 `takenAtMs = now - 200_000`（已超时），stub cancelOrder 抛错；连续 3 次 `_tickOnce` 后 entry 从 queue 删除，cancel 调用 3 次。
- 同 orderNo 重复 enqueue 不重复入队（去重）。

#### `server/__tests__/smscloud-provider.test.js`（已存在，追加用例）

- mock `_get` 抛 `Error('取消号码需要在下单 2 分钟后操作')` → cancelOrder 不抛错，返 `{ ok: false, deferred: true, reason }`。
- mock `_get` 抛 `Error('order not found')` → cancelOrder 透传抛错。
- mock `_get` resolve → cancelOrder 返 `{ ok: true }`。

#### `__tests__/protocol-engine-add-phone-retry.test.js`（新）

由于 `_finalizePhoneVerify` 依赖大量协作者，用最小 stub：
- 构造 `engine = new ProtocolEngine()`，monkey-patch `engine._acquirePhoneForProtocol` 顺序返 `[{phone:'+A',releaseFn:noop}, {phone:'+B',releaseFn:noop}, {phone:'+C',releaseFn:noop}]`。
- monkey-patch `runProtocolPhoneVerify` 顺序返 `[{status:'rate-limited'}, {status:'fraud-blocked'}, {status:'ok',tokens:{...}}]`。
- 断言 attempt 3 拿到 success，最终 `result.tokens` 非空；patch 的 acquire 收到的 excludePhones 第 2 次含 `+A`、第 3 次含 `+A, +B`。
- 另一个用例：3 次全 rate-limited → final `{ phoneVerifyFail: 'rate-limited' }`（来自 `lastReason`）。

## 4. 不在范围

- 不动 `protocol_phone_verify.py`（status 字段命名 / detail 字段）—— `rate-limited` / `fraud-blocked` / `voip-blocked` 串名保持不变。
- 不动 zhusms cancelOrder（zhusms 不消耗余额，无 < 2 分钟限制）。
- 不动 `MAX_ATTEMPTS = 3`，不引入 cooldown sleep。
- 不动 web UI（status code 不变）。
- 不动 PipelineEngine（浏览器模式 add-phone 走 `payment.js` SMS step，不经 `_finalizePhoneVerify`）。
- 不持久化 deferred-cancel queue（v2.30 优雅退出会清掉 timer，进程死透订单丢给 smscloud 端自然 timeout）。

## 5. 风险 / 边界

- **风险 R1**：fraud-blocked 在某些场景确实是号本身被永久 flag（如复用 VoIP），retry 同 provider 拿到的号若都来自同前缀 / 同 carrier 可能 3 attempts 全 fail，浪费 smscloud 余额（每 attempt 1 个号）。
  - 缓解：MAX_ATTEMPTS = 3 是当前已有上限，不放大；deferred-cancel 兜底费用回收。如果生产端发现 fraud-blocked 同前缀连失，再单开一票考虑 `_acquirePhoneForProtocol` 切 country / serviceCode。
- **风险 R2**：deferred-cancel queue 在进程意外死亡时丢失 entry → smscloud 订单未主动 cancel，平台端 timeout 自动 expire（具体扣费规则取决于 smscloud 平台政策；不在本 spec 范围内验证）。
- **风险 R3**：worker interval 30s + 125s 触发阈值意味着平均额外延迟 ~30s 之后才完成 cancel；与 retry 本身无关，账号流水线不受阻塞。

## 6. 验收

- 协议模式跑一个之前 rate-limited 直接 fail 的账号，日志出现 `attempt 2/3 (...)` / `attempt 3/3 (...)` 且最终拿到 plus token / 或落 `phone_verify_fail` 但 attempt 跑满。
- `npm test` 包含 3 个新测试用例全绿。
- smscloud 跑一次 rate-limited，看 server 日志出现 `smscloud-deferred-cancel: enqueued orderNo=...`；2-3 分钟后看到 `smscloud-deferred-cancel: cancelled orderNo=... ok`。
