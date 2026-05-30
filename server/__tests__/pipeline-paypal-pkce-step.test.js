// server/__tests__/pipeline-paypal-pkce-step.test.js
// 单元特征化测试：paypal-pkce step（PKCE / add-phone / 写凭证 终止逻辑）
//
// 通过测试接缝注入假 runProtocolPKCE（ctx.deps.__runProtocolPKCE）和
// 假 runProtocolPhoneVerify（__setRunProtocolPhoneVerify）避免 Python spawn。
//
// 测试目标：
//   1. enableOAuth=false → 不调 PKCE；调 saveCPAAuthFile；emit plus_no_rt/done；
//      summary.success++；ok:true；clearPaymentLink/clearAccessToken 被调用。
//   2. enableOAuth=true, PKCE 返 {pkce:{refresh_token:'rt', access_token:'at'}} →
//      saveCPAAuthFile with refresh_token; emit plus/done; summary.success++; ok:true.
//   3. enableOAuth=true, PKCE 返 {pkce:{needsPhone:true, session_state:{}}} +
//      phone-verify 注入返 {status:'ok', tokens:{...}} → emit plus/done; summary.success++.
//   4. 失败映射：_finalizePhoneVerify 返 {phonePoolEmpty:true} → failStatus='phone_pool_empty';
//      phoneVerifyFail='pool-disabled' → 'plus_no_rt'; 其他 phoneVerifyFail → 'phone_verify_fail'.
//   5. _finalizePhoneVerify via phone-verify seam：phone-rejected 重试、validate-error 返回、
//      ok 返回 tokens。

'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');

// --------------------------------------------------------------------------
// 关键：在 require paypal-pkce 之前，先 stub 掉所有会在模块级加载时失败的依赖
// （db, proxy, phone-pool, zhusms-provider）。
// 我们使用 require mock 模式：在 require 之前插入假模块到 require.cache。
// --------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..', '..');

// 状态追踪（跨测试重置）
let _clearPaymentLinkCalls = [];
let _clearAccessTokenCalls = [];
let _saveCPAAuthFileCalls  = [];

// ---- fake statusDB ----
const fakeStatusDB = {
  clearPaymentLink(email) { _clearPaymentLinkCalls.push(email); },
  clearAccessToken(email)  { _clearAccessTokenCalls.push(email); },
  get: () => null,
  set: () => {},
};

// ---- fake db module ----
const fakeDbModule = {
  statusDB: fakeStatusDB,
  getRawDb: () => ({}),
  save:     () => {},
};

// ---- fake proxy module ----
const fakeProxyModule = {
  getState: () => ({ enabled: false, currentNode: '' }),
};

// ---- fake phone-pool module ----
const fakePhonePoolModule = {
  acquirePhone:       () => null,
  releaseBinding:     () => {},
  markPhoneSaturated: () => {},
};

// ---- fake zhusms-provider module ----
const fakeZhusmsModule = {
  takeOrder:     async () => null,
  ensureSession: async () => '',
  cancelOrder:   async () => {},
};

// ---- fake utils module ----
const fakeUtilsModule = {
  saveCPAAuthFile(email, accessToken, session) {
    _saveCPAAuthFileCalls.push({ email, accessToken, session });
  },
};

// 在 require.cache 中注入假模块（必须在 require('../../server/pipeline/steps/paypal-pkce') 之前）
function injectFakeModules() {
  const dbPath       = require.resolve(path.join(ROOT, 'server', 'db'));
  const proxyPath    = require.resolve(path.join(ROOT, 'server', 'proxy'));
  const ppoolPath    = require.resolve(path.join(ROOT, 'server', 'phone-pool'));
  const zhusmsPath   = require.resolve(path.join(ROOT, 'server', 'zhusms-provider'));
  const utilsPath    = require.resolve(path.join(ROOT, 'utils'));

  require.cache[dbPath]     = { id: dbPath,     filename: dbPath,     loaded: true, exports: fakeDbModule };
  require.cache[proxyPath]  = { id: proxyPath,  filename: proxyPath,  loaded: true, exports: fakeProxyModule };
  require.cache[ppoolPath]  = { id: ppoolPath,  filename: ppoolPath,  loaded: true, exports: fakePhonePoolModule };
  require.cache[zhusmsPath] = { id: zhusmsPath, filename: zhusmsPath, loaded: true, exports: fakeZhusmsModule };
  require.cache[utilsPath]  = { id: utilsPath,  filename: utilsPath,  loaded: true, exports: fakeUtilsModule };
}

