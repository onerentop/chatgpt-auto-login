// server/__tests__/pipeline-paypal-verify-step.test.js
// 单元特征化测试：不发起真实网络请求，通过 __verifyCheckoutIsFree 接缝注入假实现。
// 使用 node:test runner（本项目没有 jest/mocha）。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { paypalVerifyStep } = require('../../server/pipeline/steps/paypal-verify');
const { AccountContext } = require('../../server/pipeline/context');

// --------------------------------------------------------------------------
// ctx 构造辅助
// --------------------------------------------------------------------------
function makeCtx({
  emitStatusCalls = [],
  linkSource = 'api',
  alreadyPlus = false,
  verifyFn = null,        // 测试接缝：替换 verifyCheckoutIsFree
  link = 'https://pay.stripe.com/test',
  pk   = 'pk_test_abc',
} = {}) {
  const account = { email: 'test@example.com', password: 'pw', client_id: '', refresh_token: '' };

  const deps = {
    emitStatus: (data) => { emitStatusCalls.push(data); },
    summary: { total: 1, success: 0, error: 0, noLink: 0, noJpProxy: 0, noPromo: 0, verifyError: 0 },
    progress: '1/1',
    linkSource,
    statusDB: {
      get: () => null,
      set: () => {},
    },
    // 测试接缝
    __verifyCheckoutIsFree: verifyFn,
  };

  const ctx = new AccountContext(account, deps);

  if (alreadyPlus) ctx.flags.alreadyPlus = true;

  // 模拟 paypal-fetch step 的输出（run() 中需要）
  ctx.outputs['paypal-fetch'] = { link, pk, fetchResult: { link, pk }, usedCachedLink: false };

  return ctx;
}

// --------------------------------------------------------------------------
// 测试 1：shouldSkip — ctx.flags.alreadyPlus = true → 返回 true
// --------------------------------------------------------------------------
test('shouldSkip returns true when ctx.flags.alreadyPlus is set', () => {
  const step = paypalVerifyStep();
  const ctx = makeCtx({ alreadyPlus: true });
  assert.strictEqual(step.shouldSkip(ctx), true);
});

// --------------------------------------------------------------------------
// 测试 2：shouldSkip — ctx.deps.linkSource === 'discord' → 返回 true
// --------------------------------------------------------------------------
test('shouldSkip returns true when linkSource is discord', () => {
  const step = paypalVerifyStep();
  const ctx = makeCtx({ linkSource: 'discord' });
  assert.strictEqual(step.shouldSkip(ctx), true);
});

// --------------------------------------------------------------------------
// 测试 3：shouldSkip — API 路径 + 非 Plus → 返回 false
// --------------------------------------------------------------------------
test('shouldSkip returns false for api-path non-plus account', () => {
  const step = paypalVerifyStep();
  const ctx = makeCtx({ linkSource: 'api', alreadyPlus: false });
  assert.strictEqual(step.shouldSkip(ctx), false);
});

// --------------------------------------------------------------------------
// 测试 4：!v.ok → emit verify_error，summary.verifyError++，ok:false
//   reason 字符串必须是 `Stripe init: ${v.reason}`
// --------------------------------------------------------------------------
test('!v.ok → emit verify_error/done with reason "Stripe init: boom", summary.verifyError++, ok:false', async () => {
  const emitCalls = [];
  const fakeVerify = async () => ({ ok: false, reason: 'boom' });

  const ctx = makeCtx({
    emitStatusCalls: emitCalls,
    linkSource: 'api',
    verifyFn: fakeVerify,
    link: 'https://pay.stripe.com/test',
    pk: 'pk_test_abc',
  });

  const step = paypalVerifyStep();
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, false, 'result must be ok:false on verify failure');
  assert.strictEqual(res.reason, 'Stripe init: boom', 'reason must be "Stripe init: boom"');

  // emit verify_error/done
  const verifyErrEmit = emitCalls.find(e => e.status === 'verify_error' && e.phase === 'done');
  assert.ok(verifyErrEmit, 'must emit verify_error/done');
  assert.strictEqual(verifyErrEmit.reason, 'Stripe init: boom', 'emit reason must be "Stripe init: boom"');
  assert.strictEqual(verifyErrEmit.paymentLink, 'https://pay.stripe.com/test', 'emit must include paymentLink');
  assert.strictEqual(verifyErrEmit.progress, '1/1', 'emit must include progress');
  assert.strictEqual(verifyErrEmit.email, 'test@example.com', 'emit must include email');

  // summary
  assert.strictEqual(ctx.deps.summary.verifyError, 1, 'summary.verifyError must be incremented');
  assert.strictEqual(ctx.deps.summary.noPromo, 0, 'summary.noPromo must NOT be incremented');

  // P2 flags
  assert.strictEqual(ctx.flags.finalStatus, 'verify_error');
  assert.strictEqual(ctx.flags.finalReason, 'Stripe init: boom');
  assert.strictEqual(ctx.flags.finalPaymentLink, 'https://pay.stripe.com/test');
});

