const test = require('node:test');
const assert = require('node:assert');

const { createRunner } = require('../runner');

function mkEnv(opts = {}) {
  const events = [];
  const dbCalls = [];
  const io = { emit: (name, payload) => events.push({ name, payload }) };
  const statusDB = {
    setAlive: (email, data) => dbCalls.push({ kind: 'setAlive', email, ...data }),
    set: opts.statusSetSpy || (() => {}),
    get: opts.statusGetSpy || ((email) => null),
    clearAlive: () => {},
  };
  const accountsDB = {
    get: (email) => (opts.accounts || []).find((a) => a.email === email) || null,
  };
  return {
    io, statusDB, accountsDB, events, dbCalls,
    accounts: opts.accounts || [],
    config: { protocolMode: false, ...opts.config },
    checker: opts.checker || {
      probe: async () => ({ alive_status: 'plus', alive_reason: 'check ok' }),
      verifyDeactivated: async () => ({ status: 'error', reason: 'mock not configured' }),
    },
    lightLogin: opts.lightLogin || (async () => ({ accessToken: 'tok', accountId: 'acc', expiresAtIso: 'iso' })),
    codexFile: opts.codexFile || { read: async () => ({ access_token: 'cached.tok.x' }), write: async () => {} },
    proxyMgr: opts.proxyMgr || null,
  };
}

test('dispatches one account end-to-end', async () => {
  const env = mkEnv({ accounts: [{ email: 'a@x.com', password: 'p' }] });
  const runner = createRunner(env);
  const { total } = runner.start(['a@x.com']);
  assert.strictEqual(total, 1);
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(env.dbCalls.some(c => c.email === 'a@x.com' && c.alive_status === 'plus'));
});

test('limits concurrency to 3', async () => {
  let inFlight = 0;
  let peak = 0;
  const checker = {
    probe: async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 30));
      inFlight--;
      return { alive_status: 'plus', alive_reason: 'check ok' };
    },
  };
  const env = mkEnv({
    accounts: Array.from({ length: 10 }, (_, i) => ({ email: `u${i}@x.com`, password: 'p' })),
    checker,
  });
  const runner = createRunner(env);
  runner.start(env.accounts.map(a => a.email));
  await new Promise((r) => setTimeout(r, 4000));
  assert.ok(peak <= 3, `peak in-flight was ${peak}, expected <= 3`);
});

test('throttles 1s between dispatches', async () => {
  const ts = [];
  const checker = { probe: async () => { ts.push(Date.now()); return { alive_status: 'plus', alive_reason: '' }; } };
  const env = mkEnv({
    accounts: Array.from({ length: 4 }, (_, i) => ({ email: `t${i}@x.com`, password: 'p' })),
    checker,
  });
  const runner = createRunner(env);
  runner.start(env.accounts.map(a => a.email));
  await new Promise((r) => setTimeout(r, 5500));
  const span = ts[ts.length - 1] - ts[0];
  assert.ok(span >= 900, `span ${span}ms should reflect throttle`);
});

test('start refuses while running', async () => {
  const env = mkEnv({ accounts: [{ email: 'a@x.com', password: 'p' }] });
  const runner = createRunner(env);
  runner.start(['a@x.com']);
  assert.throws(() => runner.start(['a@x.com']), /already running/);
});

test('stop aborts pending accounts', async () => {
  const env = mkEnv({
    accounts: Array.from({ length: 5 }, (_, i) => ({ email: `s${i}@x.com`, password: 'p' })),
    checker: { probe: async () => { await new Promise(r => setTimeout(r, 100)); return { alive_status: 'plus', alive_reason: '' }; } },
  });
  const runner = createRunner(env);
  runner.start(env.accounts.map(a => a.email));
  await new Promise(r => setTimeout(r, 50));
  const { stopped } = runner.stop();
  assert.ok(stopped >= 0);
  await new Promise(r => setTimeout(r, 500));
  assert.ok(env.dbCalls.length < 5, 'not all accounts got dispatched after stop');
});

test('skips deleted account (accountsDB.get returns null)', async () => {
  const env = mkEnv({ accounts: [{ email: 'present@x.com', password: 'p' }] });
  const runner = createRunner(env);
  runner.start(['present@x.com', 'deleted@x.com']);
  await new Promise(r => setTimeout(r, 2500));
  const presentCalls = env.dbCalls.filter(c => c.email === 'present@x.com');
  const deletedCalls = env.dbCalls.filter(c => c.email === 'deleted@x.com');
  assert.ok(presentCalls.length >= 1);
  assert.strictEqual(deletedCalls.length, 0, 'deleted account has no setAlive call');
});

