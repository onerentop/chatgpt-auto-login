const test = require('node:test');
const assert = require('node:assert');
const { AccountContext } = require('../../server/pipeline/context');

function fakeDeps() {
  const store = {};
  return {
    statusDB: { get: (e) => store[e] || null, set: (e, d) => { store[e] = { ...(store[e] || {}), ...d }; } },
    logged: [],
    log(email, stepId, msg) { this.logged.push({ email, stepId, msg }); },
  };
}

test('exposes account fields', () => {
  const ctx = new AccountContext({ email: 'a@x.com', password: 'p' }, fakeDeps());
  assert.strictEqual(ctx.email, 'a@x.com');
  assert.strictEqual(ctx.account.password, 'p');
});

test('getPersisted reads statusDB', () => {
  const deps = fakeDeps();
  deps.statusDB.set('a@x.com', { last_access_token: 'tok' });
  const ctx = new AccountContext({ email: 'a@x.com' }, deps);
  assert.strictEqual(ctx.getPersisted().last_access_token, 'tok');
});

test('log routes through deps.log with currentStepId', () => {
  const deps = fakeDeps();
  const ctx = new AccountContext({ email: 'a@x.com' }, deps);
  ctx.currentStepId = 'login';
  ctx.log('hello');
  assert.deepStrictEqual(deps.logged[0], { email: 'a@x.com', stepId: 'login', msg: 'hello' });
});

test('outputs + flags are mutable bags', () => {
  const ctx = new AccountContext({ email: 'a@x.com' }, fakeDeps());
  ctx.outputs.login = { accessToken: 't' };
  ctx.flags.alreadyPlus = true;
  assert.strictEqual(ctx.outputs.login.accessToken, 't');
  assert.strictEqual(ctx.flags.alreadyPlus, true);
});

test('getPersisted returns {} when statusDB has no row', () => {
  const ctx = new AccountContext({ email: 'missing@x.com' }, fakeDeps());
  assert.deepStrictEqual(ctx.getPersisted(), {});
});

test('prevPersisted is a snapshot at construction time and does not change when statusDB is mutated afterward', () => {
  const deps = fakeDeps();
  // Set up a row BEFORE constructing the context (simulates top-of-loop state)
  deps.statusDB.set('snap@x.com', { foo: 'bar', status: 'verify_error' });
  const ctx = new AccountContext({ email: 'snap@x.com' }, deps);

  // Snapshot captured at construction time
  assert.strictEqual(ctx.prevPersisted.foo, 'bar', 'prevPersisted.foo should match the row at construction time');
  assert.strictEqual(ctx.prevPersisted.status, 'verify_error', 'prevPersisted.status should match at construction time');

  // Mutate statusDB (simulates login step writing status='running')
  deps.statusDB.set('snap@x.com', { foo: 'bar', status: 'running' });

  // getPersisted() reflects the live row
  assert.strictEqual(ctx.getPersisted().status, 'running', 'getPersisted() must return the live row after mutation');

  // prevPersisted remains the original snapshot
  assert.strictEqual(ctx.prevPersisted.foo, 'bar', 'prevPersisted.foo must still be original (snapshot, not live)');
  assert.strictEqual(ctx.prevPersisted.status, 'verify_error', 'prevPersisted.status must still be original (snapshot, not live)');
});

test('prevPersisted is {} when statusDB has no row at construction time', () => {
  const ctx = new AccountContext({ email: 'nobody@x.com' }, fakeDeps());
  assert.deepStrictEqual(ctx.prevPersisted, {}, 'prevPersisted must be {} when no row exists');
});
