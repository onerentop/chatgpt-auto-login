const test = require('node:test');
const assert = require('node:assert');

const { createRunner } = require('../runner');

function mkEnv(opts = {}) {
  const events = [];
  const dbCalls = [];
  const io = { emit: (name, payload) => events.push({ name, payload }) };
  const statusDB = {
    setAlive: (email, data) => dbCalls.push({ email, ...data }),
    clearAlive: () => {},
  };
  const accountsDB = {
    get: (email) => (opts.accounts || []).find((a) => a.email === email) || null,
  };
  return {
    io, statusDB, accountsDB, events, dbCalls,
    accounts: opts.accounts || [],
    config: { protocolMode: false, ...opts.config },
    checker: opts.checker || { probe: async () => ({ alive_status: 'plus', alive_reason: 'check ok' }) },
    lightLogin: opts.lightLogin || (async () => ({ accessToken: 'tok', accountId: 'acc', expiresAtIso: 'iso' })),
    codexFile: opts.codexFile || { read: async () => ({ access_token: 'cached.tok.x' }), write: async () => {} },
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