test('emits liveness-complete with summary at end', async () => {
  const env = mkEnv({
    accounts: [
      { email: 'a@x.com', password: 'p' },
      { email: 'b@x.com', password: 'p' },
    ],
    checker: {
      probe: async (token) => token === 'cached.tok.a'
        ? { alive_status: 'plus', alive_reason: 'check ok' }
        : { alive_status: 'canceled', alive_reason: 'no plus' },
    },
    codexFile: {
      read: async (email) => ({ access_token: email === 'a@x.com' ? 'cached.tok.a' : 'cached.tok.b' }),
      write: async () => {},
    },
  });
  const runner = createRunner(env);
  runner.start(['a@x.com', 'b@x.com']);
  await new Promise(r => setTimeout(r, 3500));
  const complete = env.events.find(e => e.name === 'liveness-complete');
  assert.ok(complete, 'liveness-complete fired');
  assert.strictEqual(complete.payload.total, 2);
  assert.strictEqual(complete.payload.summary.plus, 1);
  assert.strictEqual(complete.payload.summary.canceled, 1);
});

test('emits liveness-status + liveness-progress per account', async () => {
  const env = mkEnv({
    accounts: [{ email: 'a@x.com', password: 'p' }],
    checker: { probe: async () => ({ alive_status: 'plus', alive_reason: 'check ok' }) },
  });
  const runner = createRunner(env);
  runner.start(['a@x.com']);
  await new Promise(r => setTimeout(r, 1500));
  const statuses = env.events.filter(e => e.name === 'liveness-status');
  const progresses = env.events.filter(e => e.name === 'liveness-progress');
  assert.ok(statuses.length >= 2, 'at least checking + terminal');
  assert.strictEqual(statuses[0].payload.alive_status, 'checking');
  assert.strictEqual(progresses[0].payload.done, 1);
  assert.strictEqual(progresses[0].payload.total, 1);
});

