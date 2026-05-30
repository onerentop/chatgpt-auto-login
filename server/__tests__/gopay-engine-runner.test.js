// 端到端：GoPayEngine.start([email]) 批量驱动 login→gopay 管线。
// 接缝：engine._injectDeps.__runProtocolRegister 替换协议登录；__setSpawnImpl 替换 gopay Python。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gopay-batch-test-'));
const fakeDb = path.join(tmpDir, 'data.db');
const realPath = require('path');
const origJoin = realPath.join;
realPath.join = function (...args) {
  if (args[args.length - 1] === 'data.db') return fakeDb;
  return origJoin.apply(this, args);
};
const { initDB, accountsDB, statusDB, save } = require('../db');
const { __setSpawnImpl } = require('../../server/pipeline/steps/_gopay-spawn');
const engine = require('../../server/gopay-engine');
realPath.join = origJoin;

function collectStatuses() {
  const events = [];
  const h = (d) => events.push(d);
  engine.on('account-status', h);
  return { events, stop: () => engine.off('account-status', h) };
}
async function waitIdle(timeoutMs = 5000) {
  const t0 = Date.now();
  while (engine.state.running && Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, 20));
  }
}

test('setup: init db + seed account', async () => {
  await initDB();
  accountsDB.add({ email: 'g1@x.com', password: 'pw', totp_secret: '', client_id: '', refresh_token: '' });
  await save.flush();
});

test('start([email]): login→gopay success → account-status plus_gopay + account_status 写入', async () => {
  engine._injectDeps = {
    __runProtocolRegister: async () => ({
      status: 'success', accessToken: 'at-xyz',
      session: { account: { planType: 'free' } },
    }),
  };
  let call = 0;
  __setSpawnImpl((script, input) => {
    call++;
    if (input.mode === 'register') return Promise.resolve({ status: 'registered', account: { local: '1', aid: 'a', phone: '+62x' }, proxy: 'http://p', phone: '+62x' });
    if (input.mode === 'pay') return Promise.resolve({ status: 'success', phone: '+62x', transaction_status: 'settlement' });
    return Promise.resolve({ status: 'error', detail: 'unexpected' });
  });

  const col = collectStatuses();
  await engine.start(0, ['g1@x.com']);
  await waitIdle();
  col.stop();
  __setSpawnImpl(null);
  engine._injectDeps = null;

  const finals = col.events.filter(e => e.status === 'plus_gopay');
  assert.ok(finals.length >= 1, 'emitted plus_gopay account-status');
  await save.flush();
  const row = statusDB.get('g1@x.com');
  assert.strictEqual(row.status, 'plus_gopay');
});

test('start([email]): planType=plus → already_plus, gopay 步跳过', async () => {
  engine._injectDeps = {
    __runProtocolRegister: async () => ({
      status: 'success', accessToken: 'at-plus',
      session: { account: { planType: 'plus' } },
    }),
  };
  let spawned = false;
  __setSpawnImpl(() => { spawned = true; return Promise.resolve({ status: 'registered', account: {}, proxy: '' }); });

  const col = collectStatuses();
  await engine.start(0, ['g1@x.com']);
  await waitIdle();
  col.stop();
  __setSpawnImpl(null);
  engine._injectDeps = null;

  assert.strictEqual(spawned, false, 'already-Plus → gopay register/pay 未 spawn');
  assert.ok(col.events.some(e => e.status === 'already_plus'), 'emitted already_plus');
});

test('start([email]): login 失败 → error, gopay 步不跑', async () => {
  engine._injectDeps = {
    __runProtocolRegister: async () => ({ status: 'error', error: 'bad creds' }),
  };
  let spawned = false;
  __setSpawnImpl(() => { spawned = true; return Promise.resolve({ status: 'registered' }); });

  const col = collectStatuses();
  await engine.start(0, ['g1@x.com']);
  await waitIdle();
  col.stop();
  __setSpawnImpl(null);
  engine._injectDeps = null;

  assert.strictEqual(spawned, false, 'login 失败 → gopay 未 spawn');
  assert.ok(col.events.some(e => e.status === 'error'), 'emitted error');
});

test('start with no matching emails → throws No accounts', async () => {
  await assert.rejects(() => engine.start(0, ['nobody@x.com']), /No accounts/);
});
