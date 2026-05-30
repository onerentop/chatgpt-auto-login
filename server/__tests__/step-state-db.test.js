const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stepstate-test-'));
const fakeDb = path.join(tmpDir, 'data.db');
const realPath = require('path');
const origJoin = realPath.join;
realPath.join = function (...args) {
  if (args[args.length - 1] === 'data.db') return fakeDb;
  return origJoin.apply(this, args);
};
const { initDB, stepStateDB, save } = require('../db');
realPath.join = origJoin;

test('setup', async () => { await initDB(); await save.flush(); });

test('set + get a step row', async () => {
  stepStateDB.set('a@x.com', 'login', { status: 'success', startedAt: 't1', finishedAt: 't2' });
  await save.flush();
  const row = stepStateDB.get('a@x.com', 'login');
  assert.strictEqual(row.status, 'success');
  assert.strictEqual(row.started_at, 't1');
  assert.strictEqual(row.finished_at, 't2');
});

test('set merges — updating status keeps prior started_at', async () => {
  stepStateDB.set('a@x.com', 'pay', { status: 'running', startedAt: 's1' });
  stepStateDB.set('a@x.com', 'pay', { status: 'failed', reason: 'boom', finishedAt: 'f1' });
  await save.flush();
  const row = stepStateDB.get('a@x.com', 'pay');
  assert.strictEqual(row.status, 'failed');
  assert.strictEqual(row.reason, 'boom');
  assert.strictEqual(row.started_at, 's1', 'started_at preserved across merge');
});

test('list returns all steps for an email', async () => {
  const rows = stepStateDB.list('a@x.com');
  assert.ok(rows.length >= 2);
  assert.ok(rows.every(r => r.email === 'a@x.com'));
});

test('get returns null for missing', () => {
  assert.strictEqual(stepStateDB.get('a@x.com', 'nope'), null);
});
