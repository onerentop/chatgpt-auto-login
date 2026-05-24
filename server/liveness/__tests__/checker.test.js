const test = require('node:test');
const assert = require('node:assert');

const { probe, decodeJwtExp, mapPlanType } = require('../checker');

function jwtWithExp(expSec) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url');
  return `${header}.${payload}.sig`;
}

test('decodeJwtExp parses exp from JWT payload', () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  assert.strictEqual(decodeJwtExp(jwtWithExp(exp)), exp);
});

test('decodeJwtExp returns 0 on malformed JWT', () => {
  assert.strictEqual(decodeJwtExp('not-a-jwt'), 0);
  assert.strictEqual(decodeJwtExp(''), 0);
});

test('mapPlanType: plus → alive_status=plus', () => {
  assert.deepStrictEqual(mapPlanType('plus'), { alive_status: 'plus', alive_reason: 'check ok' });
});

test('mapPlanType: free → canceled', () => {
  assert.deepStrictEqual(mapPlanType('free'), { alive_status: 'canceled', alive_reason: 'no plus' });
});

test('mapPlanType: team/enterprise → canceled w/ plan name', () => {
  assert.deepStrictEqual(mapPlanType('team'), { alive_status: 'canceled', alive_reason: 'plan: team' });
});

test('probe: JWT already expired returns token_expired without fetch', async () => {
  const fetchCalls = [];
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) - 10), {
    fetchImpl: (...a) => { fetchCalls.push(a); throw new Error('should not be called'); },
  });
  assert.strictEqual(r.alive_status, 'token_expired');
  assert.strictEqual(fetchCalls.length, 0);
});

test('probe: 200 + plan_type=plus', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({ account_plan: { plan_type: 'plus' } }),
  });
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), { fetchImpl });
  assert.strictEqual(r.alive_status, 'plus');
});

test('probe: 401 returns token_expired (caller decides re-login)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), { fetchImpl });
  assert.strictEqual(r.alive_status, 'token_expired');
  assert.strictEqual(r.alive_reason, 'check 401');
});

test('probe: 403 returns login_fail (no point re-logging)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({}) });
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), { fetchImpl });
  assert.strictEqual(r.alive_status, 'login_fail');
});

test('probe: 5xx returns network_error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), { fetchImpl });
  assert.strictEqual(r.alive_status, 'network_error');
});

test('probe: ECONNRESET / TypeError returns proxy_error', async () => {
  const fetchImpl = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e; };
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), { fetchImpl });
  assert.strictEqual(r.alive_status, 'proxy_error');
});
