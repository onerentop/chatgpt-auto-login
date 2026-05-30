// server/__tests__/pipeline-login-step.test.js
// 单元特征化测试：不 spawn Python，仅覆盖可注入测试接缝的行为。
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
  registerFn = null,   // 测试接缝，默认 null（测试会显式传入）
} = {}) {
  const statusDbRows = {};
  if (lastAccessToken || lastSessionJson) {
    statusDbRows['test@example.com'] = {
      last_access_token: lastAccessToken || '',
      last_session_json: lastSessionJson || '',
    };
  }

  const deps = {
    emitStatus: (data) => { emitStatusCalls.push(data); },
    summary: { total: 1, success: 0, error: 0, noLink: 0, noJpProxy: 0, noPromo: 0, verifyError: 0 },
    proxyMgr: {
      getState: () => ({ enabled: false, currentNode: 'node1' }),
      rotate: async () => 'node2',
      recordGoodAttempt: () => {},
      recordBadAttempt: () => {},
      isProxyNetError: () => false,
    },
    resources: {},
    runtimeCfg: {},
    progress: '1/1',
    statusDB: {
      get: (email) => statusDbRows[email] || null,
      set: (email, data) => { statusDbRows[email] = { ...(statusDbRows[email] || {}), ...data }; },
    },
    save: async () => {},
    // 测试接缝：覆盖真实 runProtocolRegister
    __runProtocolRegister: registerFn,
  };

  const account = {
    email: 'test@example.com',
    password: 'pw',
    client_id: '',
    refresh_token: '',
  };
  const ctx = new AccountContext(account, deps);
  ctx.statusDbRows = statusDbRows; // 暴露给测试断言
  return ctx;
}

// --------------------------------------------------------------------------
// 测试 1：缓存命中 —— 未过期 JWT，应走 cached-login 快路径
// --------------------------------------------------------------------------
test('cached-login hit: future JWT → ok:true, cached-login emitStatus, no Python', async () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600; // 1小时后
  const jwt = makeJwt(futureExp);
  const session = { account: { planType: 'free' } };
  const emitCalls = [];

  // 注入一个会被调用就 fail 的假 register fn，验证它从未被调用
  let registerCalled = false;
  const fakeRegister = async () => { registerCalled = true; return { status: 'success', accessToken: 'new', session: {}, planType: 'free' }; };

  const ctx = makeCtx({
    lastAccessToken: jwt,
    lastSessionJson: JSON.stringify(session),
    emitStatusCalls: emitCalls,
    registerFn: fakeRegister,
  });

  const step = loginStep({ login: 'protocol' });
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true, 'run() should return { ok: true }');
  assert.strictEqual(registerCalled, false, 'runProtocolRegister must NOT be called on cache hit');
  assert.ok(ctx.outputs.login, 'ctx.outputs.login must be set');
  assert.strictEqual(ctx.outputs.login.accessToken, jwt, 'accessToken must match cached token');

  const cachedLoginEmit = emitCalls.find(e => e.phase === 'cached-login');
  assert.ok(cachedLoginEmit, 'emitStatus with phase="cached-login" must be called');
  assert.strictEqual(cachedLoginEmit.status, 'running');
  assert.strictEqual(cachedLoginEmit.email, 'test@example.com');
});

// --------------------------------------------------------------------------
// 测试 2：缓存过期 —— JWT exp 在过去，应走正常登录路径
// --------------------------------------------------------------------------
test('cached-login expired: past JWT → cache path NOT taken, fresh-login path used', async () => {
  const pastExp = Math.floor(Date.now() / 1000) - 3600; // 1小时前
  const jwt = makeJwt(pastExp);
  const session = { account: { planType: 'free' } };
  const emitCalls = [];

  // 注入成功的假 register fn
  let registerCalled = false;
  const fakeRegister = async () => {
    registerCalled = true;
    return { status: 'success', accessToken: 'fresh-token', session: { chatgpt_plan_type: 'free' }, planType: 'free' };
  };

  const ctx = makeCtx({
    lastAccessToken: jwt,
    lastSessionJson: JSON.stringify(session),
    emitStatusCalls: emitCalls,
    registerFn: fakeRegister,
  });

  const step = loginStep({ login: 'protocol' });
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true);
  assert.strictEqual(registerCalled, true, 'runProtocolRegister MUST be called when cache expired');
  // 不应有 cached-login emit
  const cachedLoginEmit = emitCalls.find(e => e.phase === 'cached-login');
  assert.strictEqual(cachedLoginEmit, undefined, 'cached-login emit must NOT occur on expired token');
  // 应该有 protocol-login emit
  const protocolLoginEmit = emitCalls.find(e => e.phase === 'protocol-login' && e.status === 'running');
  assert.ok(protocolLoginEmit, 'emitStatus with phase="protocol-login" must be called');
  assert.strictEqual(ctx.outputs.login.accessToken, 'fresh-token');
});

