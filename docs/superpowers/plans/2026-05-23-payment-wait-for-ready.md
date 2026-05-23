# 协议模式支付：页面就绪检测 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在协议模式（`protocol-engine.js` → `payment.js`）的浏览器自动化里加入页面就绪检测，避免网络慢时表单/按钮还没就绪就操作导致卡住或报错。

**Architecture:** 新建 `payment-readiness.js` 模块，导出 `waitForPageReady(page, profile, opts)` + 6 个 `PROFILES`。Profile 用复合就绪判定：DOM 稳定（MutationObserver）+ 关键元素全部就绪（visible/enabled/options-loaded）。在 `payment.js` 的 6 个 handler 入口/状态切换点调用。超时不抛错，沿用旧路径继续填，仅记日志（用户已确认）。

**Tech Stack:** Node.js + Playwright（已在用）+ `node:test`（已在用，见 `server/proxy/__tests__/`）

**Spec:** `docs/superpowers/specs/2026-05-23-payment-wait-for-ready-design.md`

---

## File Structure

| 文件 | 角色 | 状态 |
|---|---|---|
| `payment-readiness.js` | 导出 `waitForPageReady(page, profile, opts)` + `PROFILES` 对象。无副作用、纯模块 | 新建 |
| `__tests__/payment-readiness.test.js` | 单元测试：mock page 对象，fake timers，验证就绪/超时/部分超时三态 | 新建 |
| `payment.js` | 在 `handleOpenAIPage` / `handlePayPalLogin` / `handlePayPalCheckout` / `handleSmsVerification` 共 6 个调用点插入 readiness 调用；删除被覆盖的固定 `randomDelay` | 修改 |

注意：`__tests__/` 目录与 `payment.js` 同级（参考现有 `server/proxy/__tests__/`）。

---

## Task 1: Scaffold `payment-readiness.js` 模块骨架 + PROFILES 数据

**Files:**
- Create: `payment-readiness.js`
- Test: `__tests__/payment-readiness.test.js`

- [ ] **Step 1: 创建测试文件，写 schema 校验 test（先红）**

Create `__tests__/payment-readiness.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { PROFILES, waitForPageReady } = require('../payment-readiness');

test('PROFILES: 所有 profile 含 name + requiredElements + stableWindowMs', () => {
  const names = Object.keys(PROFILES);
  assert.ok(names.length >= 6, `期望 ≥6 个 profile，实际 ${names.length}`);
  for (const key of names) {
    const p = PROFILES[key];
    assert.strictEqual(typeof p.name, 'string', `${key}.name 必须是 string`);
    assert.ok(p.name.length > 0, `${key}.name 不能为空`);
    assert.strictEqual(typeof p.stableWindowMs, 'number', `${key}.stableWindowMs 必须是 number`);
    assert.ok(Array.isArray(p.requiredElements), `${key}.requiredElements 必须是数组`);
    assert.ok(p.requiredElements.length > 0, `${key}.requiredElements 不能为空`);
    for (const el of p.requiredElements) {
      assert.strictEqual(typeof el.name, 'string', `${key} 的 element.name 必须是 string`);
      assert.ok(['visible', 'attached', 'select', 'selectAny', 'text', 'visibleAny', 'js'].includes(el.kind),
        `${key}.${el.name} 的 kind 非法: ${el.kind}`);
    }
  }
});

test('PROFILES: 必须包含全部 6 个具名 profile', () => {
  const required = ['openai', 'paypalAccordionExpanded', 'paypalLogin', 'paypalCheckout', 'paypalCheckoutAfterCountry', 'smsDialog'];
  for (const key of required) {
    assert.ok(PROFILES[key], `缺少 PROFILES.${key}`);
  }
});

test('waitForPageReady: 导出存在且为函数', () => {
  assert.strictEqual(typeof waitForPageReady, 'function');
});
```

- [ ] **Step 2: 运行测试看到失败**

Run: `node --test __tests__/payment-readiness.test.js`
Expected: `FAIL` — Cannot find module '../payment-readiness'

- [ ] **Step 3: 创建 `payment-readiness.js` 骨架 + 6 个 PROFILES**

Create `payment-readiness.js`:

