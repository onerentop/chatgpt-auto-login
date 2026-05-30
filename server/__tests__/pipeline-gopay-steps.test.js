// server/__tests__/pipeline-gopay-steps.test.js
// 单元特征化测试：gopay-register / gopay-pay / gopay-verify 三步 + spawnGopay 接缝。
// 使用 node:test runner（本项目没有 jest/mocha）。
//
// 接缝模式：通过 _gopay-spawn.__setSpawnImpl 注入假 spawn，避免真正 fork Python 进程。
// 测试覆盖：
//   1. register success  → ctx.outputs['gopay-register'] 写入，ok:true
//   2. register fail     → ctx.flags.finalStatus 写入，emit done，ok:false
//   3. pay success       → ctx.outputs['gopay-pay'] 写入，无 finalStatus，ok:true
//   4. pay fail (gopay_pay_fail) → ctx.flags.finalStatus='gopay_pay_fail'，emit done，ok:false
//   5. pay fail (gopay_fraud)    → ctx.flags.finalStatus='gopay_fraud'，emit done，ok:false
//   6. verify            → ctx.flags.finalStatus='plus_gopay'，emit plus_gopay/done+phone，ok:true
'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

// 被测模块
const { spawnGopay, __setSpawnImpl } = require('../../server/pipeline/steps/_gopay-spawn');
const { gopayRegisterStep }          = require('../../server/pipeline/steps/gopay-register');
const { gopayPayStep }               = require('../../server/pipeline/steps/gopay-pay');
const { gopayVerifyStep }            = require('../../server/pipeline/steps/gopay-verify');
const { AccountContext }             = require('../../server/pipeline/context');

// ==========================================================================
// 假 spawn 工厂
// 生成一个假 spawn 函数，模拟 Python 进程的 stdout JSON-lines 输出。
//
// lines: Array<string>  — 每行 JSON 字符串（按序在 'data' 事件中发出）
// ==========================================================================
function makeFakeSpawn(lines) {
  /**
   * 返回假 ChildProcess（EventEmitter + stdin/stdout/stderr shim）。
   */
  return function fakeSpawn(_cmd, _args, _opts) {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child  = new EventEmitter();
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin  = { write: () => {}, end: () => {} };
    child.kill   = () => {};

    // 异步发出 stdout lines，然后触发 exit
    setImmediate(() => {
      for (const line of lines) {
        stdout.emit('data', Buffer.from(line + '\n'));
      }
      child.emit('exit', 0);
    });

    return child;
  };
}

// ==========================================================================
// ctx 构造辅助
// ==========================================================================
function makeCtx({ planType = 'free', registerOut = null, payOut = null } = {}) {
  const emitCalls = [];

  const deps = {
    emitStatus: (data) => { emitCalls.push(data); },
    summary:    { total: 1, success: 0, error: 0 },
    progress:   '1/1',
    abortController: { signal: { aborted: false, addEventListener: () => {} } },
    statusDB: {
      get: () => null,
      set: () => {},
    },
    save: async () => {},
  };

  const account = { email: 'test@gopay.com', password: 'pw' };
  const ctx = new AccountContext(account, deps);

  ctx.outputs.login = {
    accessToken: 'fake-access-token',
    session:     {},
    planType,
  };

  if (registerOut) {
    ctx.outputs['gopay-register'] = registerOut;
  }
  if (payOut) {
    ctx.outputs['gopay-pay'] = payOut;
  }

  return { ctx, emitCalls };
}

// ==========================================================================
// 测试辅助：确保 __setSpawnImpl 在每个测试后恢复原生（避免测试间污染）
// 使用 try/finally 模式。
// ==========================================================================