injectFakeModules();

// 现在可以安全地 require paypal-pkce
const { paypalPkceStep, __setRunProtocolPhoneVerify } = require('../pipeline/steps/paypal-pkce');
const { AccountContext } = require('../pipeline/context');

// --------------------------------------------------------------------------
// 重置辅助
// --------------------------------------------------------------------------
function resetCallTrackers() {
  _clearPaymentLinkCalls = [];
  _clearAccessTokenCalls = [];
  _saveCPAAuthFileCalls  = [];
}

// --------------------------------------------------------------------------
// config.json stub（_finalizePhoneVerify 读取 config.json 判断 phonePool.enabled）
// --------------------------------------------------------------------------
let _cfgStub = null;
const _origReadFileSync = fs.readFileSync;
const CONFIG_PATH = path.join(ROOT, 'config.json');

function stubConfig(cfg) {
  _cfgStub = cfg;
  fs.readFileSync = function (p, enc) {
    if (p === CONFIG_PATH) return JSON.stringify(_cfgStub);
    return _origReadFileSync.apply(this, arguments);
  };
}

function unstubConfig() {
  fs.readFileSync = _origReadFileSync;
  _cfgStub = null;
}

// --------------------------------------------------------------------------
// ctx 构造辅助
// --------------------------------------------------------------------------
function makeCtx({
  emitStatusCalls = [],
  enableOAuth     = false,
  planType        = 'free',
  alreadyPlus     = false,
  paymentSuccess  = false,
  loginResult     = null,
  runPKCEFn       = null,
  summaryInit     = null,
  progress        = '1/1',
} = {}) {
  const account = { email: 'test@example.com', password: 'pw', client_id: '', refresh_token: '' };

  const summary = summaryInit || { total: 1, success: 0, error: 0, noLink: 0 };

  const resources = { pyProc: null };

  const deps = {
    emitStatus:  (data) => { emitStatusCalls.push(data); },
    summary,
    progress,
    runtimeCfg:  { enableOAuth },
    resources,
    statusDB:    fakeStatusDB,
    save:        () => {},
  };

  if (runPKCEFn) deps.__runProtocolPKCE = runPKCEFn;

  const ctx = new AccountContext(account, deps);
  if (alreadyPlus) ctx.flags.alreadyPlus = true;

  // 模拟 login step 的产物
  ctx.outputs.login = loginResult || {
    accessToken: 'access-token-from-login',
    session:     { sub: 'user123' },
    planType:    planType,
  };

  // 模拟 paypal-pay step 的产物（仅在 !alreadyPlus 时有意义）
  if (paymentSuccess) {
    ctx.outputs['paypal-pay'] = { paymentSuccess: true };
  }

  return { ctx, summary, resources };
}

// ==========================================================================
// 测试 1：enableOAuth=false → 不调 PKCE；saveCPAAuthFile；emit plus_no_rt/done；
//          summary.success++; ok:true; clearPaymentLink + clearAccessToken 被调用。
// ==========================================================================
test('enableOAuth=false → saveCPAAuthFile, emit plus_no_rt/done, summary.success++, clears called, ok:true', async () => {
  resetCallTrackers();
  const emitCalls = [];
  let pkceCalled = false;
  const fakePKCE = async () => { pkceCalled = true; return { status: 'success', pkce: { refresh_token: 'rt' } }; };

  const { ctx, summary } = makeCtx({
    emitStatusCalls: emitCalls,
    enableOAuth:     false,
    runPKCEFn:       fakePKCE,
  });

  const step = paypalPkceStep();
  const res  = await step.run(ctx);

  // ok:true
  assert.strictEqual(res.ok, true, 'result must be ok:true');

  // PKCE 不应被调用（enableOAuth=false）
  assert.strictEqual(pkceCalled, false, 'runProtocolPKCE must NOT be called when enableOAuth=false');

  // saveCPAAuthFile 应被调用一次，传 accessToken + session（无 refresh_token）
  assert.strictEqual(_saveCPAAuthFileCalls.length, 1, 'saveCPAAuthFile must be called once');
  assert.strictEqual(_saveCPAAuthFileCalls[0].email, 'test@example.com');
  assert.strictEqual(_saveCPAAuthFileCalls[0].accessToken, 'access-token-from-login');

  // emit plus_no_rt/done
  const emit = emitCalls.find(e => e.status === 'plus_no_rt' && e.phase === 'done');
  assert.ok(emit, 'must emit plus_no_rt/done');
  assert.strictEqual(emit.email,    'test@example.com');
  assert.strictEqual(emit.progress, '1/1');

  // summary.success++
  assert.strictEqual(summary.success, 1, 'summary.success must be incremented');

  // clearPaymentLink + clearAccessToken 被调用
  assert.ok(_clearPaymentLinkCalls.includes('test@example.com'), 'clearPaymentLink must be called');
  assert.ok(_clearAccessTokenCalls.includes('test@example.com'),  'clearAccessToken must be called');
});

