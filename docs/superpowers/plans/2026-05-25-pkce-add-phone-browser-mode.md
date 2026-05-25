# v2.38.0 浏览器模式 PKCE add_phone 流程 (Phase 2a/2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 浏览器模式 PKCE 检测到 add_phone 页时消费 v2.37.0 号池，Playwright 自动填手机 + 接 SMS + 填验证码 + 提交 → 继续 token exchange。失败分类清晰（phone_pool_empty / phone_verify_fail）。

**Architecture:** `phone-pool.js:fetchSmsCode` 加 proxyUrl 支持。`utils.js` 加 `isAddPhonePage` helper + 扩展 `fetchTokensViaPKCE` 在 add_phone 分支调号池 + Playwright 填表 + fetchSmsCode 接码。`engine.js` 两处 PKCE 调用站处理 4 种 return shape。`status.js` + 3 Vue 视图加 2 个新 status 码。

**Tech Stack:** Playwright（既有 chromium.connectOverCDP）、`https-proxy-agent`（已在 server/discord-gateway.js 用）、sql.js、Vue 3 + Element Plus、node:test。

**Spec:** `docs/superpowers/specs/2026-05-25-pkce-add-phone-browser-mode-design.md`

---

## File Structure

| 文件 | 改动 | 类型 |
|---|---|---|
| `server/phone-pool.js` | fetchSmsCode 加 proxyUrl 参数 + HttpsProxyAgent | 修改 |
| `server/__tests__/phone-pool.test.js` | +1 单测 (P7 proxyUrl 走 agent) | 修改 |
| `utils.js` | +`isAddPhonePage` 导出 + fetchTokensViaPKCE 替换 add-phone 分支 | 修改 |
| `server/__tests__/utils-isAddPhonePage.test.js` | 新建 +3 单测 | 新建 |
| `server/engine.js` | 2 处 PKCE 调用站处理 4 种 return shape | 修改 |
| `web/src/status.js` | TYPE_MAP / LABEL_MAP / GROUP_ORDER / ERROR_STATUSES 各 +2 | 修改 |
| `__tests__/status-row-class.test.js` | +2 断言 | 修改 |
| `web/src/views/Execute.vue` | 状态筛选下拉 +2 option | 修改 |
| `web/src/views/Accounts.vue` | 状态筛选下拉 +2 option | 修改 |
| `web/src/views/Results.vue` | 状态筛选下拉 +2 option | 修改 |
| `docs/CHANGELOG.md` | v2.38.0 节 | 修改 |

依赖：Task 1（phone-pool proxy）→ Task 2（utils.js add_phone 处理）→ Task 3（engine.js call sites） → Task 4（前端 status + 视图） → Task 5（CHANGELOG）。线性。

---

## Task 1: `server/phone-pool.js` — fetchSmsCode 加 proxyUrl 支持

**Files:**
- Modify: `server/phone-pool.js:103-131` (fetchSmsCode 函数体)
- Modify: `server/__tests__/phone-pool.test.js` (append 1 test)

### Step 1: 写失败测试

打开 `server/__tests__/phone-pool.test.js`. 在文件末尾追加（紧贴最后一个 test 之后）：

```js
test('P7 fetchSmsCode 传 proxyUrl 时 fetch 收到 HttpsProxyAgent', async () => {
  // mock global.fetch 拿到 agent 参数
  const calls = []
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, agent: opts?.agent })
    // 返回含 6 位数字的成功响应，让 fetchSmsCode 1 次拿到 code 退出
    return { ok: true, text: async () => 'your code: 123456' }
  }
  try {
    const code = await phonePool.fetchSmsCode('http://example.com/sms?k=1', { proxyUrl: 'http://127.0.0.1:7890' })
    assert.strictEqual(code, '123456')
    assert.strictEqual(calls.length, 1, 'fetch should be called once')
    const { HttpsProxyAgent } = require('https-proxy-agent')
    assert.ok(calls[0].agent instanceof HttpsProxyAgent, 'agent should be HttpsProxyAgent instance')
  } finally {
    globalThis.fetch = origFetch
  }
})
```

### Step 2: 跑测试验证 FAIL