// --------------------------------------------------------------------------
// 测试 1：gopay-register success
//   spawnGopay 返回 {status:'registered', account:{...}, proxy:'p', phone:'+62xxx'}
//   → ctx.outputs['gopay-register'] 写入，ok:true，不设 finalStatus，发出 running 事件
// --------------------------------------------------------------------------
test('gopayRegisterStep: success → outputs set, ok:true, no finalStatus', async () => {
  const fakeResult = {
    status:  'registered',
    account: { local: '8123456789', aid: 'aid-1', phone: '+628123456789' },
    proxy:   'http://id.proxy:1234',
    phone:   '+628123456789',
  };

  __setSpawnImpl(makeFakeSpawn([JSON.stringify(fakeResult)]));
  try {
    const { ctx, emitCalls } = makeCtx();
    const step = gopayRegisterStep();
    const res  = await step.run(ctx);

    assert.strictEqual(res.ok, true, 'must return ok:true on registered');
    assert.deepStrictEqual(ctx.outputs['gopay-register'], {
      account: fakeResult.account,
      proxy:   fakeResult.proxy,
      phone:   fakeResult.phone,
    }, 'outputs must be written from Python result');
    assert.strictEqual(ctx.flags.finalStatus, undefined, 'finalStatus must NOT be set on success');

    // running 事件必须发出
    const runningEmit = emitCalls.find(e => e.status === 'running' && e.phase === 'gopay_register');
    assert.ok(runningEmit, 'must emit running/gopay_register');
    assert.strictEqual(runningEmit.email, 'test@gopay.com');
    assert.strictEqual(runningEmit.progress, '1/1');
  } finally {
    __setSpawnImpl(null);
  }
});

// --------------------------------------------------------------------------
// 测试 2：gopayRegisterStep fail (gopay_reg_fail)
//   spawnGopay 返回 {status:'gopay_reg_fail', detail:'all 20 attempts failed'}
//   → ctx.flags.finalStatus='gopay_reg_fail'，emit done/gopay_reg_fail，ok:false
// --------------------------------------------------------------------------
test('gopayRegisterStep: gopay_reg_fail → finalStatus set, emit done, ok:false', async () => {
  const fakeResult = {
    status: 'gopay_reg_fail',
    detail: 'all 20 attempts failed',
    phone:  '',
  };

  __setSpawnImpl(makeFakeSpawn([JSON.stringify(fakeResult)]));
  try {
    const { ctx, emitCalls } = makeCtx();
    const step = gopayRegisterStep();
    const res  = await step.run(ctx);

    assert.strictEqual(res.ok, false, 'must return ok:false on gopay_reg_fail');
    assert.strictEqual(res.reason, 'all 20 attempts failed');
    assert.strictEqual(ctx.flags.finalStatus, 'gopay_reg_fail', 'finalStatus must be gopay_reg_fail');
    assert.strictEqual(ctx.flags.finalReason, 'all 20 attempts failed');

    // emit done 必须发出
    const doneEmit = emitCalls.find(e => e.status === 'gopay_reg_fail' && e.phase === 'done');
    assert.ok(doneEmit, 'must emit gopay_reg_fail/done');
    assert.strictEqual(doneEmit.email,    'test@gopay.com');
    assert.strictEqual(doneEmit.progress, '1/1');
    assert.strictEqual(doneEmit.reason,   'all 20 attempts failed');

    // outputs['gopay-register'] 不应被写入
    assert.strictEqual(ctx.outputs['gopay-register'], undefined, 'outputs must NOT be written on fail');
  } finally {
    __setSpawnImpl(null);
  }
});

// --------------------------------------------------------------------------
// 测试 3：gopayRegisterStep fail (timeout)
//   接缝直接返回 {status:'timeout', detail:'600000ms exceeded'}
//   → ctx.flags.finalStatus='timeout'，ok:false
// --------------------------------------------------------------------------
test('gopayRegisterStep: timeout → finalStatus=timeout, ok:false', async () => {
  const fakeResult = { status: 'timeout', detail: '600000ms exceeded' };

  __setSpawnImpl(makeFakeSpawn([JSON.stringify(fakeResult)]));
  try {
    const { ctx } = makeCtx();
    const step = gopayRegisterStep();
    const res  = await step.run(ctx);

    assert.strictEqual(res.ok, false);
    assert.strictEqual(ctx.flags.finalStatus, 'timeout');
    assert.strictEqual(ctx.flags.finalReason, '600000ms exceeded');
  } finally {
    __setSpawnImpl(null);
  }
});

