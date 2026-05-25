# v2.39.0 — zhusms 远程接码 Provider 接入设计

## 1. 背景

v2.37.0 Phase 1 + v2.38.0 Phase 2a 完成了**本地号池**架构：
- DB 表 `phone_pool` + `phone_bindings` 存死号 (phone + sms_api_url)
- 用户手工 import 号 + 对应的 SMS 接收 URL
- Phase 2a 浏览器 PKCE add_phone 流程消费本地号池

实测发现本地号池有运营痛点：
- 号要自己买 + 维护 sms_api_url
- 单号收不到 SMS（如 v2.38.0 测试 TaraReeves 走 `+17738279280` 90s 超时）就消耗 binding 名额
- 没有"号池负载均衡 / 健康检查"概念

`https://zhusms.com` 是一个**远程接码服务**，提供卡密（card key）模式：
- 用户买卡密 → 用卡密 activate 拿 session
- 按需 take 号 → 服务端自动 round-robin 分配可用号
- 用 order_no 轮询 SMS → 拿到验证码
- 失败可 cancel 释放（不扣余额名额）
- **一卡多次**（每次 take 扣 1 / 余额留在卡密上）

用户的卡密：`ZS-V8VXJSDP`（service 类目 `codex` 用于 OpenAI 场景）。

## 2. 目标

新增 zhusms 远程 provider，**并列**于本地号池（用户选其一）：
- `config.phonePool.provider = 'local' | 'zhusms'`（default `local`，向后兼容）
- v2.37/v2.38 本地号池所有代码 / DB / UI / route 一行不动
- 新模块 `server/zhusms-provider.js` 包装 zhusms 4 个 endpoint（activate/take/poll/cancel）+ 1 个余额查询
- utils.js add_phone 分支按 provider 分流
- Config UI 加 provider 单选 + zhusms 配置块（卡密 / service / baseUrl + 测试余额按钮）

## 3. 方案

### 3.1 Config schema 扩展

打开 `config.example.json` 找 `phonePool` 块，加 `provider` 字段 + `zhusms` 子块：

```json
{
  "phonePool": {
    "enabled": true,
    "provider": "local",
    "maxBindingsPerPhone": 5,
    "smsPollIntervalMs": 3000,
    "smsMaxAttempts": 30,
    "zhusms": {
      "cardKey": "",
      "service": "codex",
      "baseUrl": "https://zhusms.com"
    }
  }
}
```

**向后兼容**：旧 config.json 没 `provider` 字段时，utils.js 走 `cfg.phonePool.provider || 'local'` fallback。Phase 1 行为零变化。

### 3.2 新模块 `server/zhusms-provider.js`

基于 zhusms OpenAPI spec（https://zhusms.com/openapi.json）。完整 endpoint 表：

| 用途 | Method | Path | Body / Query | Response |
|---|---|---|---|---|
| 激活卡密 | POST | /api/guest/activate | form `code=<cardKey>` | Set-Cookie session |
| 取号下单 | POST | /api/order/take | form `service=<service>` | JSON `{order_no, phone, ...}` |
| 订单状态/接码 | GET | /api/order/status | query `order_no=<no>` | JSON 含 sms code (字段名实测确认) |
| 取消订单 | POST | /api/order/cancel | form `order_no=<no>` | JSON `{ok:true}` |
| 查余额 | GET | /api/guest/me | — | JSON 含 quota / balance |

**Session cookie**：guest 模式用 session（Cookie header），不是 token。Node fetch 默认不带 cookies → 手动从 Set-Cookie 提取 + 后续请求带 `Cookie:` header。

模块结构：