```
node --test server/__tests__/phone-pool.test.js
```

Expected: P7 FAIL（当前 fetchSmsCode 没 proxyUrl 参数，fetch 收到的 agent 是 undefined → `calls[0].agent instanceof HttpsProxyAgent` 为 false）。

### Step 3: 实现 fetchSmsCode proxyUrl 支持

打开 `server/phone-pool.js`. 找到 `async function fetchSmsCode(smsApiUrl, { pollIntervalMs = 3000, maxAttempts = 30, signal } = {})` 函数（约 line 103-131）。

整体替换为：

```js
async function fetchSmsCode(smsApiUrl, { pollIntervalMs = 3000, maxAttempts = 30, signal, proxyUrl } = {}) {
  // v2.38.0: proxyUrl 提供时走 HttpsProxyAgent（跟 server/discord-gateway.js 同模式），
  // undefined 时 fetch 直连（向后兼容 Phase 1 调用方）。
  let agent
  if (proxyUrl) {
    const { HttpsProxyAgent } = require('https-proxy-agent')
    agent = new HttpsProxyAgent(proxyUrl)
  }
  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    try {
      const resp = await fetch(smsApiUrl, { signal, agent })
      if (!resp.ok) {
        // HTTP 错误体内含 6 位数字会被误识别，跳过本轮继续
      } else {
        const text = await resp.text()
        const m = text.match(/\b(\d{6})\b/)
        if (m) return m[1]
      }
    } catch (e) {
      if (e?.name === 'AbortError') throw e
    }
    if (i < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, pollIntervalMs))
    }
  }
  throw new Error('sms-poll-timeout')
}
```

### Step 4: 跑测试验证 PASS

```
node --test server/__tests__/phone-pool.test.js
```

Expected: 7 测试 pass（原 6 + P7）。

### Step 5: 全套件回归

```
npm test
```

Expected: 既有 baseline + 1 新（v2.37.0 后基线 194 + 1 = 195），"fail 0"。

### Step 6: Commit

```bash
git add server/phone-pool.js server/__tests__/phone-pool.test.js
git commit -m "$(cat <<'EOF'
feat(phone-pool): fetchSmsCode 加 proxyUrl 支持 (v2.38.0 Phase 2a)

Phase 1 fetchSmsCode 用 globalThis.fetch 直连，Phase 2 浏览器 PKCE
add_phone 流程要全程走代理（与配置一致），所以加 proxyUrl 可选参数：
- proxyUrl 提供 → require('https-proxy-agent') 创建 HttpsProxyAgent
  跟 server/discord-gateway.js 同模式
- undefined → fetch 直连（向后兼容 Phase 1 调用方）

P7 单测 mock globalThis.fetch 验证传 proxyUrl 时 fetch 拿到的 agent
是 HttpsProxyAgent 实例。
EOF
)"
```

---

## Task 2: `utils.js` — `isAddPhonePage` + 扩展 fetchTokensViaPKCE

**Files:**
- Modify: `utils.js:326-330` (add-phone 分支替换为号池消费逻辑)
- Modify: `utils.js:444` (module.exports 加 isAddPhonePage)
- Create: `server/__tests__/utils-isAddPhonePage.test.js`

### Step 1: 写失败测试

新建 `server/__tests__/utils-isAddPhonePage.test.js`:

```js
const test = require('node:test')
const assert = require('node:assert')

let isAddPhonePage

test.before(() => {
  isAddPhonePage = require('../../utils').isAddPhonePage
})

test('IAP1 URL 含 /add-phone 时直接返回 true', async () => {
  const page = {
    url: () => 'https://auth.openai.com/add-phone?continue=...',
    waitForSelector: () => Promise.reject(new Error('should not be called')),
  }
  const r = await isAddPhonePage(page)
  assert.strictEqual(r, true)
})

test('IAP2 URL 不匹配但 DOM 含 input[type=tel] 返回 true', async () => {
  const page = {
    url: () => 'https://auth.openai.com/oauth/authorize',
    waitForSelector: async (sel, opts) => {
      assert.match(sel, /tel/)
      return { fake: 'element' }
    },
  }
  const r = await isAddPhonePage(page)
  assert.strictEqual(r, true)
})

test('IAP3 URL 不匹配 + 无 phone input 返回 false', async () => {
  const page = {
    url: () => 'https://auth.openai.com/oauth/authorize',
    waitForSelector: async () => { throw new Error('Timeout') },
  }
  const r = await isAddPhonePage(page)
  assert.strictEqual(r, false)
})
```

