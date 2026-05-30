// server/__tests__/pipeline-paypal-fetch-step.test.js
// 单元特征化测试：不发起真实网络请求，仅覆盖可注入测试接缝的行为。
// 使用 node:test runner（本项目没有 jest/mocha）。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { paypalFetchStep } = require('../../server/pipeline/steps/paypal-fetch');
const { AccountContext } = require('../../server/pipeline/context');

// --------------------------------------------------------------------------
// ctx 构造辅助
// --------------------------------------------------------------------------
function makeCtx({
  emitStatusCalls = [],
  linkSource = 'api',
  alreadyPlus = false,
  persistedRow = null,           // statusDB 中的初始行（simulate prevPersisted）
  fetchCheckoutLinkFn = null,    // 测试接缝：替换 fetchCheckoutLink
  getPaymentLinkFn = null,       // 测试接缝：替换 getPaymentLink
  connectGatewayFn = null,       // 测试接缝：替换 connectGateway
  gwReadyState = 1,              // Discord gateway ws.readyState（1=OPEN）
} = {}) {
  const statusDbRows = {};
  const account = { email: 'test@example.com', password: 'pw', client_id: '', refresh_token: '' };

  if (persistedRow) {
    statusDbRows[account.email] = { ...persistedRow };
  }

  // Fake gateway object（Discord path）
  const fakeGw = {
    ws: { readyState: gwReadyState },
    cleanup: () => {},
  };

  const deps = {
    emitStatus: (data) => { emitStatusCalls.push(data); },
    summary: { total: 1, success: 0, error: 0, noLink: 0, noJpProxy: 0, noPromo: 0, verifyError: 0 },
    progress: '1/1',
    linkSource,
    resources: { gw: fakeGw },
    statusDB: {
      get: (email) => statusDbRows[email] || null,
      set: (email, data) => { statusDbRows[email] = { ...(statusDbRows[email] || {}), ...data }; },
    },
    // 测试接缝
    __fetchCheckoutLink: fetchCheckoutLinkFn,
    __getPaymentLink: getPaymentLinkFn,
    __connectGateway: connectGatewayFn,
  };

  const ctx = new AccountContext(account, deps);
  // 模拟 login step 的输出
  ctx.outputs.login = { accessToken: 'token-abc', session: {}, planType: 'free' };
  // 设置 flags
  if (alreadyPlus) ctx.flags.alreadyPlus = true;
  // 暴露 statusDbRows 给测试断言
  ctx.statusDbRows = statusDbRows;

  return ctx;
}

// --------------------------------------------------------------------------
// 测试 1：shouldSkip：alreadyPlus = true → 返回 true
// --------------------------------------------------------------------------
test('shouldSkip returns true when ctx.flags.alreadyPlus is set', () => {
  const step = paypalFetchStep();
  const ctx = makeCtx({ alreadyPlus: true });
  assert.strictEqual(step.shouldSkip(ctx), true);
});

// --------------------------------------------------------------------------
// 测试 2：shouldSkip：alreadyPlus 未设 → 返回 false
// --------------------------------------------------------------------------
test('shouldSkip returns false when alreadyPlus is not set', () => {
  const step = paypalFetchStep();
  const ctx = makeCtx({ alreadyPlus: false });
  assert.strictEqual(step.shouldSkip(ctx), false);
});

// --------------------------------------------------------------------------
// 测试 3：缓存链接快路径 — status 在 REUSE_STATUSES（verify_error）中
//   期望：复用缓存链接，不调用 fetchCheckoutLink，emit running/checkout，
//         ctx.outputs['paypal-fetch'].link === 'L'，ok:true
// --------------------------------------------------------------------------
test('cached-link fast-path: status in REUSE_STATUSES → reuses link, no fetch call, ok:true', async () => {
  const emitCalls = [];
  let fetchCalled = false;
  const fakeCheckout = async () => { fetchCalled = true; return { link: 'NEW', pk: 'new-pk' }; };

  const ctx = makeCtx({
    emitStatusCalls: emitCalls,
    linkSource: 'api',
    persistedRow: {
      payment_link: 'L',
      payment_link_pk: 'pk',
      status: 'verify_error',
      payment_link_at: '2026-01-01T00:00:00.000Z',
    },
    fetchCheckoutLinkFn: fakeCheckout,
  });

  const step = paypalFetchStep();
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true, 'should return ok:true on cached-link reuse');
  assert.strictEqual(fetchCalled, false, 'fetchCheckoutLink must NOT be called when cache is used');

  // 必须先 emit running/checkout
  const runningEmit = emitCalls.find(e => e.status === 'running' && e.phase === 'checkout');
  assert.ok(runningEmit, 'must emit running/checkout before cache check');

  // 输出链接
  assert.ok(ctx.outputs['paypal-fetch'], 'ctx.outputs["paypal-fetch"] must be set');
  assert.strictEqual(ctx.outputs['paypal-fetch'].link, 'L', 'output link must match cached value');
  assert.strictEqual(ctx.outputs['paypal-fetch'].usedCachedLink, true, 'usedCachedLink must be true');
});