```js
// server/zhusms-provider.js
const sessions = new Map()  // baseUrl → { cookie, activatedAt }

async function ensureSession(cardKey, baseUrl, proxyUrl) {
  if (sessions.has(baseUrl) && Date.now() - sessions.get(baseUrl).activatedAt < 3600_000) {
    return sessions.get(baseUrl).cookie
  }
  // POST /api/guest/activate form code=<cardKey>
  // 解析 Set-Cookie 头 → 缓存
}

async function takeOrder(cardKey, baseUrl, service, proxyUrl) {
  let cookie = await ensureSession(cardKey, baseUrl, proxyUrl)
  let resp = await postForm(`${baseUrl}/api/order/take`, { service }, { cookie, proxyUrl })
  if (resp.status === 401 || resp.status === 403) {
    // session 过期 → 清缓存重试
    sessions.delete(baseUrl)
    cookie = await ensureSession(cardKey, baseUrl, proxyUrl)
    resp = await postForm(`${baseUrl}/api/order/take`, { service }, { cookie, proxyUrl })
  }
  const data = await resp.json()
  if (!data?.order_no || !data?.phone) return null  // 余额 0 / 服务异常
  return { order_no: data.order_no, phone: data.phone }
}

async function pollOrderSms(orderNo, baseUrl, { pollIntervalMs, maxAttempts, signal, proxyUrl }) {
  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) {
      const e = new Error('aborted'); e.name = 'AbortError'; throw e
    }
    try {
      const resp = await fetch(`${baseUrl}/api/order/status?order_no=${encodeURIComponent(orderNo)}`,
        { agent: proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined, signal })
      if (resp.ok) {
        const data = await resp.json()
        // sms code 字段：实测可能是 data.sms / data.code / data.body
        // regex tolerant: 任何字段含 6 位数字均提取
        const text = JSON.stringify(data)
        const m = text.match(/\b(\d{6})\b/)
        if (m) return m[1]
      }
    } catch (e) {
      if (e?.name === 'AbortError') throw e
    }
    if (i < maxAttempts - 1) await new Promise(r => setTimeout(r, pollIntervalMs))
  }
  throw new Error('sms-poll-timeout')
}

async function cancelOrder(orderNo, baseUrl, cardKey, proxyUrl) {
  try {
    const cookie = await ensureSession(cardKey, baseUrl, proxyUrl)
    await postForm(`${baseUrl}/api/order/cancel`, { order_no: orderNo }, { cookie, proxyUrl })
  } catch {}  // 释放失败不影响主流程
}

async function getBalance(cardKey, baseUrl, proxyUrl) {
  const cookie = await ensureSession(cardKey, baseUrl, proxyUrl)
  const resp = await fetch(`${baseUrl}/api/guest/me`, {
    headers: { Cookie: cookie },
    agent: proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined,
  })
  return await resp.json()
}

module.exports = { takeOrder, pollOrderSms, cancelOrder, getBalance, __resetForTest: () => sessions.clear() }
```

`postForm` 是个小 helper 包装 `URLSearchParams` body + Cookie header + agent。

### 3.3 `utils.js:fetchTokensViaPKCE` add_phone 分支 provider 分流

替换 v2.38.0 add_phone 块为 provider 分流版（伪代码）：

```js
if (await isAddPhonePage(page)) {
  const cfg = readConfig()
  if (!cfg?.phonePool?.enabled) return { needsPhone: true }
  
  const provider = cfg.phonePool.provider || 'local'
  let proxyUrl = null
  try {
    const st = require('./server/proxy').getState?.()
    if (st?.enabled) proxyUrl = 'http://127.0.0.1:7890'
  } catch {}
  
  // 取号 + 准备 SMS 拉取闭包
  let phone, smsCodeFn, releaseFn
  
  if (provider === 'zhusms') {
    const zhusms = require('./server/zhusms-provider')
    const z = cfg.phonePool.zhusms
    try {
      const order = await zhusms.takeOrder(z.cardKey, z.baseUrl, z.service, proxyUrl)
      if (!order) return { phonePoolEmpty: true }  // 余额 0 / 服务异常
      phone = order.phone
      smsCodeFn = () => zhusms.pollOrderSms(order.order_no, z.baseUrl, {
        pollIntervalMs: cfg.phonePool.smsPollIntervalMs || 3000,
        maxAttempts: cfg.phonePool.smsMaxAttempts || 30,
        proxyUrl,
      })
      releaseFn = () => zhusms.cancelOrder(order.order_no, z.baseUrl, z.cardKey, proxyUrl)
    } catch (e) {
      console.log(`  [PKCE] zhusms take failed: ${e?.message?.slice(0, 60)}`)
      return { phoneVerifyFail: 'zhusms-take-fail' }
    }
  } else {
    // 既有 local 逻辑（v2.38.0）
    const phonePool = require('./server/phone-pool')
    const { getRawDb } = require('./server/db')
    const allotted = phonePool.acquirePhone(getRawDb(), account.email, cfg.phonePool.maxBindingsPerPhone || 5)
    if (!allotted) return { phonePoolEmpty: true }
    phone = allotted.phone
    smsCodeFn = () => phonePool.fetchSmsCode(allotted.smsApiUrl, {
      pollIntervalMs: cfg.phonePool.smsPollIntervalMs || 3000,
      maxAttempts: cfg.phonePool.smsMaxAttempts || 30,
      proxyUrl,
    })
    releaseFn = null  // local 无释放
  }
  
  // 通用 Playwright 填表 + 接码 + 提交 + 等 callback + continue
  try {
    console.log(`  [PKCE] add-phone: filling ${phone}`)
    await page.fill('input[type="tel"], input[autocomplete="tel"]', phone)
    await page.click('button[type="submit"]')
    await page.waitForSelector('input[autocomplete="one-time-code"], input[name*="code" i]', { timeout: 15000 })
    console.log(`  [PKCE] add-phone: polling SMS code (${provider})...`)
    const code = await smsCodeFn()
    console.log(`  [PKCE] add-phone: got SMS code, filling and submitting`)
    await page.fill('input[autocomplete="one-time-code"], input[name*="code" i]', code)
    await page.click('button[type="submit"]')
    await page.waitForURL(u => /\/oauth\/callback|code=/.test(u), { timeout: 30000 })
    console.log(`  [PKCE] add-phone: verification done, continuing PKCE`)
    continue
  } catch (e) {
    if (releaseFn) try { await releaseFn() } catch {}  // 错误路径释放
    const reason = e?.message?.includes('sms-poll-timeout') ? 'sms-timeout' : 'submit-error'
    return { phoneVerifyFail: reason }
  }
}
```

