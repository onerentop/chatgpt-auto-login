// server/__tests__/gopay-engine-runner.test.js
// 端到端测试：GoPayEngine.runOne 通过 PipelineRunner 驱动 gopay 管线。
//
// 接缝：__setSpawnImpl 注入假 spawn，避免真正 fork Python 进程。
// 覆盖：
//   1. 成功激活路径 → 'result' 事件 status='plus_gopay'，携带 phone
//   2. 已是 Plus (planType:'plus') → 'result' 事件 status='already_plus'，register/pay 被跳过
//   3. 注册失败 (gopay_reg_fail) → 'result' 事件 status='gopay_reg_fail'
//   4. stop() 在 run 期间中止 → AbortController.abort() 被调用
'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

// 测试接缝
const { __setSpawnImpl } = require('../../server/pipeline/steps/_gopay-spawn');

// 被测模块（单例引擎）
// 为避免跨测试状态污染，每个测试通过 require 构造新引擎实例
// 但 module.exports 是单例 —— 用类内部克隆
const GoPayEngineModule = require('../../server/gopay-engine');

// ============================================================
// 辅助：假 spawn 工厂（与 pipeline-gopay-steps.test.js 一致）
// ============================================================
function makeFakeSpawn(lines) {
  return function fakeSpawn(_cmd, _args, _opts) {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child  = new EventEmitter();
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin  = { write: () => {}, end: () => {} };
    child.kill   = () => {};
    setImmediate(() => {
      for (const line of lines) {
        stdout.emit('data', Buffer.from(line + '\n'));
      }
      child.emit('exit', 0);
    });
    return child;
  };
}

// 注意：gopay-engine 导出的是单例 engine。
// 测试间可能互相影响——我们在每个测试前重置 _results/_logs/_running
function resetEngine(engine) {
  engine._running = false;
  engine._aborted = false;
  engine._currentAccount = null;
  engine._phase = 'idle';
  engine._childProc = null;
  engine._abortController = null;
  engine._results = [];
  engine._logs    = [];
  engine.removeAllListeners();
}

// ============================================================
// 测试 1：完整成功路径（register → pay → verify → plus_gopay）
// ============================================================
test('GoPayEngine.runOne: success path → result event status=plus_gopay with phone', async () => {
  const engine = GoPayEngineModule;
  resetEngine(engine);

  const registerResult = JSON.stringify({
    status:  'registered',
    account: { local: '8123456789', aid: 'aid-1', phone: '+628123456789' },
    proxy:   'http://id.proxy:1234',
    phone:   '+628123456789',
  });
  const payResult = JSON.stringify({
    status:             'success',
    phone:              '+628123456789',
    transaction_status: 'settlement',
  });

  // register step 和 pay step 各被 spawn 一次（mode:'register' 然后 mode:'pay'）
  // 注入同一个 fakeSpawn，第一次返回 registered，第二次返回 success
  let callCount = 0;
  __setSpawnImpl(function fakeSpawn(_cmd, _args, _opts) {
    callCount++;
    const lines = callCount === 1 ? [registerResult] : [payResult];
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child  = new EventEmitter();
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin  = { write: () => {}, end: () => {} };
    child.kill   = () => {};
    setImmediate(() => {
      for (const line of lines) stdout.emit('data', Buffer.from(line + '\n'));
      child.emit('exit', 0);
    });
    return child;
  });

  try {
    const resultEvents = [];
    engine.on('result', (r) => resultEvents.push(r));

    await engine.runOne({
      email:       'gopay@test.com',
      accessToken: 'fake-token-abc',
      planType:    'free',
    });

    assert.strictEqual(resultEvents.length, 1, 'exactly one result event');
    const r = resultEvents[0];
    assert.strictEqual(r.email,  'gopay@test.com');
    assert.strictEqual(r.status, 'plus_gopay', 'status must be plus_gopay');
    assert.strictEqual(r.phone,  '+628123456789', 'phone must be forwarded');
    assert.ok(r.timestamp, 'timestamp must be set');

    // 引擎恢复空闲
    assert.strictEqual(engine.state.running, false);
    assert.strictEqual(engine.state.phase,   'idle');
    assert.strictEqual(callCount, 2, 'spawn must be called twice (register + pay)');
  } finally {
    __setSpawnImpl(null);
  }
});

