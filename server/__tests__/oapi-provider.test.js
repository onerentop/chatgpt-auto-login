const test = require('node:test');
const assert = require('node:assert');

function mockFetch(handler) {
  const orig = global.fetch;
  global.fetch = async (url, opts) => handler(url, opts);
  return () => { global.fetch = orig; };
}

test('O1 takeOrder: X-API-Key=apiKey, body.code=cdk', async () => {
  const restore = mockFetch(async (url, opts) => {
    assert.ok(url.includes('action=open_get_phone'));
    assert.strictEqual(opts.headers['X-API-Key'], 'sk-test-apikey');
    assert.strictEqual(JSON.parse(opts.body).code, 'SMS-AAAA-BBBB-CCCC');
    return { ok: true, json: async () => ({ ok: true, phone: '+18032579874', remaining: 2 }) };
  });
  try {
    delete require.cache[require.resolve('../oapi-provider')];
    const oapi = require('../oapi-provider');
    const r = await oapi.takeOrder('SMS-AAAA-BBBB-CCCC', null, 'sk-test-apikey');
    assert.strictEqual(r.phone, '+18032579874');
    assert.strictEqual(r.remaining, 2);
  } finally { restore(); }
});

test('O2 takeOrder: ok=false 抛错带 _oapiCode', async () => {
  const restore = mockFetch(async () => ({
    ok: true,
    json: async () => ({ ok: false, error: '无效的CDK兑换码' }),
  }));
  try {
    delete require.cache[require.resolve('../oapi-provider')];
    const oapi = require('../oapi-provider');
    await assert.rejects(
      oapi.takeOrder('SMS-X', null, 'sk-x'),
      (e) => e.message.includes('无效的CDK兑换码') && e._oapiCode === 'api_fail'
    );
  } finally { restore(); }
});

test('O3 pollOnce: X-API-Key=apiKey, body.code=cdk, 返 { code, remaining }', async () => {
  const restore = mockFetch(async (url, opts) => {
    assert.ok(url.includes('action=open_get_sms'));
    assert.strictEqual(opts.headers['X-API-Key'], 'sk-test-apikey');
    assert.strictEqual(JSON.parse(opts.body).code, 'SMS-X');
    return { ok: true, json: async () => ({ ok: true, sms: '...874895', code: '874895', remaining: 1 }) };
  });
  try {
    delete require.cache[require.resolve('../oapi-provider')];
    const oapi = require('../oapi-provider');
    const r = await oapi.pollOnce('SMS-X', null, 'sk-test-apikey');
    assert.strictEqual(r.code, '874895');
    assert.strictEqual(r.remaining, 1);
  } finally { restore(); }
});

test('O4 pollOnce: ok=false 返 null（正常轮询等待）', async () => {
  const restore = mockFetch(async () => ({
    ok: true,
    json: async () => ({ ok: false, error: 'No new SMS received yet' }),
  }));
  try {
    delete require.cache[require.resolve('../oapi-provider')];
    const oapi = require('../oapi-provider');
    const r = await oapi.pollOnce('SMS-X', null, 'sk-x');
    assert.strictEqual(r, null);
  } finally { restore(); }
});

test('O5 changePhone: 成功返 { phone, remaining }', async () => {
  const restore = mockFetch(async (url) => {
    assert.ok(url.includes('action=open_change_phone'));
    return { ok: true, json: async () => ({ ok: true, phone: '+19876543210', remaining: 1 }) };
  });
  try {
    delete require.cache[require.resolve('../oapi-provider')];
    const oapi = require('../oapi-provider');
    const r = await oapi.changePhone('SMS-X', null, 'sk-x');
    assert.strictEqual(r.phone, '+19876543210');
  } finally { restore(); }
});
