// v2.45.0 — protocol-engine smscloud branch 接 cache + saturate 按 meta 分流 集成测试
// SC1：两账号连续 add-phone 应复用同一 cache 号，takeOrder 仅 1 次。
// SC2：rate-limited 时 cache 标 rejected + deferred-cancel queue 含该 orderNo。

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
    maxBindingsPerPhone: 3,
    smscloud: { apiKey: 'k', baseUrl: 'b', serviceCode: 'tg', countryCode: 187 },
  });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
}
function restoreCfg() {
  if (_origCfg !== null) fs.writeFileSync(CONFIG_PATH, _origCfg);
  else try { fs.unlinkSync(CONFIG_PATH); } catch {}
}

async function freshEngine() {
  delete require.cache[require.resolve('../protocol-engine')];
  delete require.cache[require.resolve('../server/smscloud-pool')];
  delete require.cache[require.resolve('../server/db')];
  const dbMod = require('../server/db');
  await dbMod.initDB();
  const rawDb = dbMod.getRawDb();
  rawDb.run('DELETE FROM smscloud_phone_cache');
  rawDb.run('DELETE FROM phone_bindings');
  const { ProtocolEngine } = require('../protocol-engine');
  return { engine: new ProtocolEngine(), rawDb, protoMod: require('../protocol-engine') };
}

test('SC1 两账号连续 add-phone：第 2 个复用 cache 号，takeOrder 只调一次', async () => {
  setupCfg();
  try {
    const { engine, rawDb, protoMod } = await freshEngine();

    let takeOrderCalls = 0;
    delete require.cache[require.resolve('../server/smscloud-provider')];
    const smscloud = require('../server/smscloud-provider');
    const origTake = smscloud.takeOrder;
    const origResend = smscloud.resendSms;
    let resendCalls = [];
    smscloud.takeOrder = async () => {
      takeOrderCalls++;
      return { order_no: 'OO1', phone: '+15550001111', raw: {} };
    };
    smscloud.resendSms = async (orderNo) => { resendCalls.push(orderNo); };

    const orig = protoMod.__runProtocolPhoneVerify;
    protoMod.__setRunProtocolPhoneVerify(async () => ({ status: 'ok', tokens: { access_token: 'tok' } }));

    try {
      const r1 = await engine._finalizePhoneVerify({}, { email: 'u1@x.com' });
      assert.ok(r1.tokens, 'account 1 success');
      const r2 = await engine._finalizePhoneVerify({}, { email: 'u2@x.com' });
      assert.ok(r2.tokens, 'account 2 success');
      assert.strictEqual(takeOrderCalls, 1, 'takeOrder only called once (cache reused)');
      const row = rawDb.exec("SELECT bindings_used FROM smscloud_phone_cache WHERE order_no='OO1'");
      assert.strictEqual(row[0].values[0][0], 2, 'bindings_used = 2');
      assert.deepStrictEqual(resendCalls, ['OO1'], 'resendSms called once for account 2 reuse');
      try { await require('../server/db').save?.flush?.(); } catch {}
    } finally {
      smscloud.takeOrder = origTake;
      smscloud.resendSms = origResend;
      protoMod.__setRunProtocolPhoneVerify(orig);
    }
  } finally { restoreCfg(); }
});

