# v2.38.0 — 浏览器模式 PKCE add_phone 流程实现（Phase 2a/2）

## 1. 背景

v2.37.0 Phase 1 完成了号池基础设施（DB / service / 路由 / UI / Config），但 PKCE 流程**还没消费号池**。今天 ChatGPT 在某些账户上要求绑定手机号时，浏览器模式 PKCE (`utils.js:fetchTokensViaPKCE`) 检测到 add_phone 页就返回 `{needsPhone:true}`，engine 标账户为 `plus_no_rt` 兜底退出 —— 没拿到 refresh token。

Phase 2 共有两套 PKCE 引擎要接通号池：
- **2a（本 spec）浏览器模式**：Playwright DOM 自动化，无需 OpenAI API 逆向。低风险快速 ship
- **2b（独立 spec）协议模式**：需要 Python 双向 stdin 协议 + OpenAI add_phone API 逆向。复杂，需用户先抓包

本 spec 只覆盖 2a。协议模式继续保持 `needsPhone:true → plus_no_rt` 兜底行为不动。

## 2. 目标（Phase 2a）

- 浏览器模式 PKCE 检测到 add_phone 页 → 从 v2.37.0 号池取号 → Playwright 自动填手机 + 接码 + 填验证码 + 提交 → 继续 PKCE 拿 token
- 失败分类清晰：池子空 → `phone_pool_empty` (warning)；SMS 超时 / 表单提交失败 → `phone_verify_fail` (danger)
- **`config.phonePool.enabled=false` 时回退原行为**（向后兼容，号池一行不消费）
- **`config.proxy.enabled=true` 时所有 HTTP 走主代理**（Chrome 已自动，`fetchSmsCode` 显式传 proxyUrl）；enabled=false 时直连
- 不动协议模式 / payment.js / Python 任何文件

## 3. 方案

### 3.1 `server/phone-pool.js:fetchSmsCode` 加 proxy 支持

当前签名 `fetchSmsCode(smsApiUrl, { pollIntervalMs, maxAttempts, signal })`。新增 `proxyUrl` 可选参数：

```js
const { HttpsProxyAgent } = require('https-proxy-agent')

async function fetchSmsCode(smsApiUrl, { pollIntervalMs = 3000, maxAttempts = 30, signal, proxyUrl } = {}) {
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined
  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) {
      const err = new Error('aborted'); err.name = 'AbortError'; throw err
    }
    try {
      const resp = await fetch(smsApiUrl, { signal, agent })  // agent undefined 时 = 直连
      if (!resp.ok) { /* skip, continue polling */ } else {
        const text = await resp.text()
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
```

`HttpsProxyAgent` 已在项目 deps（用于 `payment.js` 等）。`proxyUrl=undefined` 时 fetch 直连，向后兼容。

### 3.2 新增 `utils.js:isAddPhonePage(page)` helper

```js
/**
 * 双重判定（任一命中即视为 add_phone 页）。
 * - URL 含 /add-phone 或 /phone-required
 * - DOM 含 input[type="tel"] 或 input[autocomplete="tel"]
 */
async function isAddPhonePage(page) {
  try {
    const url = page.url()
    if (/\/add[-_]phone|\/phone[-_]required/i.test(url)) return true
    const el = await page.waitForSelector('input[type="tel"], input[autocomplete="tel"]', { timeout: 1500 })
    return !!el
  } catch { return false }
}
```

### 3.3 `utils.js:fetchTokensViaPKCE` 扩展处理 add_phone

当前流程：OAuth setup → page.goto(authUrl) → 检测 add_phone → 返回 `{needsPhone:true}`。

扩展为：

