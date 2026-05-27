# smscloud 一号多绑号缓存设计

> 日期：2026-05-27
> 作用域：协议模式 smscloud provider 在 add-phone 取号时复用未过期 + 未满 maxBindingsPerPhone 的号，节省接码方余额

## 1. 背景

当前 `protocol-engine.js _acquirePhoneForProtocol` 的 smscloud branch（line 207-241）每次 add-phone 都调一次 `smscloud-provider.takeOrder` 取新号，单号 cost 一次。

smscloud 平台行为（用户已验证）：takeOrder 拿到的号在 **20 分钟内**可通过同一 `orderNo` 持续 poll 不同 SMS code（与 zhusms 类似）。这意味着同一号可以绑定多个 OpenAI 账号 —— 每个账号 add-phone 会触发 OpenAI 端新发 OTP，smscloud 端 poll 同 orderNo 拿到该次 OTP，复用号不需要二次 takeOrder。

local provider 已有"一号多绑"逻辑：`server/phone-pool.js#acquirePhone` 配合 `cfg.phonePool.maxBindingsPerPhone`，按 `bindings_used < max` 选号，FIFO 轮转 + 跨账号排除 + 持久 `phone_bindings` 表。

本 spec 把同一模式落到 smscloud：取号后写入持久缓存，下次 acquire 优先复用未过期 + 未满 max + 未与本 email 绑过的号。

## 2. 决定

- **D1**：新建 SQLite 表 `smscloud_phone_cache`（独立 schema，不扩展 `phone_pool`）；email 绑定追踪**复用**现有 `phone_bindings` 表。
- **D2**：号有效期 `EXPIRY_MS = 18 * 60 * 1000`（20min 平台限制 - 2min 安全 buffer）。过期 entry 由 worker 异步清理。
- **D3**：`maxBindingsPerPhone` 复用现有 `cfg.phonePool.maxBindingsPerPhone` 配置项，不引入新字段。
- **D4**：fail 状态到 cache 操作的映射 —— 与 local provider 行为对齐（详见 §3.4）。
- **D5**：成功复用 cache 号时**不调 smscloud-provider.takeOrder**（节省余额）；仅在 cache miss 时 takeOrder。
- **D6**：cache entry 进入 `status='rejected'`（OpenAI saturate）时，**触发** smscloud cancelOrder（含 v2.44.1 的 deferred-cancel 兜底）；其他场景（过期、bindings 满）不主动 cancelOrder —— 平台端 20min 后自然 timeout。
- **D7**：过期清理 + cache 维护逻辑由 `server/smscloud-deferred-cancel.js` worker tick（30s 周期）顺带跑，不新增独立 worker。
- **D8**：Web UI（号池 / 黑名单 tab）展示 smscloud cache **不在本 spec scope**。

## 3. 改动范围

### 3.1 数据模型（`server/db.js`）

`initDB` 的 CREATE TABLE 区追加：

```sql
CREATE TABLE IF NOT EXISTS smscloud_phone_cache (
  order_no       TEXT PRIMARY KEY,
  phone          TEXT NOT NULL,
  api_key        TEXT NOT NULL,
  base_url       TEXT NOT NULL,
  taken_at_ms    INTEGER NOT NULL,
  bindings_used  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active'  -- 'active' | 'rejected'
);
CREATE INDEX IF NOT EXISTS idx_smscloud_phone_cache_phone ON smscloud_phone_cache(phone);
CREATE INDEX IF NOT EXISTS idx_smscloud_phone_cache_active ON smscloud_phone_cache(status, taken_at_ms);
```

`api_key` / `base_url` 落库是为了 cache entry 自描述 —— `smscloud-deferred-cancel` 跑 cancelOrder 时直接用 entry 字段，不依赖运行时 cfg。

### 3.2 新模块 `server/smscloud-pool.js`

参考 `server/phone-pool.js` 的 SQL-first 风格，导出：

