const test = require('node:test');
const assert = require('node:assert');
const { PipelineRunner } = require('../../server/pipeline/runner');
const { AccountContext } = require('../../server/pipeline/context');
const { defineStep } = require('../../server/pipeline/step');

function harness() {
  const stepRows = {};                 // `${email}|${id}` -> last patch
  const events = [];
  const deps = {
    statusDB: { get: () => null, set: () => {} },
    stepStateDB: { set: (email, id, patch) => { stepRows[`${email}|${id}`] = { ...(stepRows[`${email}|${id}`]||{}), ...patch }; } },
    log: () => {},
  };
  const runner = new PipelineRunner(deps);
  runner.on('step-status', (e) => events.push(e));
  return { runner, deps, events, stepRows };
}

test('runs all steps in order, emits running+success, records done', async () => {
  const { runner, deps, events } = harness();
  const order = [];
  const steps = [
    defineStep({ id: 's1', label: 'S1', run: async () => { order.push('s1'); return { ok: true }; } }),
    defineStep({ id: 's2', label: 'S2', run: async () => { order.push('s2'); return { ok: true }; } }),
  ];
  const ctx = new AccountContext({ email: 'a@x.com' }, deps);
  const res = await runner._runAccount(ctx, steps);
  assert.deepStrictEqual(order, ['s1', 's2']);
  assert.strictEqual(res.completed, true);
  assert.deepStrictEqual(events.map(e => `${e.stepId}:${e.status}`),
    ['s1:running', 's1:success', 's2:running', 's2:success']);
});

test('shouldSkip true → skipped, run not called (auto-resume)', async () => {
  const { runner, deps, events } = harness();
  let ran = false;
  const steps = [
    defineStep({ id: 's1', label: 'S1', shouldSkip: () => true, run: async () => { ran = true; return { ok: true }; } }),
    defineStep({ id: 's2', label: 'S2', run: async () => ({ ok: true }) }),
  ];
  const ctx = new AccountContext({ email: 'a@x.com' }, deps);
  await runner._runAccount(ctx, steps);
  assert.strictEqual(ran, false);
  assert.ok(events.some(e => e.stepId === 's1' && e.status === 'skipped'));
});

test('failure (ok:false) stops pipeline, downstream not run', async () => {
  const { runner, deps, events } = harness();
  let s3ran = false;
  const steps = [
    defineStep({ id: 's1', label: 'S1', run: async () => ({ ok: true }) }),
    defineStep({ id: 's2', label: 'S2', run: async () => ({ ok: false, reason: 'boom' }) }),
    defineStep({ id: 's3', label: 'S3', run: async () => { s3ran = true; return { ok: true }; } }),
  ];
  const ctx = new AccountContext({ email: 'a@x.com' }, deps);
  const res = await runner._runAccount(ctx, steps);
  assert.strictEqual(s3ran, false);
  assert.strictEqual(res.stoppedAt, 's2');
  assert.ok(events.some(e => e.stepId === 's2' && e.status === 'failed' && e.reason === 'boom'));
});

test('thrown error → failed with message, stops', async () => {
  const { runner, deps, events } = harness();
  const steps = [
    defineStep({ id: 's1', label: 'S1', run: async () => { throw new Error('kaboom'); } }),
    defineStep({ id: 's2', label: 'S2', run: async () => ({ ok: true }) }),
  ];
  const ctx = new AccountContext({ email: 'a@x.com' }, deps);
  const res = await runner._runAccount(ctx, steps);
  assert.strictEqual(res.stoppedAt, 's1');
  assert.ok(events.some(e => e.stepId === 's1' && e.status === 'failed' && /kaboom/.test(e.reason)));
});

test('forceStepId re-runs that step even if shouldSkip true; valid upstream still skipped', async () => {
  const { runner, deps } = harness();
  const calls = [];
  const steps = [
    defineStep({ id: 's1', label: 'S1', shouldSkip: () => true, run: async () => { calls.push('s1'); return { ok: true }; } }),
    defineStep({ id: 's2', label: 'S2', shouldSkip: () => true, run: async () => { calls.push('s2'); return { ok: true }; } }),
  ];
  const ctx = new AccountContext({ email: 'a@x.com' }, deps);
  await runner._runAccount(ctx, steps, { forceStepId: 's2' });
  assert.deepStrictEqual(calls, ['s2'], 's1 stayed skipped, s2 forced to run');
});

test('stopFlag halts before next step', async () => {
  const { runner, deps } = harness();
  const calls = [];
  const steps = [
    defineStep({ id: 's1', label: 'S1', run: async () => { calls.push('s1'); runner.stopFlag = true; return { ok: true }; } }),
    defineStep({ id: 's2', label: 'S2', run: async () => { calls.push('s2'); return { ok: true }; } }),
  ];
  const ctx = new AccountContext({ email: 'a@x.com' }, deps);
  await runner._runAccount(ctx, steps);
  assert.deepStrictEqual(calls, ['s1']);
});

test('output is stashed on ctx.outputs', async () => {
  const { runner, deps } = harness();
  const steps = [
    defineStep({ id: 's1', label: 'S1', run: async () => ({ ok: true, output: { token: 't' } }) }),
  ];
  const ctx = new AccountContext({ email: 'a@x.com' }, deps);
  await runner._runAccount(ctx, steps);
  assert.strictEqual(ctx.outputs.s1.token, 't');
});

test('malformed result (missing ok) is treated as failure, not silent success', async () => {
  const { runner, deps, events } = harness();
  let s2ran = false;
  const steps = [
    defineStep({ id: 's1', label: 'S1', run: async () => { /* forgot to return ok */ } }),
    defineStep({ id: 's2', label: 'S2', run: async () => { s2ran = true; return { ok: true }; } }),
  ];
  const ctx = new AccountContext({ email: 'a@x.com' }, deps);
  const res = await runner._runAccount(ctx, steps);
  assert.strictEqual(s2ran, false, 'downstream must not run after malformed result');
  assert.strictEqual(res.stoppedAt, 's1');
  assert.ok(events.some(e => e.stepId === 's1' && e.status === 'failed' && /malformed/.test(e.reason)));
});

test('forced step success lets downstream continue normally', async () => {
  const { runner, deps } = harness();
  const calls = [];
  const steps = [
    defineStep({ id: 's1', label: 'S1', shouldSkip: () => true, run: async () => { calls.push('s1'); return { ok: true }; } }),
    defineStep({ id: 's2', label: 'S2', shouldSkip: () => true, run: async () => { calls.push('s2'); return { ok: true }; } }),
    defineStep({ id: 's3', label: 'S3', run: async () => { calls.push('s3'); return { ok: true }; } }),
  ];
  const ctx = new AccountContext({ email: 'a@x.com' }, deps);
  const res = await runner._runAccount(ctx, steps, { forceStepId: 's2' });
  assert.deepStrictEqual(calls, ['s2', 's3'], 's1 skipped, s2 forced, s3 downstream runs');
  assert.strictEqual(res.completed, true);
});
