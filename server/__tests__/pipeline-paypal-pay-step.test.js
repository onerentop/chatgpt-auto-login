// server/__tests__/pipeline-paypal-pay-step.test.js
// 单元特征化测试：通过测试接缝注入假 launchChrome/waitForCDP/findFreePort/autoPayment，
// 避免启动真实 Chrome。使用 node:test runner（本项目没有 jest/mocha）。
//
// 接缝模式：ctx.deps.__launchChrome / __waitForCDP / __findFreePort / __autoPayment
// 镜像 login.js 中 ctx.deps.__runProtocolRegister 的风格。

'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const { paypalPayStep } = require('../../server/pipeline/steps/paypal-pay');
const { AccountContext } = require('../../server/pipeline/context');

// --------------------------------------------------------------------------
// 假 page 工厂
// --------------------------------------------------------------------------
function makeFakePage({ url = 'https://pay.openai.com/xyz' } = {}) {
  return {
    _url: url,
    _urlAfterRetry: null, // 若非 null，第二次 url() 调用返回此值
    _urlCallCount: 0,
    url() {
      this._urlCallCount++;
      // 第一次调用可能返回 chrome-error，第二次返回正常 URL（用于 retry 测试）
      if (this._urlCallCount === 1) return this._url;
      return this._urlAfterRetry !== null ? this._urlAfterRetry : this._url;
    },
    async goto(_href, _opts) { /* 吞掉 */ },
    locator(_sel) {
      return { first: () => ({ waitFor: async () => {} }) };
    },
  };
}

// --------------------------------------------------------------------------
// ctx 构造辅助
// --------------------------------------------------------------------------
function makeCtx({
  emitStatusCalls  = [],
  alreadyPlus      = false,
  link             = 'https://pay.openai.com/test',
  autoPaymentFn    = null,
  pageUrl          = 'https://pay.openai.com/xyz',
  pageUrlAfterRetry = null,
  proxyEnabled     = false,
  recordBadAttemptFn = null,
  recordGoodAttemptFn = null,
  rotateFn         = null,
  waitForCDPThrows = false,
  summaryInit      = null,
} = {}) {
  const account = { email: 'test@example.com', password: 'pw', client_id: '', refresh_token: '' };

  // 假 page
  const fakePage = makeFakePage({ url: pageUrl });
  fakePage._urlAfterRetry = pageUrlAfterRetry;

  // 假 browser（模拟 Playwright Browser）
  const fakeBrowser = {
    _closed: false,
    contexts() {
      return [{
        pages: () => [fakePage],
        newPage: async () => fakePage,
      }];
    },
    async close() { this._closed = true; },
  };

  // 假 proxyMgr
  const fakeProxyMgr = {
    _badAttempts: [],
    _goodAttempts: [],
    getState: () => ({ enabled: proxyEnabled, currentNode: 'node-1' }),
    recordBadAttempt: recordBadAttemptFn || function (node, ch, reason) {
      this._badAttempts.push({ node, ch, reason });
    },
    recordGoodAttempt: recordGoodAttemptFn || function (node, ch) {
      this._goodAttempts.push({ node, ch });
    },
    rotate: rotateFn || (async () => 'node-2'),
  };

  // fake resources 袋
  const resources = { chromeProc: null, browser: null, tempDir: null };

  // fake AbortController（non-aborted）
  const abortController = { signal: { aborted: false } };

  // 假 chromeProc
  const fakeChromeProc = {
    pid: 12345,
    _killed: false,
    kill() { this._killed = true; },
  };

  const summary = summaryInit || { total: 1, success: 0, error: 0, noLink: 0, noJpProxy: 0, noPromo: 0, verifyError: 0 };

  const deps = {
    emitStatus:      (data) => { emitStatusCalls.push(data); },
    summary,
    progress:        '1/1',
    proxyMgr:        fakeProxyMgr,
    abortController,
    resources,
    runtimeCfg:      { enableOAuth: false },
    statusDB: {
      get:  () => null,
      set:  () => {},
    },
    // 测试接缝
    __findFreePort:  async () => 19222,
    __launchChrome:  (_port, _tempDir, _opts) => fakeChromeProc,
    __waitForCDP:    waitForCDPThrows
      ? async (_port) => { throw new Error('CDP connection failed'); }
      : async (_port) => fakeBrowser,
    __autoPayment:   autoPaymentFn,
  };

  const ctx = new AccountContext(account, deps);
  if (alreadyPlus) ctx.flags.alreadyPlus = true;

  // 模拟 paypal-fetch step 的输出
  ctx.outputs['paypal-fetch'] = {
    link,
    pk: 'pk_test_abc',
    fetchResult: { link, pk: 'pk_test_abc' },
    usedCachedLink: false,
  };

  return { ctx, fakeBrowser, fakeChromeProc, resources, fakeProxyMgr, summary };
}