- `acquirePhone(db, email, maxBindingsPerPhone, expiryMs, excludePhones, takeOrderFn) -> Promise<{ phone, orderNo, apiKey, baseUrl, taken_at_ms, reused }>`
  - 先 SQL 查可复用 entry：`SELECT * FROM smscloud_phone_cache WHERE status='active' AND taken_at_ms + ? > ? AND bindings_used < ? AND phone NOT IN (SELECT phone FROM phone_bindings WHERE email=?) AND phone NOT IN (excludePhones) ORDER BY bindings_used ASC, taken_at_ms ASC LIMIT 1`
  - 命中 → 写 `phone_bindings (phone, email)` + `UPDATE smscloud_phone_cache SET bindings_used = bindings_used + 1 WHERE order_no = ?` + 返 `{ ..., reused: true }`
  - 未命中 → `await takeOrderFn()` 拿新 order → `INSERT INTO smscloud_phone_cache (...)` + 写 binding + 返 `{ ..., reused: false }`
  - takeOrderFn 失败抛错：直接抛给调用方（与现 smscloud branch 行为一致）

- `markRejected(db, orderNo)` —— `UPDATE smscloud_phone_cache SET status='rejected' WHERE order_no=?`

- `releaseBinding(db, orderNo, email, phone)` —— 按 **`order_no`** 精确减 cache 计数避免误伤：`DELETE FROM phone_bindings WHERE phone=? AND email=?` + `UPDATE smscloud_phone_cache SET bindings_used = MAX(0, bindings_used - 1) WHERE order_no=?`。传 phone 是为了删 binding；传 orderNo 是为了精确 UPDATE 当前 cache entry（避免同 phone 跨多个 order_no 时多减）。

- `expireOldEntries(db, expiryMs) -> { expired: number }` —— 删除 `taken_at_ms + expiryMs < now` **且 status='active'** 的 entry。status='rejected' 的不在此清理范围（由 deferred-cancel 完成 cancelOrder 后再删，§3.5）。返回计数供日志。

- `listCache(db)` —— 供 Web UI 未来使用，本 spec 实现但不接 UI。

`phone_bindings` 表的 cascade：本模块不删 `phone_bindings`（保持历史绑定记录），与 phone-pool 一致。

### 3.3 `protocol-engine.js _acquirePhoneForProtocol` smscloud branch 改造

把 line 207-241 整段 try 块改为调 `smscloud-pool.acquirePhone`：

```js
if (provider === 'smscloud') {
  const s = cfg.phonePool.smscloud || {};
  if (!s.apiKey || !s.serviceCode || !s.countryCode) { /* 同现有 incomplete 日志 */ return {}; }
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
    save();
    console.log(`[protocol] smscloud ${acq.reused ? '复用' : '新取'}号 ${acq.phone} (orderNo=${acq.orderNo}, bindings=${acq.bindings_used})`);
    return {
      phone: acq.phone,
      smsConfig: { provider: 'smscloud', order_no: acq.orderNo, api_key: acq.apiKey, base_url: acq.baseUrl },
      releaseFn: async () => { /* see §3.4 */ }
    };
  } catch (e) {
    console.log(`[protocol] smscloud acquire failed: ${e?.message?.slice(0, 60)}`);
    return {};
  }
}
```

注：`_acquirePhoneForProtocol` 现有签名 `(provider, cfg, email, proxyUrl, excludePhones = [])` —— 直接用 `email` 和 `excludePhones`，无需扩参。

### 3.4 `_finalizePhoneVerify` fail 分支映射

`protocol-engine.js:287-327` 现有四类分支与新 cache 行为映射：

| result.status | local（v2.44.1） | smscloud cache（本版） | 实现位置 |
|---|---|---|---|
| `ok` | binding 永久保留 | 同 —— `phone_bindings` 保留，bindings_used 不撤 | `_finalizePhoneVerify` ok 分支无需改 |
| `phone-rejected` | `releaseFn()`（local releaseBinding）+ `lastReason='phone-rejected-by-openai'; continue;` | `releaseFn` 调 `smscloudPool.releaseBinding`（撤本次 binding，cache entry 仍 active 给其他账号尝试）；excludePhones 屏蔽本 session | `smscloud branch releaseFn` |
| `rate-limited` / `fraud-blocked` / `voip-blocked` | `markPhoneSaturated` + `lastReason=result.status; continue;` | `smscloudPool.markRejected(orderNo)` + 让 `deferred-cancel.enqueue` 处理 cancelOrder（含 <2min 兜底） | `_finalizePhoneVerify` saturate 分支 smscloud 子路径 |
| `sms-timeout` / `validate-error` / `submit-error` | `releaseFn()` + `return { phoneVerifyFail: status }`（不 retry） | `releaseFn` 调 `smscloudPool.releaseBinding`，cache entry 仍 active | 同 phone-rejected |
| `post-validate-error` | binding 保留 | 同 —— 不动 cache | 现有行为 |

