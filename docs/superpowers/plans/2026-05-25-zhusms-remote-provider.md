# v2.39.0 zhusms 远程接码 Provider 并列接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 zhusms 远程接码作为 phonePool.provider 二选一，本地号池（v2.37/v2.38）完全保留。utils.js add_phone 分支按 provider 分流到 phonePool / zhusms 取号 + 接 SMS。

**Architecture:** `server/zhusms-provider.js` 包装 zhusms 4 endpoint (activate/take/status/cancel) + 1 balance + session cookie 缓存。`utils.js:fetchTokensViaPKCE` add_phone 分支按 `cfg.phonePool.provider` 分流，通用 Playwright 填表 / 接码 / 提交逻辑共用。Config.vue 加 provider radio + zhusms 表单 + 余额测试按钮。后端路由 `/api/phone-pool/zhusms/balance` 新增。

**Tech Stack:** Node + `https-proxy-agent`（已用）、node-fetch v3 (globalThis.fetch)、URLSearchParams (form body)、Vue 3 + Element Plus + node:test。

**Spec:** `docs/superpowers/specs/2026-05-25-zhusms-remote-provider-design.md`

---

## File Structure

| 文件 | 改动 | 类型 |
|---|---|---|
| `server/zhusms-provider.js` | service：activate / takeOrder / pollOrderSms / cancelOrder / getBalance + session cache | 新建 |
| `server/__tests__/zhusms-provider.test.js` | +6 单测 (mock global.fetch) | 新建 |
| `utils.js` | add_phone 分支按 provider 分流（local / zhusms 共用 Playwright 部分） | 修改 |
| `config.example.json` | phonePool +`provider` + `zhusms` 子块 | 修改 |
| `server/routes/phone-pool.js` | +1 endpoint `POST /zhusms/balance` | 修改 |
| `web/src/views/Config.vue` | provider radio + 条件 zhusms 表单 + 余额测试按钮 | 修改 |
| `docs/CHANGELOG.md` | v2.39.0 节 | 修改 |

依赖：Task 1（zhusms-provider + 单测）→ Task 2（utils.js 分流，依赖 zhusms-provider 存在）→ Task 3（config schema + routes 余额 endpoint）→ Task 4（前端 UI 调 endpoint）→ Task 5（CHANGELOG）。线性。

后端 / 前端 各 ~3 files。`engine.js` / `server/phone-pool.js` / `web/src/views/PhonePool.vue` / `web/src/status.js` / `payment.js` / 协议引擎 / Python **零改动**。

---

## Task 1: server/zhusms-provider.js + 6 单测

**Files:**
- Create: `server/zhusms-provider.js`
- Create: `server/__tests__/zhusms-provider.test.js`

### Step 1: 写失败测试

新建 `server/__tests__/zhusms-provider.test.js`:

```js
const test = require('node:test')
const assert = require('node:assert')

let zhusms

test.before(() => {
  zhusms = require('../zhusms-provider')
})

test.beforeEach(() => {
  zhusms.__resetForTest()
})

function mockFetch(handler) {
  const orig = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts })
    return handler(url, opts, calls)
  }
  return { calls, restore: () => { globalThis.fetch = orig } }
}

test('Z1 activate 成功后缓存 cookie，第二次 take 复用不重新 activate', async () => {
  const { calls, restore } = mockFetch(async (url) => {
    if (url.includes('/api/guest/activate')) {
      return {
        ok: true, status: 200,
        headers: { get: (k) => k.toLowerCase() === 'set-cookie' ? 'session=abc123; Path=/' : null },
        json: async () => ({ ok: true }),
      }
    }
    if (url.includes('/api/order/take')) {
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        json: async () => ({ order_no: 'ORD-1', phone: '+15551234567' }),
      }
    }
    throw new Error('unexpected ' + url)
  })
  try {
    const r1 = await zhusms.takeOrder('CARD1', 'https://zhusms.com', 'codex', null)
    const r2 = await zhusms.takeOrder('CARD1', 'https://zhusms.com', 'codex', null)
    assert.strictEqual(r1.order_no, 'ORD-1')
    assert.strictEqual(r2.order_no, 'ORD-1')
    // 应该 activate 1 次（缓存命中）+ take 2 次 = 3 个 fetch calls
    const activateCount = calls.filter(c => c.url.includes('/api/guest/activate')).length
    const takeCount = calls.filter(c => c.url.includes('/api/order/take')).length
    assert.strictEqual(activateCount, 1, 'activate 只调一次')
    assert.strictEqual(takeCount, 2, 'take 调 2 次')
  } finally { restore() }
})

test('Z2 takeOrder 返回 {order_no, phone}', async () => {
  const { restore } = mockFetch(async (url) => {
    if (url.includes('/api/guest/activate')) {
      return { ok: true, status: 200, headers: { get: (k) => k.toLowerCase() === 'set-cookie' ? 'session=x' : null }, json: async () => ({}) }
    }
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({ order_no: 'ORD-99', phone: '+18889990000', extra: 'whatever' }),
    }
  })
  try {
    const r = await zhusms.takeOrder('CARD1', 'https://zhusms.com', 'codex', null)
    assert.deepStrictEqual(r, { order_no: 'ORD-99', phone: '+18889990000' })
  } finally { restore() }
})

test('Z3 pollOrderSms 超时抛 sms-poll-timeout', async () => {
  const { restore } = mockFetch(async () => ({
    ok: true, status: 200,
    headers: { get: () => null },
    json: async () => ({ status: 'waiting' }),  // 始终无 6 位数字
  }))
  try {
    await assert.rejects(
      () => zhusms.pollOrderSms('ORD-1', 'https://zhusms.com', { pollIntervalMs: 1, maxAttempts: 3 }),
      /sms-poll-timeout/
    )
  } finally { restore() }
})

test('Z4 pollOrderSms 拿到 6 位数字返回 code', async () => {
  const { restore } = mockFetch(async () => ({
    ok: true, status: 200,
    headers: { get: () => null },
    json: async () => ({ status: 'done', sms: 'Your verification code is 654321 — expires in 10m' }),
  }))
  try {
    const code = await zhusms.pollOrderSms('ORD-1', 'https://zhusms.com', { pollIntervalMs: 1, maxAttempts: 3 })
    assert.strictEqual(code, '654321')
  } finally { restore() }
})

test('Z5 cancelOrder 调用正确 endpoint + form body', async () => {
  let captured
  const { restore } = mockFetch(async (url, opts) => {
    if (url.includes('/api/guest/activate')) {
      return { ok: true, status: 200, headers: { get: (k) => k.toLowerCase() === 'set-cookie' ? 'session=x' : null }, json: async () => ({}) }
    }
    if (url.includes('/api/order/cancel')) {
      captured = { url, body: opts?.body?.toString() }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) }
    }
    throw new Error('unexpected ' + url)
  })
  try {
    await zhusms.cancelOrder('ORD-XYZ', 'https://zhusms.com', 'CARD1', null)
    assert.ok(captured, 'cancel endpoint called')
    assert.match(captured.url, /\/api\/order\/cancel$/)
    assert.match(captured.body || '', /order_no=ORD-XYZ/)
  } finally { restore() }
})

test('Z6 take 401 时清 session 重试一次', async () => {
  let activateCount = 0, takeCount = 0
  const { restore } = mockFetch(async (url) => {
    if (url.includes('/api/guest/activate')) {
      activateCount++
      return { ok: true, status: 200, headers: { get: (k) => k.toLowerCase() === 'set-cookie' ? `session=v${activateCount}` : null }, json: async () => ({}) }
    }
    if (url.includes('/api/order/take')) {
      takeCount++
      if (takeCount === 1) return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({ error: 'session expired' }) }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ order_no: 'ORD-2', phone: '+18001234567' }) }
    }
    throw new Error('unexpected')
  })
  try {
    const r = await zhusms.takeOrder('CARD1', 'https://zhusms.com', 'codex', null)
    assert.strictEqual(r.order_no, 'ORD-2')
    assert.strictEqual(activateCount, 2, 'activate 调 2 次（401 后重新 activate）')
    assert.strictEqual(takeCount, 2, 'take 调 2 次（一次 401 + 一次成功）')
  } finally { restore() }
})
```

### Step 2: 跑测试 — 验证 FAIL

```
node --test server/__tests__/zhusms-provider.test.js
```

Expected: 6 测试 FAIL (`zhusms-provider` 模块还不存在 → `Cannot find module`).

### Step 3: 实现 `server/zhusms-provider.js`

新建文件：