test('SC2 rate-limited → cache entry 标 rejected + deferred-cancel queue 含该 orderNo', async () => {
  setupCfg();
  try {
    const { engine, rawDb, protoMod } = await freshEngine();

    delete require.cache[require.resolve('../server/smscloud-provider')];
    const smscloud = require('../server/smscloud-provider');
    const origTake = smscloud.takeOrder;
    let takeCalls = 0;
    smscloud.takeOrder = async () => {
      takeCalls++;
      return { order_no: 'OO' + takeCalls, phone: '+1555' + String(takeCalls).padStart(7, '0'), raw: {} };
    };

    delete require.cache[require.resolve('../server/smscloud-deferred-cancel')];
    const deferred = require('../server/smscloud-deferred-cancel');

    const orig = protoMod.__runProtocolPhoneVerify;
    let i = 0;
    protoMod.__setRunProtocolPhoneVerify(async () => {
      i++;
      if (i === 1) return { status: 'rate-limited', detail: 'rate_limit_exceeded' };
      return { status: 'ok', tokens: { access_token: 'tok' } };
    });

    try {
      const r = await engine._finalizePhoneVerify({}, { email: 'u3@x.com' });
      assert.ok(r.tokens, 'attempt 2 success');
      const rejected = rawDb.exec("SELECT order_no FROM smscloud_phone_cache WHERE status='rejected'");
      assert.deepStrictEqual(rejected[0].values.map(v => v[0]), ['OO1']);
      assert.ok(deferred._queueForTest().has('OO1'), 'OO1 enqueued for deferred cancel');
      assert.strictEqual(takeCalls, 2, 'each attempt takeOrder once');
      try { await require('../server/db').save?.flush?.(); } catch {}
    } finally {
      smscloud.takeOrder = origTake;
      protoMod.__setRunProtocolPhoneVerify(orig);
    }
  } finally { restoreCfg(); }
});

test('SC3 resend 失败 → cache entry markRejected + retry 拿新号', async () => {
  setupCfg();
  try {
    const { engine, rawDb, protoMod } = await freshEngine();
    delete require.cache[require.resolve('../server/smscloud-provider')];
    const smscloud = require('../server/smscloud-provider');
    const origTake = smscloud.takeOrder, origResend = smscloud.resendSms;
    let takeCalls = 0;
    smscloud.takeOrder = async () => {
      takeCalls++;
      return { order_no: 'OO' + takeCalls, phone: '+1555' + String(takeCalls).padStart(7, '0'), raw: {} };
    };
    let resendCalls = 0;
    smscloud.resendSms = async () => { resendCalls++; throw new Error('cannot get another sms'); };

    const orig = protoMod.__runProtocolPhoneVerify;
    protoMod.__setRunProtocolPhoneVerify(async () => ({ status: 'ok', tokens: { access_token: 'tok' } }));

    try {
      // 账号 1 新取号 OO1
      const r1 = await engine._finalizePhoneVerify({}, { email: 'u1@x.com' });
      assert.ok(r1.tokens);
      assert.strictEqual(takeCalls, 1);
      assert.strictEqual(resendCalls, 0, '新取号不调 resend');
      // 账号 2 复用 OO1 → resend 失败 → markRejected → attempt 2 拿新号 OO2
      const r2 = await engine._finalizePhoneVerify({}, { email: 'u2@x.com' });
      assert.ok(r2.tokens);
      assert.strictEqual(takeCalls, 2, '复用失败后拿新号');
      assert.strictEqual(resendCalls, 1, 'resend 调一次（仅复用 attempt）');
      const rejected = rawDb.exec("SELECT order_no FROM smscloud_phone_cache WHERE status='rejected'");
      assert.deepStrictEqual(rejected[0].values.map(v => v[0]), ['OO1'], 'OO1 status=rejected');
      try { await require('../server/db').save?.flush?.(); } catch {}
    } finally {
      smscloud.takeOrder = origTake;
      smscloud.resendSms = origResend;
      protoMod.__setRunProtocolPhoneVerify(orig);
    }
  } finally { restoreCfg(); }
});