```js
// payment-readiness.js — wait until a payment page (Stripe/PayPal/SMS dialog) is
// truly ready for automation: DOM has stopped mutating AND all critical elements
// are present/visible/interactive. Replaces fixed randomDelay-based waits in payment.js.

const PROFILES = {
  openai: {
    name: 'openai-stripe',
    stableWindowMs: 800,
    requiredElements: [
      { name: 'priceRendered', kind: 'js',
        check: () => /\$\s*[0-9]/.test(document.body.innerText || '') },
      { name: 'paymentAccordion', kind: 'visible',
        selector: '[data-testid="paypal-accordion-item-button"], [data-testid="card-accordion-item-button"], #payment-method-accordion-item-title-paypal' },
      { name: 'submitBtn', kind: 'attached',
        selector: 'button[data-testid="hosted-payment-submit-button"], button[data-testid="submit-button"]' },
    ],
  },
  paypalAccordionExpanded: {
    name: 'paypal-accordion-expanded',
    stableWindowMs: 500,
    elementTimeoutMs: 10000,
    requiredElements: [
      { name: 'addressLine1', kind: 'visible', selector: '#billingAddressLine1, input[name*="addressLine1"]' },
      { name: 'stateSelect', kind: 'select', selector: '#billingAdministrativeArea' },
      { name: 'termsCheckbox', kind: 'attached', selector: '#termsOfServiceConsentCheckbox, input[type="checkbox"]' },
    ],
  },
  paypalLogin: {
    name: 'paypal-login',
    stableWindowMs: 800,
    requiredElements: [
      { name: 'emailInput', kind: 'visible', selector: '#email' },
      { name: 'submitBtn', kind: 'attached', selector: 'button[data-testid="submit-button"], button[type="submit"]' },
    ],
  },
  paypalCheckout: {
    name: 'paypal-checkout',
    stableWindowMs: 1000,
    elementTimeoutMs: 8000,
    requiredElements: [
      { name: 'countrySelect', kind: 'selectAny',
        selectors: ['#country', '#countryCode', 'select[name="country"]', 'select[name="countryCode"]', 'select[id*="ountry"]'] },
      { name: 'emailInput',  kind: 'visible', selector: '#email' },
      { name: 'cardNumber',  kind: 'visible', selector: '#cardNumber' },
      { name: 'firstName',   kind: 'visible', selector: '#firstName' },
    ],
  },
  paypalCheckoutAfterCountry: {
    name: 'paypal-checkout-after-country',
    stableWindowMs: 1500,
    elementTimeoutMs: 8000,
    requiredElements: [
      { name: 'billingLine1', kind: 'visible', selector: '#billingLine1' },
      { name: 'billingState', kind: 'select',  selector: '#billingState' },
      { name: 'billingZip',   kind: 'visible', selector: '#billingPostalCode' },
    ],
  },
  smsDialog: {
    name: 'sms-dialog',
    stableWindowMs: 500,
    elementTimeoutMs: 8000,
    requiredElements: [
      { name: 'codeDialog', kind: 'text', anyOf: ['Enter your code', '输入验证码', '输入你的验证码'] },
      { name: 'codeInput', kind: 'visibleAny',
        selectors: ['input[autocomplete="one-time-code"]', 'input[type="tel"]', 'input[type="number"]'] },
    ],
  },
};

async function waitForPageReady(page, profile, opts = {}) {
  // Will be implemented in Task 4.
  return { ready: false, waitedMs: 0, missing: [] };
}

module.exports = { PROFILES, waitForPageReady };
```

- [ ] **Step 4: 运行测试看到通过**

Run: `node --test __tests__/payment-readiness.test.js`
Expected: `# pass 3` — schema 校验 + 6 个 profile 存在 + 函数导出

- [ ] **Step 5: Commit**

```bash
git add payment-readiness.js __tests__/payment-readiness.test.js
git commit -m "feat(payment): scaffold payment-readiness module + 6 profiles"
```

---

## Task 2: 实现 `waitForDomStable` 子函数

**Files:**
- Modify: `payment-readiness.js`
- Modify: `__tests__/payment-readiness.test.js`

- [ ] **Step 1: 在 test 文件追加 mock page + DOM 稳定测试（先红）**

Append to `__tests__/payment-readiness.test.js`:

```js
const { _internal } = require('../payment-readiness');

// Build a mock page whose page.evaluate(fn) returns whatever fn returns (synchronously).
function mockPage({ stableReturns = true, stableDelayMs = 0 } = {}) {
  return {
    async evaluate(fn, ...args) {
      // For waitForDomStable, the injected fn returns a Promise that resolves true/false.
      // We simulate by waiting stableDelayMs then resolving stableReturns.
      if (fn.__readinessRole === 'domStable') {
        await new Promise(r => setTimeout(r, stableDelayMs));
        return stableReturns;
      }
      return fn(...args);
    },
  };
}

test('waitForDomStable: 立即返回 true 时 ready=true', async () => {
  const page = mockPage({ stableReturns: true, stableDelayMs: 0 });
  const deadline = Date.now() + 5000;
  const ok = await _internal.waitForDomStable(page, 500, deadline);
  assert.strictEqual(ok, true);
});

test('waitForDomStable: deadline 已过返回 false', async () => {
  const page = mockPage({ stableReturns: false, stableDelayMs: 0 });
  const deadline = Date.now() - 1;
  const ok = await _internal.waitForDomStable(page, 500, deadline);
  assert.strictEqual(ok, false);
});
```

- [ ] **Step 2: 运行测试看到失败**

Run: `node --test __tests__/payment-readiness.test.js`
Expected: `FAIL` — `_internal` is undefined / `waitForDomStable` is not a function

- [ ] **Step 3: 实现 `waitForDomStable` 并通过 `_internal` 导出**

In `payment-readiness.js`, replace the placeholder `waitForPageReady` block with:

```js
async function waitForDomStable(page, windowMs, deadline) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return false;
  const inject = async function injectedDomStable(_windowMs, _maxMs) {
    return await new Promise((resolve) => {
      let timer = null;
      let observer = null;
      const finish = (ok) => {
        if (timer) clearTimeout(timer);
        if (observer) try { observer.disconnect(); } catch (e) {}
        resolve(ok);
      };
      // Hard cap so observer never lingers past maxMs.
      const cap = setTimeout(() => finish(false), _maxMs);
      const reset = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { clearTimeout(cap); finish(true); }, _windowMs);
      };
      try {
        observer = new MutationObserver(reset);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
        reset();
      } catch (e) { clearTimeout(cap); resolve(true); }
    });
  };
  inject.__readinessRole = 'domStable';
  try {
    return await page.evaluate(inject, windowMs, remainingMs);
  } catch (e) {
    return false;
  }
}

async function waitForPageReady(page, profile, opts = {}) {
  // Will be implemented in Task 4.
  return { ready: false, waitedMs: 0, missing: [] };
}

module.exports = { PROFILES, waitForPageReady, _internal: { waitForDomStable } };
```

