# v3.0.0 Protocol Expansion Design

**Date:** 2026-05-23
**Status:** Draft → 待评审
**Predecessors:** v2.18.0 (jp-kddi), v2.18.1 (jp-checkout-whitelist), v2.18.2 (country=US/USD), v2.19.0 (reliable JP-first checkout), v2.19.1 (payment.js rollback)
**Reference:** `E:\workspace\projects\Gpt-Agreement-Payment` (协议重放方向的天花板：99% HTTP + PayPal Playwright RPA 子进程隔离)

## Background

v2.19 实现了 checkout + Stripe verify 协议化，确认协议路径在这些环节稳定可用。剩余仍走 Playwright 的环节：

1. **Stripe 计费表填 + Submit** (`pay.openai.com` 页) —— 当前 `autoPayment(page)` 头部
2. **PayPal sub-flow** —— 当前 `autoPayment(page)` 尾部
3. **ChatGPT manual approval** —— 当前 Chrome 自然跳转
4. **PKCE OAuth** —— 当前 `fetchTokensViaPKCE` Playwright

Gpt-Agreement-Payment 的成熟范式（9551 行 monolith + RPA 隔离）证明：除 PayPal sub-flow 因 FraudNet/DataDome/recaptcha 必须真浏览器外，其余环节 100% 可协议化。

## Goal

按 Gpt-Agreement-Payment 范式，把上述 4 环节中**除 PayPal 外的 3 环节协议化**（HTTP 重放），同时把 PayPal 阶段**抽成独立 Node RPA 子进程**（headed Chromium，跟 server 主进程隔离）。

**约束**：
- 不动 `engine.js` (PipelineEngine) —— 用户的"不要改我们的浏览器模式"保障
- 不动 v2.19 稳定基线（`protocol_register.py` / `checkout_link.py` / `stripe_init.py` / `chatgpt-checkout.js` / `stripe-verify.js`）
- 不增加自动 fallback（fail-fast，与 v2.19 一致）
- 复用现有 `protocolMode: true` 作为统一开关，**不新增配置项**

## Architecture

### Branch
- 从 `v2.19.1` (master HEAD = `382a089`) checkout `dev` 分支
- 所有 v3.0.0 工作在 `dev` 上
- 完工后由用户决定何时 merge 回 master + tag `v3.0.0`

### Toggle (复用 protocolMode)
| protocolMode | 走法 |
|---|---|
| `true` | ProtocolEngine + 4 个老协议模块 + **3 个新 v3 协议模块** + **PayPal RPA 子进程** |
| `false` | PipelineEngine + Playwright 全套（v3.0.0 不动，行为跟 v2.19.1 完全一致）|

### Data Flow (protocolMode=true 完整链路)

```
Phase 1: protocol_register.py      ← 已有
   ↓ access_token, refresh_token

Phase 2: checkout_link.py          ← 已有，强制 7891 JP
   ↓ link (cs_live), pk

Phase 2.5: stripe_init.py          ← 已有 (v2.19)
   ↓ verify amount_due=0

Phase 3a: stripe_billing.py        ← 新 (v3.0.0)
   HTTP POST 计费 + 选 PayPal → 返回 PayPal 跳转 URL
   ↓ paypal_redirect_url

Phase 3b: paypal_rpa.js            ← 新 (v3.0.0) — 独立 Node 子进程 RPA
   headed Chromium，自包含 PayPal login/SMS/approve
   ↓ chatgpt_approval_url (Chrome 已 close)

Phase 3c: manual_approval.py       ← 新 (v3.0.0)
   curl_cffi GET approval URL → 触发 OpenAI 服务端订阅激活
   ↓ subscription = active

Phase 4: pkce_oauth.py             ← 新 (v3.0.0)
   PKCE 完整 HTTP 流：authorize → exchange → refresh_token
   ↓ save auth file
```

### 故障模型 (fail-fast)
| 失败点 | 新 status |
|---|---|
| stripe_billing.py 拿不到 PayPal URL | `stripe_billing_error` |
| PayPal RPA 失败 | `error`（沿用现有，reason 字段标 paypal_rpa 子原因）|
| manual_approval.py 30s 内 ChatGPT 不显示 plus | `activation_error` |
| pkce_oauth.py 失败 | 仍归 `plus_no_rt`（兼容现有"有/无 RT"约定）|

## Component 1: Stripe billing 协议化

