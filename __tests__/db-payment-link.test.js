const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Use a per-process temp data.db so tests don't clobber the real one
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-payment-link-test-'));
const fakeDb = path.join(tmpDir, 'data.db');

// Override DB_PATH before requiring db.js by monkey-patching path.join.
// We do this once at module load; db.js resolves DB_PATH at require time.
const realPath = require('path');
const origJoin = realPath.join;
realPath.join = function (...args) {
  // Match exactly the db.js call: path.join(__dirname, '..', 'data.db')
  if (args[args.length - 1] === 'data.db') return fakeDb;
  return origJoin.apply(this, args);
};

const { initDB, statusDB } = require('../server/db');
realPath.join = origJoin;  // restore for other modules

test('setup: init schema in fresh temp db', async () => {
  await initDB();
  statusDB.set('a@x.com', { status: 'idle' });
  const row = statusDB.get('a@x.com');
  assert.ok(row, 'row created');
  assert.strictEqual(row.payment_link, '', 'fresh row has empty payment_link');
  assert.strictEqual(row.payment_link_pk, '', 'fresh row has empty payment_link_pk');
  assert.strictEqual(row.payment_link_at, '', 'fresh row has empty payment_link_at');
});

test('statusDB.set 写入 paymentLink 后能 get 出来,payment_link_at 同时被设', () => {
  statusDB.set('b@x.com', { status: 'running', paymentLink: 'https://pay.openai.com/c/pay/cs_live_abc', paymentLinkPk: 'pk_live_xyz' });
  const row = statusDB.get('b@x.com');
  assert.strictEqual(row.payment_link, 'https://pay.openai.com/c/pay/cs_live_abc');
  assert.strictEqual(row.payment_link_pk, 'pk_live_xyz');
  assert.ok(row.payment_link_at && row.payment_link_at.length > 0, 'payment_link_at should be set');
});

test('statusDB.set 不传 paymentLink 时 DB 现存 payment_link 不被抹(关键不变式)', () => {
  // b@x.com already has payment_link from previous test; subsequent set without paymentLink must preserve it
  statusDB.set('b@x.com', { status: 'error', reason: 'failed' });
  const row = statusDB.get('b@x.com');
  assert.strictEqual(row.payment_link, 'https://pay.openai.com/c/pay/cs_live_abc', 'payment_link preserved');
  assert.strictEqual(row.payment_link_pk, 'pk_live_xyz', 'pk preserved');
  assert.strictEqual(row.status, 'error', 'status updated as expected');
});

test('statusDB.set 显式传 paymentLink="" 清空缓存', () => {
  statusDB.set('b@x.com', { status: 'error', paymentLink: '' });
  const row = statusDB.get('b@x.com');
  assert.strictEqual(row.payment_link, '', 'explicit empty wipes link');
});

test('statusDB.clearPaymentLink 清空 3 列', () => {
  statusDB.set('c@x.com', { status: 'running', paymentLink: 'https://pay.openai.com/c/pay/cs_live_def', paymentLinkPk: 'pk_live_xyz' });
  statusDB.clearPaymentLink('c@x.com');
  const row = statusDB.get('c@x.com');
  assert.strictEqual(row.payment_link, '');
  assert.strictEqual(row.payment_link_pk, '');
  assert.strictEqual(row.payment_link_at, '');
});

test('statusDB.reset 保留 payment_link(reset 只重置状态)', () => {
  statusDB.set('d@x.com', { status: 'running', paymentLink: 'https://pay.openai.com/c/pay/cs_live_ghi', paymentLinkPk: 'pk_live_xyz' });
  statusDB.reset('d@x.com');
  const row = statusDB.get('d@x.com');
  assert.strictEqual(row.status, 'idle', 'status was reset');
  assert.strictEqual(row.payment_link, 'https://pay.openai.com/c/pay/cs_live_ghi', 'payment_link preserved through reset');
});