- [ ] **Step 4: 运行测试看到通过**

Run: `node --test __tests__/payment-readiness.test.js`
Expected: `# pass 5` (3 from Task 1 + 2 new)

- [ ] **Step 5: Commit**

```bash
git add payment-readiness.js __tests__/payment-readiness.test.js
git commit -m "feat(payment): waitForDomStable via MutationObserver injection"
```

---

## Task 3: 实现 `checkElement` 多 kind 调度

**Files:**
- Modify: `payment-readiness.js`
- Modify: `__tests__/payment-readiness.test.js`

- [ ] **Step 1: 在 test 文件追加 checkElement 测试（先红）**

Append to `__tests__/payment-readiness.test.js`:

```js
// Mock a Playwright locator. callbackMap maps method-name → return value (sync or async).
function mockLocator({ waitForOutcome = 'ok', isEnabledReturn = true } = {}) {
  return {
    first: function () { return this; },
    async waitFor(_opts) { if (waitForOutcome === 'throw') throw new Error('timeout'); },
    async isEnabled() { return isEnabledReturn; },
    async count() { return 1; },
  };
}

function mockPageForLocator(locatorBuilder, { evalReturn = true } = {}) {
  return {
    locator(_sel) { return locatorBuilder(_sel); },
    async evaluate(fn, ...args) {
      if (typeof fn === 'function') {
        try { return fn(...args); } catch (e) { return evalReturn; }
      }
      return evalReturn;
    },
  };
}

test('checkElement kind=visible: locator OK + enabled → ok:true', async () => {
  const page = mockPageForLocator(() => mockLocator({ waitForOutcome: 'ok', isEnabledReturn: true }));
  const r = await _internal.checkElement(page, { name: 'foo', kind: 'visible', selector: '#x' }, 1000);
  assert.deepStrictEqual(r, { name: 'foo', ok: true });
});

test('checkElement kind=visible: locator throw → ok:false', async () => {
  const page = mockPageForLocator(() => mockLocator({ waitForOutcome: 'throw' }));
  const r = await _internal.checkElement(page, { name: 'foo', kind: 'visible', selector: '#x' }, 1000);
  assert.deepStrictEqual(r, { name: 'foo', ok: false });
});

test('checkElement kind=js: check 函数返回 true → ok:true', async () => {
  const page = { async evaluate(fn) { return fn(); } };
  const r = await _internal.checkElement(page, { name: 'price', kind: 'js', check: () => true }, 1000);
  assert.deepStrictEqual(r, { name: 'price', ok: true });
});

test('checkElement kind=js: check 函数返回 false → ok:false', async () => {
  const page = { async evaluate(fn) { return fn(); } };
  const r = await _internal.checkElement(page, { name: 'price', kind: 'js', check: () => false }, 1000);
  assert.deepStrictEqual(r, { name: 'price', ok: false });
});

test('checkElement kind=selectAny: 第一个 selector 命中即 ok', async () => {
  let calls = 0;
  const page = {
    locator: (sel) => mockLocator({ waitForOutcome: 'ok' }),
    async evaluate(fn, sel) {
      calls++;
      return { hasOptions: true };
    },
  };
  const r = await _internal.checkElement(page,
    { name: 'country', kind: 'selectAny', selectors: ['#a', '#b'] }, 1000);
  assert.strictEqual(r.ok, true);
});

test('checkElement kind=text: anyOf 中任一可见 → ok', async () => {
  const page = mockPageForLocator(() => mockLocator({ waitForOutcome: 'ok' }));
  const r = await _internal.checkElement(page,
    { name: 'dialog', kind: 'text', anyOf: ['Enter your code', '输入验证码'] }, 1000);
  assert.deepStrictEqual(r, { name: 'dialog', ok: true });
});

test('checkElement: unknown kind → ok:false', async () => {
  const page = mockPageForLocator(() => mockLocator());
  const r = await _internal.checkElement(page, { name: 'foo', kind: 'unknown' }, 1000);
  assert.deepStrictEqual(r, { name: 'foo', ok: false });
});
```

- [ ] **Step 2: 运行测试看到失败**

Run: `node --test __tests__/payment-readiness.test.js`
Expected: `FAIL` — `_internal.checkElement is not a function`

- [ ] **Step 3: 实现 `checkElement` 并把它加入 `_internal` 导出**

In `payment-readiness.js`, **before** `module.exports`, add this function:

```js
async function checkElement(page, spec, timeoutMs) {
  const fail = { name: spec.name, ok: false };
  const ok = { name: spec.name, ok: true };
  try {
    switch (spec.kind) {
      case 'visible': {
        const loc = page.locator(spec.selector).first();
        await loc.waitFor({ state: 'visible', timeout: timeoutMs });
        const enabled = await loc.isEnabled().catch(() => true);
        return enabled ? ok : fail;
      }
      case 'attached': {
        const loc = page.locator(spec.selector).first();
        await loc.waitFor({ state: 'attached', timeout: timeoutMs });
        return ok;
      }
      case 'select': {
        const loc = page.locator(spec.selector).first();
        await loc.waitFor({ state: 'visible', timeout: timeoutMs });
        const hasOptions = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return !!(el && el.tagName === 'SELECT' && el.options && el.options.length > 1);
        }, spec.selector);
        return hasOptions ? ok : fail;
      }
      case 'selectAny': {
        for (const sel of (spec.selectors || [])) {
          try {
            const loc = page.locator(sel).first();
            await loc.waitFor({ state: 'visible', timeout: Math.min(2000, timeoutMs) });
            const hasOptions = await page.evaluate((s) => {
              const el = document.querySelector(s);
              return !!(el && el.tagName === 'SELECT' && el.options && el.options.length > 1);
            }, sel);
            if (hasOptions) return ok;
          } catch (e) { /* try next */ }
        }
        return fail;
      }
      case 'visibleAny': {
        for (const sel of (spec.selectors || [])) {
          try {
            const loc = page.locator(sel).first();
            await loc.waitFor({ state: 'visible', timeout: Math.min(2000, timeoutMs) });
            return ok;
          } catch (e) { /* try next */ }
        }
        return fail;
      }
      case 'text': {
        for (const t of (spec.anyOf || [])) {
          try {
            await page.locator(`text=${t}`).first().waitFor({ state: 'visible', timeout: Math.min(2000, timeoutMs) });
            return ok;
          } catch (e) { /* try next */ }
        }
        return fail;
      }
      case 'js': {
        const result = await page.evaluate(spec.check).catch(() => false);
        return result ? ok : fail;
      }
      default:
        return fail;
    }
  } catch (e) {
    return fail;
  }
}
```

Then update the `module.exports` line to:

```js
module.exports = { PROFILES, waitForPageReady, _internal: { waitForDomStable, checkElement } };
```

- [ ] **Step 4: 运行测试看到通过**

Run: `node --test __tests__/payment-readiness.test.js`
Expected: `# pass 12` (5 from before + 7 new)

- [ ] **Step 5: Commit**

```bash
git add payment-readiness.js __tests__/payment-readiness.test.js
git commit -m "feat(payment): checkElement dispatcher for 7 element kinds"
```

---

## Task 4: 组合 `waitForPageReady` 主函数

**Files:**
- Modify: `payment-readiness.js`
- Modify: `__tests__/payment-readiness.test.js`

- [ ] **Step 1: 追加 `waitForPageReady` 集成测试（先红）**

Append to `__tests__/payment-readiness.test.js`:

```js
test('waitForPageReady: 全就绪 → ready:true, missing:[]', async () => {
  const page = {
    locator: () => mockLocator({ waitForOutcome: 'ok', isEnabledReturn: true }),
    async evaluate(fn) {
      if (fn.__readinessRole === 'domStable') return true;
      return true;
    },
  };
  const profile = {
    name: 'test', stableWindowMs: 100,
    requiredElements: [
      { name: 'a', kind: 'visible', selector: '#a' },
      { name: 'b', kind: 'attached', selector: '#b' },
    ],
  };
  const r = await waitForPageReady(page, profile, { totalTimeoutMs: 5000 });
  assert.strictEqual(r.ready, true);
  assert.deepStrictEqual(r.missing, []);
  assert.ok(r.waitedMs >= 0);
});

test('waitForPageReady: DOM 永不稳定但元素就绪 → ready:false, missing:[]', async () => {
  const page = {
    locator: () => mockLocator({ waitForOutcome: 'ok' }),
    async evaluate(fn) {
      if (fn.__readinessRole === 'domStable') return false;
      return true;
    },
  };
  const profile = {
    name: 'test', stableWindowMs: 100,
    requiredElements: [{ name: 'a', kind: 'visible', selector: '#a' }],
  };
  const r = await waitForPageReady(page, profile, { totalTimeoutMs: 1000 });
  assert.strictEqual(r.ready, false);
  assert.deepStrictEqual(r.missing, []);
});

test('waitForPageReady: 部分元素超时 → ready:false, missing 含名', async () => {
  const page = {
    locator: (sel) => {
      // #good 通过；#bad throw
      if (sel === '#good') return mockLocator({ waitForOutcome: 'ok' });
      return mockLocator({ waitForOutcome: 'throw' });
    },
    async evaluate(fn) {
      if (fn.__readinessRole === 'domStable') return true;
      return true;
    },
  };
  const profile = {
    name: 'test', stableWindowMs: 100,
    requiredElements: [
      { name: 'good', kind: 'visible', selector: '#good' },
      { name: 'bad',  kind: 'visible', selector: '#bad' },
    ],
  };
  const r = await waitForPageReady(page, profile, { totalTimeoutMs: 1000 });
  assert.strictEqual(r.ready, false);
  assert.deepStrictEqual(r.missing, ['bad']);
});

test('waitForPageReady: log callback 被调用一次', async () => {
  const logged = [];
  const page = {
    locator: () => mockLocator({ waitForOutcome: 'ok' }),
    async evaluate(fn) { return true; },
  };
  const profile = {
    name: 'test', stableWindowMs: 50,
    requiredElements: [{ name: 'a', kind: 'visible', selector: '#a' }],
  };
  await waitForPageReady(page, profile, { totalTimeoutMs: 500, log: (m) => logged.push(m) });
  assert.strictEqual(logged.length, 1);
  assert.ok(logged[0].includes('ready') || logged[0].includes('timeout'));
});
```