### Files
- Create: `stripe_billing.py` (Python curl_cffi)
- Create: `server/stripe-billing.js` (JS spawner)

### JS Interface
```js
async function submitStripeBilling(payLink, pk, billing) → {
  ok: boolean,
  paypal_redirect_url?: string,
  payment_intent_id?: string,
  reason?: string,    // 'invalid_link' | 'stripe_billing_4xx' | 'no_next_action' | 'spawn_error' | 'timeout'
  raw?: string,
}
```

`billing` 由 protocol-engine 生成（沿用 `payment.js` 现有 `fetchAddress()` 逻辑，把它抽成 module export，或在 protocol-engine 内联）。

### Python protocol
stdin：
```json
{
  "cs_id": "cs_live_a1XXX",
  "pk": "pk_live_51HOrSwXXX",
  "country": "US",
  "currency": "USD",
  "street": "1234 Main St",
  "city": "Austin",
  "state": "TX",
  "zip": "78701",
  "proxy": "http://127.0.0.1:7890"
}
```

stdout (success)：
```json
{"status":"success","data":{"paypal_redirect_url":"https://www.paypal.com/...","payment_intent_id":"pi_..."}}
```

stdout (failure)：
```json
{"status":"error","reason":"stripe_billing_4xx","body":"<truncated 200 chars>"}
```

### HTTP 流程（参考 Gpt-Agreement-Payment `card/_monolith.py`）

实施时读 9551 行 monolith 的 "stripe confirm" 段落，移植两次 HTTP：

1. **POST `/v1/payment_pages/{cs_id}/confirm`** （或 `update_payment_method`）
   - form data: `key=pk_live_*`, `payment_method_type=paypal`, `billing_details[...]`
   - response: 包含 `next_action.redirect_to_url`（PayPal URL）
2. 可选: POST 第二次确认订阅条款（取决于 Stripe 当前 flow 形态）

走 **main proxy 7890 US**（同 stripe_init.py — cs_live 已固化，IP 不影响）。

## Component 2: PKCE OAuth 协议化

### Files
- Create: `pkce_oauth.py` (Python curl_cffi)
- Create: `server/pkce-oauth.js` (JS spawner)

### JS Interface
```js
async function fetchPkceTokensProtocol(accessToken, account) → {
  ok: boolean,
  access_token?: string,
  refresh_token?: string,
  id_token?: string,
  needsPhone?: boolean,
  reason?: string,     // 'authorize_4xx' | 'no_code_in_redirect' | 'token_exchange_4xx' | 'spawn_error' | 'timeout'
  raw?: string,
}
```

返回 shape **跟现有 `fetchTokensViaPKCE` 对齐**，下游 `saveCPAAuthFile()` 不用改。

### Python protocol
stdin：
```json
{
  "access_token": "eyJ...",
  "client_id": "app_X8zY6vW2pQ9tR3dE7nK1jL5gH",
  "redirect_uri": "...",
  "scope": "openid email profile offline_access ...",
  "proxy": "http://127.0.0.1:7890"
}
```

stdout (success)：
```json
{"status":"success","data":{"access_token":"...","refresh_token":"...","id_token":"..."}}
```

### HTTP 流程（标准 PKCE）

1. **生成 verifier + challenge**：
   ```py
   verifier = base64url(secrets.token_bytes(32))
   challenge = base64url(sha256(verifier))
   ```
2. **GET `https://auth.openai.com/authorize`** with `client_id`, `redirect_uri`, `response_type=code`, `code_challenge`, `code_challenge_method=S256`, `scope`, `state`，header `Authorization: Bearer <access_token>`。期望 302 redirect 到 `redirect_uri?code=<auth_code>&state=...`；提取 `code`。
3. **POST `https://auth.openai.com/oauth/token`** with form `grant_type=authorization_code`, `code`, `code_verifier`, `client_id`, `redirect_uri`。返回 `{access_token, refresh_token, id_token}`。

走 **main proxy 7890 US**。

参考实现：
- 现有 Playwright `fetchTokensViaPKCE`（找 client_id、redirect_uri 等常量）
- Gpt-Agreement-Payment `paypal_plus/signup.py` 或 pipeline 的 OAuth 段（HTTP 重放范本）

## Component 3: Manual approval 协议化

### 是什么阶段