// --------------------------------------------------------------------------
// 测试 4：缓存链接快路径 — status 不在 REUSE_STATUSES（no_link）→ 不复用缓存
// --------------------------------------------------------------------------
test('cached-link NOT used when status not in REUSE_STATUSES (e.g. no_link)', async () => {
  let fetchCalled = false;
  const fakeCheckout = async () => {
    fetchCalled = true;
    return { link: 'FRESH', pk: 'fp' };
  };

  const ctx = makeCtx({
    linkSource: 'api',
    persistedRow: {
      payment_link: 'OLD',
      payment_link_pk: 'old-pk',
      status: 'no_link',   // NOT in REUSE_STATUSES
    },
    fetchCheckoutLinkFn: fakeCheckout,
  });

  const step = paypalFetchStep();
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true);
  assert.strictEqual(fetchCalled, true, 'fetchCheckoutLink MUST be called when status not in REUSE_STATUSES');
  assert.strictEqual(ctx.outputs['paypal-fetch'].link, 'FRESH');
  assert.strictEqual(ctx.outputs['paypal-fetch'].usedCachedLink, false);
});

// --------------------------------------------------------------------------
// 测试 5：API 路径成功（fetchCheckoutLink 返回 link）→ 持久化，输出设置，ok:true
// --------------------------------------------------------------------------
test('api-path success: fetchCheckoutLink returns link → persists, output set, ok:true', async () => {
  const emitCalls = [];
  const fakeCheckout = async () => ({ link: 'L2', pk: 'p2' });

  const ctx = makeCtx({
    emitStatusCalls: emitCalls,
    linkSource: 'api',
    fetchCheckoutLinkFn: fakeCheckout,
  });

  const step = paypalFetchStep();
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true);

  // 输出
  assert.strictEqual(ctx.outputs['paypal-fetch'].link, 'L2');
  assert.strictEqual(ctx.outputs['paypal-fetch'].pk, 'p2');
  assert.strictEqual(ctx.outputs['paypal-fetch'].usedCachedLink, false);

  // 持久化：persist-before-verify（protocol-engine.js:815-820）
  const persisted = ctx.statusDbRows[ctx.account.email];
  assert.ok(persisted, 'statusDB must have a row after successful fetch');
  assert.strictEqual(persisted.status, 'running', 'persisted status must be running');
  assert.strictEqual(persisted.phase, 'verify', 'persisted phase must be verify');
  assert.strictEqual(persisted.paymentLink, 'L2', 'persisted paymentLink must match');
  assert.strictEqual(persisted.paymentLinkPk, 'p2', 'persisted paymentLinkPk must match');

  // emit running/checkout
  const runningEmit = emitCalls.find(e => e.status === 'running' && e.phase === 'checkout');
  assert.ok(runningEmit, 'must emit running/checkout');
});

// --------------------------------------------------------------------------
// 测试 6：noJpProxy → emit no_jp_proxy/done, summary.noJpProxy++, ok:false
// --------------------------------------------------------------------------
test('noJpProxy → emit no_jp_proxy/done, summary.noJpProxy++, ok:false', async () => {
  const emitCalls = [];
  const fakeCheckout = async () => ({ noJpProxy: true, link: null, pk: '' });

  const ctx = makeCtx({
    emitStatusCalls: emitCalls,
    linkSource: 'api',
    fetchCheckoutLinkFn: fakeCheckout,
  });

  const step = paypalFetchStep();
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, false);

  const noJpEmit = emitCalls.find(e => e.status === 'no_jp_proxy' && e.phase === 'done');
  assert.ok(noJpEmit, 'must emit no_jp_proxy/done');
  assert.strictEqual(noJpEmit.reason, 'JP checkout channel unavailable');
  assert.strictEqual(ctx.deps.summary.noJpProxy, 1, 'summary.noJpProxy must be incremented');
});