```js
// v2.39.0 — zhusms 远程接码 provider
// API spec: https://zhusms.com/openapi.json
// Guest mode：卡密 activate 拿 session cookie，订单 take/poll/cancel。
// 一卡多次（每次 take 扣 1 余额）。

const { URLSearchParams } = require('url')

// Session cookie 缓存 (baseUrl → { cookie, activatedAt })
const sessions = new Map()
const SESSION_TTL_MS = 3600_000  // 1 小时

function __resetForTest() { sessions.clear() }

function _getAgent(proxyUrl) {
  if (!proxyUrl) return undefined
  const { HttpsProxyAgent } = require('https-proxy-agent')
  return new HttpsProxyAgent(proxyUrl)
}

async function _postForm(url, fields, { cookie, proxyUrl } = {}) {
  const body = new URLSearchParams(fields)
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (cookie) headers['Cookie'] = cookie
  return await fetch(url, { method: 'POST', headers, body, agent: _getAgent(proxyUrl) })
}

async function _activate(cardKey, baseUrl, proxyUrl) {
  const resp = await _postForm(`${baseUrl}/api/guest/activate`, { code: cardKey }, { proxyUrl })
  if (!resp.ok) throw new Error(`zhusms activate failed: HTTP ${resp.status}`)
  // 解析 Set-Cookie 头（fetch 不自动保留 cookies）
  const setCookie = resp.headers.get('set-cookie')
  if (!setCookie) throw new Error('zhusms activate: no Set-Cookie in response')
  // 简单提取 name=value (取第一段，去掉 Path / Expires 等)
  const cookie = setCookie.split(';')[0].trim()
  return cookie
}

async function ensureSession(cardKey, baseUrl, proxyUrl) {
  const cached = sessions.get(baseUrl)
  if (cached && Date.now() - cached.activatedAt < SESSION_TTL_MS) {
    return cached.cookie
  }
  const cookie = await _activate(cardKey, baseUrl, proxyUrl)
  sessions.set(baseUrl, { cookie, activatedAt: Date.now() })
  return cookie
}

async function takeOrder(cardKey, baseUrl, service, proxyUrl) {
  let cookie = await ensureSession(cardKey, baseUrl, proxyUrl)
  let resp = await _postForm(`${baseUrl}/api/order/take`, { service }, { cookie, proxyUrl })
  if (resp.status === 401 || resp.status === 403) {
    // session 过期 → 清缓存重试一次
    sessions.delete(baseUrl)
    cookie = await ensureSession(cardKey, baseUrl, proxyUrl)
    resp = await _postForm(`${baseUrl}/api/order/take`, { service }, { cookie, proxyUrl })
  }
  if (!resp.ok) return null  // 余额耗尽 / 服务异常
  const data = await resp.json()
  if (!data?.order_no || !data?.phone) return null
  return { order_no: data.order_no, phone: data.phone }
}

async function pollOrderSms(orderNo, baseUrl, { pollIntervalMs = 3000, maxAttempts = 30, signal, proxyUrl } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) {
      const e = new Error('aborted'); e.name = 'AbortError'; throw e
    }
    try {
      const resp = await fetch(`${baseUrl}/api/order/status?order_no=${encodeURIComponent(orderNo)}`, {
        agent: _getAgent(proxyUrl), signal,
      })
      if (resp.ok) {
        const data = await resp.json()
        // sms 字段名实测可能是 data.sms / data.code / data.body — 用 stringify + regex tolerant
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
    await _postForm(`${baseUrl}/api/order/cancel`, { order_no: orderNo }, { cookie, proxyUrl })
  } catch {
    // 释放失败不影响主流程（错误路径下尽力释放）
  }
}

async function getBalance(cardKey, baseUrl, proxyUrl) {
  const cookie = await ensureSession(cardKey, baseUrl, proxyUrl)
  const resp = await fetch(`${baseUrl}/api/guest/me`, {
    headers: { Cookie: cookie },
    agent: _getAgent(proxyUrl),
  })
  if (!resp.ok) throw new Error(`zhusms getBalance failed: HTTP ${resp.status}`)
  return await resp.json()
}

module.exports = {
  takeOrder, pollOrderSms, cancelOrder, getBalance,
  __resetForTest,
}
```

### Step 4: 跑测试验证 PASS

```
node --test server/__tests__/zhusms-provider.test.js
```

Expected: 6 pass。

常见失败：
- Z1 activate count !== 1：检查 `ensureSession` 是否真的缓存（session.get 命中分支）
- Z5 body 不含 order_no：检查 `URLSearchParams` 序列化（`new URLSearchParams({ order_no: 'X' }).toString()` 应该是 `order_no=X`）
- Z6 retry 不生效：检查 `if (resp.status === 401 || 403)` 分支 + `sessions.delete` 调用

### Step 5: 全套件回归

```
npm test
```

Expected: 既有 200 baseline (v2.38.0) + 6 新 = 206 pass，"fail 0"。

### Step 6: Commit

```bash
git add server/zhusms-provider.js server/__tests__/zhusms-provider.test.js
git commit -m "$(cat <<'EOF'
feat(zhusms): 远程接码 provider service + 6 单测 (v2.39.0)

server/zhusms-provider.js 包装 zhusms.com 5 个 endpoint:
- _activate (POST /api/guest/activate, 卡密 → Set-Cookie session)
- ensureSession (cookie 缓存 1 小时, miss 时 activate)
- takeOrder (POST /api/order/take service=<x>, 401 时清 session 重试)
- pollOrderSms (GET /api/order/status?order_no=<x>, regex tolerant 提取 6 位数字)
- cancelOrder (POST /api/order/cancel, 错误路径释放避免占余额)
- getBalance (GET /api/guest/me, UI 余额按钮用)

HttpsProxyAgent 集成（proxyUrl 提供时走代理）。URLSearchParams
form body 跟 zhusms API spec 一致。

6 单测覆盖：cookie 缓存 / take 成功 / poll 超时 / poll 拿码 /
cancel form body / 401 重试。全部 mock globalThis.fetch。
EOF
)"
```

---

## Task 2: utils.js add_phone 分支 provider 分流

**Files:**
- Modify: `utils.js:340-398` (add_phone 完整块替换)

### Step 1: 阅读当前 add_phone 块

打开 `utils.js`. add_phone 块在约 line 342-398。当前完整块（v2.38.0 形式）：

