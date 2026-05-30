// __tests__/protocol-engine-add-phone-retry.test.js
// 迁移自 protocol-engine.js → server/pipeline/steps/paypal-pkce.js（Step 3 清理）
// 测试 rate-limited / fraud-blocked / voip-blocked 换号 retry 逻辑。
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

let _origCfg = null;
function setupCfg() {
  try { _origCfg = fs.readFileSync(CONFIG_PATH, 'utf-8'); } catch { _origCfg = null; }
  const merged = _origCfg ? JSON.parse(_origCfg) : {};
  merged.phonePool = Object.assign({}, merged.phonePool, {
    enabled: true,
    provider: 'smscloud',
    smscloud: { apiKey: 'k', baseUrl: 'b', serviceCode: 'tg', countryCode: 187 },
  });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
}
function restoreCfg() {
  if (_origCfg !== null) fs.writeFileSync(CONFIG_PATH, _origCfg);
  else try { fs.unlinkSync(CONFIG_PATH); } catch {}
}

// fakeCtx：_finalizePhoneVerify(sessionState, account, ctx) 中 ctx.deps.resources.pyProc 用于 engineShim。
function makeFakeCtx() {
  return { deps: { resources: { pyProc: null } } };
}

// 从 paypal-pkce 模块中加载接缝
function getPkceMod() {
  delete require.cache[require.resolve('../server/pipeline/steps/paypal-pkce')];
  return require('../server/pipeline/steps/paypal-pkce');
}

test('attempt 1 rate-limited → attempt 2 success（换号 retry 走通）', async () => {
  setupCfg();
  try {
    const pkce = getPkceMod();

    const acquired = [];
    pkce.__setAcquirePhoneForProtocol(async (provider, cfg, email, proxyUrl, excludePhones) => {
      acquired.push([...excludePhones]);
      const i = acquired.length;
      return { phone: ['+A','+B','+C'][i-1], smsConfig: {}, releaseFn: async () => {} };
    });

    const orig = pkce.__runProtocolPhoneVerify;
    let call = 0;
    pkce.__setRunProtocolPhoneVerify(async () => {
      call++;
      if (call === 1) return { status: 'rate-limited', detail: 'rate_limit_exceeded' };
      return { status: 'ok', tokens: { access_token: 'tok' } };
    });

    try {
      const r = await pkce._finalizePhoneVerify({}, { email: 'a@b' }, makeFakeCtx());
      assert.ok(r.tokens, 'should return tokens on attempt 2');
      assert.deepStrictEqual(acquired[0], [], 'attempt 1 excludePhones empty');
      assert.deepStrictEqual(acquired[1], ['+A'], 'attempt 2 excludes +A');
    } finally {
      pkce.__setRunProtocolPhoneVerify(orig);
      pkce.__setAcquirePhoneForProtocol(null); // 重置为原始实现
    }
  } finally { restoreCfg(); }
});

test('3 次全 rate-limited → phoneVerifyFail=rate-limited（lastReason 兜底）', async () => {
  setupCfg();
  try {
    const pkce = getPkceMod();

    let i = 0;
    pkce.__setAcquirePhoneForProtocol(async () => ({ phone: '+P' + (++i), smsConfig: {}, releaseFn: async () => {} }));

    const orig = pkce.__runProtocolPhoneVerify;
    pkce.__setRunProtocolPhoneVerify(async () => ({ status: 'rate-limited', detail: 'x' }));
    try {
      const r = await pkce._finalizePhoneVerify({}, { email: 'a@b' }, makeFakeCtx());
      assert.strictEqual(r.phoneVerifyFail, 'rate-limited');
      assert.strictEqual(i, 3, 'should try 3 phones');
    } finally {
      pkce.__setRunProtocolPhoneVerify(orig);
      pkce.__setAcquirePhoneForProtocol(null);
    }
  } finally { restoreCfg(); }
});

test('fraud-blocked / voip-blocked 同样 retry', async () => {
  setupCfg();
  try {
    const pkce = getPkceMod();

    let i = 0;
    pkce.__setAcquirePhoneForProtocol(async () => ({ phone: '+Q' + (++i), smsConfig: {}, releaseFn: async () => {} }));

    const orig = pkce.__runProtocolPhoneVerify;
    const seq = [
      { status: 'fraud-blocked' },
      { status: 'voip-blocked' },
      { status: 'ok', tokens: { access_token: 'tok' } },
    ];
    pkce.__setRunProtocolPhoneVerify(async () => seq.shift());
    try {
      const r = await pkce._finalizePhoneVerify({}, { email: 'a@b' }, makeFakeCtx());
      assert.ok(r.tokens);
      assert.strictEqual(i, 3);
    } finally {
      pkce.__setRunProtocolPhoneVerify(orig);
      pkce.__setAcquirePhoneForProtocol(null);
    }
  } finally { restoreCfg(); }
});
