const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-access-token-test-'));
const fakeDb = path.join(tmpDir, 'data.db');

const realPath = require('path');
const origJoin = realPath.join;
realPath.join = function (...args) {
  if (args[args.length - 1] === 'data.db') return fakeDb;
  return origJoin.apply(this, args);
};
const { initDB, statusDB } = require('../server/db');
realPath.join = origJoin;

test('setup: fresh db has access-token defaults', async () => {
  await initDB();
  statusDB.set('a@x.com', { status: 'idle' });
  const row = statusDB.get('a@x.com');
  assert.strictEqual(row.last_access_token, '');
  assert.strictEqual(row.last_session_json, '');
  assert.strictEqual(row.last_access_token_at, '');
});

test('statusDB.set writes accessToken + sessionJson, last_access_token_at auto-set', () => {
  statusDB.set('b@x.com', {
    status: 'running',
    accessToken: 'eyJ.fake.tok',
    sessionJson: '{"account":{"planType":"free"}}',
  });
  const row = statusDB.get('b@x.com');
  assert.strictEqual(row.last_access_token, 'eyJ.fake.tok');
  assert.strictEqual(row.last_session_json, '{"account":{"planType":"free"}}');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(row.last_access_token_at), 'ISO timestamp set');
});

test('statusDB.set merge: not passing accessToken preserves cached token (critical invariant)', () => {
  statusDB.set('b@x.com', { status: 'error', reason: 'failed' });
  const row = statusDB.get('b@x.com');
  assert.strictEqual(row.last_access_token, 'eyJ.fake.tok', 'token preserved');
  assert.strictEqual(row.last_session_json, '{"account":{"planType":"free"}}', 'session preserved');
  assert.strictEqual(row.status, 'error', 'status updated as expected');
});

test('statusDB.clearAccessToken clears 3 columns', () => {
  statusDB.set('c@x.com', {
    status: 'running',
    accessToken: 'eyJ.tok.c',
    sessionJson: '{"foo":"bar"}',
  });
  statusDB.clearAccessToken('c@x.com');
  const row = statusDB.get('c@x.com');
  assert.strictEqual(row.last_access_token, '');
  assert.strictEqual(row.last_session_json, '');
  assert.strictEqual(row.last_access_token_at, '');
});

test('statusDB.reset preserves last_access_token (reset only zeros state)', () => {
  statusDB.set('d@x.com', {
    status: 'running',
    accessToken: 'eyJ.tok.d',
    sessionJson: '{}',
  });
  statusDB.reset('d@x.com');
  const row = statusDB.get('d@x.com');
  assert.strictEqual(row.status, 'idle', 'status reset');
  assert.strictEqual(row.last_access_token, 'eyJ.tok.d', 'token preserved through reset');
});