// --------------------------------------------------------------------------
// 测试 3：planType 从 session 中正确提取
//   原始代码：planType: session?.account?.planType || session?.chatgpt_plan_type || 'free'
// --------------------------------------------------------------------------
test('planType extraction: session.account.planType takes priority', async () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = makeJwt(futureExp);
  const session = { account: { planType: 'plus' }, chatgpt_plan_type: 'free' };
  const ctx = makeCtx({
    lastAccessToken: jwt,
    lastSessionJson: JSON.stringify(session),
    registerFn: async () => ({ status: 'success', accessToken: 'x', session: {}, planType: 'free' }),
  });

  const step = loginStep({ login: 'protocol' });
  await step.run(ctx);
  assert.strictEqual(ctx.outputs.login.planType, 'plus', 'session.account.planType should win');
});

test('planType extraction: chatgpt_plan_type fallback when account.planType absent', async () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = makeJwt(futureExp);
  const session = { chatgpt_plan_type: 'pro' };
  const ctx = makeCtx({
    lastAccessToken: jwt,
    lastSessionJson: JSON.stringify(session),
    registerFn: async () => ({ status: 'success', accessToken: 'x', session: {}, planType: 'free' }),
  });

  const step = loginStep({ login: 'protocol' });
  await step.run(ctx);
  assert.strictEqual(ctx.outputs.login.planType, 'pro', 'chatgpt_plan_type should be used as fallback');
});

test('planType extraction: defaults to "free" when both fields absent', async () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = makeJwt(futureExp);
  const session = { some_other_field: 'x' };
  const ctx = makeCtx({
    lastAccessToken: jwt,
    lastSessionJson: JSON.stringify(session),
    registerFn: async () => ({ status: 'success', accessToken: 'x', session: {}, planType: 'free' }),
  });

  const step = loginStep({ login: 'protocol' });
  await step.run(ctx);
  assert.strictEqual(ctx.outputs.login.planType, 'free', 'planType should default to "free"');
});

// --------------------------------------------------------------------------
// 测试 4：JWT 恰好在 buffer 边界（60s）内——应视为过期，不走缓存路径
// --------------------------------------------------------------------------
test('cached-login: JWT exp within 60s buffer → treated as expired', async () => {
  // exp = now + 30s，在 60s buffer 内，应视为过期
  const nearFutureExp = Math.floor(Date.now() / 1000) + 30;
  const jwt = makeJwt(nearFutureExp);
  const session = { account: { planType: 'free' } };
  const emitCalls = [];

  let registerCalled = false;
  const fakeRegister = async () => {
    registerCalled = true;
    return { status: 'success', accessToken: 'fresh', session: {}, planType: 'free' };
  };

  const ctx = makeCtx({
    lastAccessToken: jwt,
    lastSessionJson: JSON.stringify(session),
    emitStatusCalls: emitCalls,
    registerFn: fakeRegister,
  });

  const step = loginStep({ login: 'protocol' });
  await step.run(ctx);

  assert.strictEqual(registerCalled, true, 'Token within 60s buffer must not be cached');
  const cachedLoginEmit = emitCalls.find(e => e.phase === 'cached-login');
  assert.strictEqual(cachedLoginEmit, undefined, 'No cached-login emit when within buffer');
});

// --------------------------------------------------------------------------
// 测试 5：无 last_access_token（全新账号）—— 直接走协议登录
// --------------------------------------------------------------------------
test('no cached token → fresh protocol login', async () => {
  const emitCalls = [];
  let registerCalled = false;
  const fakeRegister = async () => {
    registerCalled = true;
    return { status: 'success', accessToken: 'new-token', session: { chatgpt_plan_type: 'free' }, planType: 'free' };
  };

  const ctx = makeCtx({ emitStatusCalls: emitCalls, registerFn: fakeRegister });
  const step = loginStep({ login: 'protocol' });
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true);
  assert.strictEqual(registerCalled, true);
  assert.strictEqual(ctx.outputs.login.accessToken, 'new-token');
});

// --------------------------------------------------------------------------
// 测试 6：deactivated 结果 → summary.error++, ok:false, reason:'deactivated'
// --------------------------------------------------------------------------
test('deactivated account → ok:false, summary.error++, emits deactivated/done', async () => {
  const emitCalls = [];
  const fakeRegister = async () => ({ status: 'deactivated', accessToken: null, session: null });

  const ctx = makeCtx({ emitStatusCalls: emitCalls, registerFn: fakeRegister });
  const step = loginStep({ login: 'protocol' });
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'deactivated');
  assert.strictEqual(ctx.deps.summary.error, 1);

  const deactivatedEmit = emitCalls.find(e => e.status === 'deactivated' && e.phase === 'done');
  assert.ok(deactivatedEmit, 'must emit deactivated/done');
  assert.strictEqual(deactivatedEmit.reason, 'account_deactivated');
});