// --------------------------------------------------------------------------
// 测试 4：gopayRegisterStep fail (aborted)
//   AbortController.signal.aborted=true → spawnGopay 立即返回 {status:'aborted'}
// --------------------------------------------------------------------------
test('gopayRegisterStep: aborted signal → finalStatus=aborted, ok:false', async () => {
  // aborted 信号：_gopay-spawn 直接 resolve {status:'aborted'} 而不 spawn 进程
  // 用 makeFakeSpawn([]) 以防万一（信号已 aborted 时不会 spawn）
  __setSpawnImpl(makeFakeSpawn([]));
  try {
    const { ctx, emitCalls } = makeCtx();
    // 强制信号已中止
    ctx.deps.abortController = { signal: { aborted: true, addEventListener: () => {} } };

    const step = gopayRegisterStep();
    const res  = await step.run(ctx);

    assert.strictEqual(res.ok, false);
    assert.strictEqual(ctx.flags.finalStatus, 'aborted');
    // emit done/aborted
    const doneEmit = emitCalls.find(e => e.status === 'aborted' && e.phase === 'done');
    assert.ok(doneEmit, 'must emit aborted/done');
  } finally {
    __setSpawnImpl(null);
  }
});

// --------------------------------------------------------------------------
// 测试 5：gopayPayStep success
//   spawnGopay 返回 {status:'success', phone:'+62xxx', transaction_status:'settlement'}
//   → ctx.outputs['gopay-pay'] 写入，不设 finalStatus，ok:true
// --------------------------------------------------------------------------
test('gopayPayStep: success → outputs set, NO finalStatus, ok:true', async () => {
  const fakeResult = {
    status:             'success',
    phone:              '+628123456789',
    transaction_status: 'settlement',
  };

  __setSpawnImpl(makeFakeSpawn([JSON.stringify(fakeResult)]));
  try {
    const registerOut = {
      account: { local: '8123456789', aid: 'aid-1', phone: '+628123456789' },
      proxy:   'http://id.proxy:1234',
      phone:   '+628123456789',
    };
    const { ctx, emitCalls } = makeCtx({ registerOut });
    const step = gopayPayStep();
    const res  = await step.run(ctx);

    assert.strictEqual(res.ok, true, 'must return ok:true on success');
    assert.deepStrictEqual(ctx.outputs['gopay-pay'], {
      phone:              '+628123456789',
      transaction_status: 'settlement',
    }, 'outputs must be written from Python result');

    // finalStatus 不应被设置（由 gopay-verify 设置 'plus_gopay'）
    assert.strictEqual(ctx.flags.finalStatus, undefined,
      'finalStatus must NOT be set by gopay-pay on success (deferred to gopay-verify)');

    // running 事件必须发出
    const runningEmit = emitCalls.find(e => e.status === 'running' && e.phase === 'gopay_pay');
    assert.ok(runningEmit, 'must emit running/gopay_pay');
  } finally {
    __setSpawnImpl(null);
  }
});

// --------------------------------------------------------------------------
// 测试 6：gopayPayStep fail (gopay_pay_fail)
//   → ctx.flags.finalStatus='gopay_pay_fail'，emit done，ok:false
// --------------------------------------------------------------------------
test('gopayPayStep: gopay_pay_fail → finalStatus set, emit done, ok:false', async () => {
  const fakeResult = {
    status: 'gopay_pay_fail',
    phone:  '+628123456789',
    detail: 'payment declined',
  };

  __setSpawnImpl(makeFakeSpawn([JSON.stringify(fakeResult)]));
  try {
    const registerOut = {
      account: { local: '8123456789', aid: 'aid-1', phone: '+628123456789' },
      proxy:   '',
      phone:   '+628123456789',
    };
    const { ctx, emitCalls } = makeCtx({ registerOut });
    const step = gopayPayStep();
    const res  = await step.run(ctx);

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'payment declined');
    assert.strictEqual(ctx.flags.finalStatus, 'gopay_pay_fail');
    assert.strictEqual(ctx.flags.finalReason, 'payment declined');

    const doneEmit = emitCalls.find(e => e.status === 'gopay_pay_fail' && e.phase === 'done');
    assert.ok(doneEmit, 'must emit gopay_pay_fail/done');
    assert.strictEqual(doneEmit.email,    'test@gopay.com');
    assert.strictEqual(doneEmit.progress, '1/1');
    assert.strictEqual(doneEmit.reason,   'payment declined');
  } finally {
    __setSpawnImpl(null);
  }
});

