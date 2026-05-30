// server/__tests__/pipeline-browser-pkce-step.test.js
// 单元特征化测试：browser-pkce step（浏览器 PKCE 终止逻辑，逐行搬运自 engine.js:343-375 + 592-626）
//
// 通过测试接缝注入假 fetchTokensViaPKCE（ctx.deps.__fetchTokensViaPKCE）避免调 Playwright。
// saveCPAAuthFile 通过 require.cache 注入 fake。
//
// 测试目标（task 规格）：
//   1. enableOAuth=false → saveCPAAuthFile(accessToken,session), finalStatus='plus_no_rt',
//      clears called, no terminal emit, no summary touch, ok:true.
//   2. refresh_token → saveCPAAuthFile(pkceTokens.access_token, pkceTokens), finalStatus='plus'.
//   3. phonePoolEmpty → emit phone_pool_empty/pkce, finalStatus='phone_pool_empty',
//      saveCPAAuthFile(accessToken,session).
//   4. phoneVerifyFail → emit phone_verify_fail/pkce, finalStatus='phone_verify_fail'.
//   5. needsPhone → finalStatus stays plus_no_rt, saveCPAAuthFile fallback.
//   6. alreadyPlus vs post-pay log-string branch — no crash + correct finalStatus for both flags.

'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const fs     = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');

// --------------------------------------------------------------------------
// 状态追踪（跨测试重置）
// --------------------------------------------------------------------------
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

// ---- fake utils module (saveCPAAuthFile + fetchTokensViaPKCE stub) ----
// fetchTokensViaPKCE は via ctx.deps.__fetchTokensViaPKCE 接缝注入，
// 这里只需要 saveCPAAuthFile + 占位 fetchTokensViaPKCE（不应被调用，除非接缝未传）
const fakeUtilsModule = {
  saveCPAAuthFile(email, accessToken, session) {
    _saveCPAAuthFileCalls.push({ email, accessToken, session });
  },
  fetchTokensViaPKCE: async () => { throw new Error('fetchTokensViaPKCE should be injected via seam'); },
  randomDelay: async () => {},
};

// --------------------------------------------------------------------------
// 注入 fake modules 到 require.cache（必须在 require('browser-pkce') 之前）
// --------------------------------------------------------------------------
function injectFakeModules() {
  const utilsPath = require.resolve(path.join(ROOT, 'utils'));
  require.cache[utilsPath] = { id: utilsPath, filename: utilsPath, loaded: true, exports: fakeUtilsModule };
}

injectFakeModules();

// 现在可以安全地 require browser-pkce
const { browserPkceStep } = require('../pipeline/steps/browser-pkce');
const { AccountContext }   = require('../pipeline/context');

// --------------------------------------------------------------------------
// config.json stub
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
// 重置辅助
// --------------------------------------------------------------------------
function resetCallTrackers() {
  _clearPaymentLinkCalls = [];
  _clearAccessTokenCalls = [];
  _saveCPAAuthFileCalls  = [];
}

// --------------------------------------------------------------------------
// ctx 构造辅助
// --------------------------------------------------------------------------
function makeCtx({
  emitStatusCalls = [],
  enableOAuth     = false,
  alreadyPlus     = false,
  loginResult     = null,
  fetchPKCEFn     = null,
  progress        = '1/1',
  browser         = { _fake: true },
} = {}) {
  const account = { email: 'test@example.com', password: 'pw', client_id: '', refresh_token: '' };

  const resources = { browser };

  const deps = {
    emitStatus:  (data) => { emitStatusCalls.push(data); },
    progress,
    runtimeCfg:  { enableOAuth },
    resources,
    statusDB:    fakeStatusDB,
  };

  if (fetchPKCEFn) deps.__fetchTokensViaPKCE = fetchPKCEFn;

  const ctx = new AccountContext(account, deps);
  ctx.flags.alreadyPlus = !!alreadyPlus;

  // 模拟 login step 产物
  ctx.outputs.login = loginResult || {
    accessToken: 'login-access-token',
    session:     { sub: 'user123' },
    planType:    'free',
    lastOtp:     'otp123',
  };

  return { ctx };
}

// ==========================================================================
// 测试用例
// ==========================================================================

