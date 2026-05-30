const test = require('node:test');
const assert = require('node:assert');
const { defineStep } = require('../../server/pipeline/step');

test('valid step passes through with default shouldSkip', () => {
  const s = defineStep({ id: 'login', label: '登录', run: async () => ({ ok: true }) });
  assert.strictEqual(s.id, 'login');
  assert.strictEqual(s.label, '登录');
  assert.strictEqual(typeof s.shouldSkip, 'function');
  assert.strictEqual(s.shouldSkip({}), false);
});

test('missing id throws', () => {
  assert.throws(() => defineStep({ label: 'x', run: async () => {} }), /id required/);
});

test('missing run throws', () => {
  assert.throws(() => defineStep({ id: 'x', label: 'x' }), /run\(\) required/);
});

test('custom shouldSkip preserved', () => {
  const s = defineStep({ id: 'x', label: 'x', shouldSkip: () => true, run: async () => {} });
  assert.strictEqual(s.shouldSkip({}), true);
});
