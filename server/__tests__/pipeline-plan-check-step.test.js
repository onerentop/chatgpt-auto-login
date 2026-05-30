// server/__tests__/pipeline-plan-check-step.test.js
// 单元特征化测试：plan-check step 行为覆盖。
// 使用 node:test runner（本项目没有 jest/mocha）。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { planCheckStep } = require('../../server/pipeline/steps/plan-check');
const { AccountContext } = require('../../server/pipeline/context');

// --------------------------------------------------------------------------
// ctx 构造辅助
// --------------------------------------------------------------------------
function makeCtx({ planType } = {}) {
  const deps = {
    emitStatus: () => {},
    summary: { total: 1, success: 0, error: 0, noLink: 0, noJpProxy: 0, noPromo: 0, verifyError: 0 },
    statusDB: {
      get: () => null,
      set: () => {},
    },
    save: async () => {},
  };

  const account = { email: 'test@example.com', password: 'pw' };
  const ctx = new AccountContext(account, deps);

  // 模拟 login step 写入的 ctx.outputs.login
  ctx.outputs.login = {
    accessToken: 'fake-token',
    session: {},
    planType,
  };

  return ctx;
}

// --------------------------------------------------------------------------
// 测试 1：planType 'plus' → alreadyPlus 为 true，返回 ok:true
// --------------------------------------------------------------------------
test('planType "plus" → ctx.flags.alreadyPlus === true, ok:true', async () => {
  const ctx = makeCtx({ planType: 'plus' });
  const step = planCheckStep();
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true, 'run() should return { ok: true }');
  assert.strictEqual(ctx.flags.alreadyPlus, true, 'alreadyPlus must be true for "plus"');
});

// --------------------------------------------------------------------------
// 测试 2：大写 'PRO' → 不区分大小写，alreadyPlus 为 true
// --------------------------------------------------------------------------
test('planType "PRO" (uppercase) → ctx.flags.alreadyPlus === true, ok:true', async () => {
  const ctx = makeCtx({ planType: 'PRO' });
  const step = planCheckStep();
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true);
  assert.strictEqual(ctx.flags.alreadyPlus, true, 'case-insensitive: "PRO" must match');
});

// --------------------------------------------------------------------------
// 测试 3：混合大小写 'Team' → alreadyPlus 为 true
// --------------------------------------------------------------------------
test('planType "Team" (mixed-case) → ctx.flags.alreadyPlus === true, ok:true', async () => {
  const ctx = makeCtx({ planType: 'Team' });
  const step = planCheckStep();
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true);
  assert.strictEqual(ctx.flags.alreadyPlus, true, 'case-insensitive: "Team" must match');
});

// --------------------------------------------------------------------------
// 测试 4：'enterprise' → alreadyPlus 为 true
// --------------------------------------------------------------------------
test('planType "enterprise" → ctx.flags.alreadyPlus === true, ok:true', async () => {
  const ctx = makeCtx({ planType: 'enterprise' });
  const step = planCheckStep();
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true);
  assert.strictEqual(ctx.flags.alreadyPlus, true, '"enterprise" must be in Plus-or-above list');
});

// --------------------------------------------------------------------------
// 测试 5：'ENTERPRISE'（全大写）→ alreadyPlus 为 true（完整覆盖 4 个 tier 的大小写）
// --------------------------------------------------------------------------
test('planType "ENTERPRISE" (uppercase) → ctx.flags.alreadyPlus === true', async () => {
  const ctx = makeCtx({ planType: 'ENTERPRISE' });
  const step = planCheckStep();
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true);
  assert.strictEqual(ctx.flags.alreadyPlus, true);
});

// --------------------------------------------------------------------------
// 测试 6：planType 'free' → alreadyPlus 保持 falsy，返回 ok:true
// --------------------------------------------------------------------------
test('planType "free" → ctx.flags.alreadyPlus stays falsy, ok:true', async () => {
  const ctx = makeCtx({ planType: 'free' });
  const step = planCheckStep();
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true, 'run() should return { ok: true }');
  assert.ok(!ctx.flags.alreadyPlus, 'alreadyPlus must NOT be set for "free"');
});

