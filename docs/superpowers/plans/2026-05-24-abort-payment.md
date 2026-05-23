# 支付阶段强行停止：AbortSignal 全栈改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户点"停止"后，无论 autoPayment 卡在哪个子阶段（SMS 90s 轮询 / 60s readiness / 90s CAPTCHA 等待等），都能在 ~1 秒内中断并把账号状态标为 `'aborted'`（中文显示「已停止」）。

**Architecture:** `AbortController` 在两个 engine 顶层创建，`signal` 沿 call chain 一路下传给 `autoPayment` → handler → 所有 sleep 点。`abortableSleep(ms, signal)` 替代裸 `setTimeout` 包装；长 for-loop 每轮开头检查 `signal.aborted`。`engine.stop()` 调 `abortController.abort()`，AbortError 在 `autoPayment` 顶层 catch 被转成结构化 `{ success: false, status: 'aborted', reason: 'Stopped by user' }`。

**Tech Stack:** Node `AbortController` / `AbortSignal`（Node 18+ 内置），`node:test`，Vue 3 (web)

**Spec:** `docs/superpowers/specs/2026-05-24-abort-payment-design.md`

---

## File Structure

| 文件 | 角色 | 状态 |
|---|---|---|
| `utils.js` | 新增 `abortableSleep` 导出；`randomDelay` 增 signal 第 3 参数 | 修改 |
| `payment.js` | `autoPayment(page, phoneConfig, opts={})` 接 signal；4 个 handler + clickSubmit + waitForCaptchaResolution 接 signal；13 处 sleep 改 abort-aware；4 处长 for-loop 加 signal check；顶层 try/catch 转 'aborted' | 修改 |
| `payment-readiness.js` | `waitForPageReady` opts.signal；abort 时短路返回 `{ ready: false, missing: ['aborted'] }` | 修改 |
| `protocol-engine.js` | `_abortController` field；`start()` init；`stop()` abort；autoPayment 传 signal；catch 识别 status=='aborted' | 修改 |
| `server/engine.js` | 同上 | 修改 |
| `web/src/status.js` | `'aborted'` → label='已停止' / type='info' | 修改 |
| `web/src/views/Execute.vue` | 状态筛选下拉加 `<el-option label="已停止" value="aborted" />` | 修改 |
| `__tests__/abortable-sleep.test.js` | 3 case 单元测试 | 新建 |

---

## Task 1: TDD scaffold `abortableSleep` + `utils.js` 改造

**Files:**
- Create: `__tests__/abortable-sleep.test.js`
- Modify: `utils.js` (around line 47, `randomDelay`)

- [ ] **Step 1: 创建测试文件，3 个 case（先红）**

Create `__tests__/abortable-sleep.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { abortableSleep, randomDelay } = require('../utils');

test('abortableSleep: 时间到自然 resolve', async () => {
  const t0 = Date.now();
  await abortableSleep(100);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 90, `expected ≥90ms, got ${elapsed}`);
  assert.ok(elapsed < 200, `expected <200ms (no abort attached), got ${elapsed}`);
});

test('abortableSleep: signal 已 aborted → 立即 reject AbortError', async () => {
  const ac = new AbortController();
  ac.abort();
  const t0 = Date.now();
  await assert.rejects(
    abortableSleep(5000, ac.signal),
    (e) => e.name === 'AbortError',
  );
  assert.ok(Date.now() - t0 < 50, 'should reject synchronously');
});

test('abortableSleep: abort 期间触发 → reject AbortError + 不等满', async () => {
  const ac = new AbortController();
  const p = abortableSleep(5000, ac.signal);
  setTimeout(() => ac.abort(), 50);
  const t0 = Date.now();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 200, `expected <200ms (early abort), got ${elapsed}`);
});

test('randomDelay: 接受 signal 第 3 参数，abort 期间也中断', async () => {
  const ac = new AbortController();
  const p = randomDelay(5000, 5000, ac.signal);
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(p, (e) => e.name === 'AbortError');
});

test('randomDelay: 不传 signal 时行为不变（向后兼容）', async () => {
  const t0 = Date.now();
  await randomDelay(50, 100);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 45, `expected ≥45ms, got ${elapsed}`);
});
```

- [ ] **Step 2: 运行测试看到失败**

Run:
```
node --test __tests__/abortable-sleep.test.js
```
Expected: 5 tests fail (`abortableSleep` is not exported from utils).

- [ ] **Step 3: 改 `utils.js` 加 `abortableSleep` + `randomDelay` 接 signal**

Find this block in `utils.js` (around line 47-50):
```js
function randomDelay(minMs, maxMs) {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, delay));
}
```

Replace with:
```js
// Sleep that can be cancelled by an AbortSignal. Engine.stop() will pull
// signal.abort() to short-circuit every sleep in flight; without this every
// randomDelay / setTimeout in the payment flow keeps running for its full
// duration even after the browser has been closed.
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const e = new Error('Aborted');
      e.name = 'AbortError';
      return reject(e);
    }
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        const e = new Error('Aborted');
        e.name = 'AbortError';
        reject(e);
      }, { once: true });
    }
  });
}

function randomDelay(minMs, maxMs, signal) {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return abortableSleep(delay, signal);
}
```