### Step 2: 跑测试验证 FAIL

```
node --test server/__tests__/utils-isAddPhonePage.test.js
```

Expected: 3 FAIL（`isAddPhonePage is not a function`，函数还没导出）。

### Step 3: 实现 isAddPhonePage + 扩展 fetchTokensViaPKCE

打开 `utils.js`. 找到 `fetchTokensViaPKCE` 定义（line 145）。**在 `async function fetchTokensViaPKCE` 之前**插入 helper：

```js
/**
 * v2.38.0: 判定当前 Playwright page 是否在 add_phone / phone-required 验证页。
 * 双重判定（任一命中即视为 add_phone 页）：
 * - URL 含 /add-phone / /add_phone / /phone-required / /phone_required（大小写不敏感）
 * - DOM 含 input[type="tel"] 或 input[autocomplete="tel"]
 * @param {Object} page Playwright Page (or duck-typed for tests)
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

接下来在 `fetchTokensViaPKCE` 内找 line 326-330 的 add-phone 分支：

```js
      // STATE: add-phone (OpenAI requires phone verification for Codex)
      if (url.includes('add-phone') || url.includes('phone-required')) {
        console.log('  [PKCE] State: add-phone — phone verification required, skipping PKCE');
        return { needsPhone: true };
      }
```

替换为：

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

        // 代理：enabled 时 fetchSmsCode 走 http://127.0.0.1:7890（Chrome 已自动走）；
        // disabled 时直连。
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

**注意**：上面的代码假设外层 while 循环存在 `continue` 关键字能回到下一轮 — 看 `fetchTokensViaPKCE` 现有结构（line 184 page.goto → while loop 跑状态机）。**实施时打开 utils.js 145-340 确认 while 循环存在 + continue 语义正确**。

最后修改 `module.exports`（line 444）：

```js
module.exports = { loadAccounts, generateTOTP, randomDelay, abortableSleep, screenshotPath, saveCPAAuthFile, fetchTokensViaPKCE };
```

替换为（追加 `isAddPhonePage`）：

```js
module.exports = { loadAccounts, generateTOTP, randomDelay, abortableSleep, screenshotPath, saveCPAAuthFile, fetchTokensViaPKCE, isAddPhonePage };
```

### Step 4: 跑测试验证 PASS

```
node --test server/__tests__/utils-isAddPhonePage.test.js
```

Expected: 3 pass。

### Step 5: Syntax check + 全套件回归

```
node --check utils.js
npm test
```

Expected: 既有 + Task 1/2 新增（195 + 3 = 198），"fail 0"。

### Step 6: Commit

```bash
git add utils.js server/__tests__/utils-isAddPhonePage.test.js
git commit -m "$(cat <<'EOF'
feat(pkce): 浏览器 add_phone 自动化 + isAddPhonePage 检测 (v2.38.0 Phase 2a)

isAddPhonePage(page) 双重判定（URL + DOM）识别 ChatGPT 手机验证页。
URL 优先 (含 /add[-_]phone 或 /phone[-_]required)；DOM 兜底 (查
input[type=tel] / input[autocomplete=tel])。

fetchTokensViaPKCE 在 add_phone 分支：
- 号池 disabled → 回退 {needsPhone:true} (向后兼容)
- 号池 enabled → acquirePhone(email) → null 时 {phonePoolEmpty:true}
- 拿到号 → Playwright 填 input[type=tel] + 提交 → waitForSelector
  SMS 框 → fetchSmsCode (proxyUrl if proxy.enabled) → 填 + 提交
  → waitForURL OAuth callback → continue 主循环 token exchange
- 任何步骤失败 → {phoneVerifyFail: 'sms-timeout' | 'submit-error'}

