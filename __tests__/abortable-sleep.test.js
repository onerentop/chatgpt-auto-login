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