// 1. enableOAuth=false → saveCPAAuthFile(accessToken,session), finalStatus='plus_no_rt',
//    clears called, no terminal emit, ok:true
test('browser-pkce: enableOAuth=false → plus_no_rt, clears called, no terminal emit', async (t) => {
  resetCallTrackers();
  stubConfig({ enableOAuth: false });
  try {
    const emitStatusCalls = [];
    const { ctx } = makeCtx({ enableOAuth: false, emitStatusCalls });

    const step = browserPkceStep();
    const result = await step.run(ctx);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(ctx.flags.finalStatus, 'plus_no_rt');

    // clears called
    assert.deepStrictEqual(_clearPaymentLinkCalls, ['test@example.com']);
    assert.deepStrictEqual(_clearAccessTokenCalls, ['test@example.com']);

    // saveCPAAuthFile called with login accessToken + session
    assert.strictEqual(_saveCPAAuthFileCalls.length, 1);
    assert.strictEqual(_saveCPAAuthFileCalls[0].email, 'test@example.com');
    assert.strictEqual(_saveCPAAuthFileCalls[0].accessToken, 'login-access-token');
    assert.deepStrictEqual(_saveCPAAuthFileCalls[0].session, { sub: 'user123' });

    // no terminal emit (no phase:'done' emitStatus)
    const terminalEmits = emitStatusCalls.filter(e => e.phase === 'done');
    assert.strictEqual(terminalEmits.length, 0, 'should not emit terminal done');

    // no summary touch — ctx.deps has no summary field at all
    assert.strictEqual(ctx.deps.summary, undefined);
  } finally {
    unstubConfig();
  }
});

// 2. enableOAuth=true, refresh_token → saveCPAAuthFile(pkceTokens.access_token, pkceTokens),
//    finalStatus='plus'
test('browser-pkce: refresh_token → finalStatus=plus, saveCPAAuthFile(pkceTokens)', async (t) => {
  resetCallTrackers();
  const pkceTokens = { access_token: 'pkce-at', refresh_token: 'pkce-rt', id_token: 'pkce-id' };
  stubConfig({ enableOAuth: true });
  try {
    const emitStatusCalls = [];
    const { ctx } = makeCtx({
      enableOAuth: true,
      emitStatusCalls,
      fetchPKCEFn: async () => pkceTokens,
    });

    const step = browserPkceStep();
    const result = await step.run(ctx);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(ctx.flags.finalStatus, 'plus');

    // saveCPAAuthFile called with pkceTokens.access_token and pkceTokens object
    assert.strictEqual(_saveCPAAuthFileCalls.length, 1);
    assert.strictEqual(_saveCPAAuthFileCalls[0].accessToken, 'pkce-at');
    assert.deepStrictEqual(_saveCPAAuthFileCalls[0].session, pkceTokens);

    // emitStatus running/pkce was called
    const runningPkce = emitStatusCalls.filter(e => e.status === 'running' && e.phase === 'pkce');
    assert.strictEqual(runningPkce.length, 1);

    // no terminal done emit
    assert.strictEqual(emitStatusCalls.filter(e => e.phase === 'done').length, 0);
  } finally {
    unstubConfig();
  }
});

// 3. phonePoolEmpty → emit phone_pool_empty/pkce, finalStatus='phone_pool_empty',
//    saveCPAAuthFile(accessToken,session)
test('browser-pkce: phonePoolEmpty → emit phone_pool_empty/pkce, finalStatus=phone_pool_empty', async (t) => {
  resetCallTrackers();
  stubConfig({ enableOAuth: true });
  try {
    const emitStatusCalls = [];
    const { ctx } = makeCtx({
      enableOAuth: true,
      emitStatusCalls,
      fetchPKCEFn: async () => ({ phonePoolEmpty: true }),
    });

    const step = browserPkceStep();
    const result = await step.run(ctx);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(ctx.flags.finalStatus, 'phone_pool_empty');

    // emitStatus phone_pool_empty/pkce
    const ppEmit = emitStatusCalls.find(e => e.status === 'phone_pool_empty');
    assert.ok(ppEmit, 'should emit phone_pool_empty');
    assert.strictEqual(ppEmit.phase, 'pkce');
    assert.strictEqual(ppEmit.reason, '号池已用尽或全部满');

    // saveCPAAuthFile fallback to loginResult
    assert.strictEqual(_saveCPAAuthFileCalls.length, 1);
    assert.strictEqual(_saveCPAAuthFileCalls[0].accessToken, 'login-access-token');
    assert.deepStrictEqual(_saveCPAAuthFileCalls[0].session, { sub: 'user123' });
  } finally {
    unstubConfig();
  }
});

// 4. phoneVerifyFail → emit phone_verify_fail/pkce, finalStatus='phone_verify_fail'
test('browser-pkce: phoneVerifyFail → emit phone_verify_fail/pkce, finalStatus=phone_verify_fail', async (t) => {
  resetCallTrackers();
  stubConfig({ enableOAuth: true });
  try {
    const emitStatusCalls = [];
    const { ctx } = makeCtx({
      enableOAuth: true,
      emitStatusCalls,
      fetchPKCEFn: async () => ({ phoneVerifyFail: 'sms-timeout' }),
    });

    const step = browserPkceStep();
    const result = await step.run(ctx);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(ctx.flags.finalStatus, 'phone_verify_fail');

    // emitStatus phone_verify_fail/pkce
    const pvEmit = emitStatusCalls.find(e => e.status === 'phone_verify_fail');
    assert.ok(pvEmit, 'should emit phone_verify_fail');
    assert.strictEqual(pvEmit.phase, 'pkce');
    assert.strictEqual(pvEmit.reason, 'sms-timeout');

    // saveCPAAuthFile fallback to loginResult
    assert.strictEqual(_saveCPAAuthFileCalls.length, 1);
    assert.strictEqual(_saveCPAAuthFileCalls[0].accessToken, 'login-access-token');
  } finally {
    unstubConfig();
  }
});