3 单测覆盖 isAddPhonePage 3 个分支 (URL 匹配 / DOM 兜底 / 都不命中)。
EOF
)"
```

---

## Task 3: `server/engine.js` — 2 处 PKCE 调用站处理 4 种 return shape

**Files:**
- Modify: `server/engine.js:348-357` (cached-login path PKCE 调用)
- Modify: `server/engine.js:576-584` (post-payment path PKCE 调用)

### Step 1: 修改 cached-login 路径

打开 `server/engine.js`. 找到 line 348-357 区域：

```js
              this.emitStatus({ email: account.email, status: 'running', phase: 'pkce', progress });
              const pkceTokens = await fetchTokensViaPKCE(browser, account, loginResult.lastOtp).catch((e) => { console.log(`  [PKCE] Failed: ${e.message}`); return null; });
              if (pkceTokens && !pkceTokens.needsPhone && pkceTokens.refresh_token) {
                saveCPAAuthFile(account.email, pkceTokens.access_token, pkceTokens);
                finalResult.status = 'plus';
              } else {
                if (pkceTokens?.needsPhone) console.log(`${p} PKCE requires phone verification`);
                else if (pkceTokens && !pkceTokens.refresh_token) console.log(`${p} PKCE returned no refresh_token`);
                saveCPAAuthFile(account.email, pkceTokens?.access_token || loginResult.accessToken, pkceTokens || loginResult.session);
              }
```

替换为（处理 4 种 return shape）：

```js
              this.emitStatus({ email: account.email, status: 'running', phase: 'pkce', progress });
              const pkceTokens = await fetchTokensViaPKCE(browser, account, loginResult.lastOtp).catch((e) => { console.log(`  [PKCE] Failed: ${e.message}`); return null; });
              if (pkceTokens?.refresh_token) {
                saveCPAAuthFile(account.email, pkceTokens.access_token, pkceTokens);
                finalResult.status = 'plus';
              } else if (pkceTokens?.phonePoolEmpty) {
                console.log(`${p} PKCE: phone pool exhausted for this account`);
                this.emitStatus({ email: account.email, status: 'phone_pool_empty', phase: 'pkce', progress, reason: '号池已用尽或全部满' });
                saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
                finalResult.status = 'phone_pool_empty';
              } else if (pkceTokens?.phoneVerifyFail) {
                console.log(`${p} PKCE: phone verify failed (${pkceTokens.phoneVerifyFail})`);
                this.emitStatus({ email: account.email, status: 'phone_verify_fail', phase: 'pkce', progress, reason: pkceTokens.phoneVerifyFail });
                saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
                finalResult.status = 'phone_verify_fail';
              } else {
                // needsPhone (pool disabled) 或其它非成功路径 → plus_no_rt 兜底（保持既有行为）
                if (pkceTokens?.needsPhone) console.log(`${p} PKCE requires phone verification (pool disabled)`);
                else if (pkceTokens && !pkceTokens.refresh_token) console.log(`${p} PKCE returned no refresh_token`);
                saveCPAAuthFile(account.email, pkceTokens?.access_token || loginResult.accessToken, pkceTokens || loginResult.session);
              }
```

### Step 2: 修改 post-payment 路径

找到 line 576-584 区域（第二处 PKCE 调用，post-payment）：

```js
                    this.emitStatus({ email: account.email, status: 'running', phase: 'pkce', progress });
                    const pkceTokens = await fetchTokensViaPKCE(browser, account, loginResult.lastOtp).catch((e) => { console.log(`  [PKCE] Failed: ${e.message}`); return null; });
                    if (pkceTokens && !pkceTokens.needsPhone && pkceTokens.refresh_token) {
                      // ... 既有 success 处理 (saveCPAAuthFile 等) ...
                    } else {
                      if (pkceTokens?.needsPhone) console.log(`${p} PKCE requires phone verification`);
                      // ... 既有 fallback 处理 ...
                    }
