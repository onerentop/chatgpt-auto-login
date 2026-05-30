// server/__tests__/pipeline-login-browser-step.test.js
// 单元特征化测试：browser login strategy 的行为验证。
// 不启动真实 Chrome / Playwright——通过测试接缝（ctx.deps.__loginAccount 等）注入 fake 实现。
// 使用 node:test runner（本项目没有 jest/mocha）。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loginStep } = require('../../server/pipeline/steps/login');
const { AccountContext } = require('../../server/pipeline/context');

// --------------------------------------------------------------------------
// JWT 构造辅助（无签名——仅用于 exp 解码，decodeJwtExp 不校验签名）
// --------------------------------------------------------------------------
function makeJwt(exp) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `${header}.${payload}.fakesig`;
}

// --------------------------------------------------------------------------
// ctx 构造辅助
// --------------------------------------------------------------------------
function makeCtx({
  lastAccessToken = null,
  lastSessionJson = null,
  emitStatusCalls = [],
  loginAccountFn = null,   // 测试接缝：替代 loginAccount
  launchChromeFn = null,   // 测试接缝：替代 launchChrome（返回 fakeChromeProc）
  waitForCDPFn = null,     // 测试接缝：替代 waitForCDP（返回 fakeBrowser）
  findFreePortFn = null,   // 测试接缝：替代 findFreePort（返回端口号）
  proxyEnabled = false,
} = {}) {
  const statusDbRows = {};
  if (lastAccessToken || lastSessionJson) {
    statusDbRows['test@example.com'] = {
      last_access_token: lastAccessToken || '',
      last_session_json: lastSessionJson || '',
    };
  }

  // 默认 fake chrome 接缝（避免测试在不需要 Chrome 的路径中报错）
  const fakeChromeProc = { pid: 9999, kill: () => {} };
  const fakeBrowser = { contexts: () => [{ pages: () => [], newPage: async () => ({}) }] };

  const recordCalls = { bad: [], good: [] };

  const deps = {
    emitStatus: (data) => { emitStatusCalls.push(data); },
    summary: { total: 1, success: 0, error: 0, noLink: 0, noJpProxy: 0, noPromo: 0, verifyError: 0 },
    proxyMgr: {
      getState: () => ({ enabled: proxyEnabled, currentNode: 'node1' }),
      rotate: async () => 'node2',
      recordGoodAttempt: (node, ch) => { recordCalls.good.push({ node, ch }); },
      recordBadAttempt: (node, ch, tag) => { recordCalls.bad.push({ node, ch, tag }); },
      isProxyNetError: (msg) => /ECONNRESET|timeout|ETIMEDOUT|ERR_PROXY/i.test(msg || ''),
    },
    resources: {},
    runtimeCfg: {},
    progress: '1/1',
    statusDB: {
      get: (email) => statusDbRows[email] || null,
      set: (email, data) => { statusDbRows[email] = { ...(statusDbRows[email] || {}), ...data }; },
    },
    save: async () => {},
    // 测试接缝（生产不传）
    __loginAccount: loginAccountFn,
    __launchChrome: launchChromeFn || (() => fakeChromeProc),
    __waitForCDP: waitForCDPFn || (async () => fakeBrowser),
    __findFreePort: findFreePortFn || (async () => 19222),
  };

  const account = {
    email: 'test@example.com',
    password: 'pw',
    client_id: '',
    refresh_token: '',
  };
  const ctx = new AccountContext(account, deps);
  ctx.statusDbRows = statusDbRows;    // 暴露给测试断言
  ctx.recordCalls = recordCalls;      // 暴露代理记账调用
  return ctx;
}

