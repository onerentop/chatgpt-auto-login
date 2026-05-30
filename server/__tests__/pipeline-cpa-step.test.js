// server/__tests__/pipeline-cpa-step.test.js
// 单元特征化测试：cpa step（浏览器 CPA 注册，逐行搬运自 engine.js:377-387 + 628-637）
//
// 通过测试接缝注入假 registerToCPA（ctx.deps.__registerToCPA）避免调 Playwright/CDP。
// cpa.js 的 registerToCPA 通过 require.cache 注入 fake（避免 cpa.js 模块级 require('../payment')）。
//
// 测试目标（task 规格）：
//   1. shouldSkip when enableCPA false.
//   2. shouldSkip when no resources.browser.
//   3. alreadyPlus → emits running/cpa + registerToCPA called.
//   4. post-pay (alreadyPlus false) → does NOT emit running/cpa but registerToCPA called.
//   5. registerToCPA throws → caught, ok:true.

'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const fs     = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');

// --------------------------------------------------------------------------
// 状态追踪
// --------------------------------------------------------------------------
let _registerToCPACalls = [];
let _emitStatusCalls    = [];

// --------------------------------------------------------------------------
// fake cpa module（避免 cpa.js 在模块级 require('../payment') 失败）
// --------------------------------------------------------------------------
const fakeCpaModule = {
  registerToCPA: async (browser, email, account) => {
    _registerToCPACalls.push({ browser, email, account });
    return true;
  },
};

// --------------------------------------------------------------------------
// 注入 fake modules（必须在 require('cpa step') 之前）
// --------------------------------------------------------------------------
function injectFakeModules() {
  const cpaPath = require.resolve(path.join(ROOT, 'cpa'));
  require.cache[cpaPath] = { id: cpaPath, filename: cpaPath, loaded: true, exports: fakeCpaModule };
}

injectFakeModules();

const { cpaStep }     = require('../pipeline/steps/cpa');
const { AccountContext } = require('../pipeline/context');

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
function reset() {
  _registerToCPACalls = [];
  _emitStatusCalls    = [];
}

// --------------------------------------------------------------------------
// ctx 构造辅助
// --------------------------------------------------------------------------
function makeCtx({
  alreadyPlus    = false,
  browser        = { _fake: true },
  registerCPAFn  = null,
  progress       = '1/1',
} = {}) {
  const account = { email: 'test@example.com', password: 'pw' };

  const resources = { browser };

  const deps = {
    emitStatus: (data) => { _emitStatusCalls.push(data); },
    progress,
    resources,
    statusDB: { clearPaymentLink: () => {}, clearAccessToken: () => {}, get: () => null, set: () => {} },
  };

  if (registerCPAFn) deps.__registerToCPA = registerCPAFn;

  const ctx = new AccountContext(account, deps);
  ctx.flags.alreadyPlus = !!alreadyPlus;

  return { ctx };
}

// ==========================================================================
// 测试用例
// ==========================================================================

// 1. shouldSkip when enableCPA false
test('cpa: shouldSkip=true when enableCPA=false', (t) => {
  stubConfig({ enableCPA: false });
  try {
    const step = cpaStep();
    const { ctx } = makeCtx({ browser: { _fake: true } });
    assert.strictEqual(step.shouldSkip(ctx), true);
  } finally {
    unstubConfig();
  }
});

// 2. shouldSkip when no resources.browser
test('cpa: shouldSkip=true when resources.browser is null/undefined', (t) => {
  stubConfig({ enableCPA: true });
  try {
    const step = cpaStep();
    const { ctx } = makeCtx({ browser: null });
    assert.strictEqual(step.shouldSkip(ctx), true);
  } finally {
    unstubConfig();
  }
});

// 2b. shouldSkip=false when enableCPA=true AND browser present
test('cpa: shouldSkip=false when enableCPA=true and browser present', (t) => {
  stubConfig({ enableCPA: true });
  try {
    const step = cpaStep();
    const { ctx } = makeCtx({ browser: { _fake: true } });
    assert.strictEqual(step.shouldSkip(ctx), false);
  } finally {
    unstubConfig();
  }
});

// 3. alreadyPlus → emits running/cpa + registerToCPA called
test('cpa: alreadyPlus=true → emits running/cpa + registerToCPA called', async (t) => {
  reset();
  stubConfig({ enableCPA: true });
  try {
    const fakeBrowser = { _fake: true };
    const { ctx } = makeCtx({ alreadyPlus: true, browser: fakeBrowser });
    const step = cpaStep();

    // inject seam
    ctx.deps.__registerToCPA = async (browser, email, account) => {
      _registerToCPACalls.push({ browser, email, account });
      return true;
    };

    const result = await step.run(ctx);

    assert.strictEqual(result.ok, true);

    // emitStatus running/cpa should be emitted (alreadyPlus path)
    const runningCpa = _emitStatusCalls.find(e => e.status === 'running' && e.phase === 'cpa');
    assert.ok(runningCpa, 'should emit running/cpa for alreadyPlus');

    // registerToCPA called with browser + email + account
    assert.strictEqual(_registerToCPACalls.length, 1);
    assert.strictEqual(_registerToCPACalls[0].email, 'test@example.com');
    assert.strictEqual(_registerToCPACalls[0].browser, fakeBrowser);
  } finally {
    unstubConfig();
  }
});

// 4. post-pay (alreadyPlus=false) → does NOT emit running/cpa but registerToCPA called
test('cpa: alreadyPlus=false (post-pay) → does NOT emit running/cpa, registerToCPA called', async (t) => {
  reset();
  stubConfig({ enableCPA: true });
  try {
    const { ctx } = makeCtx({ alreadyPlus: false });
    const step = cpaStep();

    ctx.deps.__registerToCPA = async (browser, email, account) => {
      _registerToCPACalls.push({ browser, email, account });
      return true;
    };

    const result = await step.run(ctx);

    assert.strictEqual(result.ok, true);

    // should NOT emit running/cpa (post-pay asymmetry)
    const runningCpa = _emitStatusCalls.find(e => e.status === 'running' && e.phase === 'cpa');
    assert.strictEqual(runningCpa, undefined, 'should NOT emit running/cpa for post-pay');

    // registerToCPA still called
    assert.strictEqual(_registerToCPACalls.length, 1);
  } finally {
    unstubConfig();
  }
});

// 5. registerToCPA throws → caught, ok:true (finalStatus not changed)
test('cpa: registerToCPA throws → caught, ok:true', async (t) => {
  reset();
  stubConfig({ enableCPA: true });
  try {
    const { ctx } = makeCtx({ alreadyPlus: false });
    const step = cpaStep();

    ctx.deps.__registerToCPA = async () => {
      throw new Error('CDP connection refused');
    };

    const result = await step.run(ctx);

    assert.strictEqual(result.ok, true, 'should return ok:true even when registerToCPA throws');
    // finalStatus not set by cpa step
    assert.strictEqual(ctx.flags.finalStatus, undefined);
  } finally {
    unstubConfig();
  }
});

// 5b. registerToCPA returns false → ok:true (logs "may have issues")
test('cpa: registerToCPA returns false → ok:true', async (t) => {
  reset();
  stubConfig({ enableCPA: true });
  try {
    const { ctx } = makeCtx({ alreadyPlus: true });
    const step = cpaStep();

    ctx.deps.__registerToCPA = async () => false;

    const result = await step.run(ctx);
    assert.strictEqual(result.ok, true);
  } finally {
    unstubConfig();
  }
});
