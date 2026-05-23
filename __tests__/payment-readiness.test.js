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