// --------------------------------------------------------------------------
// 测试 1：缓存命中 → ok:true, ctx.outputs.login 含 accessToken + planType + lastOtp:''
//          不调用 loginAccount 也不调用 launchChrome
// --------------------------------------------------------------------------
test('cached-login hit → ok:true, outputs correct, no loginAccount/launchChrome called', async () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = makeJwt(futureExp);
  const session = { account: { planType: 'plus' } };
  const emitCalls = [];

  let loginCalled = false;
  let chromeLaunched = false;

  const ctx = makeCtx({
    lastAccessToken: jwt,
    lastSessionJson: JSON.stringify(session),
    emitStatusCalls: emitCalls,
    loginAccountFn: async () => { loginCalled = true; return { status: 'success', accessToken: 'new', session: {}, lastOtp: 'xxx' }; },
    launchChromeFn: () => { chromeLaunched = true; return { pid: 1, kill: () => {} }; },
  });

  const step = loginStep({ login: 'browser' });
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true, 'should return ok:true');
  assert.strictEqual(loginCalled, false, 'loginAccount must NOT be called on cache hit');
  assert.strictEqual(chromeLaunched, false, 'launchChrome must NOT be called on cache hit');

  assert.ok(ctx.outputs.login, 'ctx.outputs.login must be set');
  assert.strictEqual(ctx.outputs.login.accessToken, jwt, 'accessToken must match cached JWT');
  assert.strictEqual(ctx.outputs.login.planType, 'plus', 'planType must be extracted from cached session');
  assert.strictEqual(ctx.outputs.login.lastOtp, '', 'lastOtp must be empty string on cache hit (D-L7)');

  const cachedEmit = emitCalls.find(e => e.phase === 'cached-login');
  assert.ok(cachedEmit, 'must emit cached-login');
  assert.strictEqual(cachedEmit.status, 'running');
});

// --------------------------------------------------------------------------
// 测试 2：fresh login 成功 → ok:true, resources.browser 已设置, 已持久化,
//          ctx.outputs.login.lastOtp==='123', 发出 running/login
// --------------------------------------------------------------------------
test('fresh login success → ok:true, resources.browser set, persisted, lastOtp carried', async () => {
  const emitCalls = [];
  const fakeBrowserObj = { contexts: () => [] };
  let cdpCalledWithPort = null;

  const ctx = makeCtx({
    emitStatusCalls: emitCalls,
    loginAccountFn: async (browser, account) => ({
      status: 'success',
      accessToken: 'at123',
      session: { account: { planType: 'free' } },
      lastOtp: '123',
    }),
    waitForCDPFn: async (port) => { cdpCalledWithPort = port; return fakeBrowserObj; },
    findFreePortFn: async () => 19222,
  });

  const step = loginStep({ login: 'browser' });
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true);

  // D-L2: browser handle written to resources
  assert.strictEqual(ctx.deps.resources.browser, fakeBrowserObj, 'resources.browser must be set');
  assert.ok(ctx.deps.resources.chromeProc, 'resources.chromeProc must be set');
  assert.ok(ctx.deps.resources.tempDir, 'resources.tempDir must be set');

  // D-L7: lastOtp carried through
  assert.strictEqual(ctx.outputs.login.lastOtp, '123');
  assert.strictEqual(ctx.outputs.login.accessToken, 'at123');

  // D-L3: must emit running/login (not 'protocol-login')
  const loginEmit = emitCalls.find(e => e.phase === 'login' && e.status === 'running');
  assert.ok(loginEmit, 'must emit running/login (D-L3)');

  // D-L4: DB phase='login'
  const persisted = ctx.statusDbRows['test@example.com'];
  assert.ok(persisted, 'must persist to statusDB');
  assert.strictEqual(persisted.phase, 'login', 'DB phase must be "login" (D-L4)');
  assert.strictEqual(persisted.accessToken, 'at123');
  assert.strictEqual(persisted.status, 'running');
});

// --------------------------------------------------------------------------
// 测试 3：login failure (status:'error') → emit error/login, summary.error++, ok:false
// --------------------------------------------------------------------------
test('login failure (error) → emit error/login, summary.error++, ok:false', async () => {
  const emitCalls = [];

  const ctx = makeCtx({
    emitStatusCalls: emitCalls,
    loginAccountFn: async () => ({
      status: 'error',
      reason: 'bad pw',
      accessToken: null,
    }),
  });

  const step = loginStep({ login: 'browser' });
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, false);
  assert.ok(res.reason, 'should have reason');
  assert.strictEqual(ctx.deps.summary.error, 1, 'summary.error must be incremented');

  // D-L3: phase='login' (not 'protocol-login')
  const errorEmit = emitCalls.find(e => e.status === 'error' && e.phase === 'login');
  assert.ok(errorEmit, 'must emit error/login (D-L3)');
  assert.ok(/bad pw/.test(errorEmit.reason), 'reason must contain original error');
});