// ==========================================================================
// 测试 2：enableOAuth=true, PKCE 返 refresh_token → saveCPAAuthFile with RT;
//          emit plus/done; summary.success++; ok:true.
// ==========================================================================
test('enableOAuth=true, PKCE returns refresh_token → saveCPAAuthFile with RT, emit plus/done, summary.success++', async () => {
  resetCallTrackers();
  const emitCalls = [];
  const fakePKCE = async () => ({
    status: 'success',
    pkce: { refresh_token: 'rt-from-pkce', access_token: 'at-from-pkce', id_token: 'it-from-pkce' },
  });

  const { ctx, summary } = makeCtx({
    emitStatusCalls: emitCalls,
    enableOAuth:     true,
    runPKCEFn:       fakePKCE,
  });

  const step = paypalPkceStep();
  const res  = await step.run(ctx);

  assert.strictEqual(res.ok, true, 'result must be ok:true');

  // saveCPAAuthFile 应用 PKCE 的 at 和包含 refresh_token 的 session
  assert.strictEqual(_saveCPAAuthFileCalls.length, 1);
  assert.strictEqual(_saveCPAAuthFileCalls[0].email, 'test@example.com');
  assert.strictEqual(_saveCPAAuthFileCalls[0].accessToken, 'at-from-pkce');
  assert.strictEqual(_saveCPAAuthFileCalls[0].session.refresh_token, 'rt-from-pkce', 'session must have refresh_token from PKCE');
  assert.strictEqual(_saveCPAAuthFileCalls[0].session.id_token, 'it-from-pkce');

  // emit running/pkce 然后 plus/done
  const runningPkce = emitCalls.find(e => e.status === 'running' && e.phase === 'pkce');
  assert.ok(runningPkce, 'must emit running/pkce before PKCE');
  const plusDone = emitCalls.find(e => e.status === 'plus' && e.phase === 'done');
  assert.ok(plusDone, 'must emit plus/done after PKCE with refresh_token');

  // summary.success++
  assert.strictEqual(summary.success, 1);

  // clears 被调用
  assert.ok(_clearPaymentLinkCalls.includes('test@example.com'));
  assert.ok(_clearAccessTokenCalls.includes('test@example.com'));
});

// ==========================================================================
// 测试 3：enableOAuth=true, PKCE 返 needsPhone + phone-verify 注入成功 →
//          emit plus/done; summary.success++; ok:true.
// ==========================================================================
test('enableOAuth=true, PKCE needs phone, phone-verify ok → emit plus/done, summary.success++', async () => {
  resetCallTrackers();
  // stub config：phonePool.enabled = true
  stubConfig({ phonePool: { enabled: true, provider: 'local', maxBindingsPerPhone: 3 } });

  try {
    const emitCalls = [];

    // PKCE returns needsPhone:true
    const fakePKCE = async () => ({
      status: 'success',
      pkce: { needsPhone: true, session_state: { state: 'abc' } },
    });

    // phone-verify seam 注入成功 tokens
    __setRunProtocolPhoneVerify(async () => ({
      status: 'ok',
      tokens: { access_token: 'at-phone', refresh_token: 'rt-phone', id_token: 'it-phone' },
    }));

    // phone-pool fake：返回一个号
    fakePhonePoolModule.acquirePhone = () => ({ phone: '+11111', smsApiUrl: 'http://fake' });
    fakePhonePoolModule.releaseBinding = () => {};

    const { ctx, summary } = makeCtx({
      emitStatusCalls: emitCalls,
      enableOAuth:     true,
      runPKCEFn:       fakePKCE,
    });

    const step = paypalPkceStep();
    const res  = await step.run(ctx);

    assert.strictEqual(res.ok, true, 'result must be ok:true');

    // saveCPAAuthFile with phone tokens
    assert.strictEqual(_saveCPAAuthFileCalls.length, 1);
    assert.strictEqual(_saveCPAAuthFileCalls[0].session.refresh_token, 'rt-phone');

    // emit plus/done
    const plusDone = emitCalls.find(e => e.status === 'plus' && e.phase === 'done');
    assert.ok(plusDone, 'must emit plus/done after add-phone success');

    // summary.success++
    assert.strictEqual(summary.success, 1);
  } finally {
    unstubConfig();
    // 重置 phone-pool fake
    fakePhonePoolModule.acquirePhone = () => null;
    // 重置 phone-verify seam
    __setRunProtocolPhoneVerify(null);
  }
});