PayPal 用户同意支付 → PayPal 回调 → ChatGPT 服务端 commit 订阅 + Chrome 自然跳到 `redirect_status=succeeded`。

- **当前**：Chrome 一直等到 ChatGPT 完成激活才能拿到最终 URL（~5-15s 浪费在 Chrome 里挂着）
- **协议版**：PayPal 一同意，Chrome 立刻关闭，把回调 URL 交给 curl_cffi 跟进

### Files
- Create: `manual_approval.py`
- Create: `server/manual-approval.js`

### JS Interface
```js
async function confirmSubscriptionActivation(accessToken, approvalUrl) → {
  ok: boolean,
  plan_type?: string,    // 'plus' / 'pro' / 'free'
  is_subscribed?: boolean,
  reason?: string,       // 'approve_http_4xx' | 'no_plus_after_timeout' | 'spawn_error'
  raw?: string,
}
```

### Python protocol
stdin：
```json
{
  "access_token": "eyJ...",
  "approval_url": "https://chatgpt.com/agreements/approve?token=...",
  "proxy": "http://127.0.0.1:7890",
  "poll_interval_ms": 2000,
  "max_wait_ms": 30000
}
```

stdout (success)：
```json
{"status":"success","data":{"plan_type":"plus","is_subscribed":true}}
```

### HTTP 流程
1. **GET approval_url** with `Authorization: Bearer <access_token>` —— 提交订阅同意，触发 ChatGPT 后端 commit
2. **Poll `https://chatgpt.com/backend-api/me`** (or `/billing/subscription`) every 2s
   - 当 `plan_type === 'plus'` 或 `is_subscribed === true` → success
   - 30s 内没变 plus → `no_plus_after_timeout`

走 **main proxy 7890 US**。

## Component 4: PayPal RPA 隔离 (新)

参考 Gpt-Agreement-Payment 的 `paypal_node_rpa.js` 模式，把 PayPal 阶段抽成**独立 Node 子进程 RPA**，跟 protocol-engine 解耦。

### Why RPA 隔离

| 现状 (主进程 Playwright) | RPA 子进程隔离 |
|---|---|
| Chrome 跟 server 同一 Node 进程，CDP 连接 | 独立 Node 子进程，stdin/stdout JSON 通信 |
| 每个账号 launchChrome → connect → close 在主进程做 | 子进程自管 Chrome 生命周期，主进程零接触 |
| Server 进程持有 browser/page 句柄 | Server 只持有子进程 PID，崩了就 kill PID |
| 一个账号崩了影响 server 状态 | 一个账号崩了只崩子进程，server 完好 |
| 现行：`--headless` 默认 | RPA：**headed Chromium**（真窗口；PayPal 风控对 headless 敏感）|

### Files
- Create: `paypal_rpa.js` (repo 根目录，Node 脚本)
- Create: `server/paypal-rpa.js` (JS spawner)
- Modify: `server/chrome.js` → 暴露 `launchChromeHeaded()`（如果当前 launchChrome 不支持 headed mode）
- 不在 v3.0.0 移除：`payment.js` 中的 PayPal 段（PipelineEngine 仍要用）

注：用 **`playwright-core`**（Gpt-Agreement-Payment 的选择，比较轻；可直接 npm install）。

### stdin/stdout 协议

stdin JSON：
```json
{
  "paypal_url": "https://www.paypal.com/agreements/approve?ba_token=...",
  "phone": "4642840651",
  "sms_api_url": "http://a.62-us.com/api/get_sms?key=...",
  "proxy": "http://127.0.0.1:7890",
  "worker_id": "wk-1748000000",
  "approval_url_pattern": "chatgpt\\.com/agreements/approve"
}
```

stdout (success)：
```json
{"status":"success","data":{"chatgpt_approval_url":"https://chatgpt.com/agreements/approve?token=..."}}
```

stdout (失败)：
```json
{"status":"error","reason":"paypal_login_fail" | "sms_fetch_fail" | "approval_timeout" | "card_declined" | ...}
```

stderr：人类可读 log（不解析）。

### paypal_rpa.js 结构