```js
async function fetchTokensViaPKCE(browser, account, lastOtp) {
  const ctx = browser.contexts()[0]
  const page = await ctx.newPage()
  // ... 既有 OAuth setup / page.goto / OTP 填表 ...

  if (await isAddPhonePage(page)) {
    const cfg = readConfig()  // 复用既有 readConfig helper
    if (!cfg?.phonePool?.enabled) {
      // 号池 disabled → 回退原行为（向后兼容）
      return { needsPhone: true }
    }

    const { acquirePhone, fetchSmsCode } = require('./server/phone-pool')
    const { getRawDb } = require('./server/db')
    const max = cfg.phonePool.maxBindingsPerPhone || 5

    const allotted = acquirePhone(getRawDb(), account.email, max)
    if (!allotted) return { phonePoolEmpty: true }

    // 主代理 URL（proxy enabled 时；disabled 直连）
    let proxyUrl = null
    try {
      const proxyState = require('./server/proxy').getState?.()
      if (proxyState?.enabled) proxyUrl = 'http://127.0.0.1:7890'
    } catch {}

    try {
      // 填手机号 + 提交
      await page.fill('input[type="tel"], input[autocomplete="tel"]', allotted.phone)
      await page.click('button[type="submit"]')
      // 等待 SMS 验证码输入框出现
      await page.waitForSelector('input[autocomplete="one-time-code"], input[name*="code" i]', { timeout: 15000 })
      // 拉验证码（走代理 if enabled）
      const code = await fetchSmsCode(allotted.smsApiUrl, {
        pollIntervalMs: cfg.phonePool.smsPollIntervalMs || 3000,
        maxAttempts: cfg.phonePool.smsMaxAttempts || 30,
        proxyUrl,
      })
      // 填验证码 + 提交
      await page.fill('input[autocomplete="one-time-code"], input[name*="code" i]', code)
      await page.click('button[type="submit"]')
      // 等待跳回 OAuth callback（成功标志）
      await page.waitForURL(u => /\/oauth\/callback|code=/.test(u), { timeout: 30000 })
      // → 跌入下面既有 token exchange 路径
    } catch (e) {
      const reason = e?.message?.includes('sms-poll-timeout') ? 'sms-timeout' : 'submit-error'
      return { phoneVerifyFail: reason }
    }
  }

  // 既有 token exchange (POST /oauth/token with code_verifier)
  // ...
  return { refresh_token, access_token, id_token }
}
```

**关键不变式**：
- Playwright 走 Chrome，Chrome 启动时通过 engine.js 注入 `--proxy-server=http://127.0.0.1:7890`（既有逻辑）—— Playwright 所有 DOM 操作（page.goto / page.click / waitForURL）**已自动走代理**，本节代码不需要额外配置
- 只有 `fetchSmsCode` 是显式 HTTP（不走 Chrome），需要显式传 `proxyUrl`
- `proxyUrl` 取决于 `proxyState?.enabled`，跟全局代理配置同步

### 3.4 `server/engine.js` 处理新 return shape

PKCE 调用站（line ~574-590）：

```js
const pkceTokens = await fetchTokensViaPKCE(browser, account, loginResult.lastOtp)

if (pkceTokens?.refresh_token) {
  // 既有成功路径
} else if (pkceTokens?.phonePoolEmpty) {
  await this.emitStatus({ email, status: 'phone_pool_empty', phase: 'pkce', reason: '号池已用尽或全部满' })
  return
} else if (pkceTokens?.phoneVerifyFail) {
  await this.emitStatus({ email, status: 'phone_verify_fail', phase: 'pkce', reason: pkceTokens.phoneVerifyFail })
  return
} else if (pkceTokens?.needsPhone) {
  // 既有路径：号池 disabled 时回退
  await this.emitStatus({ email, status: 'plus_no_rt', phase: 'pkce', reason: 'phone-required-pool-disabled' })
  return
}
```

### 3.5 `web/src/status.js` 加 2 个新 status 码

```js
TYPE_MAP: {
  ...
  phone_pool_empty: 'warning',
  phone_verify_fail: 'danger',
}
LABEL_MAP: {
  ...
  phone_pool_empty: '号池已用尽',
  phone_verify_fail: '手机验证失败',
}
ERROR_STATUSES: [..., 'phone_pool_empty', 'phone_verify_fail']
GROUP_ORDER: [..., 'phone_pool_empty', 'phone_verify_fail', ...]  // 插入位置：失败类 cluster
```

`rowClassFor` 自动 pickup（v2.33.1 行高亮）。

### 3.6 3 个 Vue 视图 status 筛选下拉补 option

`web/src/views/Execute.vue` / `Accounts.vue` / `Results.vue` 各 +2:

```vue
<el-option label="号池已用尽" value="phone_pool_empty" />
<el-option label="手机验证失败" value="phone_verify_fail" />
```

### 3.7 边界 / 不变式

