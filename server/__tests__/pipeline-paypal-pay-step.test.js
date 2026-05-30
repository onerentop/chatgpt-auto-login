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
  // browser-mode 扩展参数（P2 新增）
  browserMode      = false,      // ctx.deps.browserMode
  presetBrowser    = null,       // 若非 null，预先写入 resources.browser（模拟 Phase 1 已启动）
  presetChromeProc = null,       // 配合 presetBrowser 的 chromeProc
  presetTempDir    = null,       // 配合 presetBrowser 的 tempDir
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

  // fake resources 袋（browser-mode 预设：若 presetBrowser 非 null，模拟 Phase 1 已写入）
  const resources = {
    chromeProc: presetChromeProc || null,
    browser:    presetBrowser    || null,
    tempDir:    presetTempDir    || null,
  };

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
    // P2 新增：browserMode 标记（协议模式不传 → undefined → falsy）
    browserMode,
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

  // P2 flags
  assert.strictEqual(ctx.flags.finalStatus, 'aborted');
  assert.strictEqual(ctx.flags.finalReason, 'Stopped by user');
  assert.strictEqual(ctx.flags.finalPaymentLink, '');
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

  // P2 flags
  assert.strictEqual(ctx.flags.finalStatus, 'no_link');
  assert.strictEqual(ctx.flags.finalReason, 'not a free trial page');
  assert.strictEqual(ctx.flags.finalPaymentLink, '');
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

  // P2 flags
  assert.strictEqual(ctx.flags.finalStatus, 'paypal_captcha');
  assert.strictEqual(ctx.flags.finalReason, 'r');
  assert.strictEqual(ctx.flags.finalPaymentLink, '');
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

  // P2 flags
  assert.strictEqual(ctx.flags.finalStatus, 'error');
  assert.strictEqual(ctx.flags.finalReason, 'Payment not completed');
  assert.strictEqual(ctx.flags.finalPaymentLink, '');
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

  // P2 flags (outer-catch error path)
  assert.strictEqual(ctx.flags.finalStatus, 'error');
  assert.ok(ctx.flags.finalReason, 'finalReason must be the error message');
  assert.strictEqual(ctx.flags.finalPaymentLink, '');
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

// ==========================================================================
// P2 新增：browser-mode 测试（现有协议模式测试保持不变）
// ==========================================================================

// --------------------------------------------------------------------------
// 测试 9：browser-mode 复用路径
//   deps.browserMode=true + resources.browser 预设（模拟 Phase 1 已启动 Chrome）
//   → run() 不调用 launchChrome，复用 presetBrowser
//   → finally 是 no-op（browser.close() 未被调用，resources.browser 仍非 null）
// --------------------------------------------------------------------------
test('browser-mode reuse: pre-set resources.browser → launchChrome NOT called, finally no-op, browser survives', async () => {
  const emitCalls = [];
  const fakeAutoPayment = async () => ({ success: true });

  // 追踪 __launchChrome 是否被调用
  let launchCalled = false;

  // 预设 browser：模拟 login strategy 在 Phase 1 写入的 resources.browser
  const presetBrowserObj = {
    _closed: false,
    contexts() {
      return [{
        pages: () => [{
          _url: 'https://pay.openai.com/xyz',
          url() { return this._url; },
          async goto() {},
          locator(_sel) { return { first: () => ({ waitFor: async () => {} }) }; },
        }],
        newPage: async function () { return this.pages()[0]; },
      }];
    },
    async close() { this._closed = true; },
  };
  const presetChromeProcObj = { pid: 9999, _killed: false, kill() { this._killed = true; } };
  const presetTempDirVal = '/tmp/browser-phase1-dir';

  const { ctx, resources } = makeCtx({
    emitStatusCalls:  emitCalls,
    autoPaymentFn:    fakeAutoPayment,
    browserMode:      true,
    presetBrowser:    presetBrowserObj,
    presetChromeProc: presetChromeProcObj,
    presetTempDir:    presetTempDirVal,
  });

  // 覆盖 __launchChrome 追踪调用
  ctx.deps.__launchChrome = (_port, _tmpDir, _opts) => {
    launchCalled = true;
    return { pid: 0, kill() {} };
  };

  const step = paypalPayStep();
  const res  = await step.run(ctx);

  // 支付成功
  assert.strictEqual(res.ok, true, 'browser-mode reuse: result must be ok:true on success');

  // launchChrome 不得被调用（已有 resources.browser）
  assert.strictEqual(launchCalled, false, 'launchChrome must NOT be called when resources.browser is pre-set');

  // finally 是 no-op：presetBrowser.close() 未被调用
  assert.strictEqual(presetBrowserObj._closed, false, 'browser.close() must NOT be called in browser-mode finally (engine-shell owns cleanup)');

  // resources 袋保持完整（未被 null）
  assert.strictEqual(resources.browser,    presetBrowserObj,    'resources.browser must survive (not nulled) in browser-mode');
  assert.strictEqual(resources.chromeProc, presetChromeProcObj, 'resources.chromeProc must survive (not nulled) in browser-mode');
  assert.strictEqual(resources.tempDir,    presetTempDirVal,    'resources.tempDir must survive (not nulled) in browser-mode');
});