```js
#!/usr/bin/env node
// paypal_rpa.js — isolated PayPal sub-flow RPA via headed Chromium.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const os = require('os');

(async () => {
  const input = JSON.parse(await readStdin());
  const tempDir = path.join(os.tmpdir(), `paypal-rpa-${input.worker_id || Date.now()}`);

  // 关键：headless = false（PayPal 风控对 headless 敏感）
  const context = await chromium.launchPersistentContext(tempDir, {
    headless: false,
    proxy: { server: input.proxy },
    viewport: { width: 1280, height: 800 },
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    // ... PayPal login / SMS / approve（移植 payment.js v2.14 baseline 的 PayPal 段）...

    // 监听 URL 跳转到 chatgpt.com
    await page.waitForURL(new RegExp(input.approval_url_pattern), { timeout: 120000 });
    const approvalUrl = page.url();

    console.log(JSON.stringify({ status: 'success', data: { chatgpt_approval_url: approvalUrl } }));
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', reason: 'paypal_rpa_error', detail: e.message }));
  } finally {
    await context.close();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
})();
```

### JS 包装

```js
// server/paypal-rpa.js
function runPayPalRpa(opts) {
  return new Promise((resolve) => {
    const node = spawn('node', [path.join(__dirname, '..', 'paypal_rpa.js')], { stdio: ['pipe','pipe','pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { node.kill(); resolve({ ok: false, reason: 'rpa_timeout' }); }, 180000);
    node.stdout.on('data', d => { for (const line of d.toString().split('\n').filter(l=>l.trim())) stdout = line; });
    node.stderr.on('data', d => { stderr += d.toString(); console.log(`  [PayPalRPA] ${d.toString().trim()}`); });
    node.on('close', () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(stdout);
        if (r.status === 'success') resolve({ ok: true, ...r.data });
        else resolve({ ok: false, reason: r.reason, raw: r.detail });
      } catch { resolve({ ok: false, reason: 'rpa_parse_fail', raw: stderr.slice(-200) }); }
    });
    node.stdin.write(JSON.stringify(opts));
    node.stdin.end();
  });
}
```

## Integration: protocol-engine.js 完整 Phase 3 + 4 新版

```js
// === Phase 3a: Stripe billing (HTTP) ===
const billing = await generateBillingAddress();
const b = await submitStripeBilling(link, fetchResult.pk, billing);
if (!b.ok) {
  this.emitStatus({ email: account.email, status: 'stripe_billing_error', ..., reason: b.reason });
  summary.stripeBillingError++;
  continue;
}

// === Phase 3b: PayPal RPA (isolated Node subprocess, headed Chromium) ===
console.log(`${p} Phase 3b: PayPal RPA...`);
this.emitStatus({ email: account.email, status: 'running', phase: 'paypal-rpa', progress });
const payResult = await runPayPalRpa({
  paypal_url: b.paypal_redirect_url,
  phone: phoneSlot.phone,
  sms_api_url: phoneSlot.smsApiUrl,
  proxy: proxyMgr.getProxyUrl(),
  worker_id: `wk-${Date.now()}-${i}`,
  approval_url_pattern: 'chatgpt\\.com/agreements/approve',
});
if (!payResult.ok) {
  this.emitStatus({ ..., status: 'error', phase: 'paypal-rpa', reason: payResult.reason });
  summary.error++;
  continue;
}

// === Phase 3c: HTTP manual approval ===
console.log(`${p} Phase 3c: Confirming subscription activation (protocol)...`);
const c = await confirmSubscriptionActivation(result.accessToken, payResult.chatgpt_approval_url);
if (!c.ok || c.plan_type !== 'plus') {
  this.emitStatus({ ..., status: 'activation_error', reason: c.reason });
  summary.activationError++;
  continue;
}

// === Phase 4: HTTP PKCE OAuth ===
if (latestCfg.enableOAuth) {
  const pkceTokens = await fetchPkceTokensProtocol(result.accessToken, account);
  if (pkceTokens.ok && pkceTokens.refresh_token) {
    saveCPAAuthFile(account.email, pkceTokens.access_token, pkceTokens);
    status = 'plus';
  } else {
    saveCPAAuthFile(account.email, result.accessToken, result.session);
    status = 'plus_no_rt';
  }
}
summary.success++;
```

### summary buckets 新增

```js
const summary = {
  ...existing,
  stripeBillingError: 0,
  activationError: 0,
};
```

## Web Dashboard

新增 2 个 status（PKCE 失败仍走 `plus_no_rt`，PayPal RPA 失败仍走 `error`）：

| status | type | label | retryable |
|---|---|---|---|
| `stripe_billing_error` | danger | Stripe 计费失败 | ✅ (网络问题) |
| `activation_error` | danger | 订阅激活超时 | ✅ |

