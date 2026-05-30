// server/__tests__/protocol-phone-verify.test.js
// 迁移自 protocol-engine.js → server/pipeline/steps/paypal-pkce.js（Step 3 清理）
// 测试场景和断言与迁移前完全一致；只改 require 路径和 API 调用方式。
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');

function setupTestEnv(cfg) {
  // 清模块缓存（改为针对 paypal-pkce / phone-pool / zhusms-provider / server/db）
  for (const k of Object.keys(require.cache)) {
    if (k.includes('paypal-pkce') || k.includes('phone-pool') || k.includes('zhusms-provider') || k.includes('server/db')) {
      delete require.cache[k];
    }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-verify-'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(cfg));
  const origReadFile = fs.readFileSync;
  fs.readFileSync = function (p, enc) {
    if (p === path.join(ROOT, 'config.json')) return origReadFile(path.join(tmp, 'config.json'), enc);
    return origReadFile.apply(this, arguments);
  };
  return {
    cleanup() {
      fs.readFileSync = origReadFile;
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    },
  };
}

// fakeCtx：_finalizePhoneVerify(sessionState, account, ctx) 中 ctx.deps.resources.pyProc
// 用于 engineShim setter，无需 emitStatus 等（_finalizePhoneVerify 不读它们）。
function makeFakeCtx() {
  return {
    deps: {
      resources: { pyProc: null },
    },
  };
}

async function mkEngine(opts) {
  const pkce = require('../pipeline/steps/paypal-pkce');
  pkce.__setRunProtocolPhoneVerify(opts.runResult);
  if (opts.localQueue) {
    let i = 0;
    pkce.__setAcquirePhoneForProtocol(async (provider, cfg, email) => {
      if (provider !== 'local') throw new Error('expected local');
      const item = opts.localQueue[i++];
      if (!item) return {};
      return {
        phone: item.phone,
        smsConfig: { provider: 'local', url: 'http://test' },
        releaseFn: opts.releaseFn || (async () => {}),
      };
    });
  }
  if (opts.zhusmsQueue) {
    let i = 0;
    pkce.__setAcquirePhoneForProtocol(async (provider) => {
      if (provider !== 'zhusms') throw new Error('expected zhusms');
      const item = opts.zhusmsQueue[i++];
      if (!item) return {};
      return {
        phone: item.phone,
        smsConfig: { provider: 'zhusms', order_no: item.order, base_url: 'https://zhusms.com', card_key: 'k', cookie: 'c' },
        releaseFn: opts.cancelOrderFn || (async () => {}),
      };
    });
  }
  return pkce;
}

test('local 1 attempt 成功 → 返 {tokens}', async () => {
  const env = setupTestEnv({ phonePool: { enabled: true, provider: 'local', maxBindingsPerPhone: 3 } });
  try {
    let spawnCount = 0;
    let releaseCount = 0;
    const pkce = await mkEngine({
      runResult: async () => { spawnCount++; return { status: 'ok', tokens: { access_token: 'AT', refresh_token: 'RT', id_token: 'ID' } }; },
      localQueue: [{ phone: '+1111' }],
      releaseFn: async () => { releaseCount++; },
    });
    const r = await pkce._finalizePhoneVerify({}, { email: 'a@b.c' }, makeFakeCtx());
    assert.deepEqual(r, { tokens: { access_token: 'AT', refresh_token: 'RT', id_token: 'ID' } });
    assert.equal(spawnCount, 1);
    assert.equal(releaseCount, 0, 'success 不应 release');
  } finally { env.cleanup(); }
});

test('local 1 拒 + 2 成功 → 返 {tokens}', async () => {
  const env = setupTestEnv({ phonePool: { enabled: true, provider: 'local', maxBindingsPerPhone: 3 } });
  try {
    let spawnCount = 0;
    let releaseCount = 0;
    const responses = [
      { status: 'phone-rejected', detail: 'HTTP 400' },
      { status: 'ok', tokens: { access_token: 'AT', refresh_token: 'RT', id_token: 'ID' } },
    ];
    const pkce = await mkEngine({
      runResult: async () => { return responses[spawnCount++]; },
      localQueue: [{ phone: '+1' }, { phone: '+2' }],
      releaseFn: async () => { releaseCount++; },
    });
    const r = await pkce._finalizePhoneVerify({}, { email: 'a@b.c' }, makeFakeCtx());
    assert.ok(r.tokens);
    assert.equal(spawnCount, 2);
    assert.equal(releaseCount, 1, '只有第一次 phone-rejected 才 release');
  } finally { env.cleanup(); }
});

test('local 3 attempt 全拒 → phoneVerifyFail=lastReason（v2.44.1 lastReason 兜底）', async () => {
  const env = setupTestEnv({ phonePool: { enabled: true, provider: 'local', maxBindingsPerPhone: 3 } });
  try {
    let spawnCount = 0;
    let releaseCount = 0;
    const pkce = await mkEngine({
      runResult: async () => { spawnCount++; return { status: 'phone-rejected', detail: 'rej' }; },
      localQueue: [{ phone: '+1' }, { phone: '+2' }, { phone: '+3' }],
      releaseFn: async () => { releaseCount++; },
    });
    const r = await pkce._finalizePhoneVerify({}, { email: 'a@b.c' }, makeFakeCtx());
    assert.deepEqual(r, { phoneVerifyFail: 'phone-rejected-by-openai' });
    assert.equal(spawnCount, 3);
    assert.equal(releaseCount, 3);
  } finally { env.cleanup(); }
});

test('池空 → phonePoolEmpty', async () => {
  const env = setupTestEnv({ phonePool: { enabled: true, provider: 'local', maxBindingsPerPhone: 3 } });
  try {
    let spawnCount = 0;
    const pkce = await mkEngine({
      runResult: async () => { spawnCount++; return { status: 'ok' }; },
      localQueue: [],  // 拿不到号
    });
    const r = await pkce._finalizePhoneVerify({}, { email: 'a@b.c' }, makeFakeCtx());
    assert.deepEqual(r, { phonePoolEmpty: true });
    assert.equal(spawnCount, 0, '没拿到号不应 spawn');
  } finally { env.cleanup(); }
});

test('sms-timeout 换号 retry 跑满 MAX_ATTEMPTS（v2.49）', async () => {
  const env = setupTestEnv({ phonePool: { enabled: true, provider: 'local', maxBindingsPerPhone: 3 } });
  try {
    let spawnCount = 0;
    let releaseCount = 0;
    const pkce = await mkEngine({
      runResult: async () => { spawnCount++; return { status: 'sms-timeout' }; },
      localQueue: [{ phone: '+1' }, { phone: '+2' }, { phone: '+3' }],
      releaseFn: async () => { releaseCount++; },
    });
    const r = await pkce._finalizePhoneVerify({}, { email: 'a@b.c' }, makeFakeCtx());
    assert.deepEqual(r, { phoneVerifyFail: 'sms-timeout' });
    assert.equal(spawnCount, 3, 'v2.49: sms-timeout 每 attempt 都换号 retry，跑满 3 次');
    assert.equal(releaseCount, 3, '每次 attempt 都 release');
  } finally { env.cleanup(); }
});

test('validate-error 单次 break → release', async () => {
  const env = setupTestEnv({ phonePool: { enabled: true, provider: 'local', maxBindingsPerPhone: 3 } });
  try {
    let spawnCount = 0;
    let releaseCount = 0;
    const pkce = await mkEngine({
      runResult: async () => { spawnCount++; return { status: 'validate-error', detail: 'HTTP 400' }; },
      localQueue: [{ phone: '+1' }, { phone: '+2' }],
      releaseFn: async () => { releaseCount++; },
    });
    const r = await pkce._finalizePhoneVerify({}, { email: 'a@b.c' }, makeFakeCtx());
    assert.deepEqual(r, { phoneVerifyFail: 'validate-error' });
    assert.equal(spawnCount, 1);
    assert.equal(releaseCount, 1);
  } finally { env.cleanup(); }
});

test('post-validate-error 单次 break → 不 release (binding 保留)', async () => {
  const env = setupTestEnv({ phonePool: { enabled: true, provider: 'local', maxBindingsPerPhone: 3 } });
  try {
    let spawnCount = 0;
    let releaseCount = 0;
    const pkce = await mkEngine({
      runResult: async () => { spawnCount++; return { status: 'post-validate-error', detail: 'token exchange empty' }; },
      localQueue: [{ phone: '+1' }, { phone: '+2' }],
      releaseFn: async () => { releaseCount++; },
    });
    const r = await pkce._finalizePhoneVerify({}, { email: 'a@b.c' }, makeFakeCtx());
    assert.deepEqual(r, { phoneVerifyFail: 'post-validate-error' });
    assert.equal(spawnCount, 1);
    assert.equal(releaseCount, 0, '*** 关键: post-validate-error 不 release，binding 保留 ***');
  } finally { env.cleanup(); }
});

test('zhusms 1 attempt 成功', async () => {
  const env = setupTestEnv({ phonePool: { enabled: true, provider: 'zhusms', maxBindingsPerPhone: 3, zhusms: { cardKey: 'ZS-X' } } });
  try {
    let spawnCount = 0;
    let cancelCount = 0;
    const pkce = await mkEngine({
      runResult: async () => { spawnCount++; return { status: 'ok', tokens: { access_token: 'AT', refresh_token: 'RT', id_token: 'ID' } }; },
      zhusmsQueue: [{ phone: '+9', order: 'o1' }],
      cancelOrderFn: async () => { cancelCount++; },
    });
    const r = await pkce._finalizePhoneVerify({}, { email: 'a@b.c' }, makeFakeCtx());
    assert.ok(r.tokens);
    assert.equal(spawnCount, 1);
    assert.equal(cancelCount, 0);
  } finally { env.cleanup(); }
});

test('zhusms 1 拒 + 2 成功 → cancelOrder ×1', async () => {
  const env = setupTestEnv({ phonePool: { enabled: true, provider: 'zhusms', maxBindingsPerPhone: 3, zhusms: { cardKey: 'ZS-X' } } });
  try {
    let spawnCount = 0;
    let cancelCount = 0;
    const responses = [
      { status: 'phone-rejected', detail: 'HTTP 400' },
      { status: 'ok', tokens: { access_token: 'AT', refresh_token: 'RT', id_token: 'ID' } },
    ];
    const pkce = await mkEngine({
      runResult: async () => responses[spawnCount++],
      zhusmsQueue: [{ phone: '+1', order: 'o1' }, { phone: '+2', order: 'o2' }],
      cancelOrderFn: async () => { cancelCount++; },
    });
    const r = await pkce._finalizePhoneVerify({}, { email: 'a@b.c' }, makeFakeCtx());
    assert.ok(r.tokens);
    assert.equal(spawnCount, 2);
    assert.equal(cancelCount, 1);
  } finally { env.cleanup(); }
});

test('pool-disabled → phoneVerifyFail=pool-disabled，不调任何 acquire/spawn', async () => {
  const env = setupTestEnv({ phonePool: { enabled: false, provider: 'local' } });
  try {
    let spawnCount = 0;
    const pkce = await mkEngine({
      runResult: async () => { spawnCount++; return { status: 'ok' }; },
      localQueue: [{ phone: '+1' }],
    });
    const r = await pkce._finalizePhoneVerify({}, { email: 'a@b.c' }, makeFakeCtx());
    assert.deepEqual(r, { phoneVerifyFail: 'pool-disabled' });
    assert.equal(spawnCount, 0);
  } finally { env.cleanup(); }
});
