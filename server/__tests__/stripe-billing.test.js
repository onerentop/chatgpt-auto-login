const test = require('node:test');
const assert = require('node:assert');
const { validateBillingInput, parseStripeResponse } = require('../stripe-billing');

test('validateBillingInput: 完整合法输入返回 null', () => {
  const input = { cs_id: 'cs_live_a1abc', pk: 'pk_live_51XYZ', country: 'US', street: '1', city: 'A', state: 'TX', zip: '78701' };
  assert.strictEqual(validateBillingInput(input), null);
});

test('validateBillingInput: 缺 cs_id 返回 invalid_link', () => {
  const input = { pk: 'pk_live_51XYZ', country: 'US' };
  assert.strictEqual(validateBillingInput(input), 'invalid_link');
});

test('validateBillingInput: pk 格式不对返回 invalid_pk', () => {
  const input = { cs_id: 'cs_live_a1abc', pk: 'sk_live_xxx' };
  assert.strictEqual(validateBillingInput(input), 'invalid_pk');
});

test('parseStripeResponse: success 含 paypal_redirect_url', () => {
  const r = parseStripeResponse({ status: 'success', data: { paypal_redirect_url: 'https://paypal.com/x', payment_intent_id: 'pi_1' } });
  assert.deepStrictEqual(r, { ok: true, paypal_redirect_url: 'https://paypal.com/x', payment_intent_id: 'pi_1' });
});

test('parseStripeResponse: error 透传 reason', () => {
  const r = parseStripeResponse({ status: 'error', reason: 'stripe_billing_400', body: 'oops' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'stripe_billing_400');
});

test('parseStripeResponse: 缺 status 字段返回 ok=false reason=unparsable', () => {
  const r = parseStripeResponse({ data: { paypal_redirect_url: 'x' } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unparsable');
});