test('runner: probe token_expired + verifyDeactivated deactivated → terminal deactivated', async () => {
  const env = mkEnv({
    accounts: [{ email: 'banned@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => ({ alive_status: 'token_expired', alive_reason: 'check 401' }),
      verifyDeactivated: async () => ({ status: 'deactivated', reason: 'account_deactivated' }),
    },
    codexFile: { read: async () => ({ access_token: 'eyJ.dead.tok' }), write: async () => {} },
  });
  const runner = createRunner(env);
  runner.start(['banned@x.com']);
  await new Promise(r => setTimeout(r, 2000));
  const dbCall = env.dbCalls.find(c => c.email === 'banned@x.com' && c.alive_status !== 'checking');
  assert.ok(dbCall, 'terminal setAlive call exists');
  assert.strictEqual(dbCall.alive_status, 'deactivated');
});

test('runner: probe token_expired + verifyDeactivated active → falls through to lightLogin', async () => {
  let lightLoginCalls = 0;
  const env = mkEnv({
    accounts: [{ email: 'maybe@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => ({ alive_status: 'token_expired', alive_reason: 'check 401' }),
      verifyDeactivated: async () => ({ status: 'active', reason: null }),
    },
    codexFile: { read: async () => ({ access_token: 'eyJ.expired.tok' }), write: async () => {} },
    lightLogin: async () => { lightLoginCalls++; throw new Error('liveness not yet supported in protocol mode'); },
  });
  const runner = createRunner(env);
  runner.start(['maybe@x.com']);
  await new Promise(r => setTimeout(r, 2000));
  assert.strictEqual(lightLoginCalls, 1, 'lightLogin was attempted after verifyDeactivated=active');
  const dbCall = env.dbCalls.find(c => c.email === 'maybe@x.com' && c.alive_status !== 'checking');
  assert.strictEqual(dbCall.alive_status, 'token_expired');
});

test('runner: network_error retries up to 3 times', async () => {
  let attempts = 0;
  const env = mkEnv({
    accounts: [{ email: 'flaky@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => { attempts++; return { alive_status: 'network_error', alive_reason: 'check 503' }; },
      verifyDeactivated: async () => ({ status: 'error', reason: 'na' }),
    },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
  });
  const runner = createRunner(env);
  runner.start(['flaky@x.com']);
  await new Promise(r => setTimeout(r, 5000));
  assert.strictEqual(attempts, 3, 'probe called 3 times');
  const final = env.dbCalls.find(c => c.email === 'flaky@x.com' && c.alive_status !== 'checking');
  assert.ok(final, 'terminal setAlive was called');
  assert.strictEqual(final.alive_status, 'network_error');
});

test('runner: first network_error retry succeeds → terminal plus', async () => {
  let attempts = 0;
  const env = mkEnv({
    accounts: [{ email: 'recovery@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => {
        attempts++;
        return attempts === 1
          ? { alive_status: 'network_error', alive_reason: 'check 503' }
          : { alive_status: 'plus', alive_reason: 'check ok' };
      },
      verifyDeactivated: async () => ({ status: 'error', reason: 'na' }),
    },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
  });
  const runner = createRunner(env);
  runner.start(['recovery@x.com']);
  await new Promise(r => setTimeout(r, 3500));
  assert.strictEqual(attempts, 2, 'probe called 2 times (network_error then plus)');
  const final = env.dbCalls.find(c => c.email === 'recovery@x.com' && c.alive_status !== 'checking');
  assert.ok(final, 'terminal setAlive was called');
  assert.strictEqual(final.alive_status, 'plus');
});

test('runner: plus on first attempt does NOT retry', async () => {
  let attempts = 0;
  const env = mkEnv({
    accounts: [{ email: 'fast@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => { attempts++; return { alive_status: 'plus', alive_reason: 'check ok' }; },
      verifyDeactivated: async () => ({ status: 'error', reason: 'na' }),
    },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
  });
  const runner = createRunner(env);
  runner.start(['fast@x.com']);
  await new Promise(r => setTimeout(r, 1500));
  assert.strictEqual(attempts, 1, 'probe called exactly once');
});

test('runner: 3 attempts net_error 全部 vote bad (粒度 v2.31.1)', async () => {
  const calls = [];
  const env = mkEnv({
    accounts: [{ email: 'n@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => ({ alive_status: 'network_error', alive_reason: 'check 503' }),
      verifyDeactivated: async () => ({ status: 'error', reason: 'na' }),
    },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
    proxyMgr: {
      getState: () => ({ enabled: true, currentNode: 'pro-us-99' }),
      recordBadAttempt: (tag, channel, reason) => {
        calls.push({ kind: 'bad', tag, channel, reason });
        return { blacklisted: false, count: calls.filter(c => c.kind === 'bad').length };
      },
      recordGoodAttempt: (tag, channel) => calls.push({ kind: 'good', tag, channel }),
      rotate: async () => calls.push({ kind: 'rotate' }),
    },
  });
  const runner = createRunner(env);
  runner.start(['n@x.com']);
  await new Promise(r => setTimeout(r, 5500));
  const bads = calls.filter(c => c.kind === 'bad');
  assert.strictEqual(bads.length, 3, '每个 attempt 都 vote bad，共 3 次');
  assert.match(bads[0].reason, /liveness_net_error_a1/);
  assert.match(bads[1].reason, /liveness_net_error_a2/);
  assert.match(bads[2].reason, /liveness_net_error_a3/);
  assert.strictEqual(calls.filter(c => c.kind === 'rotate').length, 0);
});

test('runner: terminal plus calls recordGoodAttempt', async () => {
  const calls = [];
  const env = mkEnv({
    accounts: [{ email: 'p@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => ({ alive_status: 'plus', alive_reason: 'check ok' }),
      verifyDeactivated: async () => ({ status: 'error', reason: 'na' }),
    },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
    proxyMgr: {
      getState: () => ({ enabled: true, currentNode: 'pro-us-77' }),
      recordBadAttempt: (...args) => calls.push({ kind: 'bad', args }),
      recordGoodAttempt: (tag, channel) => calls.push({ kind: 'good', tag, channel }),
    },
  });
  const runner = createRunner(env);
  runner.start(['p@x.com']);
  await new Promise(r => setTimeout(r, 1500));
  const good = calls.find(c => c.kind === 'good');
  assert.ok(good, 'recordGoodAttempt was called');
  assert.strictEqual(good.tag, 'pro-us-77');
  assert.strictEqual(good.channel, 'main');
});

test('runner: proxy disabled skips vote', async () => {
  const calls = [];
  const env = mkEnv({
    accounts: [{ email: 'd@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => ({ alive_status: 'plus', alive_reason: 'check ok' }),
      verifyDeactivated: async () => ({ status: 'error', reason: 'na' }),
    },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
    proxyMgr: {
      getState: () => ({ enabled: false, currentNode: 'pro-us-disabled' }),
      recordBadAttempt: (...args) => calls.push({ kind: 'bad', args }),
      recordGoodAttempt: (...args) => calls.push({ kind: 'good', args }),
    },
  });
  const runner = createRunner(env);
  runner.start(['d@x.com']);
  await new Promise(r => setTimeout(r, 1500));
  assert.strictEqual(calls.length, 0, 'no vote when proxy disabled');
});

test('runner: blacklist mid-retry triggers explicit await rotate', async () => {
  const calls = [];
  let badCount = 0;
  const env = mkEnv({
    accounts: [{ email: 'm@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => ({ alive_status: 'network_error', alive_reason: 'check 503' }),
      verifyDeactivated: async () => ({ status: 'error', reason: 'na' }),
    },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
    proxyMgr: {
      getState: () => ({ enabled: true, currentNode: 'pro-us-mid' }),
      recordBadAttempt: (tag, channel, reason) => {
        badCount++;
        calls.push({ kind: 'bad', tag, channel, reason });
        return { blacklisted: badCount === 2, count: badCount };
      },
      recordGoodAttempt: (tag, channel) => calls.push({ kind: 'good', tag, channel }),
      rotate: async () => {
        calls.push({ kind: 'rotate' });
        await new Promise(r => setTimeout(r, 5));
      },
    },
  });
  const runner = createRunner(env);
  runner.start(['m@x.com']);
  await new Promise(r => setTimeout(r, 5500));
  const bads = calls.filter(c => c.kind === 'bad');
  const rotates = calls.filter(c => c.kind === 'rotate');
  assert.strictEqual(bads.length, 3);
  assert.strictEqual(rotates.length, 1, 'rotate called exactly once when blacklisted:true');
  const badIdx2 = calls.findIndex(c => c.kind === 'bad' && c.reason.includes('a2'));
  const rotateIdx = calls.findIndex(c => c.kind === 'rotate');
  const badIdx3 = calls.findIndex(c => c.kind === 'bad' && c.reason.includes('a3'));
  assert.ok(badIdx2 < rotateIdx, 'rotate after a2 vote');
  assert.ok(rotateIdx < badIdx3, 'rotate before a3 vote (because await)');
});

test('runner: alive=plus 同步 status=plus (v2.32.0)', async () => {
  const setCalls = [];
  const env = mkEnv({
    accounts: [{ email: 'sp@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => ({ alive_status: 'plus', alive_reason: 'check ok' }),
      verifyDeactivated: async () => ({ status: 'error', reason: 'na' }),
    },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
    statusSetSpy: (email, data) => setCalls.push({ email, ...data }),
    statusGetSpy: () => ({ status: 'idle' }),
  });
  const runner = createRunner(env);
  runner.start(['sp@x.com']);
  await new Promise(r => setTimeout(r, 1500));
  const c = setCalls.find(x => x.email === 'sp@x.com');
  assert.ok(c, 'statusDB.set was called');
  assert.strictEqual(c.status, 'plus');
  assert.strictEqual(c.phase, '');
  assert.strictEqual(c.progress, 0);
});

test('runner: alive=deactivated 覆盖 status (无论原值)', async () => {
  const setCalls = [];
  const env = mkEnv({
    accounts: [{ email: 'sd@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => ({ alive_status: 'deactivated', alive_reason: 'account_deactivated' }),
      verifyDeactivated: async () => ({ status: 'error', reason: 'na' }),
    },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
    statusSetSpy: (email, data) => setCalls.push({ email, ...data }),
    statusGetSpy: () => ({ status: 'plus' }),
  });
  const runner = createRunner(env);
  runner.start(['sd@x.com']);
  await new Promise(r => setTimeout(r, 1500));
  const c = setCalls.find(x => x.email === 'sd@x.com');
  assert.ok(c, 'statusDB.set was called');
  assert.strictEqual(c.status, 'deactivated');
});

test('runner: alive=network_error 不同步 status', async () => {
  const setCalls = [];
  const env = mkEnv({
    accounts: [{ email: 'sn@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => ({ alive_status: 'network_error', alive_reason: 'check 503' }),
      verifyDeactivated: async () => ({ status: 'error', reason: 'na' }),
    },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
    statusSetSpy: (email, data) => setCalls.push({ email, ...data }),
    statusGetSpy: () => ({ status: 'idle' }),
  });
  const runner = createRunner(env);
  runner.start(['sn@x.com']);
  await new Promise(r => setTimeout(r, 5500));
  const c = setCalls.find(x => x.email === 'sn@x.com');
  assert.strictEqual(c, undefined, 'statusDB.set must NOT be called for network_error');
});

// v2.41.14: 新 SPA OAuth flow 错误码分类
test('runner v2.41.14: lightLogin throws "deactivated: account_deactivated" → alive_status=deactivated', async () => {
  const env = mkEnv({
    accounts: [{ email: 'dead@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => ({ alive_status: 'token_expired', alive_reason: 'check 401' }),
      verifyDeactivated: async () => ({ status: 'active', reason: null }),
    },
    lightLogin: async () => { throw new Error('deactivated: account_deactivated'); },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
  });
  const runner = createRunner(env);
  runner.start(['dead@x.com']);
  await new Promise(r => setTimeout(r, 2000));
  const final = env.dbCalls.find(c => c.email === 'dead@x.com' && c.alive_status !== 'checking');
  assert.ok(final, 'terminal setAlive was called');
  assert.strictEqual(final.alive_status, 'deactivated');
  assert.match(final.alive_reason, /account_deactivated/);
});

test('runner v2.41.14: lightLogin throws "login_fail: invalid_code" → alive_status=login_fail', async () => {
  const env = mkEnv({
    accounts: [{ email: 'badotp@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => ({ alive_status: 'token_expired', alive_reason: 'check 401' }),
      verifyDeactivated: async () => ({ status: 'active', reason: null }),
    },
    lightLogin: async () => { throw new Error('login_fail: invalid_code'); },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
  });
  const runner = createRunner(env);
  runner.start(['badotp@x.com']);
  await new Promise(r => setTimeout(r, 2000));
  const final = env.dbCalls.find(c => c.email === 'badotp@x.com' && c.alive_status !== 'checking');
  assert.ok(final, 'terminal setAlive was called');
  assert.strictEqual(final.alive_status, 'login_fail');
  assert.match(final.alive_reason, /invalid OTP/i);
});

test('runner v2.41.14: lightLogin throws "login_fail: authorize/continue unknown_user" → alive_status=login_fail', async () => {
  const env = mkEnv({
    accounts: [{ email: 'noexist@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => ({ alive_status: 'token_expired', alive_reason: 'check 401' }),
      verifyDeactivated: async () => ({ status: 'active', reason: null }),
    },
    lightLogin: async () => { throw new Error('login_fail: authorize/continue unknown_user'); },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
  });
  const runner = createRunner(env);
  runner.start(['noexist@x.com']);
  await new Promise(r => setTimeout(r, 2000));
  const final = env.dbCalls.find(c => c.email === 'noexist@x.com' && c.alive_status !== 'checking');
  assert.ok(final, 'terminal setAlive was called');
  assert.strictEqual(final.alive_status, 'login_fail');
  assert.match(final.alive_reason, /unknown user/i);
});

test('runner: alive=plus 不降级 plus_no_rt', async () => {
  const setCalls = [];
  const env = mkEnv({
    accounts: [{ email: 'snr@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => ({ alive_status: 'plus', alive_reason: 'check ok' }),
      verifyDeactivated: async () => ({ status: 'error', reason: 'na' }),
    },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
    statusSetSpy: (email, data) => setCalls.push({ email, ...data }),
    statusGetSpy: () => ({ status: 'plus_no_rt' }),
  });
  const runner = createRunner(env);
  runner.start(['snr@x.com']);
  await new Promise(r => setTimeout(r, 1500));
  const c = setCalls.find(x => x.email === 'snr@x.com');
  assert.strictEqual(c, undefined, 'plus 不该降级覆盖 plus_no_rt');
});