// --------------------------------------------------------------------------
// 测试 7：gopayPayStep fail (gopay_fraud)
//   → ctx.flags.finalStatus='gopay_fraud'，emit done，ok:false
// --------------------------------------------------------------------------
test('gopayPayStep: gopay_fraud → finalStatus=gopay_fraud, emit done, ok:false', async () => {
  const fakeResult = {
    status: 'gopay_fraud',
    phone:  '+628123456789',
    detail: 'FRAUD_DENY: transaction blocked by risk engine',
  };

  __setSpawnImpl(makeFakeSpawn([JSON.stringify(fakeResult)]));
  try {
    const registerOut = {
      account: { local: '8123456789', aid: 'aid-1', phone: '+628123456789' },
      proxy:   '',
      phone:   '+628123456789',
    };
    const { ctx, emitCalls } = makeCtx({ registerOut });
    const step = gopayPayStep();
    const res  = await step.run(ctx);

    assert.strictEqual(res.ok, false);
    assert.strictEqual(ctx.flags.finalStatus, 'gopay_fraud');
    assert.strictEqual(ctx.flags.finalReason, 'FRAUD_DENY: transaction blocked by risk engine');

    const doneEmit = emitCalls.find(e => e.status === 'gopay_fraud' && e.phase === 'done');
    assert.ok(doneEmit, 'must emit gopay_fraud/done');
    assert.strictEqual(doneEmit.reason, 'FRAUD_DENY: transaction blocked by risk engine');
  } finally {
    __setSpawnImpl(null);
  }
});

// --------------------------------------------------------------------------
// 测试 8：gopayPayStep fail (error)
//   → ctx.flags.finalStatus='error'，ok:false
// --------------------------------------------------------------------------
test('gopayPayStep: error → finalStatus=error, ok:false', async () => {
  const fakeResult = { status: 'error', detail: 'subprocess crashed' };

  __setSpawnImpl(makeFakeSpawn([JSON.stringify(fakeResult)]));
  try {
    const registerOut = {
      account: { local: '8111', aid: 'aid-2', phone: '+628111' },
      proxy:   '',
      phone:   '+628111',
    };
    const { ctx } = makeCtx({ registerOut });
    const step = gopayPayStep();
    const res  = await step.run(ctx);

    assert.strictEqual(res.ok, false);
    assert.strictEqual(ctx.flags.finalStatus, 'error');
    assert.strictEqual(ctx.flags.finalReason, 'subprocess crashed');
  } finally {
    __setSpawnImpl(null);
  }
});