test('SC4 cache 有 2 entry，第 1 个 resend 失败 → 第 2 个 resend 成功 → 不调 takeOrder', async () => {
  setupCfg();
  try {
    const { engine, rawDb, protoMod } = await freshEngine();
    delete require.cache[require.resolve('../server/smscloud-provider')];
    const smscloud = require('../server/smscloud-provider');
    const origTake = smscloud.takeOrder, origResend = smscloud.resendSms;

    // 预先注入 2 个 active cache entry（不同 orderNo / 不同 phone，takenAtMs 区分）
    const now = Date.now();
    rawDb.run("INSERT INTO smscloud_phone_cache (order_no, phone, api_key, base_url, taken_at_ms, bindings_used, status) VALUES ('A1', '+1AAA', 'k', 'b', ?, 1, 'active')", [now - 5000]);
    rawDb.run("INSERT INTO smscloud_phone_cache (order_no, phone, api_key, base_url, taken_at_ms, bindings_used, status) VALUES ('A2', '+1BBB', 'k', 'b', ?, 1, 'active')", [now - 3000]);

    let takeCalls = 0;
    smscloud.takeOrder = async () => { takeCalls++; throw new Error('should NOT be called'); };

    let resendCalls = [];
    smscloud.resendSms = async (orderNo) => {
      resendCalls.push(orderNo);
      if (orderNo === 'A1') throw new Error('cannot get another sms');
      // A2 resend 成功
    };

    const orig = protoMod.__runProtocolPhoneVerify;
    protoMod.__setRunProtocolPhoneVerify(async () => ({ status: 'ok', tokens: { access_token: 'tok' } }));

    try {
      const r = await engine._finalizePhoneVerify({}, { email: 'sc4@x.com' });
      assert.ok(r.tokens, 'tokens 拿到');
      assert.strictEqual(takeCalls, 0, '内层循环消化 cache，不触发 takeOrder');
      assert.deepStrictEqual(resendCalls, ['A1', 'A2'], '两次 resend：A1 失败 → A2 成功');
      // A1 status='rejected'
      const a1Row = rawDb.exec("SELECT status FROM smscloud_phone_cache WHERE order_no='A1'");
      assert.strictEqual(a1Row[0].values[0][0], 'rejected');
      // A2 status='active'，bindings_used=2 (1 + 本次)
      const a2Row = rawDb.exec("SELECT status, bindings_used FROM smscloud_phone_cache WHERE order_no='A2'");
      assert.strictEqual(a2Row[0].values[0][0], 'active');
      assert.strictEqual(a2Row[0].values[0][1], 2);
      try { await require('../server/db').save?.flush?.(); } catch {}
    } finally {
      smscloud.takeOrder = origTake;
      smscloud.resendSms = origResend;
      protoMod.__setRunProtocolPhoneVerify(orig);
    }
  } finally { restoreCfg(); }
});

test('SC5 attempt 1/2/3 跨 countryCode list 切换', async () => {
  setupCfg();
  try {
    // 覆盖 cfg 用 list
    const fs2 = require('fs');
    const cfg = JSON.parse(fs2.readFileSync(CONFIG_PATH, 'utf-8'));
    cfg.phonePool.smscloud.countryCode = [7, 187, 44];
    fs2.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));

    const { engine, rawDb, protoMod } = await freshEngine();
    delete require.cache[require.resolve('../server/smscloud-provider')];
    const smscloud = require('../server/smscloud-provider');
    const origTake = smscloud.takeOrder, origResend = smscloud.resendSms;
    const takeCountries = [];
    smscloud.takeOrder = async (apiKey, baseUrl, serviceCode, countryCode) => {
      takeCountries.push(countryCode);
      return { order_no: 'OO' + takeCountries.length, phone: '+1cc' + countryCode + 'p' + takeCountries.length, raw: {} };
    };
    smscloud.resendSms = async () => {};

    const orig = protoMod.__runProtocolPhoneVerify;
    let i = 0;
    protoMod.__setRunProtocolPhoneVerify(async () => {
      i++;
      if (i < 3) return { status: 'fraud-blocked', detail: 'fraud_guard' };
      return { status: 'ok', tokens: { access_token: 'tok' } };
    });
    try {
      const r = await engine._finalizePhoneVerify({}, { email: 'sc5@x.com' });
      assert.ok(r.tokens, 'attempt 3 success');
      assert.deepStrictEqual(takeCountries, [7, 187, 44], 'attempt 跨 country fallback');
      try { await require('../server/db').save?.flush?.(); } catch {}
    } finally {
      smscloud.takeOrder = origTake;
      smscloud.resendSms = origResend;
      protoMod.__setRunProtocolPhoneVerify(orig);
    }
  } finally { restoreCfg(); }
});