```

读取完整 line 576-595 看实际 success / fallback 内容（与 cached-login 路径不完全一样），然后用同样的 4-分支模式重构。**实施时打开 engine.js 看 post-payment PKCE 路径完整代码**，按相同 pattern 加 phonePoolEmpty / phoneVerifyFail 分支 + emitStatus。

具体例子（按读到的实际代码改写）：

```js
                    this.emitStatus({ email: account.email, status: 'running', phase: 'pkce', progress });
                    const pkceTokens = await fetchTokensViaPKCE(browser, account, loginResult.lastOtp).catch((e) => { console.log(`  [PKCE] Failed: ${e.message}`); return null; });
                    if (pkceTokens?.refresh_token) {
                      // 既有 success 块（saveCPAAuthFile + finalResult.status='plus' 等）
                      // ... 保留原内容 ...
                    } else if (pkceTokens?.phonePoolEmpty) {
                      console.log(`${p} PKCE: phone pool exhausted for this account`);
                      this.emitStatus({ email: account.email, status: 'phone_pool_empty', phase: 'pkce', progress, reason: '号池已用尽或全部满' });
                      finalResult.status = 'phone_pool_empty';
                    } else if (pkceTokens?.phoneVerifyFail) {
                      console.log(`${p} PKCE: phone verify failed (${pkceTokens.phoneVerifyFail})`);
                      this.emitStatus({ email: account.email, status: 'phone_verify_fail', phase: 'pkce', progress, reason: pkceTokens.phoneVerifyFail });
                      finalResult.status = 'phone_verify_fail';
                    } else {
                      if (pkceTokens?.needsPhone) console.log(`${p} PKCE requires phone verification (pool disabled)`);
                      // 既有 fallback 块 ...
                    }
```

### Step 3: Syntax check

```
node --check server/engine.js
```

Expected: no output.

### Step 4: 全套件回归

```
npm test
```

Expected: 既有 + Task 1/2 新增 = 198 (Task 3 无新测), "fail 0"。

### Step 5: Commit

```bash
git add server/engine.js
git commit -m "$(cat <<'EOF'
feat(engine): PKCE 调用站处理 add_phone 4 种 return shape (v2.38.0 Phase 2a)

fetchTokensViaPKCE v2.38.0 后 return 4 种 shape:
- {refresh_token}        — 既有成功路径
- {phonePoolEmpty:true}  — 号池空 / 全满
- {phoneVerifyFail:str}  — SMS 超时 / submit-error
- {needsPhone:true}      — 号池 disabled 回退 (老兼容路径)

2 处 PKCE 调用站（line 348 cached-login 路径 + line 576 post-payment
路径）从原 2-branch (success / fallback) 改为 4-branch。

新增 status:
- phone_pool_empty → emitStatus + finalResult.status 同步
- phone_verify_fail → 同上

needsPhone 仍走 fallback 保 plus_no_rt 老行为（号池 disabled 时）。
EOF
)"
```

---

## Task 4: 前端 — `web/src/status.js` + 3 个视图 status 筛选下拉 +2

**Files:**
- Modify: `web/src/status.js` (TYPE_MAP / LABEL_MAP / GROUP_ORDER / ERROR_STATUSES 各 +2)
- Modify: `__tests__/status-row-class.test.js` (+2 断言)
- Modify: `web/src/views/Execute.vue` / `Accounts.vue` / `Results.vue` 各 +2 option

### Step 1: 写失败测试 — `__tests__/status-row-class.test.js`

打开 `__tests__/status-row-class.test.js`. 在文件末尾追加新测试（紧贴最后一个 test 之后）：

```js
test('rowClassFor: v2.38.0 phone_pool_empty 走 warning', () => {
  assert.strictEqual(rowClassFor('phone_pool_empty'), 'row-status-warning')
})

test('rowClassFor: v2.38.0 phone_verify_fail 走 danger', () => {
  assert.strictEqual(rowClassFor('phone_verify_fail'), 'row-status-danger')
})
```

### Step 2: 跑测试验证 FAIL

```
node --test __tests__/status-row-class.test.js
```

Expected: 2 新断言 FAIL（rowClassFor 走 statusType 然后 fallback 'info' → 返回 'row-status-info'，不是 warning/danger）。

### Step 3: 实现 status.js +2 codes

打开 `web/src/status.js`. 找到 TYPE_MAP（约 line 3-19）。在 `verify_error: 'danger'` 之后插入：

```js
  phone_pool_empty: 'warning',
  phone_verify_fail: 'danger',