// --------------------------------------------------------------------------
// 测试 9：gopayVerifyStep
//   → ctx.flags.finalStatus='plus_gopay'，emit running/verify_plus + plus_gopay/done，
//     done emit 携带 phone，ok:true
// --------------------------------------------------------------------------
test('gopayVerifyStep: sets finalStatus=plus_gopay, emits verify_plus+done with phone, ok:true', async () => {
  const payOut = {
    phone:              '+628123456789',
    transaction_status: 'settlement',
  };
  const { ctx, emitCalls } = makeCtx({ payOut });

  const step = gopayVerifyStep();
  const res  = await step.run(ctx);

  assert.strictEqual(res.ok, true, 'must return ok:true');
  assert.strictEqual(ctx.flags.finalStatus, 'plus_gopay', 'finalStatus must be plus_gopay');
  assert.strictEqual(ctx.flags.finalReason, '', 'finalReason must be empty string');

  // running/verify_plus 必须发出
  const runningEmit = emitCalls.find(e => e.status === 'running' && e.phase === 'verify_plus');
  assert.ok(runningEmit, 'must emit running/verify_plus');
  assert.strictEqual(runningEmit.email,    'test@gopay.com');
  assert.strictEqual(runningEmit.progress, '1/1');

  // plus_gopay/done 必须发出，携带 phone
  const doneEmit = emitCalls.find(e => e.status === 'plus_gopay' && e.phase === 'done');
  assert.ok(doneEmit, 'must emit plus_gopay/done');
  assert.strictEqual(doneEmit.email,    'test@gopay.com');
  assert.strictEqual(doneEmit.progress, '1/1');
  assert.strictEqual(doneEmit.phone,    '+628123456789', 'done emit must carry phone from gopay-pay outputs');
});

// --------------------------------------------------------------------------
// 测试 10：gopayVerifyStep — gopay-pay outputs 缺失时 phone 为 undefined（不崩溃）
// --------------------------------------------------------------------------
test('gopayVerifyStep: missing gopay-pay outputs → phone=undefined in emit, ok:true', async () => {
  // 不传 payOut
  const { ctx, emitCalls } = makeCtx();

  const step = gopayVerifyStep();
  const res  = await step.run(ctx);

  assert.strictEqual(res.ok, true);
  assert.strictEqual(ctx.flags.finalStatus, 'plus_gopay');

  const doneEmit = emitCalls.find(e => e.status === 'plus_gopay' && e.phase === 'done');
  assert.ok(doneEmit, 'must emit plus_gopay/done even without payOut');
  assert.strictEqual(doneEmit.phone, undefined, 'phone must be undefined if gopay-pay outputs missing');
});

// --------------------------------------------------------------------------
// 测试 11：shouldSkip — verify 永远不跳；register/pay 在 alreadyPlus 时跳过
// --------------------------------------------------------------------------
test('shouldSkip: gopay-verify always false; register+pay false when not alreadyPlus', () => {
  const reg  = gopayRegisterStep();
  const pay  = gopayPayStep();
  const ver  = gopayVerifyStep();

  // 非 alreadyPlus：三步均不跳
  assert.strictEqual(reg.shouldSkip({ flags: {} }), false, 'gopay-register shouldSkip must be false when not alreadyPlus');
  assert.strictEqual(pay.shouldSkip({ flags: {} }), false, 'gopay-pay shouldSkip must be false when not alreadyPlus');
  assert.strictEqual(ver.shouldSkip({ flags: {} }), false, 'gopay-verify shouldSkip must always be false');
});

// --------------------------------------------------------------------------
// 测试 11b：shouldSkip — register/pay 在 alreadyPlus=true 时跳过；verify 仍不跳
// --------------------------------------------------------------------------
test('shouldSkip: register+pay skip when alreadyPlus=true; verify still runs', () => {
  const reg  = gopayRegisterStep();
  const pay  = gopayPayStep();
  const ver  = gopayVerifyStep();

  const ctxWithPlus = { flags: { alreadyPlus: true } };

  assert.strictEqual(reg.shouldSkip(ctxWithPlus), true, 'gopay-register must skip when alreadyPlus');
  assert.strictEqual(pay.shouldSkip(ctxWithPlus), true, 'gopay-pay must skip when alreadyPlus');
  assert.strictEqual(ver.shouldSkip(ctxWithPlus), false, 'gopay-verify must NOT skip even when alreadyPlus');
});

