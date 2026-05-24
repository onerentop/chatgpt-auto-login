const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Use a per-process temp data.db so we don't clobber the real one.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-atomic-test-'));
const fakeDb = path.join(tmpDir, 'data.db');

// Override DB_PATH before requiring db.js (matches db.js: path.join(__dirname, '..', 'data.db'))
const realPath = require('path');
const origJoin = realPath.join;
realPath.join = function (...args) {
  if (args[args.length - 1] === 'data.db') return fakeDb;
  return origJoin.apply(this, args);
};
const { initDB, statusDB, save } = require('../db');
realPath.join = origJoin;

test('setup: init schema', async () => {
  await initDB();
  await save.flush();
  assert.ok(fs.existsSync(fakeDb), 'data.db exists after initDB');
});

test('save() returns a flushable promise', async () => {
  statusDB.set('a@x.com', { status: 'idle' });
  const p = save.flush();
  assert.ok(p && typeof p.then === 'function', 'save.flush returns a promise');
  await p;
});

test('save() uses tmp + rename — no leftover .tmp on success', async () => {
  statusDB.set('b@x.com', { status: 'plus' });
  await save.flush();
  const tmpPath = fakeDb + '.tmp';
  // The renameSync replaces tmp atomically; after settling there should be no tmp file.
  assert.strictEqual(fs.existsSync(tmpPath), false, 'no leftover .tmp after successful save');
});

test('save() is serialized — 20 concurrent set() calls all land in DB on disk', async () => {
  // Mutate the in-memory DB 20 times back-to-back. Each set() enqueues a save.
  for (let i = 0; i < 20; i++) {
    statusDB.set(`c${i}@x.com`, { status: 'plus', reason: `r${i}` });
  }
  // Flush the queue and ensure the on-disk file reflects the last mutation.
  await save.flush();
  // Re-read from disk via a fresh sql.js handle to guarantee we're not just seeing memory.
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(fakeDb);
  const fresh = new SQL.Database(buf);
  const rows = fresh.exec("SELECT email, status, reason FROM account_status WHERE email LIKE 'c%@x.com' ORDER BY email");
  fresh.close();
  const values = rows[0]?.values || [];
  assert.strictEqual(values.length, 20, 'all 20 rows persisted to disk');
  // Spot-check one mutation made it through.
  const lastRow = values.find(([email]) => email === 'c19@x.com');
  assert.ok(lastRow, 'c19@x.com row present');
  assert.strictEqual(lastRow[1], 'plus');
  assert.strictEqual(lastRow[2], 'r19');
});

test('save() writes a buffer big enough to round-trip — sanity check', async () => {
  statusDB.set('huge@x.com', { status: 'plus', reason: 'x'.repeat(8192) });
  await save.flush();
  const buf = fs.readFileSync(fakeDb);
  // sql.js writes its standard SQLite header; first 16 bytes = "SQLite format 3\x00"
  const header = buf.slice(0, 15).toString('utf-8');
  assert.strictEqual(header, 'SQLite format 3', 'on-disk file has SQLite header');
});