```

找到 LABEL_MAP（约 line 21-37）。在 `verify_error: 'Stripe验证失败'` 之后插入：

```js
  phone_pool_empty: '号池已用尽',
  phone_verify_fail: '手机验证失败',
```

找到 ERROR_STATUSES（约 line 48）。改 array：

```js
export const ERROR_STATUSES = ['error', 'no_link', 'deactivated', 'no_promo', 'canceled', 'token_expired', 'login_fail', 'phone_pool_empty', 'phone_verify_fail']
```

找到 GROUP_ORDER 数组（约 line 91-105）。在 `'login_fail',` 之后、`'no_link',` 之前插入：

```js
  'phone_pool_empty', // 号池已用尽（v2.38.0）
  'phone_verify_fail', // 手机验证失败（v2.38.0）
```

### Step 4: 跑测试验证 PASS

```
node --test __tests__/status-row-class.test.js
```

Expected: 全过（原 8 + 2 新 = 10 个 assertions in 8 tests，or 10 tests if separate）。

### Step 5: 3 个 Vue 视图加 option

打开 `web/src/views/Execute.vue`. 找 status 筛选 el-select（约 line 38-53），在 `<el-option label="登录失败" value="login_fail" />` 之后追加：

```vue
          <el-option label="号池已用尽" value="phone_pool_empty" />
          <el-option label="手机验证失败" value="phone_verify_fail" />
```

打开 `web/src/views/Accounts.vue`. 同样在状态筛选 `<el-option label="登录失败" value="login_fail" />` 之后追加 2 个 option。

打开 `web/src/views/Results.vue`. 同样追加 2 个 option（位置随其它筛选 option 旁）。

**注意**：如果某个视图 status filter 用 `v-for="opt in EXECUTE_STATUS_FILTER_OPTIONS"` 动态生成（看 Execute.vue 是否这样），新 LABEL_MAP 字段会自动 pick up，无需改模板。**实施时打开各 .vue 看实际写法**。

### Step 6: 构建前端

```
cd web ; npm run build
```

Expected: `✓ built`. 常见错误：
- LABEL_MAP / TYPE_MAP / GROUP_ORDER / ERROR_STATUSES 任一漏改 → 排序 / 行高亮异常但不会编译错
- el-option 嵌入位置错（如套在 </el-select> 外面）→ Vue 编译错

### Step 7: 后端测试回归

```
cd .. ; npm test
```

Expected: 已有 + Task 1/2 新增 + Task 4 状态码测试 (198 + 2 = 200), "fail 0"。

### Step 8: Commit

```bash
git add web/src/status.js __tests__/status-row-class.test.js web/src/views/Execute.vue web/src/views/Accounts.vue web/src/views/Results.vue
git commit -m "$(cat <<'EOF'
feat(ui): phone_pool_empty + phone_verify_fail status 码 (v2.38.0 Phase 2a)

新增 2 个 status 码支持 v2.38.0 浏览器 PKCE add_phone 流程的失败分类:
- phone_pool_empty (warning, 浅黄) — 号池空 / 全满
- phone_verify_fail (danger, 浅红) — SMS 超时 / add_phone 提交失败

web/src/status.js: TYPE_MAP / LABEL_MAP / GROUP_ORDER / ERROR_STATUSES
各 +2。GROUP_ORDER 插入位置在 login_fail 后、no_link 前（账户层面
失败 cluster）。ERROR_STATUSES 让 Accounts.vue 的「计划」列推导为 free
（沿用 v2.32 规则）。

3 个视图 (Execute / Accounts / Results) status 筛选下拉硬编码 list
各 +2 option。

rowClassFor 自动 pickup（v2.33.1 行高亮）。+2 单测断言。
EOF
)"
```

---

## Task 5: CHANGELOG v2.38.0

**Files:**
- Modify: `docs/CHANGELOG.md`

### Step 1: Prepend v2.38.0 section

打开 `docs/CHANGELOG.md`. 在 `# Changelog` 之后、第一个现有 `## v2.x.x` 之前插入：