// --------------------------------------------------------------------------
// 测试 1：shouldSkip — alreadyPlus=true → 返回 true
// --------------------------------------------------------------------------
test('shouldSkip returns true when ctx.flags.alreadyPlus is set', () => {
  const step = paypalPayStep();
  const { ctx } = makeCtx({ alreadyPlus: true });
  assert.strictEqual(step.shouldSkip(ctx), true);
});

// --------------------------------------------------------------------------
// 测试 2：success → ok:true，NOT call clear/save/summary.success（deferred to pkce）
//          finally cleanup 完成：resources nulled
// --------------------------------------------------------------------------
test('success: autoPayment returns {success:true} → ok:true, summary.success unchanged, resources nulled', async () => {
  const emitCalls = [];
  const fakeAutoPayment = async () => ({ success: true });
  const { ctx, resources, summary } = makeCtx({ emitStatusCalls: emitCalls, autoPaymentFn: fakeAutoPayment });

  const step = paypalPayStep();
  const res  = await step.run(ctx);

  assert.strictEqual(res.ok, true, 'result must be ok:true on success');

  // SUCCESS path is DEFERRED to paypal-pkce step — summary.success must NOT be touched here
  assert.strictEqual(summary.success, 0, 'summary.success must NOT be incremented by paypal-pay (deferred to pkce)');

  // ctx.outputs['paypal-pay'] 写入 paymentSuccess:true 供 paypal-pkce 读取
  assert.deepStrictEqual(ctx.outputs['paypal-pay'], { paymentSuccess: true }, 'must write paymentSuccess:true to outputs');

  // finally cleanup: resources nulled
  assert.strictEqual(resources.browser,    null, 'resources.browser must be null after finally');
  assert.strictEqual(resources.chromeProc, null, 'resources.chromeProc must be null after finally');
  assert.strictEqual(resources.tempDir,    null, 'resources.tempDir must be null after finally');

  // running/payment emit 必须发出
  const runningEmit = emitCalls.find(e => e.status === 'running' && e.phase === 'payment');
  assert.ok(runningEmit, 'must emit running/payment');
});

// --------------------------------------------------------------------------
// 测试 3：aborted → emit aborted/payment, summary.aborted===1, ok:false
// --------------------------------------------------------------------------
test('aborted: {status:"aborted"} → emit aborted/payment, summary.aborted===1, ok:false', async () => {
  const emitCalls = [];
  const fakeAutoPayment = async () => ({ success: false, status: 'aborted' });
  const { ctx, summary } = makeCtx({ emitStatusCalls: emitCalls, autoPaymentFn: fakeAutoPayment });

  const step = paypalPayStep();
  const res  = await step.run(ctx);

  assert.strictEqual(res.ok, false, 'result must be ok:false on aborted');

  // emit aborted/payment
  const abortedEmit = emitCalls.find(e => e.status === 'aborted' && e.phase === 'payment');
  assert.ok(abortedEmit, 'must emit aborted/payment');
  assert.strictEqual(abortedEmit.reason, 'Stopped by user', 'emit reason must be "Stopped by user"');
  assert.strictEqual(abortedEmit.email,  'test@example.com', 'emit must include email');
  assert.strictEqual(abortedEmit.progress, '1/1', 'emit must include progress');

  // summary.aborted 懒初始化为 1
  assert.strictEqual(summary.aborted, 1, 'summary.aborted must be 1 (lazy init)');
  // summary.error 不变
  assert.strictEqual(summary.error, 0, 'summary.error must NOT be incremented');
});