- **§3.7.1 号池 disabled 完全回退**：`cfg.phonePool.enabled=false` 时跑老路径，账户标 `plus_no_rt`。零行为变化
- **§3.7.2 代理 disabled 时 fetchSmsCode 直连**：跟 PayPal SMS 现有行为一致。Chrome 自动跟全局代理同步
- **§3.7.3 协议模式不动**：protocol_register.py / protocol-engine.js 保持 `needsPhone:true` 兜底；Phase 2b 才接通
- **§3.7.4 payment.js 不动**：PayPal SMS 仍用 config.smsApiUrl + 既有 handleSmsVerification
- **§3.7.5 acquirePhone 失败不重试**：拿不到号一次性 phone_pool_empty；不消耗其它号池名额
- **§3.7.6 SMS 超时不切号**：90s 内拿不到 → phone_verify_fail；不再 acquirePhone 第二号（避免连环消耗）
- **§3.7.7 Selector 兜底**：URL + DOM 双重判定 add_phone 页；通用 selector（`input[type=tel]` / `autocomplete=one-time-code`）不绑定具体 ID
- **§3.7.8 binding 计数语义不变**（v2.37.0 §3.6.2）：`acquirePhone` 写 binding 后即便后续提交失败，binding 仍永久保留，bindings_used 不回退
- **§3.7.9 OAuth callback wait 30s timeout**：超时归为 `submit-error`（视为 add_phone 流程失败，不假设拿到了 token）

### 3.8 测试

- **`server/__tests__/engine-pkce-phone.test.js` 新建**：mock fetchTokensViaPKCE 返回 4 种 shape（refresh_token / phonePoolEmpty / phoneVerifyFail / needsPhone）→ 验证 emitStatus 调用正确（status / reason 字段）
- **`server/__tests__/utils-isAddPhonePage.test.js` 新建**：mock page 对象 → URL 匹配 / DOM 兜底 / 都不命中 三个分支
- **`server/__tests__/phone-pool.test.js` 扩展**：+1 测试 P7 `fetchSmsCode 接 proxyUrl 时 fetch 收到 agent`（mock global.fetch，断言 args.agent instanceof HttpsProxyAgent）
- **`__tests__/status-row-class.test.js` 扩展**：+1 断言 phone_pool_empty → warning class、phone_verify_fail → danger class
- **Playwright 端到端**：手动 smoke —— 找会撞手机验证的账户用浏览器模式跑 1 次，观察 row 颜色 + 池子 binding +1

### 3.9 文件清单

| 文件 | 改动 |
|---|---|
| `server/phone-pool.js` | fetchSmsCode 加 proxyUrl 参数 + HttpsProxyAgent 集成 |
| `utils.js` | +`isAddPhonePage` helper + fetchTokensViaPKCE 扩展 add_phone 处理 |
| `server/engine.js` | PKCE 调用站处理 4 种 return shape (refresh_token / phonePoolEmpty / phoneVerifyFail / needsPhone) |
| `web/src/status.js` | TYPE_MAP / LABEL_MAP / GROUP_ORDER / ERROR_STATUSES 各 +2 |
| `web/src/views/Execute.vue` | status 筛选下拉 +2 option |
| `web/src/views/Accounts.vue` | status 筛选下拉 +2 option |
| `web/src/views/Results.vue` | status 筛选下拉 +2 option |
| `server/__tests__/engine-pkce-phone.test.js` | 新建 +4 单测 |
| `server/__tests__/utils-isAddPhonePage.test.js` | 新建 +3 单测 |
| `server/__tests__/phone-pool.test.js` | +1 单测 (P7 proxyUrl) |
| `__tests__/status-row-class.test.js` | +2 断言 |
| `docs/CHANGELOG.md` | v2.38.0 节 |

**协议模式 / payment.js / Python 全部不动**。

## 4. YAGNI / 不做的

- 不动协议模式（Phase 2b）
- 不动 payment.js（PayPal SMS 仍用 config.smsApiUrl + handleSmsVerification）
- 不动 Python（chatgpt_register/）
- 不为 phone_verify_fail 加自动重试（避免连环消耗号池名额）
- 不为 add_phone 流程加超时上限以外的配置（30s waitForURL 写死）
- 不为 phone 输入框加国家代码下拉处理（假设号已含 + 前缀 = E.164 完整）
- 不持久化 add_phone 失败 reason 详情（emitStatus reason 字段够用）

## 5. Phase 2b 预览（独立 spec）

需用户提供：
- OpenAI 内部 `add_phone` endpoint URLs（Chrome DevTools Network 抓 POST 请求）
- 请求 payload schema（phone 字段名、country code 是否需要）
- 验证 endpoint URL + payload
- 成功响应特征 (HTTP code, body shape)

Phase 2b 工作量预估：5-7 个文件，包含 Python bidirectional stdin 协议重构 + protocol-engine.js 协调层 + add_phone HTTP 调用实现。

## 6. 版本

v2.38.0 — minor over v2.37.0（Phase 1 号池）。Phase 2b = v2.38.1 / v2.39.0 后续确认。

避开 v2.35.x / v2.36.x（并行 session frontend redesign 已占用）。