- [ ] **Step 2: 运行测试看到失败**

Run: `node --test __tests__/payment-readiness.test.js`
Expected: `FAIL` — `waitForPageReady` still returns the placeholder `{ ready: false, ... }`

- [ ] **Step 3: 实现 `waitForPageReady`**

Replace the placeholder `waitForPageReady` in `payment-readiness.js` with:

```js
async function waitForPageReady(page, profile, opts = {}) {
  const totalTimeoutMs = opts.totalTimeoutMs || 60000;
  const elementTimeoutMs = profile.elementTimeoutMs || 5000;
  const log = opts.log || (() => {});
  const start = Date.now();
  const deadline = start + totalTimeoutMs;

  // Concurrently run DOM-stability wait and all element checks. Element checks
  // get the smaller of their own timeout and the remaining budget so we never
  // exceed totalTimeoutMs.
  const domStablePromise = waitForDomStable(page, profile.stableWindowMs, deadline);
  const elementPromises = profile.requiredElements.map((spec) => {
    const remaining = Math.max(500, deadline - Date.now());
    return checkElement(page, spec, Math.min(elementTimeoutMs, remaining));
  });

  const [domStableOk, elementResults] = await Promise.all([
    domStablePromise,
    Promise.all(elementPromises),
  ]);

  const missing = elementResults.filter((r) => !r.ok).map((r) => r.name);
  const ready = domStableOk && missing.length === 0;
  const waitedMs = Date.now() - start;

  if (ready) {
    log(`[Pay] Page ready (${profile.name}) in ${waitedMs}ms`);
  } else {
    log(`[Pay] Readiness timeout (${profile.name}) — missing=[${missing.join(',')}] domStable=${domStableOk} waited=${waitedMs}ms`);
  }
  return { ready, waitedMs, missing };
}
```

- [ ] **Step 4: 运行测试看到通过**

Run: `node --test __tests__/payment-readiness.test.js`
Expected: `# pass 16` (12 from before + 4 new)

- [ ] **Step 5: Commit**

```bash
git add payment-readiness.js __tests__/payment-readiness.test.js
git commit -m "feat(payment): waitForPageReady composes DOM-stable + element checks"
```

---

## Task 5: 接入 `handleOpenAIPage` 入口

**Files:**
- Modify: `payment.js` (function `handleOpenAIPage`, around line 160-211)

- [ ] **Step 1: 阅读现有 `handleOpenAIPage` 开头**

Open `payment.js`, find the function `handleOpenAIPage(page)` starting at line 160. The current opening is:

```js
async function handleOpenAIPage(page) {
  console.log('    [Pay] OpenAI/Stripe page detected');

  // Step 0a: Detect if this is actually a $0 trial. ...
  await randomDelay(1500, 2500);  // let Stripe render the prices
  const scan = await page.evaluate(() => {
    ...
```

The `randomDelay(1500, 2500)` is what we replace.

- [ ] **Step 2: 在文件顶部新增 require**

Edit `payment.js` near the top (after the existing `require('./utils')` line, line 3):

Change:
```js
const { randomDelay } = require('./utils');
```
to:
```js
const { randomDelay } = require('./utils');
const { waitForPageReady, PROFILES } = require('./payment-readiness');
```

- [ ] **Step 3: 替换 `handleOpenAIPage` 头部 randomDelay 为 readiness 调用**

Change (around line 168):
```js
  console.log('    [Pay] OpenAI/Stripe page detected');

  // Step 0a: Detect if this is actually a $0 trial. Some Discord links lead to a
  // regular paid subscription page; we don't want to start filling cards on those.
  // Strategy: (1) look for a localized "Total due today" label and parse the amount
  // after it; (2) fallback — if no label matched but there ARE USD amounts on the
  // page AND none of them is $0, then there's no "free" anywhere → treat as paid.
  await randomDelay(1500, 2500);  // let Stripe render the prices
```

to:
```js
  console.log('    [Pay] OpenAI/Stripe page detected');

  const r0 = await waitForPageReady(page, PROFILES.openai, { log: (m) => console.log('    ' + m) });
  if (!r0.ready) {
    console.log(`    [Pay] 警告：openai-stripe 页 60s 未就绪 missing=[${r0.missing.join(',')}]，仍尝试继续`);
  }

  // Step 0a: Detect if this is actually a $0 trial. Some Discord links lead to a
  // regular paid subscription page; we don't want to start filling cards on those.
  // Strategy: (1) look for a localized "Total due today" label and parse the amount
  // after it; (2) fallback — if no label matched but there ARE USD amounts on the
  // page AND none of them is $0, then there's no "free" anywhere → treat as paid.
```

- [ ] **Step 4: 语法校验**

Run: `node --check payment.js`
Expected: no output (silent success)

- [ ] **Step 5: 跑 readiness 单元测试确保没回归**

Run: `node --test __tests__/payment-readiness.test.js`
Expected: `# pass 16`

- [ ] **Step 6: Commit**

```bash
git add payment.js
git commit -m "feat(payment): wait for OpenAI/Stripe page readiness before \$0 scan"
```

---

## Task 6: 接入 `handleOpenAIPage` 中的 paypal-accordion-expanded 检测

**Files:**
- Modify: `payment.js` (around line 234-260)

- [ ] **Step 1: 阅读现有 PayPal accordion 展开后的等待逻辑**

