const test = require('node:test');
const assert = require('node:assert');
const { extractAuthCode, parsePkceResponse } = require('../pkce-oauth');

test('extractAuthCode: 标准 query 提取 code', () => {
  assert.strictEqual(extractAuthCode('https://app/cb?code=abc123&state=xyz'), 'abc123');
});

test('extractAuthCode: code 在 fragment 也能拿到', () => {
  assert.strictEqual(extractAuthCode('https://app/cb#code=abc123'), 'abc123');
});

test('extractAuthCode: 无 code 返回 null', () => {
  assert.strictEqual(extractAuthCode('https://app/cb?error=denied'), null);
});

test('extractAuthCode: 空/null 安全返回 null', () => {
  assert.strictEqual(extractAuthCode(''), null);
  assert.strictEqual(extractAuthCode(null), null);
});

test('parsePkceResponse: success → ok:true + refresh_token', () => {
  const r = parsePkceResponse({ status: 'success', data: { access_token: 'a', refresh_token: 'b', id_token: 'c' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.refresh_token, 'b');
});

test('parsePkceResponse: error 透传 reason', () => {
  const r = parsePkceResponse({ status: 'error', reason: 'pkce_token_exchange_400' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'pkce_token_exchange_400');
});
