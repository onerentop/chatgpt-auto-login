const test = require('node:test');
const assert = require('node:assert');

function freshModule() {
  delete require.cache[require.resolve('../smscloud-deferred-cancel')];
  delete require.cache[require.resolve('../smscloud-provider')];
  return require('../smscloud-deferred-cancel');
}

test('enqueue + tick: 未到 125s 不调 cancelOrder', async () => {
  const mod = freshModule();
  const smscloud = require('../smscloud-provider');
  let calls = 0;
  const origCancel = smscloud.cancelOrder;
  smscloud.cancelOrder = async () => { calls++; return { ok: true }; };
  try {
    mod.enqueue({ apiKey: 'k', baseUrl: 'b', orderNo: '1', takenAtMs: Date.now() });
    await mod._tickOnce();
    assert.strictEqual(calls, 0, 'should not cancel yet');
    assert.strictEqual(mod._queueForTest().size, 1);
  } finally { smscloud.cancelOrder = origCancel; }
});

test('enqueue + tick: 到 125s 后调 cancelOrder 并出队', async () => {
  const mod = freshModule();
  const smscloud = require('../smscloud-provider');
  let calls = 0;
  const origCancel = smscloud.cancelOrder;
  smscloud.cancelOrder = async (orderNo) => { calls++; assert.strictEqual(orderNo, '2'); return { ok: true }; };
  try {
    mod.enqueue({ apiKey: 'k', baseUrl: 'b', orderNo: '2', takenAtMs: Date.now() - 130_000 });
    await mod._tickOnce();
    assert.strictEqual(calls, 1);
    assert.strictEqual(mod._queueForTest().size, 0);
  } finally { smscloud.cancelOrder = origCancel; }
});

test('enqueue + tick: cancel 失败重试 3 次后丢弃', async () => {
  const mod = freshModule();
  const smscloud = require('../smscloud-provider');
  let calls = 0;
  const origCancel = smscloud.cancelOrder;
  smscloud.cancelOrder = async () => { calls++; throw new Error('boom'); };
  try {
    mod.enqueue({ apiKey: 'k', baseUrl: 'b', orderNo: '3', takenAtMs: Date.now() - 130_000 });
    await mod._tickOnce();
    await mod._tickOnce();
    await mod._tickOnce();
    assert.strictEqual(calls, 3);
    assert.strictEqual(mod._queueForTest().size, 0, 'dropped after 3 retries');
  } finally { smscloud.cancelOrder = origCancel; }
});

test('enqueue: 同 orderNo 去重', async () => {
  const mod = freshModule();
  mod.enqueue({ apiKey: 'k', baseUrl: 'b', orderNo: '4', takenAtMs: 1000 });
  mod.enqueue({ apiKey: 'k', baseUrl: 'b', orderNo: '4', takenAtMs: 2000 });
  assert.strictEqual(mod._queueForTest().size, 1);
  assert.strictEqual(mod._queueForTest().get('4').takenAtMs, 1000);
});