// --------------------------------------------------------------------------
// 测试 7：空链接（link=null）→ emit no_link/done, summary.noLink++, ok:false
// --------------------------------------------------------------------------
test('empty link → emit no_link/done, summary.noLink++, ok:false', async () => {
  const emitCalls = [];
  const fakeCheckout = async () => ({ link: null, pk: '', raw: 'no promo available' });

  const ctx = makeCtx({
    emitStatusCalls: emitCalls,
    linkSource: 'api',
    fetchCheckoutLinkFn: fakeCheckout,
  });

  const step = paypalFetchStep();
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, false);

  const noLinkEmit = emitCalls.find(e => e.status === 'no_link' && e.phase === 'done');
  assert.ok(noLinkEmit, 'must emit no_link/done');
  assert.strictEqual(ctx.deps.summary.noLink, 1, 'summary.noLink must be incremented');
});

// --------------------------------------------------------------------------
// 测试 8：fetch 抛非 transient 异常 → emit error/phaseTag, summary.error++, ok:false
// --------------------------------------------------------------------------
test('fetch throws non-transient error → emit error/checkout, summary.error++, ok:false', async () => {
  const emitCalls = [];
  const fakeCheckout = async () => { throw new Error('Connection refused'); };

  const ctx = makeCtx({
    emitStatusCalls: emitCalls,
    linkSource: 'api',
    fetchCheckoutLinkFn: fakeCheckout,
  });

  const step = paypalFetchStep();
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, false);

  const errorEmit = emitCalls.find(e => e.status === 'error' && e.phase === 'checkout');
  assert.ok(errorEmit, 'must emit error/checkout');
  assert.ok(/Connection refused/.test(errorEmit.reason), 'reason must include error message');
  assert.strictEqual(ctx.deps.summary.error, 1, 'summary.error must be incremented');
});

// --------------------------------------------------------------------------
// 测试 9：transient 错误后重试成功（3 次循环）→ ok:true
//   第 1 次抛 Timeout → 等 2s（测试中会快速完成）→ 第 2 次成功
// --------------------------------------------------------------------------
test('transient Timeout error then success on retry → ok:true', async () => {
  let callCount = 0;
  const fakeCheckout = async () => {
    callCount++;
    if (callCount === 1) throw new Error('Timeout waiting for response');
    return { link: 'RETRY-OK', pk: 'r-pk' };
  };

  const ctx = makeCtx({
    linkSource: 'api',
    fetchCheckoutLinkFn: fakeCheckout,
  });

  const step = paypalFetchStep();
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true, 'should succeed after transient error + retry');
  assert.strictEqual(callCount, 2, 'fetchCheckoutLink should be called exactly twice');
  assert.strictEqual(ctx.outputs['paypal-fetch'].link, 'RETRY-OK');
}, { timeout: 10000 }); // 测试超时：2s backoff × 1 次

// --------------------------------------------------------------------------
// 测试 10：'fetch' transient 错误后重试成功
// --------------------------------------------------------------------------
test('transient "fetch" error then success on retry → ok:true', async () => {
  let callCount = 0;
  const fakeCheckout = async () => {
    callCount++;
    if (callCount === 1) throw new Error('fetch network error');
    return { link: 'F-OK', pk: 'f-pk' };
  };

  const ctx = makeCtx({
    linkSource: 'api',
    fetchCheckoutLinkFn: fakeCheckout,
  });

  const step = paypalFetchStep();
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true);
  assert.strictEqual(callCount, 2);
  assert.strictEqual(ctx.outputs['paypal-fetch'].link, 'F-OK');
}, { timeout: 10000 });

// --------------------------------------------------------------------------
// 测试 11：Discord 路径成功（getPaymentLink 返回链接）→ emit running/discord, ok:true
// --------------------------------------------------------------------------
test('discord path success → emit running/discord, ok:true', async () => {
  const emitCalls = [];
  const fakeGetPaymentLink = async (gw, accessToken) => ({ link: 'DISC-L', pk: 'd-pk', title: 'Discord link' });

  const ctx = makeCtx({
    emitStatusCalls: emitCalls,
    linkSource: 'discord',
    getPaymentLinkFn: fakeGetPaymentLink,
  });

  const step = paypalFetchStep();
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true);

  const runningEmit = emitCalls.find(e => e.status === 'running' && e.phase === 'discord');
  assert.ok(runningEmit, 'must emit running/discord on Discord path');

  assert.strictEqual(ctx.outputs['paypal-fetch'].link, 'DISC-L');
});