// 5. needsPhone → finalStatus stays plus_no_rt, saveCPAAuthFile fallback
test('browser-pkce: needsPhone → finalStatus=plus_no_rt, saveCPAAuthFile fallback', async (t) => {
  resetCallTrackers();
  stubConfig({ enableOAuth: true });
  try {
    const emitStatusCalls = [];
    const { ctx } = makeCtx({
      enableOAuth: true,
      emitStatusCalls,
      fetchPKCEFn: async () => ({ needsPhone: true, session_state: {} }),
    });

    const step = browserPkceStep();
    const result = await step.run(ctx);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(ctx.flags.finalStatus, 'plus_no_rt');

    // saveCPAAuthFile called (fallback — pkceTokens has no access_token, use loginResult.accessToken)
    assert.strictEqual(_saveCPAAuthFileCalls.length, 1);
    assert.strictEqual(_saveCPAAuthFileCalls[0].accessToken, 'login-access-token');

    // no terminal done emit
    assert.strictEqual(emitStatusCalls.filter(e => e.phase === 'done').length, 0);
  } finally {
    unstubConfig();
  }
});

// 6a. alreadyPlus=true, refresh_token → no crash, finalStatus='plus'
test('browser-pkce: alreadyPlus=true path — no crash, correct finalStatus', async (t) => {
  resetCallTrackers();
  const pkceTokens = { access_token: 'pkce-at', refresh_token: 'pkce-rt' };
  stubConfig({ enableOAuth: true });
  try {
    const emitStatusCalls = [];
    const { ctx } = makeCtx({
      enableOAuth:  true,
      alreadyPlus:  true,
      emitStatusCalls,
      fetchPKCEFn:  async () => pkceTokens,
    });

    const step = browserPkceStep();
    const result = await step.run(ctx);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(ctx.flags.finalStatus, 'plus');
    // clears were called
    assert.strictEqual(_clearPaymentLinkCalls.length, 1);
    assert.strictEqual(_clearAccessTokenCalls.length, 1);
  } finally {
    unstubConfig();
  }
});

// 6b. alreadyPlus=false (post-pay), refresh_token → no crash, finalStatus='plus'
test('browser-pkce: alreadyPlus=false (post-pay) path — no crash, correct finalStatus', async (t) => {
  resetCallTrackers();
  const pkceTokens = { access_token: 'pkce-at', refresh_token: 'pkce-rt' };
  stubConfig({ enableOAuth: true });
  try {
    const emitStatusCalls = [];
    const { ctx } = makeCtx({
      enableOAuth:  true,
      alreadyPlus:  false,
      emitStatusCalls,
      fetchPKCEFn:  async () => pkceTokens,
    });

    const step = browserPkceStep();
    const result = await step.run(ctx);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(ctx.flags.finalStatus, 'plus');
    // clears were called
    assert.strictEqual(_clearPaymentLinkCalls.length, 1);
    assert.strictEqual(_clearAccessTokenCalls.length, 1);
  } finally {
    unstubConfig();
  }
});

// 6c. alreadyPlus asymmetry: post-pay has extra else log (PKCE failed, no RT);
//     alreadyPlus does not — both should not crash and finalStatus=plus_no_rt
test('browser-pkce: pkceTokens null (PKCE failed) — alreadyPlus vs post-pay, no crash', async (t) => {
  stubConfig({ enableOAuth: true });
  try {
    for (const alreadyPlus of [true, false]) {
      resetCallTrackers();
      const emitStatusCalls = [];
      const { ctx } = makeCtx({
        enableOAuth:  true,
        alreadyPlus,
        emitStatusCalls,
        fetchPKCEFn:  async () => null,  // PKCE threw → catch returns null
      });

      const step = browserPkceStep();
      const result = await step.run(ctx);

      assert.strictEqual(result.ok, true, `alreadyPlus=${alreadyPlus} should return ok:true`);
      assert.strictEqual(ctx.flags.finalStatus, 'plus_no_rt', `alreadyPlus=${alreadyPlus} finalStatus should be plus_no_rt`);
      // saveCPAAuthFile called with loginResult fallback (null?.access_token || loginResult.accessToken)
      assert.strictEqual(_saveCPAAuthFileCalls[0].accessToken, 'login-access-token');
    }
  } finally {
    unstubConfig();
  }
});