// ==========================================================================
// 测试 4a：add-phone 返 {phonePoolEmpty:true} → failStatus='phone_pool_empty'
// ==========================================================================
test('add-phone poolEmpty → failStatus=phone_pool_empty, emit phone_pool_empty/done, summary.success++', async () => {
  resetCallTrackers();
  stubConfig({ phonePool: { enabled: true, provider: 'local', maxBindingsPerPhone: 3 } });

  try {
    const emitCalls = [];

    const fakePKCE = async () => ({
      status: 'success',
      pkce: { needsPhone: true, session_state: {} },
    });

    // phone-pool返回空（pool empty）
    fakePhonePoolModule.acquirePhone = () => null;

    const { ctx, summary } = makeCtx({
      emitStatusCalls: emitCalls,
      enableOAuth:     true,
      runPKCEFn:       fakePKCE,
    });

    const step = paypalPkceStep();
    const res  = await step.run(ctx);

    assert.strictEqual(res.ok, true, 'result must be ok:true (step always ok)');

    const failEmit = emitCalls.find(e => e.status === 'phone_pool_empty' && e.phase === 'done');
    assert.ok(failEmit, 'must emit phone_pool_empty/done');

    // saveCPAAuthFile called (降级 auth)
    assert.strictEqual(_saveCPAAuthFileCalls.length, 1);

    // summary.success++ (step always increments on reaching here)
    assert.strictEqual(summary.success, 1);
  } finally {
    unstubConfig();
    fakePhonePoolModule.acquirePhone = () => null;
  }
});

// ==========================================================================
// 测试 4b：add-phone 返 {phoneVerifyFail:'pool-disabled'} → failStatus='plus_no_rt'
// ==========================================================================
test('add-phone pool-disabled → failStatus=plus_no_rt, emit plus_no_rt/done', async () => {
  resetCallTrackers();
  // phonePool.enabled = false → _finalizePhoneVerify 立即返 {phoneVerifyFail:'pool-disabled'}
  stubConfig({ phonePool: { enabled: false, provider: 'local' } });

  try {
    const emitCalls = [];

    const fakePKCE = async () => ({
      status: 'success',
      pkce: { needsPhone: true, session_state: {} },
    });

    const { ctx, summary } = makeCtx({
      emitStatusCalls: emitCalls,
      enableOAuth:     true,
      runPKCEFn:       fakePKCE,
    });

    const step = paypalPkceStep();
    const res  = await step.run(ctx);

    assert.strictEqual(res.ok, true);

    const failEmit = emitCalls.find(e => e.status === 'plus_no_rt' && e.phase === 'done');
    assert.ok(failEmit, 'must emit plus_no_rt/done when pool-disabled');

    assert.strictEqual(summary.success, 1);
  } finally {
    unstubConfig();
  }
});

