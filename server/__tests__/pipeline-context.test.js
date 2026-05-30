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