// --------------------------------------------------------------------------
// 测试 10：browser-mode 懒启动路径（缓存登录跳过 Phase 1，resources.browser=null）
//   deps.browserMode=true + resources.browser=null（缓存登录路径）
//   → run() 调用 launchChrome（懒启动）
//   → finally 是 no-op（browser.close() 未被调用，resources.browser 保持非 null）
//   说明：engine-shell 在账号循环 finally 清理（engine.js:647-657）；
//         CPA step 在 paypal-pkce 后需要 browser，故 paypal-pay 不能 close。
// --------------------------------------------------------------------------
test('browser-mode lazy-launch: resources.browser=null, browserMode=true → launches but finally no-op, browser survives', async () => {
  const emitCalls = [];
  const fakeAutoPayment = async () => ({ success: false, status: 'error', reason: 'test' });

  let launchCalled = false;
  const fakeCDPBrowser = {
    _closed: false,
    contexts() {
      return [{
        pages: () => [{
          _url: 'https://pay.openai.com/xyz',
          url() { return this._url; },
          async goto() {},
          locator(_sel) { return { first: () => ({ waitFor: async () => {} }) }; },
        }],
        newPage: async function () { return this.pages()[0]; },
      }];
    },
    async close() { this._closed = true; },
  };
  const fakeLazyProc = { pid: 7777, _killed: false, kill() { this._killed = true; } };

  // resources.browser=null（缓存登录路径）
  const { ctx, resources } = makeCtx({
    emitStatusCalls: emitCalls,
    autoPaymentFn:   fakeAutoPayment,
    browserMode:     true,
    // presetBrowser 不传 → resources.browser=null
  });

  // 注入追踪 launchChrome + 返回可追踪的 browser
  ctx.deps.__launchChrome = (_port, _tmpDir, _opts) => {
    launchCalled = true;
    return fakeLazyProc;
  };
  ctx.deps.__waitForCDP = async (_port) => fakeCDPBrowser;

  const step = paypalPayStep();
  const res  = await step.run(ctx);

  // 结果不关键（error 路径），重点是 Chrome 行为
  assert.strictEqual(res.ok, false, 'browser-mode lazy: payment failure returns ok:false');

  // launchChrome 必须被调用（缓存登录没有预启动 Chrome）
  assert.strictEqual(launchCalled, true, 'launchChrome MUST be called when resources.browser is null in browser-mode');

  // finally 是 no-op：browser.close() 未被调用
  assert.strictEqual(fakeCDPBrowser._closed, false, 'browser.close() must NOT be called in browser-mode lazy-launch finally');

  // resources.browser 由 launch 路径写入并保留（CPA step 需要）
  assert.strictEqual(resources.browser,    fakeCDPBrowser, 'resources.browser must survive after browser-mode lazy-launch');
  assert.strictEqual(resources.chromeProc, fakeLazyProc,   'resources.chromeProc must survive after browser-mode lazy-launch');
});

// --------------------------------------------------------------------------
// 测试 11：protocol-mode 不变（browserMode 未传/falsy，resources.browser=null）
//   → launch 路径执行，finally 正常 close + null resources
//   此测试是对已有测试 2/7 核心行为的显式 browser-mode 对照验证。
// --------------------------------------------------------------------------
test('protocol-mode unchanged: browserMode falsy, resources.browser null → launches AND finally closes+nulls', async () => {
  const emitCalls = [];
  const fakeAutoPayment = async () => ({ success: true });

  let launchCalled = false;
  const fakeCDPBrowser2 = {
    _closed: false,
    contexts() {
      return [{
        pages: () => [{
          _url: 'https://pay.openai.com/xyz',
          url() { return this._url; },
          async goto() {},
          locator(_sel) { return { first: () => ({ waitFor: async () => {} }) }; },
        }],
        newPage: async function () { return this.pages()[0]; },
      }];
    },
    async close() { this._closed = true; },
  };
  const fakeProtoProc = { pid: 5555, _killed: false, kill() { this._killed = true; } };

  // browserMode 未传（falsy），resources.browser=null → 协议模式
  const { ctx, resources } = makeCtx({
    emitStatusCalls: emitCalls,
    autoPaymentFn:   fakeAutoPayment,
    // browserMode 不传 → undefined → falsy（协议模式）
  });

  ctx.deps.__launchChrome = (_port, _tmpDir, _opts) => {
    launchCalled = true;
    return fakeProtoProc;
  };
  ctx.deps.__waitForCDP = async (_port) => fakeCDPBrowser2;

  const step = paypalPayStep();
  const res  = await step.run(ctx);

  assert.strictEqual(res.ok, true, 'protocol-mode: success returns ok:true');

  // 启动路径：launchChrome 必须被调用
  assert.strictEqual(launchCalled, true, 'launchChrome MUST be called in protocol mode');

  // finally 正常清理：browser.close() 被调用
  assert.strictEqual(fakeCDPBrowser2._closed, true, 'browser.close() MUST be called in protocol-mode finally');

  // resources 袋被清为 null（协议引擎镜像 this._browser=null 等）
  assert.strictEqual(resources.browser,    null, 'resources.browser must be nulled in protocol-mode finally');
  assert.strictEqual(resources.chromeProc, null, 'resources.chromeProc must be nulled in protocol-mode finally');
  assert.strictEqual(resources.tempDir,    null, 'resources.tempDir must be nulled in protocol-mode finally');
});