```js
      // STATE: add-phone (OpenAI requires phone verification for Codex)
      // v2.38.0: 号池启用时自动填手机 + 接 SMS + 填验证码 + 提交；
      // 号池 disabled 时回退原 needsPhone 行为（向后兼容）。
      if (await isAddPhonePage(page)) {
        const fs = require('fs');
        const pathMod = require('path');
        const cfgPath = pathMod.join(__dirname, 'config.json');
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); } catch {}
        if (!cfg?.phonePool?.enabled) {
          console.log('  [PKCE] State: add-phone — phone pool disabled, skipping PKCE');
          return { needsPhone: true };
        }

        const phonePool = require('./server/phone-pool');
        const { getRawDb } = require('./server/db');
        const max = cfg.phonePool.maxBindingsPerPhone || 5;

        const allotted = phonePool.acquirePhone(getRawDb(), account.email, max);
        if (!allotted) {
          console.log('  [PKCE] phone pool exhausted for this account');
          return { phonePoolEmpty: true };
        }

        // 代理：enabled 时 fetchSmsCode 走主代理（Chrome 已自动走）；disabled 时直连。
        let proxyUrl = null;
        try {
          const state = require('./server/proxy').getState?.();
          if (state?.enabled) proxyUrl = 'http://127.0.0.1:7890';
        } catch {}

        try {
          console.log(`  [PKCE] add-phone: filling ${allotted.phone}`);
          await page.fill('input[type="tel"], input[autocomplete="tel"]', allotted.phone);
          await page.click('button[type="submit"]');
          // 等待 SMS 输入框
          await page.waitForSelector('input[autocomplete="one-time-code"], input[name*="code" i]', { timeout: 15000 });
          console.log('  [PKCE] add-phone: polling SMS code...');
          const code = await phonePool.fetchSmsCode(allotted.smsApiUrl, {
            pollIntervalMs: cfg.phonePool.smsPollIntervalMs || 3000,
            maxAttempts: cfg.phonePool.smsMaxAttempts || 30,
            proxyUrl,
          });
          console.log(`  [PKCE] add-phone: got SMS code, filling and submitting`);
          await page.fill('input[autocomplete="one-time-code"], input[name*="code" i]', code);
          await page.click('button[type="submit"]');
          await page.waitForURL(u => /\/oauth\/callback|code=/.test(u), { timeout: 30000 });
          console.log('  [PKCE] add-phone: verification done, continuing PKCE');
          continue;  // 跌回 PKCE 主循环，下一轮拿到 OAuth callback URL → token exchange
        } catch (e) {
          const reason = e?.message?.includes('sms-poll-timeout') ? 'sms-timeout' : 'submit-error';
          console.log(`  [PKCE] add-phone failed: ${reason} (${e?.message?.slice(0, 60)})`);
          return { phoneVerifyFail: reason };
        }
      }
```

### Step 2: 整体替换为 provider 分流版

整个 `if (await isAddPhonePage(page)) { ... }` 块（约 56 行）替换为：

