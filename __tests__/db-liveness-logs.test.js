const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-liveness-logs-test-'));
const fakeDb = path.join(tmpDir, 'data.db');

const realPath = require('path');
const origJoin = realPath.join;
realPath.join = function (...args) {
  if (args[args.length - 1] === 'data.db') return fakeDb;
  return origJoin.apply(this, args);
};
const { initDB, livenessLogsDB } = require('../server/db');
realPath.join = origJoin;

test('setup: fresh db starts empty', async () => {
  await initDB();
  const rows = livenessLogsDB.recent(200);
  assert.strictEqual(rows.length, 0);
});

test('add() writes a row, recent() reads it back', () => {
  livenessLogsDB.add({ email: 'a@x.com', level: 'info', message: '[liveness] checking' });
  const rows = livenessLogsDB.recent(200);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].email, 'a@x.com');
  assert.strictEqual(rows[0].level, 'info');
  assert.strictEqual(rows[0].message, '[liveness] checking');
  assert.ok(rows[0].timestamp, 'timestamp auto-set');
});

test('recent() returns chronological order (oldest first)', () => {
  livenessLogsDB.clear();
  livenessLogsDB.add({ email: 'b@x.com', level: 'info', message: 'msg-1' });
  livenessLogsDB.add({ email: 'b@x.com', level: 'info', message: 'msg-2' });
  livenessLogsDB.add({ email: 'b@x.com', level: 'success', message: 'msg-3' });
  const rows = livenessLogsDB.recent(200);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].message, 'msg-1');
  assert.strictEqual(rows[1].message, 'msg-2');
  assert.strictEqual(rows[2].message, 'msg-3');
});

test('recent(limit) caps result size', () => {
  livenessLogsDB.clear();
  for (let i = 0; i < 50; i++) {
    livenessLogsDB.add({ email: `u${i}@x.com`, level: 'info', message: `m${i}` });
  }
  const rows = livenessLogsDB.recent(10);
  assert.strictEqual(rows.length, 10);
  // recent returns the latest N in chronological order — last 10 inserted = m40..m49
  assert.strictEqual(rows[0].message, 'm40');
  assert.strictEqual(rows[9].message, 'm49');
});

test('clear() empties the table', () => {
  livenessLogsDB.add({ email: 'c@x.com', level: 'info', message: 'will-be-cleared' });
  assert.ok(livenessLogsDB.recent(10).length > 0);
  livenessLogsDB.clear();
  assert.strictEqual(livenessLogsDB.recent(10).length, 0);
});

test('add() accepts explicit timestamp', () => {
  livenessLogsDB.clear();
  livenessLogsDB.add({ email: 'd@x.com', level: 'info', message: 'with-ts', timestamp: '2026-05-24T10:00:00.000Z' });
  const rows = livenessLogsDB.recent(10);
  assert.strictEqual(rows[0].timestamp, '2026-05-24T10:00:00.000Z');
});
