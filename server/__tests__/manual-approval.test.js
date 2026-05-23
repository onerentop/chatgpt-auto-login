const test = require('node:test');
const assert = require('node:assert');
const { validateApprovalInput, parseApprovalResponse } = require('../manual-approval');

test('validateApprovalInput: 合法返回 null', () => {
  assert.strictEqual(
    validateApprovalInput({ access_token: 'eyJ123', approval_url: 'https://chatgpt.com/agreements/approve?token=x' }),
    null
  );
});

test('validateApprovalInput: 缺 access_token 返回 invalid_access_token', () => {
  assert.strictEqual(
    validateApprovalInput({ approval_url: 'https://x' }),
    'invalid_access_token'
  );
});

test('validateApprovalInput: 缺 approval_url 返回 missing_approval_url', () => {
  assert.strictEqual(
    validateApprovalInput({ access_token: 'eyJ123' }),
    'missing_approval_url'
  );
});

test('parseApprovalResponse: success → ok=true + plan_type', () => {
  const r = parseApprovalResponse({ status: 'success', data: { plan_type: 'plus', is_subscribed: true } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.plan_type, 'plus');
  assert.strictEqual(r.is_subscribed, true);
});

test('parseApprovalResponse: timeout 失败透传', () => {
  const r = parseApprovalResponse({ status: 'error', reason: 'approval_no_plus_after_timeout', body: 'last_plan=free' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'approval_no_plus_after_timeout');
});
