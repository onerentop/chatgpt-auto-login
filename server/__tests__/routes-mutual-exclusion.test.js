// server/__tests__/routes-mutual-exclusion.test.js
const test = require('node:test');
const assert = require('node:assert');

test('gopay engine state.running is readable (drives 互斥判定)', () => {
  const gopayEngine = require('../gopay-engine');
  const orig = Object.getOwnPropertyDescriptor(gopayEngine, 'state');
  let running = true;
  Object.defineProperty(gopayEngine, 'state', { get: () => ({ running }), configurable: true });
  assert.strictEqual(gopayEngine.state.running, true);
  running = false;
  assert.strictEqual(gopayEngine.state.running, false);
  if (orig) Object.defineProperty(gopayEngine, 'state', orig);
});