// --------------------------------------------------------------------------
// 测试 5：v.ok && !v.is_free → emit no_promo，summary.noPromo++，ok:false
//   reason 字符串必须是 `amount_due=${v.amount_due} ${v.currency}`
// --------------------------------------------------------------------------
test('{ok:true, is_free:false, amount_due:2000, currency:"usd"} → emit no_promo/done, summary.noPromo++, ok:false', async () => {
  const emitCalls = [];
  const fakeVerify = async () => ({ ok: true, is_free: false, amount_due: 2000, currency: 'usd' });

  const ctx = makeCtx({
    emitStatusCalls: emitCalls,
    linkSource: 'api',
    verifyFn: fakeVerify,
    link: 'https://pay.stripe.com/test2',
    pk: 'pk_test_xyz',
  });

  const step = paypalVerifyStep();
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, false, 'result must be ok:false when not free');
  assert.strictEqual(res.reason, 'amount_due=2000 usd', 'reason must be "amount_due=2000 usd"');

  // emit no_promo/done
  const noPromoEmit = emitCalls.find(e => e.status === 'no_promo' && e.phase === 'done');
  assert.ok(noPromoEmit, 'must emit no_promo/done');
  assert.strictEqual(noPromoEmit.reason, 'amount_due=2000 usd', 'emit reason must be "amount_due=2000 usd"');
  assert.strictEqual(noPromoEmit.paymentLink, 'https://pay.stripe.com/test2', 'emit must include paymentLink');
  assert.strictEqual(noPromoEmit.progress, '1/1', 'emit must include progress');
  assert.strictEqual(noPromoEmit.email, 'test@example.com', 'emit must include email');

  // summary
  assert.strictEqual(ctx.deps.summary.noPromo, 1, 'summary.noPromo must be incremented');
  assert.strictEqual(ctx.deps.summary.verifyError, 0, 'summary.verifyError must NOT be incremented');

  // P2 flags
  assert.strictEqual(ctx.flags.finalStatus, 'no_promo');
  assert.strictEqual(ctx.flags.finalReason, 'amount_due=2000 usd');
  assert.strictEqual(ctx.flags.finalPaymentLink, 'https://pay.stripe.com/test2');
});

// --------------------------------------------------------------------------
// 测试 6：v.ok && v.is_free → ok:true（无终止 emit，仅 running/verify）
// --------------------------------------------------------------------------
test('{ok:true, is_free:true, coupons:["X"]} → ok:true, no terminal emit', async () => {
  const emitCalls = [];
  const fakeVerify = async () => ({ ok: true, is_free: true, coupons: ['X'] });

  const ctx = makeCtx({
    emitStatusCalls: emitCalls,
    linkSource: 'api',
    verifyFn: fakeVerify,
  });

  const step = paypalVerifyStep();
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true, 'result must be ok:true when free');

  // 不应有 verify_error 或 no_promo 的 emit
  const terminalEmit = emitCalls.find(e => e.status === 'verify_error' || e.status === 'no_promo');
  assert.strictEqual(terminalEmit, undefined, 'must NOT emit verify_error or no_promo when is_free');

  // 仅有 running/verify
  const runningEmit = emitCalls.find(e => e.status === 'running' && e.phase === 'verify');
  assert.ok(runningEmit, 'must emit running/verify');

  // summary 计数不变
  assert.strictEqual(ctx.deps.summary.verifyError, 0);
  assert.strictEqual(ctx.deps.summary.noPromo, 0);
});
