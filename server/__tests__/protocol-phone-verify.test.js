// server/__tests__/protocol-phone-verify.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');

function setupTestEnv(cfg) {
  // 清模块缓存
  for (const k of Object.keys(require.cache)) {
    if (k.includes('protocol-engine') || k.includes('phone-pool') || k.includes('zhusms-provider') || k.includes('server/db')) {
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

async function mkEngine(opts) {
  const { ProtocolEngine, __setRunProtocolPhoneVerify } = require('../../protocol-engine');
  __setRunProtocolPhoneVerify(opts.runResult);
  const engine = new ProtocolEngine();
  // mock phone-pool acquirePhone / releaseBinding
  if (opts.localQueue) {
    let i = 0;
    engine._acquirePhoneForProtocol = async (provider, cfg, email) => {
      if (provider !== 'local') throw new Error('expected local');
      const item = opts.localQueue[i++];
      if (!item) return {};
      return {
        phone: item.phone,
        smsConfig: { provider: 'local', url: 'http://test' },
        releaseFn: opts.releaseFn || (async () => {}),
      };
    };
  }
  return engine;
}

test('local 1 attempt 成功 → 返 {tokens}', async () => {
  const env = setupTestEnv({ phonePool: { enabled: true, provider: 'local', maxBindingsPerPhone: 3 } });
  try {
    let spawnCount = 0;
    let releaseCount = 0;
    const engine = await mkEngine({
      runResult: async () => { spawnCount++; return { status: 'ok', tokens: { access_token: 'AT', refresh_token: 'RT', id_token: 'ID' } }; },
      localQueue: [{ phone: '+1111' }],
      releaseFn: async () => { releaseCount++; },
    });
    const r = await engine._finalizePhoneVerify({}, { email: 'a@b.c' });
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
    const engine = await mkEngine({
      runResult: async () => { return responses[spawnCount++]; },
      localQueue: [{ phone: '+1' }, { phone: '+2' }],
      releaseFn: async () => { releaseCount++; },
    });
    const r = await engine._finalizePhoneVerify({}, { email: 'a@b.c' });
    assert.ok(r.tokens);
    assert.equal(spawnCount, 2);
    assert.equal(releaseCount, 1, '只有第一次 phone-rejected 才 release');
  } finally { env.cleanup(); }
});

test('local 3 attempt 全拒 → all-phones-rejected', async () => {
  const env = setupTestEnv({ phonePool: { enabled: true, provider: 'local', maxBindingsPerPhone: 3 } });
  try {
    let spawnCount = 0;
    let releaseCount = 0;
    const engine = await mkEngine({
      runResult: async () => { spawnCount++; return { status: 'phone-rejected', detail: 'rej' }; },
      localQueue: [{ phone: '+1' }, { phone: '+2' }, { phone: '+3' }],
      releaseFn: async () => { releaseCount++; },
    });
    const r = await engine._finalizePhoneVerify({}, { email: 'a@b.c' });
    assert.deepEqual(r, { phoneVerifyFail: 'all-phones-rejected' });
    assert.equal(spawnCount, 3);
    assert.equal(releaseCount, 3);
  } finally { env.cleanup(); }
});