// --------------------------------------------------------------------------
// 测试 4：notFreeTrial → emit no_link/done, summary.noLink++, ok:false
//          autoPayment 抛 NOT_FREE_TRIAL 错误
// --------------------------------------------------------------------------
test('notFreeTrial: autoPayment throws NOT_FREE_TRIAL → emit no_link/done, summary.noLink++, ok:false', async () => {
  const emitCalls = [];
  const fakeAutoPayment = async () => {
    const err = new Error('not a free trial page');
    err.code  = 'NOT_FREE_TRIAL';
    throw err;
  };
  const { ctx, summary } = makeCtx({ emitStatusCalls: emitCalls, autoPaymentFn: fakeAutoPayment });

  const step = paypalPayStep();
  const res  = await step.run(ctx);

  assert.strictEqual(res.ok, false, 'result must be ok:false on NOT_FREE_TRIAL');

  // emit no_link/done
  const noLinkEmit = emitCalls.find(e => e.status === 'no_link' && e.phase === 'done');
  assert.ok(noLinkEmit, 'must emit no_link/done');
  assert.strictEqual(noLinkEmit.reason, 'not a free trial page', 'emit reason must be the error message');
  assert.strictEqual(noLinkEmit.email,  'test@example.com');
  assert.strictEqual(noLinkEmit.progress, '1/1');

  // summary
  assert.strictEqual(summary.noLink, 1, 'summary.noLink must be incremented');
  assert.strictEqual(summary.error,  0, 'summary.error must NOT be incremented');
});

// --------------------------------------------------------------------------
// 测试 5：status passthrough → emit with status 'paypal_captcha', summary.error++, ok:false
// --------------------------------------------------------------------------
test('status passthrough: {status:"paypal_captcha",reason:"r"} → emit paypal_captcha/payment, summary.error++, ok:false', async () => {
  const emitCalls = [];
  const fakeAutoPayment = async () => ({ success: false, status: 'paypal_captcha', reason: 'r' });
  const { ctx, summary } = makeCtx({ emitStatusCalls: emitCalls, autoPaymentFn: fakeAutoPayment });

  const step = paypalPayStep();
  const res  = await step.run(ctx);

  assert.strictEqual(res.ok, false, 'result must be ok:false on status passthrough');

  // emit {paymentResult.status}/payment
  const captchaEmit = emitCalls.find(e => e.status === 'paypal_captcha' && e.phase === 'payment');
  assert.ok(captchaEmit, 'must emit paypal_captcha/payment');
  assert.strictEqual(captchaEmit.reason,   'r', 'emit reason must be "r"');
  assert.strictEqual(captchaEmit.email,    'test@example.com');
  assert.strictEqual(captchaEmit.progress, '1/1');

  // summary
  assert.strictEqual(summary.error, 1, 'summary.error must be incremented');
});

// --------------------------------------------------------------------------
// 测试 6：plain failure ({success:false} no status) → emit error/payment, summary.error++, ok:false
// --------------------------------------------------------------------------
test('plain failure: {success:false} no status → emit error/payment, summary.error++, ok:false', async () => {
  const emitCalls = [];
  const fakeAutoPayment = async () => ({ success: false });
  const { ctx, summary } = makeCtx({ emitStatusCalls: emitCalls, autoPaymentFn: fakeAutoPayment });

  const step = paypalPayStep();
  const res  = await step.run(ctx);

  assert.strictEqual(res.ok, false, 'result must be ok:false on plain failure');

  // emit error/payment
  const errEmit = emitCalls.find(e => e.status === 'error' && e.phase === 'payment');
  assert.ok(errEmit, 'must emit error/payment');
  assert.strictEqual(errEmit.email,    'test@example.com');
  assert.strictEqual(errEmit.progress, '1/1');

  // summary
  assert.strictEqual(summary.error, 1, 'summary.error must be incremented');
});