In `payment.js`, the current logic (around line 234-260) is:

```js
  // Verify billing form appears
  await randomDelay(2000, 3000);
  let formFound = false;
  for (let w = 0; w < 10; w++) {
    const hasForm = await page.locator('#billingAddressLine1').isVisible({ timeout: 1000 }).catch(() => false);
    if (hasForm) { formFound = true; break; }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!formFound) {
    console.log('    [Pay] Billing form not visible, reloading to retry...');
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await randomDelay(3000, 4000);
    ppClicked = await page.evaluate(...).catch(() => false);
    console.log('    [Pay] PayPal retry:', ppClicked);
    await randomDelay(2000, 3000);
  }
```

There are two waits: the `randomDelay(2000, 3000)` + 10-iteration loop, then a separate `randomDelay(2000, 3000)` after reload retry. We replace the first wait block with readiness; keep the reload retry path but use readiness inside it too.

- [ ] **Step 2: 替换第一段等待**

Change:
```js
  // Verify billing form appears
  await randomDelay(2000, 3000);
  let formFound = false;
  for (let w = 0; w < 10; w++) {
    const hasForm = await page.locator('#billingAddressLine1').isVisible({ timeout: 1000 }).catch(() => false);
    if (hasForm) { formFound = true; break; }
    await new Promise(r => setTimeout(r, 1000));
  }
```

to:
```js
  // Verify billing form appears + key fields ready (state options loaded, terms checkbox attached)
  const r1 = await waitForPageReady(page, PROFILES.paypalAccordionExpanded, { log: (m) => console.log('    ' + m) });
  const formFound = r1.ready;
  if (!r1.ready) {
    console.log(`    [Pay] 警告：accordion 展开未就绪 missing=[${r1.missing.join(',')}]`);
  }
```

- [ ] **Step 3: 替换 reload retry 后的等待**

Change:
```js
  if (!formFound) {
    console.log('    [Pay] Billing form not visible, reloading to retry...');
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await randomDelay(3000, 4000);
    ppClicked = await page.evaluate(() => { var el = document.querySelector('[data-testid="paypal-accordion-item-button"]') || document.querySelector('#payment-method-accordion-item-title-paypal'); if (el) { el.click(); return true; } return false; }).catch(() => false);
    console.log('    [Pay] PayPal retry:', ppClicked);
    await randomDelay(2000, 3000);
  }
```

to:
```js
  if (!formFound) {
    console.log('    [Pay] Billing form not visible, reloading to retry...');
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    const r1a = await waitForPageReady(page, PROFILES.openai, { log: (m) => console.log('    ' + m) });
    if (!r1a.ready) console.log(`    [Pay] 警告：reload 后 openai 未就绪 missing=[${r1a.missing.join(',')}]`);
    ppClicked = await page.evaluate(() => { var el = document.querySelector('[data-testid="paypal-accordion-item-button"]') || document.querySelector('#payment-method-accordion-item-title-paypal'); if (el) { el.click(); return true; } return false; }).catch(() => false);
    console.log('    [Pay] PayPal retry:', ppClicked);
    const r1b = await waitForPageReady(page, PROFILES.paypalAccordionExpanded, { log: (m) => console.log('    ' + m) });
    if (!r1b.ready) console.log(`    [Pay] 警告：retry 后 accordion 未就绪 missing=[${r1b.missing.join(',')}]`);
  }
```

- [ ] **Step 4: 删除随后冗余的 "Waiting for billing form" 10 轮循环**

Find this block (around line 254-260):
```js
  // Wait for billing address form to appear after PayPal selection
  console.log('    [Pay] Waiting for billing form...');
  for (let w = 0; w < 10; w++) {
    const hasForm = await page.locator('#billingAddressLine1, input[name*="addressLine1"]').first().isVisible({ timeout: 1000 }).catch(() => false);
    if (hasForm) break;
    await new Promise(r => setTimeout(r, 1000));
  }
```

Delete it entirely — readiness already covers this case.

- [ ] **Step 5: 语法校验 + 单元测试**

Run: `node --check payment.js && node --test __tests__/payment-readiness.test.js`
Expected: no syntax error + `# pass 16`

- [ ] **Step 6: Commit**

```bash
git add payment.js
git commit -m "feat(payment): use readiness for PayPal accordion expansion + drop redundant loops"
```

---

## Task 7: 接入 `handlePayPalLogin` 入口

**Files:**
- Modify: `payment.js` (function `handlePayPalLogin`, around line 356-366)

- [ ] **Step 1: 阅读现有 `handlePayPalLogin`**

Current code:
```js
async function handlePayPalLogin(page) {
  console.log('    [Pay] PayPal login page detected');
  await randomDelay(2000, 3000);

  const email = randEmail();
  console.log('    [Pay] Email:', email);
  await fillInput(page, '#email', email);
  await randomDelay(800, 1200);
  await clickSubmit(page);
  console.log('    [Pay] PayPal login submitted');
}
```

The `randomDelay(2000, 3000)` at the top is the load-wait; `randomDelay(800, 1200)` between fill and click is anti-detection (keep).

- [ ] **Step 2: 替换入口 randomDelay 为 readiness**

Change:
```js
async function handlePayPalLogin(page) {
  console.log('    [Pay] PayPal login page detected');
  await randomDelay(2000, 3000);
```

