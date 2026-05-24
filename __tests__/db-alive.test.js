const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-alive-test-'));
const fakeDb = path.join(tmpDir, 'data.db');

const realPath = require('path');
const origJoin = realPath.join;
realPath.join = function (...args) {
  if (args[args.length - 1] === 'data.db') return fakeDb;
  return origJoin.apply(this, args);
};
const { initDB, statusDB } = require('../server/db');
realPath.join = origJoin;

test('setup: fresh db has alive defaults', async () => {
  await initDB();
  statusDB.set('a@x.com', { status: 'idle' });
  const row = statusDB.get('a@x.com');
  assert.strictEqual(row.alive_status, 'unknown', 'default alive_status');
  assert.strictEqual(row.alive_checked_at, '');
  assert.strictEqual(row.alive_reason, '');
});

test('setAlive writes 3 columns + auto ISO timestamp', () => {
  statusDB.setAlive('b@x.com', { alive_status: 'plus', alive_reason: 'check ok' });
  const row = statusDB.get('b@x.com');
  assert.strictEqual(row.alive_status, 'plus');
  assert.strictEqual(row.alive_reason, 'check ok');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(row.alive_checked_at), 'ISO timestamp set');
});

test('setAlive merge: does not touch status / payment_link', () => {
  statusDB.set('c@x.com', {
    status: 'error',
    paymentLink: 'https://pay.openai.com/cs_test',
    paymentLinkPk: 'pk_test_xyz',
    reason: 'phase 3 fail',
  });
  statusDB.setAlive('c@x.com', { alive_status: 'plus', alive_reason: 'check ok' });
  const row = statusDB.get('c@x.com');
  assert.strictEqual(row.status, 'error', 'status preserved');
  assert.strictEqual(row.reason, 'phase 3 fail', 'reason preserved');
  assert.strictEqual(row.payment_link, 'https://pay.openai.com/cs_test', 'payment_link preserved');
  assert.strictEqual(row.payment_link_pk, 'pk_test_xyz', 'payment_link_pk preserved');
  assert.strictEqual(row.alive_status, 'plus');
});

test('clearAlive resets 3 columns to defaults', () => {
  statusDB.setAlive('d@x.com', { alive_status: 'login_fail', alive_reason: 'bad password' });
  statusDB.clearAlive('d@x.com');
  const row = statusDB.get('d@x.com');
  assert.strictEqual(row.alive_status, 'unknown');
  assert.strictEqual(row.alive_checked_at, '');
  assert.strictEqual(row.alive_reason, '');
});

test('statusDB.reset preserves alive_*', () => {
  statusDB.setAlive('e@x.com', { alive_status: 'plus', alive_reason: 'check ok' });
  statusDB.set('e@x.com', { status: 'running', reason: 'started' });
  statusDB.reset('e@x.com');
  const row = statusDB.get('e@x.com');
  assert.strictEqual(row.status, 'idle');
  assert.strictEqual(row.alive_status, 'plus', 'alive preserved through reset');
});