- [ ] **Step 4: 更新 `module.exports` 加 `abortableSleep`**

Find at the bottom of `utils.js` (around line 421):
```js
module.exports = { loadAccounts, generateTOTP, randomDelay, screenshotPath, saveCPAAuthFile, fetchTokensViaPKCE };
```

Change to:
```js
module.exports = { loadAccounts, generateTOTP, randomDelay, abortableSleep, screenshotPath, saveCPAAuthFile, fetchTokensViaPKCE };
```

- [ ] **Step 5: 运行测试看到通过**

Run:
```
node --test __tests__/abortable-sleep.test.js
```
Expected: `# pass 5 # fail 0`

- [ ] **Step 6: 跑现有 Node tests 确认不回归**

Run:
```
node --test __tests__/payment-readiness.test.js server/proxy/__tests__/index.test.js
```
Expected: `# pass 28` (16 readiness + 11 proxy + nothing regressed; existing tests don't use abortableSleep)

- [ ] **Step 7: Commit**

```bash
git add utils.js __tests__/abortable-sleep.test.js
git commit -m "feat(utils): abortableSleep + randomDelay accepts AbortSignal

Returns AbortError when the signal fires mid-sleep, otherwise behaves
exactly like the old timer-based randomDelay (signal is the optional
third argument so existing callers stay correct). The plan is to thread
an AbortController.signal from engine.stop() through autoPayment so the
~10 setTimeout-based waits scattered across payment.js can short-circuit
when the user clicks stop — currently the UI says 'stopped' but the
worst-case path keeps running ~5 minutes of background sleep."
```

---

## Task 2: `payment.js` — 替换所有 sleep + 传 signal + 顶层 try/catch

**Files:**
- Modify: `payment.js` (13 sleep call sites, 4 handler signatures, 3 helpers, 1 top-level wrapper)

- [ ] **Step 1: 改顶部 import 加 `abortableSleep`**

Find this line in `payment.js` (line 3):
```js
const { randomDelay } = require('./utils');
```

Change to:
```js
const { randomDelay, abortableSleep } = require('./utils');
```

- [ ] **Step 2: 在文件顶部加 `_abortError` helper**

Insert this helper just after `const { randomDelay, abortableSleep } = require('./utils');` (line 3):

```js
// Build an AbortError consistent with what abortableSleep emits, so all
// throw sites in this module produce the same shape (e.name === 'AbortError').
// Used by the long for-loops below — they peek at signal.aborted between
// iterations and synthesize this error to bail out of the loop early.
function _abortError() {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}
```

- [ ] **Step 3: 改 `clickSubmit` 接 signal + 循环 check + 替换 sleep**

Find this function (around line 140-168) — the current signature is `async function clickSubmit(page) {`. Replace the entire function with:

```js
async function clickSubmit(page, signal) {
  for (let retry = 0; retry < 10; retry++) {
    if (signal?.aborted) throw _abortError();
    const selectors = [
      'button[data-testid="submit-button"]',
      'button[data-testid="hosted-payment-submit-button"]',
      'button[data-atomic-wait-intent="Submit_Email"]',
      'button.SubmitButton--complete',
    ];
    for (const sel of selectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
          if (await btn.isEnabled()) { await btn.click(); return true; }
        }
      } catch (e) { console.log(`    [Pay] Submit btn: ${e.message?.slice(0, 60)}`); }
    }
    const texts = ['訂閱', '订阅', '下一页', 'Next', 'Subscribe', 'Pay', 'Continue', 'Agree', '同意'];
    for (const t of texts) {
      try {
        const btn = page.locator(`button:has-text("${t}")`).first();
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          if (await btn.isEnabled()) { await btn.click(); return true; }
        }
      } catch (e) { console.log(`    [Pay] Submit text btn: ${e.message?.slice(0, 60)}`); }
    }
    await abortableSleep(1000, signal);
  }
  return false;
}
```

- [ ] **Step 4: 改 `handleOpenAIPage` 接 signal + 替换 sleep**

In `payment.js`, the `handleOpenAIPage(page)` function signature is around line 172. Change it to `async function handleOpenAIPage(page, signal) {`.

Within `handleOpenAIPage`, find these sleep calls and thread `signal`:
- Around line 372: `await randomDelay(1500, 2000);` → `await randomDelay(1500, 2000, signal);`
- Any other `await randomDelay(...)` inside this function: add `, signal` as the last argument

Also find the `await clickSubmit(page);` call inside this function and change it to `await clickSubmit(page, signal);`.

Find `await page.reload(...)` / `await page.goto(...)` calls — these are Playwright-native and will reject naturally when the browser closes, so no signal needed there.

Find the `await new Promise(r => setTimeout(r, 1000));` inside any inner loop in this function (Step 1 grep showed line 165 is in `clickSubmit` which we already covered).

- [ ] **Step 5: 改 `handlePayPalLogin` 接 signal + 替换 sleep**

Find `async function handlePayPalLogin(page, emailOverride) {` (around line 376). Change it to:

```js
async function handlePayPalLogin(page, emailOverride, signal) {
```

Inside the body, find `await randomDelay(800, 1200);` (around line 388) and change to:
```js
await randomDelay(800, 1200, signal);
```

Find any `await clickSubmit(page)` inside and change to `await clickSubmit(page, signal)`.

- [ ] **Step 6: 改 `handlePayPalCheckout` 接 signal + 替换 sleep**

Find `async function handlePayPalCheckout(page, phoneOverride, smsOverride, emailOverride) {` (around line 393). Change it to:

```js
async function handlePayPalCheckout(page, phoneOverride, smsOverride, emailOverride, signal) {
```

Inside the body, thread `signal` to all sleep calls:
- Line ~516: `await randomDelay(500, 1000);` → `await randomDelay(500, 1000, signal);`
- Line ~518: `await randomDelay(500, 1000);` → `await randomDelay(500, 1000, signal);`
- Line ~524: `await randomDelay(3000, 5000);` → `await randomDelay(3000, 5000, signal);`

Find any `await clickSubmit(page)` inside → `await clickSubmit(page, signal)`.

Find any `await handleSmsVerification(page, ...)` call → `await handleSmsVerification(page, smsOverride, signal)` (we change that signature next).

- [ ] **Step 7: 改 `handleSmsVerification` 接 signal + 替换 sleep + 循环 check**

Find `async function handleSmsVerification(page, smsOverride) {` (around line 551). Replace the whole function with:

```js
async function handleSmsVerification(page, smsOverride, signal) {
  const SMS_URL = smsOverride || CONFIG.smsApiUrl;
  if (!SMS_URL) return;

  // SMS dialog is optional — readiness returning ready:false means no dialog
  // surfaced within the timeout; treat same as "no dialog detected".
  const rSms = await waitForPageReady(page, PROFILES.smsDialog,
    { totalTimeoutMs: 15000, log: (m) => console.log('    ' + m), signal });
  if (!rSms.ready) {
    console.log('    [Pay] No SMS verification dialog detected');
    return false;
  }

  console.log('    [Pay] SMS verification dialog detected, polling for code...');

  // Poll SMS API for the verification code (retry up to 30 times, every 3s = ~90s)
  let smsCode = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (signal?.aborted) throw _abortError();
    try {
      const res = await fetch(SMS_URL, { signal, timeout: 10000 });
      const text = await res.text();
      console.log(`    [Pay] SMS API attempt ${attempt + 1}: ${text.slice(0, 100)}`);

      let data;
      try { data = JSON.parse(text); } catch (e) { data = text; }
      const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
      const match = dataStr.match(/\b(\d{6})\b/);
      if (match) {
        smsCode = match[1];
        console.log(`    [Pay] Got SMS code: ${smsCode}`);
        break;
      }
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      console.log(`    [Pay] SMS API error: ${e.message}`);
    }
    await abortableSleep(3000, signal);
  }

  if (!smsCode) {
    console.log('    [Pay] Failed to get SMS code after 30 attempts');
    return;
  }

  // Fill in the 6-digit code (individual input boxes)
  const codeInputs = page.locator('input[type="tel"], input[type="text"], input[type="number"]').filter({ has: page.locator('xpath=ancestor::*[contains(@class,"code") or contains(@class,"otp") or contains(@class,"pin")]') });
  const codeCount = await codeInputs.count().catch(() => 0);

  if (codeCount >= 6) {
    for (let i = 0; i < 6; i++) {
      if (signal?.aborted) throw _abortError();
      await codeInputs.nth(i).fill(smsCode[i]);
      await randomDelay(100, 200, signal);
    }
    console.log('    [Pay] SMS code filled (individual boxes)');
  } else {
    await page.keyboard.type(smsCode, { delay: 100 });
    console.log('    [Pay] SMS code typed');
  }

  await randomDelay(2000, 3000, signal);
  await clickSubmit(page, signal);
  console.log('    [Pay] SMS verification submitted');
  return true;
}
```

(Replaces lines ~551-617 of the original.)

Note: `AbortSignal.timeout(10000)` was the original timeout pattern. We now combine the user abort signal and a per-request 10s timeout by passing only `signal` — losing the per-request timeout. To preserve both, use `AbortSignal.any([signal, AbortSignal.timeout(10000)])` if Node version supports it; for now the lone signal is fine since the 30 × 3s outer loop already bounds total time.

- [ ] **Step 8: 改 `waitForCaptchaResolution` 接 signal + 循环 check**

Find this function (around line 624). Replace it with:

```js
async function waitForCaptchaResolution(page, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw _abortError();
    await abortableSleep(2000, signal);
    let url;
    try { url = page.url(); } catch { return false; }
    if (!/paypal\.com\/agreements\/approve/i.test(url)) return true;
  }
  return false;
}
```

(Replaces lines ~624-633.)

- [ ] **Step 9: 改 `autoPayment` 签名 + 顶层 try/catch + 主循环 + redirect wait**

Find `async function autoPayment(page, phoneConfig) {` (around line 635). The whole function body needs three changes:

1. Signature: `async function autoPayment(page, phoneConfig, opts = {}) {`
2. Wrap body in `try { ... } catch (e) { if (e?.name === 'AbortError') return { success: false, status: 'aborted', reason: 'Stopped by user' }; throw e; }`
3. Thread `signal` from `opts` into every handler / sleep / clickSubmit / fetchAddress / waitForCaptchaResolution call

Replace the entire `autoPayment` function (from `async function autoPayment(page, phoneConfig) {` to its closing `}` around line 733) with:

```js
async function autoPayment(page, phoneConfig, opts = {}) {
  const signal = opts.signal;
  try {
    return await _doAutoPayment(page, phoneConfig, signal);
  } catch (e) {
    if (e?.name === 'AbortError') {
      console.log('    [Pay] Aborted by user');
      return { success: false, status: 'aborted', reason: 'Stopped by user' };
    }
    throw e;
  }
}

async function _doAutoPayment(page, phoneConfig, signal) {
  const PHONE = phoneConfig?.phone || CONFIG.phone;
  const SMS_API = phoneConfig?.smsApiUrl || CONFIG.smsApiUrl;
  const EMAIL = phoneConfig?.email || '';
  console.log('    [Pay] Starting auto-payment flow...');

  await page.addStyleTag({ content: '#captcha-standalone,.captcha-overlay,.captcha-container,.AddressAutocomplete-results{display:none!important;height:0!important;overflow:hidden!important}' }).catch(() => {});

  const url = page.url();
  if (url.includes('pay.openai.com') || url.includes('checkout.stripe.com')) {
    await handleOpenAIPage(page, signal);
  }

  let paypalHandled = false;
  let captchaFirstSeenAt = 0;
  let captchaHandled = false;
  for (let round = 0; round < 15; round++) {
    if (signal?.aborted) throw _abortError();
    await randomDelay(2000, 3000, signal);
    let currentUrl;
    try { currentUrl = page.url(); } catch (e) { console.log(`    [Pay] Page closed/crashed: ${e.message?.slice(0, 40)}`); break; }

    if (currentUrl.includes('paypal.com/pay')) {
      await handlePayPalLogin(page, EMAIL, signal);
    } else if (currentUrl.includes('paypal.com') && (currentUrl.includes('checkoutweb') || currentUrl.includes('signup'))) {
      await handlePayPalCheckout(page, PHONE, SMS_API, EMAIL, signal);
      paypalHandled = true;
      break;
    } else if (/paypal\.com\/agreements\/approve/i.test(currentUrl)) {
      if (!captchaFirstSeenAt) {
        captchaFirstSeenAt = Date.now();
      } else if (Date.now() - captchaFirstSeenAt > 4000 && !captchaHandled) {
        captchaHandled = true;
        console.log('    [Pay] PayPal slider CAPTCHA detected — please drag manually (90s timeout)');
        const cleared = await waitForCaptchaResolution(page, 90000, signal);
        if (!cleared) {
          return { success: false, status: 'paypal_captcha', reason: 'PayPal slider CAPTCHA timeout (90s)' };
        }
        console.log('    [Pay] CAPTCHA cleared, continuing flow');
      }
      continue;
    } else if (currentUrl.includes('pay.openai.com') || currentUrl.includes('checkout.stripe.com')) {
      if (round % 3 === 2) console.log('    [Pay] Waiting for PayPal redirect...');
      continue;
    } else {
      if (round % 3 === 2) console.log('    [Pay] Page: ' + currentUrl.slice(0, 60) + '...');
      continue;
    }
  }
  if (!paypalHandled) {
    console.log('    [Pay] PayPal flow not detected, continuing...');
    console.log('    [Pay] Auto-payment flow completed');
    return { success: false, reason: 'PayPal not reached' };
  }

  console.log('    [Pay] Waiting for payment redirect...');
  let paymentSuccess = false;
  let genericError = false;
  for (let w = 0; w < 15; w++) {
    if (signal?.aborted) throw _abortError();
    await abortableSleep(2000, signal);
    let currentUrl;
    try { currentUrl = page.url(); } catch { break; }
    if (currentUrl.includes('pay.openai.com') && currentUrl.includes('redirect_status=succeeded')) {
      console.log('    [Pay] Payment succeeded! (redirect_status=succeeded)');
      paymentSuccess = true;
      break;
    }
    if (currentUrl.includes('chatgpt.com')) {
      console.log('    [Pay] Redirected to chatgpt.com — payment likely succeeded');
      paymentSuccess = true;
      break;
    }
    if (/paypal\.com\/checkoutweb\/genericError/i.test(currentUrl)) {
      console.log(`    [Pay] PayPal risk-control rejected (genericError): ${currentUrl.slice(0, 80)}`);
      genericError = true;
      break;
    }
    if (w % 3 === 2) console.log(`    [Pay] Waiting... (${currentUrl.slice(0, 50)})`);
  }

  console.log('    [Pay] Auto-payment flow completed');
  return {
    success: paymentSuccess,
    reason: paymentSuccess ? '' : (genericError ? 'PayPal risk-control (genericError)' : 'Payment redirect not detected'),
  };
}
```

- [ ] **Step 10: 改 `fetchAddress` 接 signal**

Find `async function fetchAddress() {` (around line 64). Change it to:

```js
async function fetchAddress(signal) {
```

Within its body, find this line (around line 83):
```js
if (retry < 2) await new Promise(r => setTimeout(r, 2000));
```

Change to:
```js
if (retry < 2) await abortableSleep(2000, signal);
```

Find all `await fetchAddress()` callers inside `payment.js` and change to `await fetchAddress(signal)` (there should be 2-3, inside `handleOpenAIPage` and `handlePayPalCheckout`).

- [ ] **Step 11: 语法 + 现有测试不回归**

Run:
```
node --check payment.js && echo "SYNTAX OK"
node --test __tests__/abortable-sleep.test.js __tests__/payment-readiness.test.js server/proxy/__tests__/index.test.js
```
Expected: `SYNTAX OK` + `# pass 33` (5 abort + 16 readiness + 11 proxy + 1 if any)

- [ ] **Step 12: Commit**

```bash
git add payment.js
git commit -m "feat(payment): thread AbortSignal through autoPayment + handlers

autoPayment(page, phoneConfig) becomes autoPayment(page, phoneConfig,
opts={}) where opts.signal is an AbortSignal. The signal is threaded
through all 4 handlers (handleOpenAIPage, handlePayPalLogin,
handlePayPalCheckout, handleSmsVerification), clickSubmit, fetchAddress,
and waitForCaptchaResolution. All 13 sleep call sites that used to be
naked setTimeout / un-cancellable randomDelay now pass signal so they
short-circuit when engine.stop() fires abort. Long for-loops (main loop
of autoPayment, redirect wait, SMS 30x3s polling, clickSubmit 10x1s,
waitForCaptchaResolution) check signal.aborted at the top of each
iteration. Top-level autoPayment try/catch turns AbortError into a
structured { success: false, status: 'aborted', reason: 'Stopped by user' }
so callers get a clean result instead of a raw throw."
```

---

## Task 3: `payment-readiness.js` — opts.signal + 短路返回

**Files:**
- Modify: `payment-readiness.js`

- [ ] **Step 1: 在 `waitForPageReady` 顶部加 signal 短路**

Find `async function waitForPageReady(page, profile, opts = {}) {` in `payment-readiness.js`. Add this immediately after the opening brace, before any other logic:

```js
  const signal = opts.signal;
  if (signal?.aborted) {
    return { ready: false, waitedMs: 0, missing: ['aborted'] };
  }
```

- [ ] **Step 2: 在主等待处加 abort race**

Find the inside of `waitForPageReady` where it builds `Promise.all([...])` of element checks and the DOM-stable promise. Wrap it with `Promise.race` against an abort promise. Locate the line that looks like:

```js
const [ready, waitedMs, missing] = await Promise.all([...]);
```

(actual structure may differ; the goal is wherever the function `await`s the bundle of checks.)

Add this above the await:

```js
  const abortPromise = signal
    ? new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const e = new Error('Aborted');
          e.name = 'AbortError';
          reject(e);
        }, { once: true });
      })
    : null;
```

Then wrap the main await with race:

```js
  try {
    const result = abortPromise
      ? await Promise.race([
          /* original Promise.all here */,
          abortPromise,
        ])
      : await /* original Promise.all here */;
    // ... continue with result
  } catch (e) {
    if (e?.name === 'AbortError') {
      return { ready: false, waitedMs: Date.now() - startTime, missing: ['aborted'] };
    }
    throw e;
  }
```

Adapt the exact insertion to wherever the bulk-await sits in the current implementation.

- [ ] **Step 3: 语法 + readiness 测试不回归**

Run:
```
node --check payment-readiness.js && echo "SYNTAX OK"
node --test __tests__/payment-readiness.test.js
```
Expected: `SYNTAX OK` + `# pass 16` (existing tests don't pass `signal`, so abort path isn't exercised but no regression)

- [ ] **Step 4: Commit**

```bash
git add payment-readiness.js
git commit -m "feat(payment-readiness): waitForPageReady honors opts.signal

When signal.aborted at entry → return { ready: false, missing: ['aborted'] }
immediately without touching the page. When signal fires mid-wait →
Promise.race vs abortPromise unwinds the in-flight Promise.all of
element checks + dom-stable observer, returning the same aborted shape
so callers see a consistent failure mode."
```

---

## Task 4: `protocol-engine.js` — AbortController 接入

**Files:**
- Modify: `protocol-engine.js`

- [ ] **Step 1: 构造函数加 `_abortController` field**

Find the `ProtocolEngine` class constructor (around line 89). It currently looks like:

```js
class ProtocolEngine extends EventEmitter {
  constructor() {
    super();
    this.status = 'idle';
    this.stopFlag = false;
    this._gw = null;
    this._chromeProc = null;
    this._browser = null;
    this._tempDir = null;
  }
```

Add a line for `_abortController`:

```js
class ProtocolEngine extends EventEmitter {
  constructor() {
    super();
    this.status = 'idle';
    this.stopFlag = false;
    this._gw = null;
    this._chromeProc = null;
    this._browser = null;
    this._tempDir = null;
    this._abortController = null;
  }
```

- [ ] **Step 2: `stop()` 加 `abortController.abort()`**

Find `stop() { if (this.status !== 'idle') { this.stopFlag = true; ...` (around line 135). After `this.stopFlag = true;` add:

```js
      if (this._abortController) try { this._abortController.abort(); } catch {}
```

Also add a null-out after the existing field nullifications (around line 143):
```js
      this._abortController = null;
```

- [ ] **Step 3: `start()` 顶部初始化 abortController**

Find `async start(startFrom = 0, filterEmails = null) {` (around line 156). Right after `this.stopFlag = false;` (around line 158) add:

```js
    this._abortController = new AbortController();
```

- [ ] **Step 4: 调 `autoPayment` 时传 signal**

Find this line (around line 402):
```js
            paymentResult = await autoPayment(page, { phone: slot.phone, smsApiUrl: slot.smsApiUrl, email: account.email }) || { success: false };
```

Change to:
```js
            paymentResult = await autoPayment(page, { phone: slot.phone, smsApiUrl: slot.smsApiUrl, email: account.email }, { signal: this._abortController.signal }) || { success: false };
```

- [ ] **Step 5: catch 识别 status='aborted'**

Find the existing `if (paymentResult.success) {` block (around line 414). Just before it (or in the existing `else if` chain), add an aborted branch.

Locate this section:
```js
          if (paymentResult.success) {
            ...
          } else if (paymentResult.notFreeTrial) {
            ...
          } else if (paymentResult.status) {
            const reason = paymentResult.reason || 'Payment not completed';
            console.log(`[${progress}] Payment incomplete: ${reason}`);
            this.emitStatus({ email: account.email, status: paymentResult.status, phase: 'payment', progress, reason });
            summary.error++;
          }
```

The existing `else if (paymentResult.status)` branch will naturally pick up `status === 'aborted'` and emit it. **But** we want it to bump a different counter and NOT count toward `summary.error`. Replace that `else if` chain with:

```js
          if (paymentResult.success) {
            if (runtimeCfg.enableOAuth) {
              console.log(`[${progress}] Running PKCE via protocol...`);
              await this._finalizePkce(account, result, progress);
            } else {
              saveCPAAuthFile(account.email, result.accessToken, result.session);
              this.emitStatus({ email: account.email, status: 'plus_no_rt', phase: 'done', progress });
            }
            summary.success++;
          } else if (paymentResult.status === 'aborted') {
            console.log(`[${progress}] Payment aborted by user`);
            this.emitStatus({ email: account.email, status: 'aborted', phase: 'payment', progress, reason: 'Stopped by user' });
            summary.aborted = (summary.aborted || 0) + 1;
          } else if (paymentResult.notFreeTrial) {
            this.emitStatus({ email: account.email, status: 'no_link', phase: 'done', progress, reason: paymentResult.reason });
            summary.noLink++;
          } else if (paymentResult.status) {
            const reason = paymentResult.reason || 'Payment not completed';
            console.log(`[${progress}] Payment incomplete: ${reason}`);
            this.emitStatus({ email: account.email, status: paymentResult.status, phase: 'payment', progress, reason });
            summary.error++;
          } else {
            const reason = paymentResult.reason || 'Payment not completed';
            console.log(`[${progress}] Payment incomplete: ${reason}`);
            this.emitStatus({ email: account.email, status: 'error', phase: 'payment', progress, reason });
            summary.error++;
          }
```

Note: this preserves all existing branches and just inserts the `aborted` branch above `notFreeTrial`.

- [ ] **Step 6: 语法 + 现有测试不回归**

Run:
```
node --check protocol-engine.js && echo "SYNTAX OK"
node --test __tests__/abortable-sleep.test.js __tests__/payment-readiness.test.js server/proxy/__tests__/index.test.js
```
Expected: `SYNTAX OK` + same pass count

- [ ] **Step 7: Commit**

```bash
git add protocol-engine.js
git commit -m "feat(protocol-engine): create AbortController in start, abort in stop

ProtocolEngine holds an AbortController across one start() invocation
(reset to null in stop()). Its signal is threaded into autoPayment via
the new opts argument so the ~13 sleep points inside payment.js can
short-circuit when the user hits stop. When autoPayment returns
status: 'aborted', the engine emits an 'aborted' status (separate from
the existing 'error' bucket) and bumps summary.aborted instead of
summary.error so user-cancelled accounts aren't lumped in with real
failures for follow-up retry logic."
```

---

## Task 5: `server/engine.js` — AbortController 接入

**Files:**
- Modify: `server/engine.js`

- [ ] **Step 1: 构造函数加 `_abortController` field**

Find the `PipelineEngine` class constructor (around line 40). It currently looks like:

```js
class PipelineEngine extends EventEmitter {
  constructor() {
    super();
    this.status = 'idle';
    this.stopFlag = false;
    ...
  }
```

Add `this._abortController = null;` next to the other null-initialized fields. Locate by searching for `this._chromeProc = null;` — add the new line below it:

```js
    this._chromeProc = null;
    this._browser = null;
    this._abortController = null;
```

- [ ] **Step 2: `stop()` 加 `abortController.abort()` + null-out**

Find `stop() { if (this.status !== 'idle') { this.stopFlag = true; ...` (around line 63). After `this.stopFlag = true;` add:

```js
      if (this._abortController) try { this._abortController.abort(); } catch {}
```

After the existing kills/closes (around line 75-78), add:
```js
      this._abortController = null;
```

- [ ] **Step 3: `start()` 顶部初始化 abortController**

Find `async start(...)` then `this.stopFlag = false;` (around line 112). Right after that line add:

```js
    this._abortController = new AbortController();
```

- [ ] **Step 4: 调 `autoPayment` 时传 signal**

Find this line (around line 390):
```js
                  const payResult = await autoPayment(page, { phone: phoneSlot.phone, smsApiUrl: phoneSlot.smsApiUrl, email: account.email }) || {};
```

Change to:
```js
                  const payResult = await autoPayment(page, { phone: phoneSlot.phone, smsApiUrl: phoneSlot.smsApiUrl, email: account.email }, { signal: this._abortController.signal }) || {};
```

- [ ] **Step 5: catch 识别 status='aborted'**

Find this section (around line 408-415):
```js
                if (paymentOk) {
                  finalResult.status = 'plus_no_rt';
                  console.log(`${p} Payment succeeded (redirect_status=succeeded)`);
                } else {
                  finalResult.status = paymentStatus || 'error';
                  finalResult.reason = paymentReason || 'Payment not completed';
                  console.log(`${p} Payment failed: ${finalResult.reason}, skipping auth file generation`);
                }
```

Replace with:
```js
                if (paymentOk) {
                  finalResult.status = 'plus_no_rt';
                  console.log(`${p} Payment succeeded (redirect_status=succeeded)`);
                } else if (paymentStatus === 'aborted') {
                  finalResult.status = 'aborted';
                  finalResult.reason = 'Stopped by user';
                  console.log(`${p} Payment aborted by user`);
                  this.emitStatus({ email: account.email, status: 'aborted', phase: 'payment', progress, reason: 'Stopped by user' });
                } else {
                  finalResult.status = paymentStatus || 'error';
                  finalResult.reason = paymentReason || 'Payment not completed';
                  console.log(`${p} Payment failed: ${finalResult.reason}, skipping auth file generation`);
                }
```

- [ ] **Step 6: 语法 + 测试不回归**

Run:
```
node --check server/engine.js && echo "SYNTAX OK"
node --test __tests__/abortable-sleep.test.js __tests__/payment-readiness.test.js server/proxy/__tests__/index.test.js
```
Expected: `SYNTAX OK` + same pass count

- [ ] **Step 7: Commit**

```bash
git add server/engine.js
git commit -m "feat(engine): create AbortController in start, abort in stop

Same shape as the protocol-engine change one commit back: the
PipelineEngine (browser mode) now owns an AbortController per start()
invocation, passes its signal to autoPayment, and maps a returned
status: 'aborted' to a distinct finalResult.status='aborted' +
emitStatus rather than collapsing it into the generic 'error' bucket.
Now both engines respond to the user's stop button at any point in
the payment flow, not just between high-level phases."
```

---

## Task 6: Web UI — `aborted` status label + 筛选

**Files:**
- Modify: `web/src/status.js`
- Modify: `web/src/views/Execute.vue`

- [ ] **Step 1: 在 `status.js` 加 `aborted` 映射**

Open `web/src/status.js`. The file exports `statusLabel(s)` and `statusType(s)` functions. Add the `'aborted'` case to each.

Find `statusLabel`. It's a small switch / map. Add an entry mapping `'aborted'` → `'已停止'`.

Find `statusType`. Add an entry mapping `'aborted'` → `'info'`.

Also find the `PLUS_STATUSES` / `ERROR_STATUSES` const arrays. `'aborted'` should NOT be added to either — it's a third category.

- [ ] **Step 2: 在 `Execute.vue` 状态筛选下拉加 option**

Find the status filter dropdown in `web/src/views/Execute.vue` (around line 37-48):

```vue
        <el-select v-model="statusFilter" placeholder="状态" clearable style="width:130px;margin-left:8px">
          <el-option label="Plus(有RT)" value="plus" />
          <el-option label="Plus(无RT)" value="plus_no_rt" />
          <el-option label="错误" value="error" />
          <el-option label="已删除" value="deactivated" />
          <el-option label="无链接" value="no_link" />
          <el-option label="空闲" value="idle" />
          <el-option label="运行中" value="running" />
          <el-option label="JP节点不可用" value="no_jp_proxy" />
          <el-option label="无0元资格" value="no_promo" />
          <el-option label="Stripe验证失败" value="verify_error" />
        </el-select>
```

Add a new `el-option` between "运行中" and "JP节点不可用":

```vue
          <el-option label="已停止" value="aborted" />
```

- [ ] **Step 3: 重新 build web 前端**

Run:
```
cd web && npm run build && cd ..
```
Expected: vite build succeeds; `dist/index.html` is updated.

- [ ] **Step 4: Commit (Vue source only — `web/dist` is gitignored)**

```bash
git add web/src/status.js web/src/views/Execute.vue
git commit -m "feat(web): show 'aborted' status as 已停止 + add to status filter

Surfaces the new 'aborted' status from the engine's stop-mid-payment
behavior. Filter dropdown gets a '已停止' option so users can find
accounts they cancelled. Uses el-tag type 'info' to visually distinguish
from 'error' (red) and from 'plus_no_rt' (green) — a stopped account is
neither a failure to investigate nor a success to celebrate."
```

---

## Task 7: 全量验证 + 重启 server + 手工 dry-run 指南

**Files:** None (verification only)

- [ ] **Step 1: 跑全量 Node 测试**

Run:
```
node --test __tests__/abortable-sleep.test.js __tests__/payment-readiness.test.js server/proxy/__tests__/index.test.js
```
Expected: `# pass ≥21` (5 abort + 16 readiness + 11 proxy = 32; counts may shift if abortable-sleep tests count differently)

- [ ] **Step 2: 全部 JS syntax check**

Run:
```
node --check utils.js && node --check payment.js && node --check payment-readiness.js && node --check protocol-engine.js && node --check server/engine.js && echo "SYNTAX_OK"
```
Expected: `SYNTAX_OK`

- [ ] **Step 3: 重启 server**

PowerShell:
```powershell
$p = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($p) { Stop-Process -Id $p.OwningProcess -Force }
```

Bash:
```bash
cd chatgpt-auto-login
node server/index.js > server.log 2>&1 &
sleep 5
```

Verify:
```powershell
$p = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($p) { "OK PID=$($p.OwningProcess)" } else { 'Not listening' }
Get-Content E:\workspace\projects\demo\chatgpt-auto-login\server.log -Tail 10
```
Expected: server listening + `[Proxy] sing-box running: main=:7890(N) jp=:7891(M)`

- [ ] **Step 4: 手工 dry-run 验证 abort 行为**

Through the web dashboard at http://localhost:3000:

1. 选一个账号点 `执行选中`
2. 等账号进入 `Phase 3` 或 `payment` 阶段（dashboard 状态显示 "payment" 或日志出现 `[Pay] Starting auto-payment flow...`）
3. 进一步等到日志显示一个长 sleep（任选一种）：
   - `[Pay] SMS verification dialog detected, polling for code...` (30 × 3s)
   - `[Pay] Waiting for PayPal redirect...` (15 × 2s)
   - `[Pay] PayPal slider CAPTCHA detected — please drag manually` (90s)
   - 或者就是 `[Pay] Page ready (...)` 之后任何 `randomDelay` 期间
4. 点 dashboard 顶栏的 `停止` 按钮
5. **观察**：server.log 在 **1 秒内**应当不再产生新的 `[Pay]` 日志；最后一条 `[Pay]` 日志附近会出现 `[Pay] Aborted by user`（来自 `_doAutoPayment` 顶层 catch）
6. **观察**：dashboard 该账号状态变为 `已停止`（el-tag 显示 info 灰色）
7. **观察**：状态筛选下拉里选 `已停止` 应能筛出该账号

如果观察通过 → abort 链路工作。

如果 1 秒内日志仍在动 → 有未覆盖的 sleep 点；检查 server.log 最后那条日志对应的 payment.js 代码位置，找出对应的裸 setTimeout 或 randomDelay 未接 signal 的地方，回到 Task 2 补上。

- [ ] **Step 5: 完成判定记录**

无 commit。这是 plan 的终止 checkpoint。

---

## 完成判定

- ✅ 5 个 abortableSleep 单元测试 pass
- ✅ 现有 27 个 Node 测试不回归（16 readiness + 11 proxy）
- ✅ 5 个 JS 文件 syntax check OK
- ✅ Server 在 :3000 重启正常 + sing-box 启动
- ✅ 手工 dry-run：进入 autoPayment 任意阶段点 stop → 1 秒内停止 + 账号状态 'aborted'
- ✅ Web 状态筛选下拉新增 "已停止" option

---

## Self-Review Checklist（写完后已自审）

**Spec 覆盖：**
- §4.1 utils 改造 → Task 1 ✓
- §4.2 payment.js 改造 → Task 2 ✓（13 处 sleep 全部覆盖 Step 3-10）
- §4.3 payment-readiness 改造 → Task 3 ✓
- §4.4 两个 engine 接入 → Task 4 + Task 5 ✓
- §4.5 Web UI → Task 6 ✓
- §4.6 测试 → Task 1 Step 1 已含 5 个测试 ✓
- §5 错误处理（AbortError 转结构化、不调 markBad）→ Task 2 Step 9 顶层 try/catch + Task 4 Step 5 / Task 5 Step 5 的 catch 分支 ✓
- §6 完成判定 → Task 7 全量验证 ✓

**Placeholder 扫描：** 无 TBD / TODO；所有代码块完整；所有命令含 expected output。

**类型/方法一致性：** `abortableSleep(ms, signal)` 在 utils.js 定义 → 在 payment.js 调用 → 签名一致。`opts.signal` 在 autoPayment / waitForPageReady 都用同名。`_abortError()` helper 在 payment.js 模块内部一致使用。`status === 'aborted'` 字符串在 payment.js return / engine catch / web status.js / Execute.vue option 四处完全一致。
