const test = require('node:test');
const assert = require('node:assert');

function mockFetch(handler) {
  const orig = global.fetch;
  global.fetch = async (url, opts) => handler(url, opts);
  return () => { global.fetch = orig; };
}

test('takeOrder: 成功返回 { order_no, phone }', async () => {
  const restore = mockFetch(async (url) => {
    assert.ok(url.includes('/public/sms/getNumber?serviceCode=tg&countryCode=187'));
    return {
      ok: true,
      json: async () => ({ code: 0, data: { id: '2046386613387407360', phoneNumber: '15551234567', countryPhoneCode: '+1' } }),
    };
  });
  try {
    const smscloud = require('../smscloud-provider');
    const order = await smscloud.takeOrder('test-key', null, 'tg', '187');
    assert.strictEqual(order.order_no, '2046386613387407360');
    assert.strictEqual(order.phone, '+15551234567');
  } finally { restore(); }
});

test('takeOrder: code !== 0 抛错并带 _smscloudCode', async () => {
  const restore = mockFetch(async () => ({
    ok: true,
    json: async () => ({ code: 1001, message: 'service not available' }),
  }));
  try {
    delete require.cache[require.resolve('../smscloud-provider')];
    const smscloud = require('../smscloud-provider');
    await assert.rejects(
      smscloud.takeOrder('key', null, 'tg', '187'),
      (e) => e.message.includes('service not available') && e._smscloudCode === '1001'
    );
  } finally { restore(); }
});

test('pollOrderSms: data.code 拿到验证码', async () => {
  let calls = 0;
  const restore = mockFetch(async (url) => {
    assert.ok(url.includes('/public/sms/orders/sync/order-123'));
    calls++;
    if (calls === 1) return { ok: true, json: async () => ({ code: 0, data: null }) };  // 第 1 次未到
    return { ok: true, json: async () => ({ code: 0, data: { code: '654321' } }) };
  });
  try {
    delete require.cache[require.resolve('../smscloud-provider')];
    const smscloud = require('../smscloud-provider');
    const code = await smscloud.pollOrderSms('order-123', 'key', null, { pollIntervalMs: 10, maxAttempts: 5 });
    assert.strictEqual(code, '654321');
    assert.ok(calls >= 2);
  } finally { restore(); }
});

test('pollOrderSms: maxAttempts 全过返回 null', async () => {
  const restore = mockFetch(async () => ({ ok: true, json: async () => ({ code: 0, data: null }) }));
  try {
    delete require.cache[require.resolve('../smscloud-provider')];
    const smscloud = require('../smscloud-provider');
    const code = await smscloud.pollOrderSms('o1', 'key', null, { pollIntervalMs: 10, maxAttempts: 3 });
    assert.strictEqual(code, null);
  } finally { restore(); }
});

test('getBalance: 返回 data.balance 数值', async () => {
  const restore = mockFetch(async () => ({ ok: true, json: async () => ({ code: 0, data: { balance: 128.5 } }) }));
  try {
    delete require.cache[require.resolve('../smscloud-provider')];
    const smscloud = require('../smscloud-provider');
    const bal = await smscloud.getBalance('key', null);
    assert.strictEqual(bal, 128.5);
  } finally { restore(); }
});

test('listServices: 返回服务数组', async () => {
  const restore = mockFetch(async () => ({ ok: true, json: async () => ({ code: 0, data: [{ code: 'tg', name: 'Telegram' }, { code: 'ai', name: 'OpenAI' }] }) }));
  try {
    delete require.cache[require.resolve('../smscloud-provider')];
    const smscloud = require('../smscloud-provider');
    const services = await smscloud.listServices('key', null);
    assert.strictEqual(services.length, 2);
    assert.strictEqual(services[0].code, 'tg');
  } finally { restore(); }
});