```markdown
## v2.38.0 — 2026-05-25

### 浏览器模式 PKCE add_phone 自动化 (Phase 2a/2)

v2.37.0 Phase 1 交付了号池基础设施（DB / service / 路由 / UI /
Config）。Phase 2a 接通浏览器模式 PKCE 流程消费号池 —— ChatGPT
要求手机号验证时自动从池里取号、Playwright 填表 + 接 SMS + 填验
证码 + 提交、继续 token exchange。

**完成流程**：

```
PKCE Playwright OAuth flow
    │
    ▼ 检测到 add_phone 页 (URL /add-phone 或 DOM input[type=tel])
    │
    ├─ config.phonePool.enabled=false → return {needsPhone:true} → plus_no_rt (兼容)
    │
    └─ acquirePhone(email) ──┬─ null → return {phonePoolEmpty:true} → status='phone_pool_empty'
                              │
                              └─ {phone, smsApiUrl} → 填 phone + submit
                                                   → wait SMS form
                                                   → fetchSmsCode(proxyUrl if proxy enabled)
                                                   → 填 code + submit
                                                   → wait /oauth/callback
                                                   → continue PKCE 主循环 → token exchange ✓
                                                   │
                                                   └ 任一步失败 → {phoneVerifyFail: 'sms-timeout'|'submit-error'}
                                                                → status='phone_verify_fail'
```

**代理覆盖**：跟全局 proxy 配置同步。`proxy.enabled=true` 时
Chrome 已自动走 `http://127.0.0.1:7890`（既有），`fetchSmsCode` 显
式传 proxyUrl 走 HttpsProxyAgent；`proxy.enabled=false` 时全部直连。

**新增**：

- **`server/phone-pool.js:fetchSmsCode`** 加 `proxyUrl` 参数（接 HttpsProxyAgent）
- **`utils.js`** +`isAddPhonePage(page)` 导出（URL + DOM 双重判定）
- **`utils.js:fetchTokensViaPKCE`** add_phone 分支扩展：号池消费 + Playwright 填表 +
  接 SMS + continue 主循环（成功）or 4 种新 return shape（失败分类）
- **`server/engine.js`** 2 处 PKCE 调用站（cached-login + post-payment）处理新 return shape
- **新 status 码**：`phone_pool_empty` (warning) + `phone_verify_fail` (danger)，
  加入 ERROR_STATUSES → Accounts 计划列推导 free（v2.32 规则）
- **前端**：status.js +2 codes + 3 视图筛选下拉 +2 option

**不变式**：
- `config.phonePool.enabled=false` → 完全跳过号池逻辑（向后兼容老行为）
- 协议模式 `protocol_register.py` / `protocol-engine.js` **不动**（Phase 2b 另开 spec）
- `payment.js` PayPal SMS 流程**不动**（继续用 config.smsApiUrl + handleSmsVerification）
- Python 任何文件**不动**

**测试**：`server/__tests__/phone-pool.test.js` +1 (P7 proxyUrl agent) +
`server/__tests__/utils-isAddPhonePage.test.js` +3（URL match / DOM
fallback / both miss）+ `__tests__/status-row-class.test.js` +2 断言。

**Phase 2b 预览**（独立 spec，需用户先抓包）：协议模式 PKCE add_phone
实现，需要 Python bidirectional stdin + OpenAI add_phone endpoint
URLs（用 Chrome DevTools Network 抓 POST 请求 + payload + response shape）。

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-pkce-add-phone-browser-mode-design.md`
+ `docs/superpowers/plans/2026-05-25-pkce-add-phone-browser-mode.md`。

```

### Step 2: Final regression

```
npm test
```

Expected: 全套件 "fail 0"（基线 + 6 个新增 = 200）。

### Step 3: 手动 smoke (用户跑)

1. 重启 server + 硬刷 web
2. 配置：进 Config 页打开"启用号池"开关 + 确认 4 个限值 + 保存
3. 号池页确认至少 1 个号未满绑定 (`bindings_used < max`)
4. Execute 页选一个**确认会撞手机验证**的账户（之前因 `needsPhone` 被标 `plus_no_rt` 的）
5. 浏览器模式跑 → 期望 server log 应出现：
   - `[PKCE] State: add-phone`
   - `[PKCE] add-phone: filling +14642840651`
   - `[PKCE] add-phone: polling SMS code...`
   - `[PKCE] add-phone: got SMS code, filling and submitting`
   - `[PKCE] add-phone: verification done, continuing PKCE`