// --------------------------------------------------------------------------
// 测试 4：deactivated → emit deactivated/done, recordGoodAttempt called (not bad),
//          summary.error++, ok:false
// --------------------------------------------------------------------------
test('deactivated account → emit deactivated/done, recordGoodAttempt (not bad), summary.error++', async () => {
  const emitCalls = [];

  const ctx = makeCtx({
    emitStatusCalls: emitCalls,
    loginAccountFn: async () => ({ status: 'deactivated', accessToken: null }),
    proxyEnabled: true,
  });

  const step = loginStep({ login: 'browser' });
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'account_deactivated');
  assert.strictEqual(ctx.deps.summary.error, 1);

  // deactivated → recordGoodAttempt (node is fine, account is the problem)
  assert.ok(ctx.recordCalls.good.length > 0, 'recordGoodAttempt must be called for deactivated');
  assert.strictEqual(ctx.recordCalls.bad.length, 0, 'recordBadAttempt must NOT be called for deactivated');

  // D-L3: emit deactivated/done
  const deactivatedEmit = emitCalls.find(e => e.status === 'deactivated' && e.phase === 'done');
  assert.ok(deactivatedEmit, 'must emit deactivated/done');
  assert.strictEqual(deactivatedEmit.reason, 'account_deactivated');
});

// --------------------------------------------------------------------------
// 测试 5：planType 从 chatgpt_plan_type 提取（D-L6）
// --------------------------------------------------------------------------
test('planType: chatgpt_plan_type extracted when account.planType absent (D-L6)', async () => {
  const emitCalls = [];

  const ctx = makeCtx({
    emitStatusCalls: emitCalls,
    loginAccountFn: async () => ({
      status: 'success',
      accessToken: 'tok',
      session: { chatgpt_plan_type: 'plus' },
      lastOtp: '',
    }),
  });

  const step = loginStep({ login: 'browser' });
  await step.run(ctx);

  assert.strictEqual(ctx.outputs.login.planType, 'plus', 'planType must be extracted from chatgpt_plan_type (D-L6)');
});

// --------------------------------------------------------------------------
// 测试 6：T9 proxy 记账——网络类错误 → recordBadAttempt('login_net_error') (D-L5)
// --------------------------------------------------------------------------
test('T9 net error → recordBadAttempt with login_net_error tag (D-L5)', async () => {
  const ctx = makeCtx({
    loginAccountFn: async () => ({
      status: 'error',
      reason: 'ECONNRESET: connection reset',
      accessToken: null,
    }),
    proxyEnabled: true,
  });

  const step = loginStep({ login: 'browser' });
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, false);
  // D-L5: tag must be 'login_net_error' (not 'protocol_net_error')
  const badCall = ctx.recordCalls.bad.find(c => c.tag === 'login_net_error');
  assert.ok(badCall, 'recordBadAttempt must be called with login_net_error tag (D-L5)');
});

// --------------------------------------------------------------------------
// 测试 7：shouldSkip 永远返回 false
// --------------------------------------------------------------------------
test('shouldSkip always returns false', () => {
  const step = loginStep({ login: 'browser' });
  assert.strictEqual(step.shouldSkip({}), false);
  assert.strictEqual(step.shouldSkip({ outputs: { login: { accessToken: 'x' } } }), false);
});

// --------------------------------------------------------------------------
// 测试 8：成功后 G2 recordGoodAttempt 被调用
// --------------------------------------------------------------------------
test('fresh login success → G2 recordGoodAttempt called', async () => {
  const ctx = makeCtx({
    loginAccountFn: async () => ({
      status: 'success',
      accessToken: 'tok',
      session: {},
      lastOtp: '',
    }),
    proxyEnabled: true,
  });

  const step = loginStep({ login: 'browser' });
  await step.run(ctx);

  assert.ok(ctx.recordCalls.good.length > 0, 'G2: recordGoodAttempt must be called on login success');
});

// --------------------------------------------------------------------------
// 测试 9：cached-login fast-path—planType 同样从 cached session 正确注入
// --------------------------------------------------------------------------
test('cached-login: planType from account.planType in cached session', async () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = makeJwt(futureExp);
  const session = { account: { planType: 'pro' }, chatgpt_plan_type: 'free' };

  const ctx = makeCtx({
    lastAccessToken: jwt,
    lastSessionJson: JSON.stringify(session),
  });

  const step = loginStep({ login: 'browser' });
  await step.run(ctx);

  assert.strictEqual(ctx.outputs.login.planType, 'pro', 'session.account.planType must take priority');
});