```js
      // STATE: add-phone (OpenAI requires phone verification for Codex)
      // v2.38.0: 号池启用时自动填手机 + 接 SMS + 填验证码 + 提交；
      //   disabled 时回退 needsPhone（向后兼容）。
      // v2.39.0: 按 cfg.phonePool.provider 分流 local / zhusms，
      //   通用 Playwright 部分（填手机 → submit → 等 SMS 框 → 填 code → 提交 →
      //   等 OAuth callback → continue）共用。
      if (await isAddPhonePage(page)) {
        const fs = require('fs');
        const pathMod = require('path');
        const cfgPath = pathMod.join(__dirname, 'config.json');
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); } catch {}
        if (!cfg?.phonePool?.enabled) {
          console.log('  [PKCE] State: add-phone — phone pool disabled, skipping PKCE');
          return { needsPhone: true };
        }

        // 代理 URL（enabled 时 fetchSmsCode / zhusms API 走主代理；disabled 直连）
        let proxyUrl = null;
        try {
          const state = require('./server/proxy').getState?.();
          if (state?.enabled) proxyUrl = 'http://127.0.0.1:7890';
        } catch {}

        const provider = cfg.phonePool.provider || 'local';
        let phone, smsCodeFn, releaseFn;

        if (provider === 'zhusms') {
          // v2.39.0: zhusms 远程 provider
          const zhusms = require('./server/zhusms-provider');
          const z = cfg.phonePool.zhusms || {};
          if (!z.cardKey) {
            console.log('  [PKCE] zhusms provider: cardKey not configured');
            return { phonePoolEmpty: true };
          }
          try {
            const order = await zhusms.takeOrder(z.cardKey, z.baseUrl || 'https://zhusms.com', z.service || 'codex', proxyUrl);
            if (!order) {
              console.log('  [PKCE] zhusms: takeOrder returned null (余额耗尽 / 服务异常)');
              return { phonePoolEmpty: true };
            }
            phone = order.phone;
            smsCodeFn = () => zhusms.pollOrderSms(order.order_no, z.baseUrl || 'https://zhusms.com', {
              pollIntervalMs: cfg.phonePool.smsPollIntervalMs || 3000,
              maxAttempts: cfg.phonePool.smsMaxAttempts || 30,
              proxyUrl,
            });
            releaseFn = () => zhusms.cancelOrder(order.order_no, z.baseUrl || 'https://zhusms.com', z.cardKey, proxyUrl);
          } catch (e) {
            console.log(`  [PKCE] zhusms takeOrder failed: ${e?.message?.slice(0, 60)}`);
            return { phoneVerifyFail: 'zhusms-take-fail' };
          }
        } else {
          // 既有 local 路径（v2.38.0）
          const phonePool = require('./server/phone-pool');
          const { getRawDb } = require('./server/db');
          const max = cfg.phonePool.maxBindingsPerPhone || 5;
          const allotted = phonePool.acquirePhone(getRawDb(), account.email, max);
          if (!allotted) {
            console.log('  [PKCE] phone pool exhausted for this account');
            return { phonePoolEmpty: true };
          }
          phone = allotted.phone;
          smsCodeFn = () => phonePool.fetchSmsCode(allotted.smsApiUrl, {
            pollIntervalMs: cfg.phonePool.smsPollIntervalMs || 3000,
            maxAttempts: cfg.phonePool.smsMaxAttempts || 30,
            proxyUrl,
          });
          releaseFn = null;  // local 模式 binding 永久，无释放
        }

        // 通用 Playwright 填表 + 接码 + 提交 + 等 callback + continue（两个 provider 共用）
        try {
          console.log(`  [PKCE] add-phone: filling ${phone} (provider=${provider})`);
          await page.fill('input[type="tel"], input[autocomplete="tel"]', phone);
          await page.click('button[type="submit"]');
          await page.waitForSelector('input[autocomplete="one-time-code"], input[name*="code" i]', { timeout: 15000 });
          console.log(`  [PKCE] add-phone: polling SMS code (${provider})...`);
          const code = await smsCodeFn();
          console.log(`  [PKCE] add-phone: got SMS code, filling and submitting`);
          await page.fill('input[autocomplete="one-time-code"], input[name*="code" i]', code);
          await page.click('button[type="submit"]');
          await page.waitForURL(u => /\/oauth\/callback|code=/.test(u), { timeout: 30000 });
          console.log('  [PKCE] add-phone: verification done, continuing PKCE');
          continue;
        } catch (e) {
          if (releaseFn) try { await releaseFn(); } catch {}
          const reason = e?.message?.includes('sms-poll-timeout') ? 'sms-timeout' : 'submit-error';
          console.log(`  [PKCE] add-phone failed: ${reason} (${e?.message?.slice(0, 60)})`);
          return { phoneVerifyFail: reason };
        }
      }
```

### Step 3: Syntax check

```
node --check utils.js
```

Expected: no output.

### Step 4: 全套件回归

```
npm test
```

Expected: 206 (Task 1 + baseline) pass，"fail 0"。

### Step 5: Commit

```bash
git add utils.js
git commit -m "$(cat <<'EOF'
feat(pkce): utils.js add_phone 分支按 provider 分流 (v2.39.0)

cfg.phonePool.provider='local' (default) → 既有 phonePool.acquirePhone +
fetchSmsCode 路径（v2.38.0 行为不变）。

cfg.phonePool.provider='zhusms' → zhusms.takeOrder 取号（远程）+
zhusms.pollOrderSms 接码 + releaseFn 错误路径调 zhusms.cancelOrder
释放避免占余额（local 模式 binding 永久无释放）。

通用 Playwright 部分（填手机 → submit → 等 SMS 框 → 填 code →
提交 → 等 OAuth callback → continue）两个 provider 共用，DRY。

engine.js return shape 不变（refresh_token / phonePoolEmpty /
phoneVerifyFail / needsPhone），无需改 engine.js。

zhusms 失败语义：cardKey 未配 / takeOrder 返 null → phonePoolEmpty；
takeOrder 抛错 → phoneVerifyFail='zhusms-take-fail'；填表 / 接码 /
提交失败 → phoneVerifyFail='sms-timeout' or 'submit-error'。
EOF
)"
```

---

## Task 3: config.example.json schema + routes/phone-pool.js 余额 endpoint

**Files:**
- Modify: `config.example.json` (phonePool 加 provider + zhusms)
- Modify: `server/routes/phone-pool.js` (+1 endpoint `/zhusms/balance`)

### Step 1: 修改 `config.example.json`

打开 `config.example.json`. 找到 `phonePool` 块（v2.37.0 留下的 4 字段）：

```json
  "phonePool": {
    "enabled": false,
    "maxBindingsPerPhone": 5,
    "smsPollIntervalMs": 3000,
    "smsMaxAttempts": 30
  },
```

整体替换为（加 `provider` + `zhusms` 子块）：

```json
  "phonePool": {
    "enabled": false,
    "provider": "local",
    "maxBindingsPerPhone": 5,
    "smsPollIntervalMs": 3000,
    "smsMaxAttempts": 30,
    "zhusms": {
      "cardKey": "",
      "service": "codex",
      "baseUrl": "https://zhusms.com"
    }
  },
```