**关键**：
- 通用 Playwright 填表 / 接码 / 提交 / continue 部分两个 provider 共用（DRY）
- zhusms 失败时 cancelOrder 释放（避免占余额）；local 模式 binding 已永久建立无释放
- engine.js return shape 不变（refresh_token / phonePoolEmpty / phoneVerifyFail / needsPhone），所以 engine.js 不需要改

### 3.4 路由 `server/routes/phone-pool.js` +1 endpoint

```js
router.post('/zhusms/balance', async (req, res) => {
  try {
    const cfg = readConfig()
    const z = cfg?.phonePool?.zhusms
    if (!z?.cardKey) return res.status(400).json({ error: 'cardKey not configured' })
    let proxyUrl = null
    try {
      const st = require('../proxy').getState?.()
      if (st?.enabled) proxyUrl = 'http://127.0.0.1:7890'
    } catch {}
    const zhusms = require('../zhusms-provider')
    const balance = await zhusms.getBalance(z.cardKey, z.baseUrl, proxyUrl)
    res.json({ ok: true, balance })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
```

### 3.5 前端 `Config.vue` provider 块

phonePool 分区加 provider 选择 + 条件展示 zhusms 表单：

```vue
<el-form-item label="Provider">
  <el-radio-group v-model="config.phonePool.provider">
    <el-radio label="local">本地号池（v2.37）</el-radio>
    <el-radio label="zhusms">zhusms 卡密</el-radio>
  </el-radio-group>
</el-form-item>

<template v-if="config.phonePool.provider === 'zhusms'">
  <el-form-item label="卡密">
    <el-input v-model="config.phonePool.zhusms.cardKey" />
  </el-form-item>
  <el-form-item label="Service">
    <el-input v-model="config.phonePool.zhusms.service" placeholder="codex" />
  </el-form-item>
  <el-form-item label="Base URL">
    <el-input v-model="config.phonePool.zhusms.baseUrl" placeholder="https://zhusms.com" />
  </el-form-item>
  <el-form-item label="余额测试">
    <el-button @click="testZhusmsBalance" :loading="testingBalance">查询余额</el-button>
    <span style="margin-left:8px;color:#909399">{{ zhusmsBalance || '点按钮测试' }}</span>
  </el-form-item>
</template>
```

`testZhusmsBalance` 调 POST `/api/phone-pool/zhusms/balance` 回显结果。

Config.vue load() 加 fallback init 防止旧 config.json 缺字段：

```js
if (!config.value.phonePool) config.value.phonePool = { /* full default */ }
if (!config.value.phonePool.provider) config.value.phonePool.provider = 'local'
if (!config.value.phonePool.zhusms) config.value.phonePool.zhusms = { cardKey: '', service: 'codex', baseUrl: 'https://zhusms.com' }
```

### 3.6 边界 / 不变式