更新 4 个 `.vue` 文件的 status filter dropdown（同 v2.19 pattern）+ Dashboard.vue KPI 卡片（再加一行 2 卡）。

## Files Affected (summary)

**新建**：
- `stripe_billing.py`
- `pkce_oauth.py`
- `manual_approval.py`
- `paypal_rpa.js` (Node, repo 根目录)
- `server/stripe-billing.js`
- `server/pkce-oauth.js`
- `server/manual-approval.js`
- `server/paypal-rpa.js`
- 各对应 `server/__tests__/*.test.js`

**修改**：
- `protocol-engine.js`：重写 Phase 3 + Phase 4（含 `engine.js` line ~370-440 等价段）
- `payment.js`：抽 `fetchAddress` 为 module export（被 stripe-billing.js 调用），其余不动
- `server/chrome.js`：暴露 `launchChromeHeaded` 如果当前 `launchChrome` 不支持
- `web/src/status.js`：加 2 个 type/label 映射
- `web/src/views/Dashboard.vue`：KPI 第三行加 2 卡
- `web/src/views/Accounts.vue` / `Execute.vue` / `Results.vue`：状态筛选加 2 个 option
- `docs/CHANGELOG.md`：v3.0.0 entry
- `package.json`：加 `playwright-core` 依赖（如果还没有）

**不动**：
- `server/engine.js` (PipelineEngine)
- `server/chatgpt-checkout.js` / `server/stripe-verify.js`
- `checkout_link.py` / `stripe_init.py` / `protocol_register.py`
- `payment.js` 的 `autoPayment` 主函数（PipelineEngine 仍用它）
- `config.json` 字段（沿用 `protocolMode`）

## Testing

### 单元测试
- `stripe-billing.test.js` — input validation, reason mapping
- `pkce-oauth.test.js` — PKCE challenge generation correctness, URL parsing
- `manual-approval.test.js` — URL pattern validation, polling termination
- `paypal-rpa.test.js` — input validation, spawn timeout handling

### 端到端（手动）
- `osxti6295` (有资格) → 应 `plus` (或 `plus_no_rt` 看 PKCE)
- `gexi4056685` (无资格) → 应 `no_promo` (Phase 2.5 仍拦截)
- 故障注入：故意把 stripe.com 的 main proxy 设成不可达 → 应 `stripe_billing_error`
- 故障注入：手动 kill paypal_rpa 子进程 → 应 `error` with `rpa_timeout` reason

### 回归
- `protocolMode: false` (PipelineEngine) 跑 osxti → 走 Playwright 全套，行为跟 v2.19.1 完全一致（验证 engine.js 未被影响）
- 验证 `payment.js autoPayment` 主函数未变（git diff 应只显示 fetchAddress export 变化）

## Acceptance Criteria

1. ✅ `submitStripeBilling` 成功返回 PayPal redirect URL，跳过 Stripe OpenAI 页 Chrome 渲染
2. ✅ `runPayPalRpa` 在独立 Node 子进程跑 headed Chromium，主 server 进程零 Chrome 接触
3. ✅ PayPal 通过后 Chrome 子进程立即关闭，`confirmSubscriptionActivation` 接管完成订阅激活
4. ✅ `fetchPkceTokensProtocol` 通过 HTTP 拿到 refresh_token，账号最终 `status=plus`
5. ✅ 任意阶段失败映射到正确的新 status（`stripe_billing_error` / `activation_error`），不进入下游浪费资源
6. ✅ Web Dashboard 显示新 2 状态徽章 + 文案 + 筛选选项
7. ✅ `protocolMode: false` 路径完全不受影响，回归测试通过

## Out of Scope (v3.0.0)

- 不动 `engine.js` (PipelineEngine)
- 不动 v2.19 协议基线
- 不增加自动 fallback（fail-fast 一致）
- 不优化 PayPal RPA selectors（先用 v2.14 baseline 移植；后续 v3.x 再迭代）
- 不支持多 worker 并发（worker_id 字段预留，但本版只跑单线程顺序）
- 不引入新支付方式（GoPay / QRIS 等 Gpt-Agreement-Payment 支持的非 PayPal 方式）
- 不实现 hCaptcha 视觉求解器（Gpt-Agreement-Payment 有，但我们当前不需要）