// --------------------------------------------------------------------------
// 测试 11c：gopayVerifyStep with alreadyPlus=true
//   → finalStatus='already_plus', emit already_plus/done (no phone), ok:true
//   → NO running/verify_plus emitted
// --------------------------------------------------------------------------
test('gopayVerifyStep: alreadyPlus → finalStatus=already_plus, emit already_plus/done, ok:true', async () => {
  const { ctx, emitCalls } = makeCtx();
  ctx.flags.alreadyPlus = true;

  const step = gopayVerifyStep();
  const res  = await step.run(ctx);

  assert.strictEqual(res.ok, true, 'must return ok:true');
  assert.strictEqual(ctx.flags.finalStatus, 'already_plus', 'finalStatus must be already_plus');
  assert.strictEqual(ctx.flags.finalReason, '', 'finalReason must be empty string');

  // already_plus/done 必须发出
  const doneEmit = emitCalls.find(e => e.status === 'already_plus' && e.phase === 'done');
  assert.ok(doneEmit, 'must emit already_plus/done');
  assert.strictEqual(doneEmit.email,    'test@gopay.com');
  assert.strictEqual(doneEmit.progress, '1/1');

  // 不应发出 running/verify_plus（alreadyPlus 路径不走 verify）
  const runningEmit = emitCalls.find(e => e.status === 'running' && e.phase === 'verify_plus');
  assert.strictEqual(runningEmit, undefined, 'must NOT emit running/verify_plus when alreadyPlus');

  // 不应发出 plus_gopay
  const gopayDone = emitCalls.find(e => e.status === 'plus_gopay');
  assert.strictEqual(gopayDone, undefined, 'must NOT emit plus_gopay when alreadyPlus');
});

// --------------------------------------------------------------------------
// 测试 12：log lines — {log:'...'} 行触发 onLog（redact 验证）
//   中间插入 log 行，最终结果行是 JSON，验证 log 被转发、final 正确解析
// --------------------------------------------------------------------------
test('spawnGopay: {log:...} lines forwarded via onLog, final result parsed correctly', async () => {
  const logLines = [
    JSON.stringify({ log: '  [GoPay] Rented phone: +628111 OTP pin 123456' }),
    JSON.stringify({ log: '  [GoPay] Bearer eyJfakeTokenAAA' }),
    JSON.stringify({ status: 'registered', account: {}, proxy: '', phone: '+628111' }),
  ];

  const collectedLogs = [];
  __setSpawnImpl(makeFakeSpawn(logLines));
  try {
    const result = await spawnGopay(
      'fake_script.py',
      { mode: 'register' },
      { timeoutMs: 5000, onLog: (m) => collectedLogs.push(m) },
    );

    assert.strictEqual(result.status, 'registered', 'final result must be parsed');

    // log 行必须被转发
    assert.strictEqual(collectedLogs.length, 2, 'two log lines must be forwarded');

    // redact 验证：OTP 数字应被脱敏
    const otpLog = collectedLogs[0];
    assert.ok(otpLog.includes('[REDACTED_OTP]'), 'OTP digits must be redacted in log');

    // redact 验证：Bearer token 应被脱敏
    const tokenLog = collectedLogs[1];
    assert.ok(tokenLog.includes('[REDACTED_TOKEN]'), 'Bearer token must be redacted in log');
  } finally {
    __setSpawnImpl(null);
  }
});

// --------------------------------------------------------------------------
// 测试 13：register — 中间含 log 行，最终是 registered（完整流）
// --------------------------------------------------------------------------
test('gopayRegisterStep: log lines mixed with final result → outputs set, ok:true', async () => {
  const lines = [
    JSON.stringify({ log: '  [GoPay] Attempt 1/20, proxy: http://id' }),
    JSON.stringify({ log: '  [GoPay] Registration complete: +628999' }),
    JSON.stringify({
      status:  'registered',
      account: { local: '8999', aid: 'aid-99', phone: '+628999' },
      proxy:   'http://id.proxy:1234',
      phone:   '+628999',
    }),
  ];

  __setSpawnImpl(makeFakeSpawn(lines));
  try {
    const { ctx } = makeCtx();
    const step = gopayRegisterStep();
    const res  = await step.run(ctx);

    assert.strictEqual(res.ok, true);
    assert.strictEqual(ctx.outputs['gopay-register'].phone, '+628999');
  } finally {
    __setSpawnImpl(null);
  }
});
