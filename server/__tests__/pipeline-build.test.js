const test = require('node:test');
const assert = require('node:assert');
const { buildPipeline } = require('../../server/pipeline');

test('paypal pipeline declares the 6 user-facing steps in order', () => {
  const steps = buildPipeline({ login: 'protocol', payment: 'paypal' });
  assert.deepStrictEqual(steps.map(s => s.id),
    ['login', 'plan-check', 'paypal-fetch', 'paypal-verify', 'paypal-pay', 'paypal-pkce']);
});

test('browser paypal pipeline declares the 7 browser-specific steps in order', () => {
  const steps = buildPipeline({ login: 'browser', payment: 'paypal' });
  assert.deepStrictEqual(steps.map(s => s.id),
    ['login', 'plan-check', 'paypal-fetch', 'paypal-verify', 'paypal-pay', 'browser-pkce', 'cpa']);
});

test('gopay pipeline declares its 4 real steps in order (no login step)', () => {
  const steps = buildPipeline({ login: 'protocol', payment: 'gopay' });
  assert.deepStrictEqual(steps.map(s => s.id),
    ['plan-check', 'gopay-register', 'gopay-pay', 'gopay-verify']);
});

test('every step satisfies the contract', () => {
  for (const combo of [{ login: 'protocol', payment: 'paypal' }, { login: 'browser', payment: 'paypal' }, { login: 'protocol', payment: 'gopay' }]) {
    for (const s of buildPipeline(combo)) {
      assert.ok(s.id && s.label && typeof s.run === 'function' && typeof s.shouldSkip === 'function', `bad step ${s.id}`);
    }
  }
});