// ============================================================
// 测试 2：账号已是 Plus → already_plus，register/pay spawn 不发生
// ============================================================
test('GoPayEngine.runOne: planType=plus → result already_plus, no spawn', async () => {
  const engine = GoPayEngineModule;
  resetEngine(engine);

  let spawnCallCount = 0;
  __setSpawnImpl(function fakeSpawn(_cmd, _args, _opts) {
    spawnCallCount++;
    // should never be called
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child  = new EventEmitter();
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin  = { write: () => {}, end: () => {} };
    child.kill   = () => {};
    setImmediate(() => { child.emit('exit', 0); });
    return child;
  });

  try {
    const resultEvents = [];
    engine.on('result', (r) => resultEvents.push(r));

    await engine.runOne({
      email:       'plus@test.com',
      accessToken: 'fake-token-plus',
      planType:    'plus',
    });

    assert.strictEqual(resultEvents.length, 1, 'exactly one result event');
    const r = resultEvents[0];
    assert.strictEqual(r.email,  'plus@test.com');
    assert.strictEqual(r.status, 'already_plus', 'status must be already_plus for Plus accounts');

    assert.strictEqual(spawnCallCount, 0, 'Python spawn must NOT be called for already-Plus accounts');
    assert.strictEqual(engine.state.running, false);
  } finally {
    __setSpawnImpl(null);
  }
});

// ============================================================
// 测试 3：register 失败 → gopay_reg_fail，pay spawn 不发生
// ============================================================
test('GoPayEngine.runOne: register fail → result gopay_reg_fail', async () => {
  const engine = GoPayEngineModule;
  resetEngine(engine);

  let spawnCallCount = 0;
  __setSpawnImpl(function fakeSpawn(_cmd, _args, _opts) {
    spawnCallCount++;
    const lines = [
      JSON.stringify({ status: 'gopay_reg_fail', detail: 'all 20 attempts failed' }),
    ];
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child  = new EventEmitter();
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin  = { write: () => {}, end: () => {} };
    child.kill   = () => {};
    setImmediate(() => {
      for (const line of lines) stdout.emit('data', Buffer.from(line + '\n'));
      child.emit('exit', 0);
    });
    return child;
  });

  try {
    const resultEvents = [];
    engine.on('result', (r) => resultEvents.push(r));

    await engine.runOne({
      email:       'fail@test.com',
      accessToken: 'fake-token-fail',
      planType:    'free',
    });

    assert.strictEqual(resultEvents.length, 1, 'exactly one result event');
    const r = resultEvents[0];
    assert.strictEqual(r.email,  'fail@test.com');
    assert.strictEqual(r.status, 'gopay_reg_fail', 'status must be gopay_reg_fail');

    assert.strictEqual(spawnCallCount, 1, 'spawn called only once (register only, pay skipped)');
    assert.strictEqual(engine.state.running, false);
  } finally {
    __setSpawnImpl(null);
  }
});

// ============================================================
// 测试 4：无 accessToken → 抛出错误 → 'result' 事件 status='error'
// ============================================================
test('GoPayEngine.runOne: no accessToken → result status=error', async () => {
  const engine = GoPayEngineModule;
  resetEngine(engine);

  const resultEvents = [];
  engine.on('result', (r) => resultEvents.push(r));

  // 不需要 setSpawnImpl — 流程在 token 校验处就终止
  await engine.runOne({ email: 'no-token@test.com', planType: 'free' });

  assert.strictEqual(resultEvents.length, 1);
  assert.strictEqual(resultEvents[0].status, 'error');
  assert.ok(resultEvents[0].detail?.includes('access token'), 'detail must mention access token');
  assert.strictEqual(engine.state.running, false);
});

// ============================================================
// 测试 5：重入保护 — engine 运行中调 runOne 应 throw
// ============================================================
test('GoPayEngine.runOne: reentrance guard throws when already running', async () => {
  const engine = GoPayEngineModule;
  resetEngine(engine);
  // 手动把 _running 设为 true 模拟运行中
  engine._running = true;

  try {
    await assert.rejects(
      () => engine.runOne({ email: 'x@test.com', accessToken: 'tok' }),
      /already running/i,
    );
  } finally {
    engine._running = false;
  }
});

// ============================================================
// 测试 6：state getter 空闲态结构
// ============================================================
test('GoPayEngine.state: idle state has correct shape', () => {
  const engine = GoPayEngineModule;
  resetEngine(engine);

  const s = engine.state;
  assert.strictEqual(s.running,        false);
  assert.strictEqual(s.phase,          'idle');
  assert.strictEqual(s.currentAccount, null);
  assert.ok(Array.isArray(s.results),  'results must be array');
  assert.strictEqual(s.logCount,       0);
});