// --------------------------------------------------------------------------
// 测试 12：Discord 路径 gateway 断线重连 → 调用 connectGateway，更新 resources.gw
// --------------------------------------------------------------------------
test('discord gateway disconnected → reconnects, updates resources.gw', async () => {
  const emitCalls = [];
  let gatewayConnectCalled = false;
  const newFakeGw = { ws: { readyState: 1 }, cleanup: () => {} };
  const fakeConnectGateway = async () => {
    gatewayConnectCalled = true;
    return newFakeGw;
  };
  const fakeGetPaymentLink = async () => ({ link: 'RECONNECT-L', pk: '' });

  const ctx = makeCtx({
    emitStatusCalls: emitCalls,
    linkSource: 'discord',
    gwReadyState: 3,   // NOT OPEN — triggers reconnect
    getPaymentLinkFn: fakeGetPaymentLink,
    connectGatewayFn: fakeConnectGateway,
  });

  const step = paypalFetchStep();
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true);
  assert.strictEqual(gatewayConnectCalled, true, 'connectGateway must be called when ws not OPEN');
  assert.strictEqual(ctx.deps.resources.gw, newFakeGw, 'resources.gw must be updated to new gateway');
});

// --------------------------------------------------------------------------
// 测试 13：缓存快路径 — 非缓存时持久化 persist-before-verify；缓存时不重复持久化
// --------------------------------------------------------------------------
test('persist-before-verify: NOT called when usedCachedLink=true', async () => {
  const fakeCheckout = async () => ({ link: 'NL', pk: 'np' });

  // 缓存命中场景
  const ctx = makeCtx({
    linkSource: 'api',
    persistedRow: {
      payment_link: 'CACHED',
      payment_link_pk: 'c-pk',
      status: 'error',
    },
    fetchCheckoutLinkFn: fakeCheckout,
  });

  // 记录 statusDB.set 调用次数
  let setCalls = 0;
  const origSet = ctx.deps.statusDB.set;
  ctx.deps.statusDB.set = (email, data) => {
    setCalls++;
    origSet(email, data);
  };

  const step = paypalFetchStep();
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true);
  assert.strictEqual(setCalls, 0, 'statusDB.set must NOT be called when cache is used (link && !usedCachedLink gate)');
});

// --------------------------------------------------------------------------
// 测试 14：REUSE_STATUSES 精确包含 5 个值
// --------------------------------------------------------------------------
test('REUSE_STATUSES contains exactly the 5 expected values', async () => {
  // 各 status 测试：在 REUSE_STATUSES 中的应命中缓存，不在的不应命中
  const inSet = ['error', 'aborted', 'paypal_captcha', 'verify_error'];
  const notInSet = ['no_link', 'no_jp_proxy', 'no_promo', 'running', 'idle', 'plus'];

  for (const status of inSet) {
    let fetchCalled = false;
    const ctx = makeCtx({
      linkSource: 'api',
      persistedRow: { payment_link: 'L', payment_link_pk: '', status },
      fetchCheckoutLinkFn: async () => { fetchCalled = true; return { link: 'NEW', pk: '' }; },
    });
    const step = paypalFetchStep();
    const res = await step.run(ctx);
    assert.strictEqual(fetchCalled, false, `status='${status}' should be in REUSE_STATUSES → no fetch`);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(ctx.outputs['paypal-fetch'].usedCachedLink, true, `status='${status}' must use cache`);
  }

  for (const status of notInSet) {
    let fetchCalled = false;
    const ctx = makeCtx({
      linkSource: 'api',
      persistedRow: { payment_link: 'L', payment_link_pk: '', status },
      fetchCheckoutLinkFn: async () => { fetchCalled = true; return { link: 'NEW', pk: '' }; },
    });
    const step = paypalFetchStep();
    await step.run(ctx);
    assert.strictEqual(fetchCalled, true, `status='${status}' should NOT be in REUSE_STATUSES → fetch called`);
  }
});
