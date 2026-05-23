const test = require('node:test');
const assert = require('node:assert');
const { validateRpaInput, parseRpaResponse } = require('../paypal-rpa');

test('validateRpaInput: 合法 input 返回 null', () => {
  assert.strictEqual(
    validateRpaInput({ paypal_url: 'https://www.paypal.com/agreements/approve?ba=x', phone: '4642840651', sms_api_url: 'http://...', proxy: 'http://127.0.0.1:7890', approval_url_pattern: 'chatgpt\\.com' }),
    null
  );
});

test('validateRpaInput: 缺 paypal_url 返回 missing_paypal_url', () => {
  assert.strictEqual(validateRpaInput({ phone: '1', sms_api_url: 'x', approval_url_pattern: 'y' }), 'missing_paypal_url');
});

test('validateRpaInput: paypal_url 非 paypal.com 返回 invalid_paypal_url', () => {
  assert.strictEqual(
    validateRpaInput({ paypal_url: 'https://example.com/x', phone: '1', sms_api_url: 'x', approval_url_pattern: 'y' }),
    'invalid_paypal_url'
  );
});

test('parseRpaResponse: success → ok=true + chatgpt_approval_url', () => {
  const r = parseRpaResponse({ status: 'success', data: { chatgpt_approval_url: 'https://chatgpt.com/agreements/approve?token=x' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.chatgpt_approval_url, 'https://chatgpt.com/agreements/approve?token=x');
});

test('parseRpaResponse: error 透传 reason', () => {
  const r = parseRpaResponse({ status: 'error', reason: 'sms_fetch_fail' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'sms_fetch_fail');
});