// --------------------------------------------------------------------------
// 测试 7：planType undefined → 默认为 'free'，alreadyPlus 保持 falsy
// --------------------------------------------------------------------------
test('planType undefined → defaults to "free", ctx.flags.alreadyPlus stays falsy', async () => {
  const ctx = makeCtx({ planType: undefined });
  const step = planCheckStep();
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true);
  assert.ok(!ctx.flags.alreadyPlus, 'undefined planType must default to "free" (not Plus)');
});

// --------------------------------------------------------------------------
// 测试 8：planType null → 默认为 'free'，alreadyPlus 保持 falsy
// --------------------------------------------------------------------------
test('planType null → defaults to "free", ctx.flags.alreadyPlus stays falsy', async () => {
  const ctx = makeCtx({ planType: null });
  const step = planCheckStep();
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true);
  assert.ok(!ctx.flags.alreadyPlus, 'null planType must default to "free" (not Plus)');
});

// --------------------------------------------------------------------------
// 测试 9：从 ctx.outputs.login.planType 读取（而非其他路径）
// --------------------------------------------------------------------------
test('reads planType specifically from ctx.outputs.login.planType', async () => {
  const deps = {
    emitStatus: () => {},
    summary: {},
    statusDB: { get: () => null, set: () => {} },
    save: async () => {},
  };
  const account = { email: 'specific@example.com', password: 'pw' };
  const ctx = new AccountContext(account, deps);

  // 只在 ctx.outputs.login 里设置，其他路径均无
  ctx.outputs.login = {
    accessToken: 'tok',
    session: { account: { planType: 'free' } }, // session 里是 free，但 login.planType 是 plus
    planType: 'plus',
  };

  const step = planCheckStep();
  const res = await step.run(ctx);

  assert.strictEqual(res.ok, true);
  assert.strictEqual(ctx.flags.alreadyPlus, true,
    'must read from ctx.outputs.login.planType, not session fields');
});

// --------------------------------------------------------------------------
// 测试 10：shouldSkip 永远返回 false
// --------------------------------------------------------------------------
test('shouldSkip always returns false', () => {
  const step = planCheckStep();

  assert.strictEqual(step.shouldSkip({}), false, 'shouldSkip({}) must be false');
  assert.strictEqual(
    step.shouldSkip({ flags: { alreadyPlus: true }, outputs: { login: { planType: 'plus' } } }),
    false,
    'shouldSkip must be false even when alreadyPlus is already set'
  );
});

// --------------------------------------------------------------------------
// 测试 11：plan-check 不调用 emitStatus（原始代码在检测阶段不发出任何事件）
// --------------------------------------------------------------------------
test('plan-check never calls emitStatus (detection only, no side effects)', async () => {
  let emitCalled = false;
  const deps = {
    emitStatus: () => { emitCalled = true; },
    summary: { total: 1, success: 0, error: 0 },
    statusDB: { get: () => null, set: () => {} },
    save: async () => {},
  };
  const account = { email: 'emit@example.com', password: 'pw' };
  const ctx = new AccountContext(account, deps);
  ctx.outputs.login = { accessToken: 'tok', session: {}, planType: 'plus' };

  const step = planCheckStep();
  await step.run(ctx);

  assert.strictEqual(emitCalled, false, 'plan-check must NOT emit any status events');
});

// --------------------------------------------------------------------------
// 测试 12：plan-check 不修改 summary（终止动作由 paypal-pkce step 负责）
// --------------------------------------------------------------------------
test('plan-check never mutates summary (deferred to paypal-pkce step)', async () => {
  const ctx = makeCtx({ planType: 'plus' });
  const originalSummary = { ...ctx.deps.summary };

  const step = planCheckStep();
  await step.run(ctx);

  assert.deepStrictEqual(ctx.deps.summary, originalSummary,
    'summary must not be mutated by plan-check (deferred to paypal-pkce via alreadyPlus flag)');
});
