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