to:
```js
async function handlePayPalLogin(page) {
  console.log('    [Pay] PayPal login page detected');
  const r = await waitForPageReady(page, PROFILES.paypalLogin, { log: (m) => console.log('    ' + m) });
  if (!r.ready) {
    console.log(`    [Pay] 警告：paypal-login 60s 未就绪 missing=[${r.missing.join(',')}]，仍尝试继续`);
  }
```

- [ ] **Step 3: 语法校验 + 单元测试**

Run: `node --check payment.js && node --test __tests__/payment-readiness.test.js`
Expected: no syntax error + `# pass 16`

- [ ] **Step 4: Commit**

```bash
git add payment.js
git commit -m "feat(payment): wait for PayPal login page readiness before email fill"
```

---

## Task 8: 接入 `handlePayPalCheckout` 入口

**Files:**
- Modify: `payment.js` (function `handlePayPalCheckout`, around line 368-405)

- [ ] **Step 1: 阅读现有 `handlePayPalCheckout` 开头**

Current code (around line 368-376):
```js
async function handlePayPalCheckout(page, phoneOverride, smsOverride) {
  console.log('    [Pay] PayPal checkout page detected');
  await randomDelay(2000, 3000);

  // Set country to US. PayPal uses different element IDs across A/B tests and
  // locale variants (#country, #countryCode, select[name="country"], etc.). We
  // try multiple selectors and wait for at least one to appear before switching.
  // If none is found or the switch doesn't stick, we abort rather than fill a
  // Chinese-schema form with US address data.
  const countryInfo = await page.evaluate(() => {
    ...
  });
```

- [ ] **Step 2: 替换入口 randomDelay 为 readiness**

Change:
```js
async function handlePayPalCheckout(page, phoneOverride, smsOverride) {
  console.log('    [Pay] PayPal checkout page detected');
  await randomDelay(2000, 3000);
```

to:
```js
async function handlePayPalCheckout(page, phoneOverride, smsOverride) {
  console.log('    [Pay] PayPal checkout page detected');
  const r = await waitForPageReady(page, PROFILES.paypalCheckout, { log: (m) => console.log('    ' + m) });
  if (!r.ready) {
    console.log(`    [Pay] 警告：paypal-checkout 60s 未就绪 missing=[${r.missing.join(',')}]，仍尝试继续`);
  }
```

- [ ] **Step 3: 语法校验 + 单元测试**

Run: `node --check payment.js && node --test __tests__/payment-readiness.test.js`
Expected: no syntax error + `# pass 16`

- [ ] **Step 4: Commit**

```bash
git add payment.js
git commit -m "feat(payment): wait for PayPal checkout page readiness before country switch"
```

---

## Task 9: 接入 `handlePayPalCheckout` 切完国家后的 readiness

**Files:**
- Modify: `payment.js` (around line 428-432)

- [ ] **Step 1: 阅读现有切换国家后的等待**

In `payment.js` `handlePayPalCheckout`, after the country select-and-wait block (around line 426-432):

```js
    // Give the dependent fields (state options, address schema) a beat to repaint.
    await randomDelay(1500, 2500);
  } else if (initial === 'US') {
    console.log('    [Pay] Country already US');
  }
```

The `randomDelay(1500, 2500)` here is exactly the "wait for dependent fields to repaint" — perfect place for the after-country readiness profile.

- [ ] **Step 2: 替换为 readiness**

Change:
```js
    // Give the dependent fields (state options, address schema) a beat to repaint.
    await randomDelay(1500, 2500);
  } else if (initial === 'US') {
    console.log('    [Pay] Country already US');
  }
```

to:
```js
    // Wait for billing schema to repaint (state options, addressLine1, zip) after country switch.
    const rAfter = await waitForPageReady(page, PROFILES.paypalCheckoutAfterCountry, { log: (m) => console.log('    ' + m) });
    if (!rAfter.ready) {
      console.log(`    [Pay] 警告：切换国家后 billing schema 未就绪 missing=[${rAfter.missing.join(',')}]，仍尝试继续`);
    }
  } else if (initial === 'US') {
    console.log('    [Pay] Country already US');
    // Even when no switch happened, the billing form may not have rendered yet.
    const rAfter = await waitForPageReady(page, PROFILES.paypalCheckoutAfterCountry, { log: (m) => console.log('    ' + m) });
    if (!rAfter.ready) {
      console.log(`    [Pay] 警告：billing schema 未就绪 missing=[${rAfter.missing.join(',')}]，仍尝试继续`);
    }
  }
```

- [ ] **Step 3: 语法校验 + 单元测试**

Run: `node --check payment.js && node --test __tests__/payment-readiness.test.js`
Expected: no syntax error + `# pass 16`

- [ ] **Step 4: Commit**

```bash
git add payment.js
git commit -m "feat(payment): wait for billing schema repaint after country switch"
```

---

## Task 10: 接入 `handleSmsVerification`

**Files:**
- Modify: `payment.js` (function `handleSmsVerification`, around line 515-528)

- [ ] **Step 1: 阅读现有 SMS 对话框探测**

Current code (around line 515-528):
```js
async function handleSmsVerification(page, smsOverride) {
  const SMS_URL = smsOverride || CONFIG.smsApiUrl;
  if (!SMS_URL) return;

  await randomDelay(2000, 3000);

  // Check if SMS code dialog appeared ("Enter your code")
  const codeDialog = page.locator('text=Enter your code').or(page.locator('text=输入验证码').or(page.locator('text=输入你的验证码')));
  const dialogVisible = await codeDialog.isVisible({ timeout: 8000 }).catch(() => false);
  if (!dialogVisible) {
    console.log('    [Pay] No SMS verification dialog detected');
    return false;
  }
```