具体改动：
- `releaseFn` 闭包内默认调 `smscloudPool.releaseBinding(getRawDb(), phone, email)`（撤本次 binding，不撤 cache entry 本身）
- `_finalizePhoneVerify` rate-limited/fraud/voip 的 `else` 分支（line 310-314）改成：
  - 调 `smscloudPool.markRejected(getRawDb(), orderNo)` 标记 cache rejected
  - 调 `smscloudDeferredCancel.enqueue({ apiKey, baseUrl, orderNo, takenAtMs })` 让平台订单被 cancel（v2.44.1 已就位）
  - 不再调 `releaseFn`（因为 saturate 语义跟 release-binding 不同：binding 应该保留作为"该号被该账号试过"的记录，避免 retry session 内同账号又被分到同号）

为了让 `_finalizePhoneVerify` saturate 分支拿到 `orderNo / apiKey / baseUrl / takenAtMs` 调 markRejected + deferred-cancel.enqueue，`_acquirePhoneForProtocol` smscloud branch 的返回对象在现有 `{ phone, smsConfig, releaseFn }` 之外**显式新增 `meta` 字段**：

```js
return {
  phone, smsConfig, releaseFn,
  meta: { provider: 'smscloud', orderNo: acq.orderNo, apiKey: acq.apiKey, baseUrl: acq.baseUrl, takenAtMs: acq.taken_at_ms },
};
```

`_finalizePhoneVerify` 的 acquire 解构改为 `const { phone, smsConfig, releaseFn, meta } = acq;`。zhusms / local branch 返 `meta: undefined`，saturate 分支只在 `meta?.provider === 'smscloud'` 时走新路径，其他 provider 走原 markPhoneSaturated / cancelOrder 路径不变。

### 3.5 `server/smscloud-deferred-cancel.js` 扩展

`_tickOnce` 末尾新增两步：

1. `await smscloudPool.expireOldEntries(rawDb, EXPIRY_MS)` —— 清理过期 active entry
2. 扫描 `smscloud_phone_cache` 中 `status='rejected'` 的 entry，对每条调 `smscloud.cancelOrder` —— 若返 `{ deferred: true }`，落进 deferred queue；成功 cancel 则 `DELETE FROM smscloud_phone_cache WHERE order_no=?`

为了让 worker 拿到 db handle，`smscloud-deferred-cancel.start()` 改为 `start(getDb)` —— `server/index.js` wire 时 `start(() => require('./db').getRawDb())`。模块内 `_tickOnce` 通过 `getDb()` 获取最新 db 引用（避免循环依赖）。

### 3.6 测试

#### `server/__tests__/smscloud-pool.test.js`（新）

- `acquirePhone` cache miss：mock takeOrderFn 返新号，断言写入 cache + binding，return `reused: false`
- `acquirePhone` cache hit：先注入一个 active entry，acquire 不调 takeOrderFn，return `reused: true`，bindings_used += 1
- `acquirePhone` 满 max 跳过：注入 `bindings_used = max` 的 entry，acquire 必然 takeOrderFn 拿新号
- `acquirePhone` 过期跳过：注入 `taken_at_ms = now - 20min` 的 entry，acquire 必然 takeOrderFn 拿新号
- `acquirePhone` 同 email 跳过：注入 entry + 已 bind 该 email，acquire 必然 takeOrderFn 拿新号
- `acquirePhone` excludePhones 跳过：注入 entry，excludePhones 含该 phone → takeOrderFn 拿新号
- `markRejected`：注入 active entry，调 markRejected → 再次 acquire 跳过
- `releaseBinding`：注入 entry + binding，调 releaseBinding，断言 binding 删除 + bindings_used -= 1
- `expireOldEntries`：注入 2 active + 1 已过期，调 expire 后只剩 1 行