// --------------------------------------------------------------------------
// 测试 7：登录抛异常 → summary.error++, ok:false
// --------------------------------------------------------------------------
test('login throws → ok:false, summary.error++, emits error/protocol-login', async () => {
  const emitCalls = [];
  const fakeRegister = async () => { throw new Error('network timeout'); };

  const ctx = makeCtx({ emitStatusCalls: emitCalls, registerFn: fakeRegister });
  const step = loginStep({ login: 'protocol' });
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, false);
  assert.ok(/network timeout/.test(res.reason));
  assert.strictEqual(ctx.deps.summary.error, 1);

  const errorEmit = emitCalls.find(e => e.status === 'error' && e.phase === 'protocol-login');
  assert.ok(errorEmit, 'must emit error/protocol-login');
  assert.ok(/network timeout/.test(errorEmit.reason));
});

// --------------------------------------------------------------------------
// 测试 8：TLS 两次失败 → ok:false, reason:'tls_failure_after_rotation'
// --------------------------------------------------------------------------
test('TLS double failure → ok:false, summary.error++, emits error/protocol-login', async () => {
  const emitCalls = [];
  // 总是返回 tls_failure
  const fakeRegister = async () => ({ status: 'tls_failure', error: 'TLS handshake failed' });

  // 启用 proxy 以覆盖 recordBadAttempt / rotate 分支
  const ctx = makeCtx({ emitStatusCalls: emitCalls, registerFn: fakeRegister });
  ctx.deps.proxyMgr = {
    getState: () => ({ enabled: true, currentNode: 'bad-node' }),
    rotate: async () => 'new-node',
    recordGoodAttempt: () => {},
    recordBadAttempt: () => {},
    isProxyNetError: () => false,
  };

  const step = loginStep({ login: 'protocol' });
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'tls_failure_after_rotation');
  assert.strictEqual(ctx.deps.summary.error, 1);

  const errorEmit = emitCalls.find(e => e.status === 'error' && e.phase === 'protocol-login');
  assert.ok(errorEmit, 'must emit error/protocol-login after double TLS failure');
});

// --------------------------------------------------------------------------
// 测试 9：session 解析失败 → 缓存快路径不生效（JSON.parse 异常时 session=null）
// --------------------------------------------------------------------------
test('cached token but corrupt session JSON → cache path skipped, fresh login', async () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = makeJwt(futureExp);
  const emitCalls = [];
  let registerCalled = false;
  const fakeRegister = async () => {
    registerCalled = true;
    return { status: 'success', accessToken: 'recovered', session: {}, planType: 'free' };
  };

  const ctx = makeCtx({
    lastAccessToken: jwt,
    lastSessionJson: 'NOT VALID JSON{{{{',  // 故意损坏
    emitStatusCalls: emitCalls,
    registerFn: fakeRegister,
  });

  const step = loginStep({ login: 'protocol' });
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true);
  assert.strictEqual(registerCalled, true, 'Must fall through to fresh login when session JSON is corrupt');
  const cachedLoginEmit = emitCalls.find(e => e.phase === 'cached-login');
  assert.strictEqual(cachedLoginEmit, undefined, 'No cached-login emit when session is corrupt');
});

// --------------------------------------------------------------------------
// 测试 10：成功后 DB 持久化（post-login persistence）
// --------------------------------------------------------------------------
test('success writes last_access_token to statusDB', async () => {
  const emitCalls = [];
  const fakeRegister = async () => ({
    status: 'success',
    accessToken: 'tok123',
    session: { chatgpt_plan_type: 'free' },
    planType: 'free',
  });

  const ctx = makeCtx({ emitStatusCalls: emitCalls, registerFn: fakeRegister });
  const step = loginStep({ login: 'protocol' });
  await step.run(ctx);

  const persisted = ctx.statusDbRows['test@example.com'];
  assert.ok(persisted, 'statusDB must have a row for the account');
  assert.strictEqual(persisted.accessToken, 'tok123', 'accessToken must be persisted');
  assert.strictEqual(persisted.status, 'running', 'status must be running after login');
  assert.strictEqual(persisted.phase, 'protocol-login', 'phase must be protocol-login');
});

// --------------------------------------------------------------------------
// 测试 11：shouldSkip 永远返回 false（缓存路径在 run() 内部）
// --------------------------------------------------------------------------
test('shouldSkip always returns false', () => {
  const step = loginStep({ login: 'protocol' });
  assert.strictEqual(step.shouldSkip({}), false);
  assert.strictEqual(step.shouldSkip({ outputs: { login: { accessToken: 'x' } } }), false);
});

// --------------------------------------------------------------------------
// 测试 12：未知策略时构造失败（P2 已实现 browser，用真正未知的 tag 触发）
// --------------------------------------------------------------------------
test('unknown strategy throws at factory time', () => {
  assert.throws(() => loginStep({ login: 'foobar' }), /not implemented yet/);
});