The `randomDelay(2000, 3000)` + `isVisible({ timeout: 8000 })` get replaced by one readiness call. Note: SMS dialog is optional — if not present, we silently exit (existing behavior). Readiness with `ready=false` here means "no dialog after 60s" → treat same as "no dialog detected".

- [ ] **Step 2: 替换为 readiness**

Change:
```js
async function handleSmsVerification(page, smsOverride) {
  const SMS_URL = smsOverride || CONFIG.smsApiUrl;
  if (!SMS_URL) return;

  await randomDelay(2000, 3000);

  // Check if SMS code dialog appeared ("Enter your code")
  const codeDialog = page.locator('text=Enter your code').or(page.locator('text=输入验证码').or(page.locator('text=输入你的验证码')));
  const dialogVisible = await codeDialog.isVisible({ timeout: 8000 }).catch(() => false);
  if (!dialogVisible) {
    console.log('    [Pay] No SMS verification dialog detected');
    return false;
  }
```

to:
```js
async function handleSmsVerification(page, smsOverride) {
  const SMS_URL = smsOverride || CONFIG.smsApiUrl;
  if (!SMS_URL) return;

  // SMS dialog is optional — readiness returning ready:false means no dialog
  // surfaced within the timeout; treat same as "no dialog detected".
  const rSms = await waitForPageReady(page, PROFILES.smsDialog,
    { totalTimeoutMs: 15000, log: (m) => console.log('    ' + m) });
  if (!rSms.ready) {
    console.log('    [Pay] No SMS verification dialog detected');
    return false;
  }
```

Note: we shorten `totalTimeoutMs` to 15000 here because SMS dialog appearing or not is decisive — no point in waiting 60s if it didn't pop within 15s (PayPal already decided no MFA challenge for this session).

- [ ] **Step 3: 语法校验 + 单元测试**

Run: `node --check payment.js && node --test __tests__/payment-readiness.test.js`
Expected: no syntax error + `# pass 16`

- [ ] **Step 4: Commit**

```bash
git add payment.js
git commit -m "feat(payment): use readiness for SMS verification dialog detection"
```

---

## Task 11: 全量回归 + 重启 server 验证

**Files:** None (verification only)

- [ ] **Step 1: 跑全量单元测试**

Run: `node --test __tests__/payment-readiness.test.js server/proxy/__tests__/index.test.js`
Expected: `# pass 27` (16 readiness + 11 proxy)

- [ ] **Step 2: 语法校验所有 modify 过的 JS 文件**

Run: `node --check payment.js && node --check payment-readiness.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 3: grep 确认 payment.js 不再有"裸 randomDelay 接 fill/click"模式被误删（反检测随机间隔应保留）**

Run (PowerShell): `Select-String -Path payment.js -Pattern 'randomDelay\(' | Measure-Object | Select-Object -ExpandProperty Count`
Expected: ≥ 8（fill/click 之间的反检测延迟、PayPal checkout card retry 之间的延迟、handlePayPalCheckout 末尾 await randomDelay 等都保留）

If the count drops below 8, you've deleted too many — review the diff.

- [ ] **Step 4: 重启 server（杀旧 server，启新 server）**

PowerShell:
```powershell
$p = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($p) { Stop-Process -Id $p.OwningProcess -Force }
```

Then in a Bash terminal in `chatgpt-auto-login/`:
```bash
node server/index.js > server.log 2>&1 &
sleep 4
```

Verify with PowerShell:
```powershell
$p = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($p) { "OK PID=$($p.OwningProcess)" } else { 'Not listening'; Get-Content server.log -Tail 30 }
```

Expected: `OK PID=...`

- [ ] **Step 5: Commit the plan completion (optional dry-run note)**

```bash
git log --oneline -12
```

Confirm the last 10 commits are the Task 1-10 commits in order.

This task has no code commit of its own — it's a verification checkpoint. To declare the plan done, manually trigger one real payment run (协议模式启动一个账号) and watch the log for `[Pay] Page ready (...)` or `Readiness timeout (...)` lines. If timeouts dominate the logs, profiles need tuning — but that's a follow-up, not a blocker.

---

## 完成判定

- ✅ 16 个 readiness 单元测试全过
- ✅ payment.js 语法 OK
- ✅ 6 个 readiness 调用点全部接入（grep `waitForPageReady` 应该有 6+ 个 hit 在 payment.js）
- ✅ 反检测 `randomDelay` 数量 ≥ 8（fill/click 间）
- ✅ Server 在 :3000 正常监听
- ✅ 一次真实支付 dry-run 出现 `[Pay] Page ready (...)` 日志

---

## Self-Review Checklist（写完后我已自审）

**Spec 覆盖：** 6 个 profile / 6 个调用点 / waitForPageReady API / 错误处理 / 测试 → 全部映射到 Task 1-11。

**Placeholder 扫描：** 无 TBD / TODO；所有代码块完整。

**类型/方法一致性：** `waitForPageReady` 签名、`PROFILES.<key>` 键名、`_internal.{waitForDomStable, checkElement}` 一致贯穿全部 task。
