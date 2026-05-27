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

test('attempt 1 rate-limited → attempt 2 success（换号 retry 走通）', async () => {
  setupCfg();
  try {
    delete require.cache[require.resolve('../protocol-engine')];
    const { ProtocolEngine } = require('../protocol-engine');
    const engine = new ProtocolEngine();

    const acquired = [];
    engine._acquirePhoneForProtocol = async (provider, cfg, email, proxyUrl, excludePhones) => {
      acquired.push([...excludePhones]);
      const i = acquired.length;
      return { phone: ['+A','+B','+C'][i-1], smsConfig: {}, releaseFn: async () => {} };
    };

    const protoMod = require('../protocol-engine');
    const orig = protoMod.__runProtocolPhoneVerify;
    let call = 0;
    protoMod.__setRunProtocolPhoneVerify(async () => {
      call++;
      if (call === 1) return { status: 'rate-limited', detail: 'rate_limit_exceeded' };
      return { status: 'ok', tokens: { access_token: 'tok' } };
    });

    try {
      const r = await engine._finalizePhoneVerify({}, { email: 'a@b' });
      assert.ok(r.tokens, 'should return tokens on attempt 2');
      assert.deepStrictEqual(acquired[0], [], 'attempt 1 excludePhones empty');
      assert.deepStrictEqual(acquired[1], ['+A'], 'attempt 2 excludes +A');
    } finally { protoMod.__setRunProtocolPhoneVerify(orig); }
  } finally { restoreCfg(); }
});

test('3 次全 rate-limited → phoneVerifyFail=rate-limited（lastReason 兜底）', async () => {
  setupCfg();
  try {
    delete require.cache[require.resolve('../protocol-engine')];
    const { ProtocolEngine } = require('../protocol-engine');
    const engine = new ProtocolEngine();
    let i = 0;
    engine._acquirePhoneForProtocol = async () => ({ phone: '+P' + (++i), smsConfig: {}, releaseFn: async () => {} });
    const protoMod = require('../protocol-engine');
    const orig = protoMod.__runProtocolPhoneVerify;
    protoMod.__setRunProtocolPhoneVerify(async () => ({ status: 'rate-limited', detail: 'x' }));
    try {
      const r = await engine._finalizePhoneVerify({}, { email: 'a@b' });
      assert.strictEqual(r.phoneVerifyFail, 'rate-limited');
      assert.strictEqual(i, 3, 'should try 3 phones');
    } finally { protoMod.__setRunProtocolPhoneVerify(orig); }
  } finally { restoreCfg(); }
});

test('fraud-blocked / voip-blocked 同样 retry', async () => {
  setupCfg();
  try {
    delete require.cache[require.resolve('../protocol-engine')];
    const { ProtocolEngine } = require('../protocol-engine');
    const engine = new ProtocolEngine();
    let i = 0;
    engine._acquirePhoneForProtocol = async () => ({ phone: '+Q' + (++i), smsConfig: {}, releaseFn: async () => {} });
    const protoMod = require('../protocol-engine');
    const orig = protoMod.__runProtocolPhoneVerify;
    const seq = [
      { status: 'fraud-blocked' },
      { status: 'voip-blocked' },
      { status: 'ok', tokens: { access_token: 'tok' } },
    ];
    protoMod.__setRunProtocolPhoneVerify(async () => seq.shift());
    try {
      const r = await engine._finalizePhoneVerify({}, { email: 'a@b' });
      assert.ok(r.tokens);
      assert.strictEqual(i, 3);
    } finally { protoMod.__setRunProtocolPhoneVerify(orig); }
  } finally { restoreCfg(); }
});