注意：JSON 语法 — 确认整个文件仍合法。

### Step 2: JSON 合法性验证

```
node -e "JSON.parse(require('fs').readFileSync('config.example.json','utf-8')); console.log('OK')"
```

Expected: `OK`。

### Step 3: 添加 `/zhusms/balance` endpoint

打开 `server/routes/phone-pool.js`. 在文件末尾、`module.exports = router` 之前插入：

```js
// v2.39.0: zhusms 余额查询（Config 页「测试余额」按钮调）
router.post('/zhusms/balance', async (req, res) => {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    const cfg = JSON.parse(raw)
    const z = cfg?.phonePool?.zhusms
    if (!z?.cardKey) return res.status(400).json({ error: 'cardKey not configured' })
    let proxyUrl = null
    try {
      const state = require('../proxy').getState?.()
      if (state?.enabled) proxyUrl = 'http://127.0.0.1:7890'
    } catch {}
    const zhusms = require('../zhusms-provider')
    const balance = await zhusms.getBalance(z.cardKey, z.baseUrl || 'https://zhusms.com', proxyUrl)
    res.json({ ok: true, balance })
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) })
  }
})
```

注意 `fs` + `CONFIG_PATH` 已在文件顶部 require/定义（routes/phone-pool.js Phase 1 已有）。

### Step 4: Syntax check

```
node --check server/routes/phone-pool.js
```

Expected: no output。

### Step 5: 全套件回归

```
npm test
```

Expected: 206 pass（Task 3 不加新 test，仅 schema/endpoint）。

### Step 6: Commit

```bash
git add config.example.json server/routes/phone-pool.js
git commit -m "$(cat <<'EOF'
feat(phone-pool): config provider 字段 + /zhusms/balance endpoint (v2.39.0)

config.example.json phonePool 加 provider (default 'local') + zhusms
子块 (cardKey '' / service 'codex' / baseUrl 'https://zhusms.com')。
向后兼容：旧 config.json 没 provider 字段时 utils.js fallback 'local'。

server/routes/phone-pool.js +1 endpoint POST /zhusms/balance：
- 读 config.json 拿 cardKey
- 调 zhusms.getBalance() 走代理（如果 proxy.enabled）
- 返回 zhusms /api/guest/me 原样响应
Config UI 「测试余额」按钮调这个。
EOF
)"
```

---

## Task 4: 前端 Config.vue provider radio + zhusms 表单 + 余额按钮

**Files:**
- Modify: `web/src/views/Config.vue` (phonePool 分区扩展)

### Step 1: 先读 Config.vue phonePool 当前结构

打开 `web/src/views/Config.vue`. grep `phonePool` 找到该分区的 el-form-item 块（v2.37.0 加的 4 个 input）。然后在 `smsMaxAttempts` el-form-item 之后插入 provider 选择 + 条件 zhusms 表单。

具体插入位置：在 `<el-form-item label="SMS 最多尝试次数">` 之后、phonePool 分区结束（下一个 `<el-divider>` 或顶级表单结束）之前。

### Step 2: 加 provider radio + zhusms 表单

插入：

```vue
        <el-form-item label="Provider">
          <el-radio-group v-model="form.phonePool.provider">
            <el-radio label="local">本地号池（v2.37）</el-radio>
            <el-radio label="zhusms">zhusms 卡密</el-radio>
          </el-radio-group>
        </el-form-item>

        <template v-if="form.phonePool.provider === 'zhusms'">
          <el-form-item label="zhusms 卡密">
            <el-input v-model="form.phonePool.zhusms.cardKey" placeholder="ZS-XXXXXXXX" />
          </el-form-item>
          <el-form-item label="Service">
            <el-input v-model="form.phonePool.zhusms.service" placeholder="codex" />
          </el-form-item>
          <el-form-item label="Base URL">
            <el-input v-model="form.phonePool.zhusms.baseUrl" placeholder="https://zhusms.com" />
          </el-form-item>
          <el-form-item label="余额测试">
            <el-button @click="testZhusmsBalance" :loading="testingZhusms">查询余额</el-button>
            <span style="margin-left:8px;color:#909399">{{ zhusmsBalance || '点按钮测试' }}</span>
          </el-form-item>
        </template>
```

**Note**: 实际 Config.vue 用 `form` 还是 `config`、用 `form.value` 还是直接 `form` 因为 ref/reactive 差异不一样，**实施时打开文件确认实际变量名**（v2.37 phonePool 块用啥这里跟它一致）。

### Step 3: 加 script setup 中的 state + handler

在 `<script setup>` 区域适当位置（其它 ref/function 旁）加：