// --------------------------------------------------------------------------
// 测试 7：finally cleanup runs on thrown path (waitForCDP throws)
//          → resources nulled, summary.error++, ok:false
// --------------------------------------------------------------------------
test('finally cleanup: waitForCDP throws → resources nulled, summary.error++, ok:false', async () => {
  const emitCalls = [];
  // waitForCDPThrows=true → __waitForCDP throws
  const { ctx, resources, summary } = makeCtx({ emitStatusCalls: emitCalls, waitForCDPThrows: true });

  const step = paypalPayStep();
  const res  = await step.run(ctx);

  assert.strictEqual(res.ok, false, 'result must be ok:false on CDP throw');

  // emit error/payment
  const errEmit = emitCalls.find(e => e.status === 'error' && e.phase === 'payment');
  assert.ok(errEmit, 'must emit error/payment from outer catch');

  // summary.error++
  assert.strictEqual(summary.error, 1, 'summary.error must be incremented');

  // finally cleanup: resources nulled（CDP 抛出时 chromeProc 已被 launchChrome 赋值但 browser=null）
  assert.strictEqual(resources.browser,    null, 'resources.browser must be null after finally');
  assert.strictEqual(resources.chromeProc, null, 'resources.chromeProc must be null after finally');
  assert.strictEqual(resources.tempDir,    null, 'resources.tempDir must be null after finally');
});

// --------------------------------------------------------------------------
// 测试 8：chrome-error retry-once path
//          page.url() 第一次返回 'chrome-error://x', 第二次返回正常 URL
//          → rotate 被调用, recordBadAttempt 调用, recordGoodAttempt(G3) 调用
//          → autoPayment 被调用 → success 返回 ok:true
// --------------------------------------------------------------------------
test('chrome-error retry: rotate + recordBadAttempt + recordGoodAttempt G3 after retry', async () => {
  const emitCalls = [];

  // 追踪 proxy 操作
  const badAttempts  = [];
  const goodAttempts = [];
  let   rotated      = false;

  const fakeAutoPayment = async () => ({ success: true });

  // makeCtx 里 fakePage.url() 第1次返回 chrome-error，第2次返回正常 URL
  const { ctx, summary } = makeCtx({
    emitStatusCalls:      emitCalls,
    autoPaymentFn:        fakeAutoPayment,
    pageUrl:              'chrome-error://chromewebdata/',
    pageUrlAfterRetry:    'https://pay.openai.com/xyz',
    proxyEnabled:         true,
    recordBadAttemptFn(node, ch, reason) { badAttempts.push({ node, ch, reason }); },
    recordGoodAttemptFn(node, ch) { goodAttempts.push({ node, ch }); },
    rotateFn: async () => { rotated = true; return 'node-2'; },
  });

  const step = paypalPayStep();
  const res  = await step.run(ctx);

  assert.strictEqual(res.ok, true, 'result must be ok:true after chrome-error retry');

  // recordBadAttempt 至少调用一次（第一次失败），reason='payment_unreachable'
  assert.ok(badAttempts.length >= 1, 'recordBadAttempt must be called');
  assert.ok(badAttempts.some(b => b.reason === 'payment_unreachable'), 'reason must be payment_unreachable');

  // rotate 被调用
  assert.strictEqual(rotated, true, 'rotate must be called after chrome-error');

  // G3 recordGoodAttempt 在重试成功后调用
  assert.ok(goodAttempts.length >= 1, 'recordGoodAttempt(G3) must be called after retry success');

  // success: deferred to pkce, summary.success unchanged
  assert.strictEqual(summary.success, 0, 'summary.success must NOT be incremented (deferred to pkce)');
});