#### `__tests__/protocol-engine-smscloud-cache.test.js`（新，集成）

- 用 monkey-patch `_acquirePhoneForProtocol` 的 takeOrder 模拟 smscloud 平台；跑两次 `_finalizePhoneVerify`（不同 account.email），断言第二次 acquire `reused: true`，takeOrder 只调一次
- saturate 路径：第一次 attempt 返 `rate-limited` → 断言 cache entry status='rejected' + deferred-cancel queue 有该 orderNo

#### `server/__tests__/smscloud-deferred-cancel.test.js`（追加）

- `_tickOnce` 现在还会清理过期 entry 和 cancel rejected entry：用 fake clock + db mock 注入 entries，断言 tick 后状态正确

## 4. 不在范围

- 不动 local provider acquire 路径（`phone-pool.acquirePhone` 不变）。
- 不动 zhusms provider（zhusms 也是一号多接码，但当前实现已每次 takeOrder 拿同号付费一次 —— 改 zhusms 是另一票）。
- 不动 Web UI（号池 / 黑名单 tab 不展示 smscloud cache）。
- 不引入新 config 字段（不加 `phonePool.smscloud.maxBindings`，复用 `phonePool.maxBindingsPerPhone`）。
- 不动 `protocol_phone_verify.py`（Python 侧仍按 `smsConfig.order_no` poll，不感知 cache）。
- 不动 PipelineEngine（浏览器模式不走 smscloud）。

## 5. 风险 / 边界

- **R1（一致性）**：sql.js (WASM) 单线程，server 内 acquire 三步（SELECT + INSERT binding + UPDATE bindings_used）走 JS event loop 顺序执行，不会真并发竞争。多账号同时 add-phone 会被 `/api/execute` 路由 queue 化处理，无问题。
- **R2（边界过期）**：18min buffer 应付绝大多数场景（一次 add-phone 平均 30s）。若用户开极慢账号或 SMS poll maxAttempts 调大，可能 acquire 时还 active、verify 完成时已过 20min；smscloud 端 poll 返 timeout、本地视为 `sms-timeout` 走 releaseBinding —— 不破坏 cache 完整性，下次 expireOldEntries 兜底删 entry。
- **R3（rejected entry 残留）**：`status='rejected'` entry 由 `_tickOnce` 调 cancelOrder 后删除。若 cancelOrder 持续失败（>3 deferred 重试），entry 永久留库。可接受 —— 占库微小，不影响 acquire（status filter）。可加未来 cleanup job，本 spec 不做。
- **R4（v2.44.1 deferred-cancel 接口微变）**：`start()` 改 `start(getDb)`，`_tickOnce` 多两步逻辑。需同步改 `server/index.js` wire-up 和现有测试用例（注入 noop getDb）。
- **R5（cache 跨进程重启）**：持久化在 SQLite，重启后未过期号继续可用 —— 这是设计目标。
- **R6（同号跨 order_no）**：理论上 smscloud 平台可能在不同时刻把同号分配给不同 orderNo。本表 PK 是 order_no，phone 可重复出现多行（不同 order_no, 不同 taken_at_ms）。`acquirePhone` 的 phone NOT IN binding 子句对同 email 还是会跳过 —— 行为正确。

## 6. 验收

- 跑同一 smscloud 配置下连续激活 2 个账号，日志：第 1 个出现"smscloud 新取号 +XXX (orderNo=Y, bindings=1)"，第 2 个出现"smscloud 复用号 +XXX (orderNo=Y, bindings=2)"，smscloud 余额仅扣 1 次。
- 跑同账号触发 rate-limited，cache entry status 变 rejected，下个账号 acquire 跳过该号 takeOrder 新号；deferred-cancel queue 含该 orderNo 待 cancel。
- `npm test` 新增 smscloud-pool 单测 9 项 + 集成测试 2 项 + deferred-cancel 追加测试全绿。
- 进程重启后未过期号仍能命中 cache 复用。