- **§3.6.1 Phase 1 本地号池零改动**：DB 表 / UI 页 (`/phone-pool`) / service / route 完全保留。`provider='local'` 跑老路径
- **§3.6.2 协议模式 + payment.js + Python 不动**
- **§3.6.3 zhusms session cookie 缓存 1 小时**：避免每次 take 都 activate。401/403 时清缓存重试一次
- **§3.6.4 zhusms 失败必释放**：try/catch cancelOrder 在 failure 路径，不消耗卡密名额
- **§3.6.5 代理覆盖**：zhusms 所有 API + SMS poll 全走 HttpsProxyAgent（proxy enabled 时），与 fetchSmsCode 一致
- **§3.6.6 service 字段 zhusms 专属**：local provider 不知道 service 概念（local phone 通用），不动既有 schema
- **§3.6.7 PhonePool.vue 页保留**：local provider 时仍用得着；zhusms 时该页 listPhones 仍返回本地空数组，UI 仍可访问（不冲突）
- **§3.6.8 SMS code 提取 tolerant**：`JSON.stringify(data).match(/\b(\d{6})\b/)` —— 不假设 zhusms 响应字段名（sms / code / body），实测时改更精准
- **§3.6.9 同卡密并发**：假设 zhusms 支持。若实测 take 报"已有 waiting 订单" → 用 `/api/order/current` 复用，本 spec 暂不实现（YAGNI）
- **§3.6.10 engine.js 不动**：v2.38.0 4-shape return handling 完全复用

### 3.7 测试

`server/__tests__/zhusms-provider.test.js` 新建：

```js
test('Z1 activate 成功后缓存 cookie，第二次 take 不重新 activate', ...)
test('Z2 takeOrder 返回 {order_no, phone}', ...)
test('Z3 pollOrderSms 超时抛 sms-poll-timeout', ...)
test('Z4 pollOrderSms 拿到 6 位数字返回 code', ...)
test('Z5 cancelOrder 调用正确 endpoint + form body', ...)
test('Z6 take 401 时清 session 重试一次', ...)
```

全部 mock `globalThis.fetch`。`__resetForTest()` 在 beforeEach 调清缓存。

### 3.8 文件清单

| 文件 | 改动 |
|---|---|
| `server/zhusms-provider.js` | 新建 service (~150 LOC) |
| `server/__tests__/zhusms-provider.test.js` | 新建 +6 单测 |
| `utils.js:fetchTokensViaPKCE` | add_phone 分支加 provider 分流 |
| `server/routes/phone-pool.js` | +1 endpoint `/zhusms/balance` |
| `config.example.json` | phonePool +provider/zhusms 字段 |
| `web/src/views/Config.vue` | provider radio + 条件 zhusms 表单 + 余额按钮 |
| `docs/CHANGELOG.md` | v2.39.0 节 |

`engine.js` / `server/phone-pool.js` / `web/src/views/PhonePool.vue` / `web/src/status.js` 全部不动。

## 4. YAGNI / 不做的

- 不动 Phase 1 本地号池 (DB / UI / service / route 全保留)
- 不动 engine.js (4-shape return shape 不变)
- 不动 status.js (无新 status 码 — phonePoolEmpty / phoneVerifyFail 复用)
- 不动 payment.js (PayPal SMS 不接 zhusms)
- 不动协议模式 / Python
- 不为 zhusms 加单独 UI 页 (Config 块够用)
- 不持久化 zhusms 订单历史 (用户自己上 zhusms 网站看 /api/orders)
- 不为 cardKey 加 mask (Config GET 仍 mask sensitive，跟现有 phoneSlots 一致；新增 zhusms.cardKey 需要加到 SENSITIVE_FIELDS)
- 不为 baseUrl 加白名单校验 (用户责任)
- 不为同卡密并发加 mutex (假设 zhusms 支持，实测打脸再加)

## 5. 已知未知 / 实测时确认

- **zhusms `/api/order/status` 响应字段**：spec 用 `JSON.stringify + regex` tolerant 提取，但 API 实际可能用 `{sms: "your code is 123456"}` / `{code: "123456"}` / `{body: "..."}`。实测一次后可精准 parse
- **zhusms `/api/order/take` 余额耗尽响应**：可能是 HTTP 200 含 `{error: "no balance"}` 或 HTTP 4xx。`takeOrder` 内 `if (!data?.order_no) return null` 兜底，但精确 reason 待实测
- **session cookie 过期时长**：spec 假设 1 小时，401 重试兜底。实测可能更短/更长
- **service 标签**：spec 默认 `'codex'`，user 提到 zhusms 首页有 PayPal/Codex 两个类目。用户买的卡密 ZS-V8VXJSDP 假设是 codex 服务

## 6. 版本

v2.39.0 — minor over v2.38.0（v2.37/2.38 Phase 1+2a 本地号池 + 浏览器 PKCE 已落地）。

避开 v2.35.x / v2.36.x（并行 session frontend redesign）。