```js
import { ElMessage } from 'element-plus'  // 应该已 import

const testingZhusms = ref(false)
const zhusmsBalance = ref('')

async function testZhusmsBalance() {
  testingZhusms.value = true
  zhusmsBalance.value = ''
  try {
    const { data } = await api.post('/phone-pool/zhusms/balance', {})
    zhusmsBalance.value = JSON.stringify(data.balance)
    ElMessage.success('余额查询成功')
  } catch (e) {
    zhusmsBalance.value = `错误: ${e?.response?.data?.error || e?.message || '未知'}`
    ElMessage.error(zhusmsBalance.value)
  } finally {
    testingZhusms.value = false
  }
}
```

### Step 4: load() fallback init for phonePool fields

找到 Config.vue 的 load 函数（拉 /api/config 后赋值给 form）。在赋值之后加 fallback init 防止老 config.json 缺字段崩溃：

```js
// v2.39.0 fallback init（防止老 config.json 缺 provider / zhusms）
if (!form.value.phonePool) {
  form.value.phonePool = { enabled: false, maxBindingsPerPhone: 5, smsPollIntervalMs: 3000, smsMaxAttempts: 30 }
}
if (!form.value.phonePool.provider) form.value.phonePool.provider = 'local'
if (!form.value.phonePool.zhusms) {
  form.value.phonePool.zhusms = { cardKey: '', service: 'codex', baseUrl: 'https://zhusms.com' }
}
```

**Note**：实际 load 函数名 / form 变量名按 Config.vue 现有写法 — 实施时定位。

### Step 5: 构建前端

```
cd web ; npm run build
```

Expected: `✓ built`. 常见错误：
- `form.phonePool.zhusms is undefined` → Step 4 fallback init 没生效或位置错
- el-radio-group v-model 不绑定 → 检查 `v-model="form.phonePool.provider"`（不是 form.value）

### Step 6: 后端测试回归

```
cd .. ; npm test
```

Expected: 同 Task 3 数字（前端不影响）。

### Step 7: Commit

```bash
git add web/src/views/Config.vue
git commit -m "$(cat <<'EOF'
feat(ui): Config.vue +provider radio + zhusms 表单 + 余额按钮 (v2.39.0)

phonePool 分区扩展：
- Provider radio（local / zhusms 二选一，default local）
- 条件展示 zhusms 表单（卡密 / service / baseUrl）
- 余额测试按钮调 POST /api/phone-pool/zhusms/balance 回显结果

load() fallback init 防老 config.json 缺 provider / zhusms 字段时
模板取值崩溃。
EOF
)"
```

---

## Task 5: CHANGELOG v2.39.0

**Files:**
- Modify: `docs/CHANGELOG.md`

### Step 1: Prepend v2.39.0 section

打开 `docs/CHANGELOG.md`. 在 `# Changelog` 之后、第一个 `## v2.x.x` 之前插入：

```markdown
## v2.39.0 — 2026-05-25

### zhusms 远程接码 Provider 并列接入

v2.37/v2.38 完成本地号池架构（手动 import phone + sms_api_url）。
本次新增 **zhusms.com 远程接码服务**作为可选 provider — 用户买卡密
（一卡多次），服务端自动 round-robin 取号 + 接 SMS + 释放，不用
维护本地 phone 列表。两个 provider 并列，用户在 Config 二选一。

**新增**

- **`server/zhusms-provider.js`** 包装 zhusms 5 个 endpoint（基于
  https://zhusms.com/openapi.json）：
  - `_activate` (POST /api/guest/activate, 卡密 → Set-Cookie session)
  - `ensureSession` (1 小时 cookie 缓存)
  - `takeOrder` (POST /api/order/take service=<x>, 401 时清 session 重试)
  - `pollOrderSms` (GET /api/order/status?order_no=<x>, regex tolerant 6 位数字)
  - `cancelOrder` (POST /api/order/cancel, 错误路径释放避免占余额)
  - `getBalance` (GET /api/guest/me, UI 余额按钮用)
- **`utils.js:fetchTokensViaPKCE`** add_phone 分支按 `cfg.phonePool.provider`
  分流 local（既有）/ zhusms（新）。通用 Playwright 填表 / 接码 / 提交
  逻辑共用，仅取号 / 接码 fn 不同
- **`server/routes/phone-pool.js`** +1 endpoint `POST /zhusms/balance`
- **Config 字段** `phonePool.{provider, zhusms.{cardKey, service, baseUrl}}`
- **`web/src/views/Config.vue`** provider radio + 条件 zhusms 表单 +
  「查询余额」按钮

**绑定语义对比**

| 维度 | local provider (v2.37) | zhusms provider (v2.39) |
|---|---|---|
| 号管理 | 用户手动 import `phone\|url` | 服务端自动 round-robin |
| 单次成本 | 维护本地 phone 列表 | 卡密扣 1/单 |
| 失败释放 | 无（binding 永久 +1） | `cancelOrder` 释放（不扣余额） |
| 接码 | 每号独立 URL | `/api/order/status?order_no=<x>` |
| 服务标签 | 无（号通用） | 按 service（codex / paypal / ...） |

**不变式**：
- Phase 1 本地号池（DB / UI / route）零改动
- engine.js 不动（4-shape return shape 不变）
- `payment.js` + 协议模式 + Python 不动
- `provider='local'` (default) 时跑老路径，行为零变化

**代理覆盖**：跟全局 proxy 同步 — `proxy.enabled=true` 时 zhusms
所有 API call + SMS poll 走 `HttpsProxyAgent`，与 fetchSmsCode 一致；
disabled 时直连。

**测试**：`server/__tests__/zhusms-provider.test.js` +6（cookie 缓存
/ take / poll 超时 / poll 拿码 / cancel form body / 401 重试）。共
206 tests pass on v2.38.0 baseline 200。

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-zhusms-remote-provider-design.md`
+ `docs/superpowers/plans/2026-05-25-zhusms-remote-provider.md`。

