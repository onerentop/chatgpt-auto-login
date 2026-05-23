const test = require('node:test');
const assert = require('node:assert');
const { extractCsId, parseInitResponse } = require('../stripe-verify');

test('extractCsId: 标准 cs_live URL', () => {
  const link = 'https://pay.openai.com/c/pay/cs_live_a1abc123XYZ#fidnandhYHd';
  assert.strictEqual(extractCsId(link), 'cs_live_a1abc123XYZ');
});

test('extractCsId: 不含 fragment', () => {
  assert.strictEqual(
    extractCsId('https://pay.openai.com/c/pay/cs_live_abc999'),
    'cs_live_abc999'
  );
});

test('extractCsId: 非 cs_live 链接返回 null', () => {
  assert.strictEqual(extractCsId('https://example.com/foo'), null);
});

test('extractCsId: 空/null/非字符串返回 null', () => {
  assert.strictEqual(extractCsId(''), null);
  assert.strictEqual(extractCsId(null), null);
  assert.strictEqual(extractCsId(undefined), null);
});

test('parseInitResponse: amount_due=0 → is_free=true', () => {
  const data = {
    invoice: {
      amount_due: 0,
      currency: 'usd',
      total_discount_amounts: [{ coupon: { name: 'ChatGPT Plus - 1 Month Free Trial' } }],
    },
    payment_method_types: ['card', 'paypal'],
  };
  const r = parseInitResponse(data);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.is_free, true);
  assert.strictEqual(r.amount_due, 0);
  assert.strictEqual(r.currency, 'usd');
  assert.strictEqual(r.has_paypal, true);
  assert.deepStrictEqual(r.coupons, ['ChatGPT Plus - 1 Month Free Trial']);
});

test('parseInitResponse: amount_due=2000 → is_free=false', () => {
  const data = {
    invoice: { amount_due: 2000, currency: 'usd', total_discount_amounts: [] },
    payment_method_types: ['card', 'paypal'],
  };
  const r = parseInitResponse(data);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.is_free, false);
  assert.strictEqual(r.amount_due, 2000);
});

test('parseInitResponse: amount_due=2727 JPY 也算非 free', () => {
  const data = {
    invoice: { amount_due: 2727, currency: 'jpy', total_discount_amounts: [] },
    payment_method_types: ['card'],
  };
  const r = parseInitResponse(data);
  assert.strictEqual(r.is_free, false);
  assert.strictEqual(r.currency, 'jpy');
  assert.strictEqual(r.has_paypal, false);
});

test('parseInitResponse: 缺失 invoice → ok=false reason=no_invoice', () => {
  const r = parseInitResponse({ payment_method_types: ['card'] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_invoice');
});

test('parseInitResponse: invoice 缺 amount_due → ok=false reason=no_invoice', () => {
  const r = parseInitResponse({ invoice: { currency: 'usd' } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_invoice');
});