// ==========================================================================
// 测试 4c：add-phone 返 {phoneVerifyFail:'phone-rejected-by-openai'}（其他 phoneVerifyFail）
//          → failStatus='phone_verify_fail'
// ==========================================================================
test('add-phone other phoneVerifyFail → failStatus=phone_verify_fail, emit phone_verify_fail/done', async () => {
  resetCallTrackers();
  stubConfig({ phonePool: { enabled: true, provider: 'local', maxBindingsPerPhone: 3 } });

  try {
    const emitCalls = [];

    const fakePKCE = async () => ({
      status: 'success',
      pkce: { needsPhone: true, session_state: {} },
    });

    // phone-verify 总返回 phone-rejected：3 次后 lastReason = 'phone-rejected-by-openai'
    let callCount = 0;
    __setRunProtocolPhoneVerify(async () => { callCount++; return { status: 'phone-rejected', detail: 'rej' }; });

    // phone-pool 提供 3 个号
    let phoneIdx = 0;
    const phones = ['+1', '+2', '+3'];
    fakePhonePoolModule.acquirePhone = () => ({
      phone: phones[phoneIdx++ % phones.length],
      smsApiUrl: 'http://fake',
    });

    const { ctx, summary } = makeCtx({
      emitStatusCalls: emitCalls,
      enableOAuth:     true,
      runPKCEFn:       fakePKCE,
    });

    const step = paypalPkceStep();
    const res  = await step.run(ctx);

    assert.strictEqual(res.ok, true);

    const failEmit = emitCalls.find(e => e.status === 'phone_verify_fail' && e.phase === 'done');
    assert.ok(failEmit, 'must emit phone_verify_fail/done for other phoneVerifyFail');

    // 3 times tried
    assert.strictEqual(callCount, 3, 'phone-verify must be called 3 times (MAX_ATTEMPTS)');

    assert.strictEqual(summary.success, 1);
  } finally {
    unstubConfig();
    __setRunProtocolPhoneVerify(null);
    fakePhonePoolModule.acquirePhone = () => null;
  }
});

// ==========================================================================
// 测试 5a：_finalizePhoneVerify — phone-rejected 触发 retry（3 次后 phoneVerifyFail）
// ==========================================================================
test('_finalizePhoneVerify phone-rejected 3x → phoneVerifyFail=phone-rejected-by-openai', async () => {
  resetCallTrackers();
  stubConfig({ phonePool: { enabled: true, provider: 'local', maxBindingsPerPhone: 3 } });

  try {
    const emitCalls = [];
    let spawnCount = 0;
    let releaseCount = 0;

    __setRunProtocolPhoneVerify(async () => { spawnCount++; return { status: 'phone-rejected', detail: 'rej' }; });

    let phoneIdx2 = 0;
    const testPhones = ['+A', '+B', '+C'];
    fakePhonePoolModule.acquirePhone = () => ({
      phone: testPhones[phoneIdx2++],
      smsApiUrl: 'http://fake',
    });
    fakePhonePoolModule.releaseBinding = () => { releaseCount++; };

    const fakePKCE = async () => ({
      status: 'success',
      pkce: { needsPhone: true, session_state: {} },
    });

    const { ctx } = makeCtx({ enableOAuth: true, runPKCEFn: fakePKCE, emitStatusCalls: emitCalls });

    const step = paypalPkceStep();
    await step.run(ctx);

    assert.strictEqual(spawnCount, 3, 'phone-rejected must cause 3 attempts (MAX_ATTEMPTS)');
    assert.strictEqual(releaseCount, 3, 'each phone-rejected attempt should release');

    const failEmit = emitCalls.find(e => e.status === 'phone_verify_fail' && e.phase === 'done');
    assert.ok(failEmit, 'must emit phone_verify_fail/done after all attempts rejected');
  } finally {
    unstubConfig();
    __setRunProtocolPhoneVerify(null);
    fakePhonePoolModule.acquirePhone = () => null;
    fakePhonePoolModule.releaseBinding = () => {};
  }
});

// ==========================================================================
// 测试 5b：_finalizePhoneVerify — validate-error → 返回 phoneVerifyFail, 不 retry
// ==========================================================================
test('_finalizePhoneVerify validate-error → phoneVerifyFail=validate-error, no retry', async () => {
  resetCallTrackers();
  stubConfig({ phonePool: { enabled: true, provider: 'local', maxBindingsPerPhone: 3 } });

  try {
    const emitCalls = [];
    let spawnCount = 0;
    let releaseCount = 0;

    __setRunProtocolPhoneVerify(async () => { spawnCount++; return { status: 'validate-error', detail: 'bad code' }; });

    fakePhonePoolModule.acquirePhone = () => ({ phone: '+V1', smsApiUrl: 'http://fake' });
    fakePhonePoolModule.releaseBinding = () => { releaseCount++; };

    const fakePKCE = async () => ({
      status: 'success',
      pkce: { needsPhone: true, session_state: {} },
    });

    const { ctx } = makeCtx({ enableOAuth: true, runPKCEFn: fakePKCE, emitStatusCalls: emitCalls });

    const step = paypalPkceStep();
    await step.run(ctx);

    assert.strictEqual(spawnCount, 1, 'validate-error must NOT retry');
    assert.strictEqual(releaseCount, 1, 'validate-error must release the phone');

    // failStatus is 'phone_verify_fail' (not pool_empty, not plus_no_rt)
    const failEmit = emitCalls.find(e => e.status === 'phone_verify_fail' && e.phase === 'done');
    assert.ok(failEmit, 'must emit phone_verify_fail/done on validate-error');
  } finally {
    unstubConfig();
    __setRunProtocolPhoneVerify(null);
    fakePhonePoolModule.acquirePhone = () => null;
    fakePhonePoolModule.releaseBinding = () => {};
  }
});