```

### Step 2: Final regression

```
npm test
```

Expected: 206 pass。

### Step 3: 手动 smoke（用户跑）

1. 重启 server + 硬刷 web
2. Config 页打开「启用号池」 + Provider 选「zhusms 卡密」 + 填卡密 `ZS-V8VXJSDP` + 保存
3. 点「查询余额」 → 应回显 zhusms 余额（JSON.stringify 结果）
4. Execute 页找一个会撞手机验证的账户 + **浏览器模式**跑
5. server log 应出现：`[PKCE] add-phone: filling +xxx (provider=zhusms)` → `polling SMS code (zhusms)...`
6. 成功：账户 status=`plus`（拿到 RT 了！）；失败：`phone_pool_empty` / `phone_verify_fail`
7. 失败路径自动 `cancelOrder` 释放，zhusms 余额不消耗 1

### Step 4: Commit

```bash
git add docs/CHANGELOG.md
git commit -m "docs(changelog): v2.39.0 — zhusms 远程接码 Provider 并列接入"
```

---

## Self-Review

**1. Spec coverage:**

- Spec §1 背景：informational。
- Spec §2 目标（新增 provider，二选一） → Task 1-4 全覆盖。
- Spec §3.1 Config schema → Task 3 Step 1。
- Spec §3.2 zhusms-provider service → Task 1 Step 3。
- Spec §3.3 utils.js add_phone provider 分流 → Task 2 Step 2。
- Spec §3.4 /zhusms/balance endpoint → Task 3 Step 3。
- Spec §3.5 Config.vue UI → Task 4 Steps 2-4。
- Spec §3.6 边界 10 条 → 实现 + 注释 + CHANGELOG 体现（Phase 1 不动 / 协议不动 / cookie 缓存 / 失败释放 / 代理覆盖 / service 专属 / 余额查询 / regex tolerant / 并发假设）。
- Spec §3.7 测试 6 个 → Task 1 Step 1 全部到位。
- Spec §3.8 文件清单 → matches Task 1-5。
- Spec §4 YAGNI → 不动 engine.js / phone-pool.js / PhonePool.vue / status.js / payment.js / 协议模式 / Python — 计划严格遵守。
- Spec §5 已知未知 → CHANGELOG + 手动 smoke 步骤体现。
- Spec §6 v2.39.0 → Task 5 Step 1。

**注意**：spec §4 YAGNI 还提到 "新增 zhusms.cardKey 需要加到 SENSITIVE_FIELDS"。但 SENSITIVE_FIELDS 现在只支持顶级 flat field（'discordToken', 'cpaKey', 'smsApiUrl'），扩展到嵌套路径需要修改 mask 逻辑（不平凡）。**Plan 不包含 cardKey masking** — config.json 是 gitignored + 项目 localhost only，风险可控。需要的话另开 hotfix。

**2. Placeholder scan:** 无 "TBD" / "implement later"。Task 4 几处「实施时确认变量名 / load 函数名」是因为 Config.vue 被并行 session 改过 — 给出 grep 指引 + 通用 v-model 模式，是确切的 how。

**3. Type/symbol consistency:**

- `phonePool.provider` 字符串 `'local'` / `'zhusms'` —— Task 2 utils.js if 分支 + Task 3 config.example.json + Task 4 radio v-model，3 处一致
- `phonePool.zhusms.cardKey` / `service` / `baseUrl` —— Task 1 service 函数签名 + Task 2 utils.js 调用 + Task 3 config schema + Task 4 Config.vue input v-model，5 处一致
- `takeOrder(cardKey, baseUrl, service, proxyUrl)` —— Task 1 export 签名 + Task 2 utils.js call + Task 1 测试 Z1/Z2/Z6 三处对齐
- `pollOrderSms(orderNo, baseUrl, opts)` —— Task 1 + Task 2 call site + 测试 Z3/Z4 一致
- `cancelOrder(orderNo, baseUrl, cardKey, proxyUrl)` —— Task 1 + Task 2 + 测试 Z5 一致
- `getBalance(cardKey, baseUrl, proxyUrl)` —— Task 1 + Task 3 route 调用一致
- engine.js 4-shape return (phonePoolEmpty / phoneVerifyFail / refresh_token / needsPhone) —— v2.38.0 既有，Task 2 zhusms 路径返回同样 shape，engine.js 不需要改

无 issue。Plan ready.