6. 账户最终 status=`plus`（拿到 RT 了！）；号池页该 phone bindings_used +1，账户出现在 boundEmails 列表
7. 异常路径手动制造：暂停 server / 杀掉 SMS API 服务 → status 应分别变 `phone_verify_fail` (sms-timeout) 或 ECONNRESET 类报错

### Step 4: Commit CHANGELOG

```bash
git add docs/CHANGELOG.md
git commit -m "docs(changelog): v2.38.0 — 浏览器模式 PKCE add_phone 自动化 (Phase 2a)"
```

---

## Self-Review

**1. Spec coverage:**

- Spec §1 背景：informational。
- Spec §2 目标 → Task 1-5 全覆盖（fetchSmsCode proxy / PKCE add_phone 处理 / 失败分类 / 向后兼容 / 代理覆盖）。
- Spec §3.1 fetchSmsCode proxyUrl → Task 1 Step 3。
- Spec §3.2 isAddPhonePage helper → Task 2 Step 3。
- Spec §3.3 fetchTokensViaPKCE 扩展 → Task 2 Step 3。
- Spec §3.4 engine.js 4-shape 处理 → Task 3 Steps 1-2。
- Spec §3.5 status.js +2 codes → Task 4 Step 3。
- Spec §3.6 3 视图 status 筛选 +2 → Task 4 Step 5。
- Spec §3.7 边界 9 条（向后兼容 / 代理 / 协议不动 / payment.js 不动 / 不重试 / SMS 超时 / Selector / binding 不回退 / 30s timeout）→ 实现 + CHANGELOG 一并体现。
- Spec §3.8 测试 4 套 → Task 1 (P7) + Task 2 (3 isAddPhonePage) + Task 4 (2 status assertions)。engine.js 走手动 smoke。
- Spec §3.9 文件清单 → matches Task 1-5。
- Spec §4 YAGNI → 不动协议 / 不动 payment / 不动 Python / 不重试 / 不持久化失败 reason —— 严格遵守。
- Spec §5 Phase 2b 预览 → CHANGELOG 引用。
- Spec §6 版本 → Task 5 v2.38.0。

**2. Placeholder scan:** 无 "TBD" / "implement later"。Task 3 Step 2 说「实施时打开 engine.js 看完整代码按相同 pattern 改」—— 是给了 4-branch 模板 + 上下文，要求读取实际 success/fallback 块再适配，不是占位。Task 4 Step 5 说「如果是 v-for 动态生成 LABEL_MAP 则自动 pickup」也是确定的条件分支。

**3. Type/symbol consistency:**

- `isAddPhonePage` —— Task 2 Step 3 定义 + module.exports + Task 1 测试 3 处一致。
- `phonePoolEmpty` / `phoneVerifyFail` —— utils.js return key (Task 2) + engine.js branch (Task 3) + CHANGELOG，3 处一致。
- `phone_pool_empty` / `phone_verify_fail` —— status 码字符串：utils.js 不出现（utils 用驼峰返回值），engine.js (status='phone_pool_empty' / 'phone_verify_fail')、status.js TYPE_MAP / LABEL_MAP / GROUP_ORDER / ERROR_STATUSES、3 视图 el-option value、status-row-class.test.js 断言 —— 全部 snake_case 一致。
- `proxyUrl` 参数 —— phone-pool.js fetchSmsCode (Task 1) + utils.js 调用站 (Task 2) 一致。
- `acquirePhone(db, email, max)` —— Phase 1 既有，Task 2 调用站签名一致。
- `getRawDb()` —— Phase 1 既有，Task 2 require + 使用一致。
- `cfg.phonePool.enabled` / `maxBindingsPerPhone` / `smsPollIntervalMs` / `smsMaxAttempts` —— Phase 1 config.example.json schema + Task 2 utils.js 读取一致。

无 issue。Plan ready.