// ==========================================================================
// 测试 5c：_finalizePhoneVerify — ok → returns tokens on first attempt
// ==========================================================================
test('_finalizePhoneVerify ok on first attempt → emit plus/done, no release', async () => {
  resetCallTrackers();
  stubConfig({ phonePool: { enabled: true, provider: 'local', maxBindingsPerPhone: 3 } });

  try {
    const emitCalls = [];
    let spawnCount = 0;
    let releaseCount = 0;

    __setRunProtocolPhoneVerify(async () => {
      spawnCount++;
      return { status: 'ok', tokens: { access_token: 'at2', refresh_token: 'rt2', id_token: 'it2' } };
    });

    fakePhonePoolModule.acquirePhone = () => ({ phone: '+OK1', smsApiUrl: 'http://fake' });
    fakePhonePoolModule.releaseBinding = () => { releaseCount++; };

    const fakePKCE = async () => ({
      status: 'success',
      pkce: { needsPhone: true, session_state: {} },
    });

    const { ctx, summary } = makeCtx({ enableOAuth: true, runPKCEFn: fakePKCE, emitStatusCalls: emitCalls });

    const step = paypalPkceStep();
    const res  = await step.run(ctx);

    assert.strictEqual(res.ok, true);
    assert.strictEqual(spawnCount, 1, 'should succeed on first attempt');
    assert.strictEqual(releaseCount, 0, 'success must not release phone');

    const plusDone = emitCalls.find(e => e.status === 'plus' && e.phase === 'done');
    assert.ok(plusDone, 'must emit plus/done on ok');

    assert.strictEqual(summary.success, 1);
    assert.strictEqual(_saveCPAAuthFileCalls[0].session.refresh_token, 'rt2');
  } finally {
    unstubConfig();
    __setRunProtocolPhoneVerify(null);
    fakePhonePoolModule.acquirePhone = () => null;
    fakePhonePoolModule.releaseBinding = () => {};
  }
});

// ==========================================================================
// 测试 6：PKCE 抛异常 → emit plus_no_rt/done, saveCPAAuthFile (fallback), summary.success++
// ==========================================================================
test('PKCE throws → emit plus_no_rt/done, saveCPAAuthFile fallback, summary.success++', async () => {
  resetCallTrackers();
  const emitCalls = [];

  const fakePKCE = async () => { throw new Error('PKCE Python timeout (180s)'); };

  const { ctx, summary } = makeCtx({
    emitStatusCalls: emitCalls,
    enableOAuth:     true,
    runPKCEFn:       fakePKCE,
  });

  const step = paypalPkceStep();
  const res  = await step.run(ctx);

  assert.strictEqual(res.ok, true, 'PKCE error must still return ok:true (step catches internally)');

  // emit plus_no_rt/done (PKCE catch fallback)
  const noRtEmit = emitCalls.find(e => e.status === 'plus_no_rt' && e.phase === 'done');
  assert.ok(noRtEmit, 'must emit plus_no_rt/done when PKCE throws');

  // saveCPAAuthFile fallback with original login accessToken
  assert.strictEqual(_saveCPAAuthFileCalls.length, 1);
  assert.strictEqual(_saveCPAAuthFileCalls[0].accessToken, 'access-token-from-login');

  assert.strictEqual(summary.success, 1);
});

// ==========================================================================
// 测试 7：shouldSkip 永远返回 false
// ==========================================================================
test('shouldSkip always returns false', () => {
  const step = paypalPkceStep();
  const { ctx } = makeCtx({ alreadyPlus: true });
  assert.strictEqual(step.shouldSkip(ctx), false, 'shouldSkip must always return false');
});
