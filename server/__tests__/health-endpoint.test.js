const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Use a per-process temp data.db so we don't clobber the real one.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-test-'));
const fakeDb = path.join(tmpDir, 'data.db');
const realPath = require('path');
const origJoin = realPath.join;
realPath.join = function (...args) {
  if (args[args.length - 1] === 'data.db') return fakeDb;
  return origJoin.apply(this, args);
};
const { initDB } = require('../db');
realPath.join = origJoin;

// Drive the route handler directly — no supertest, no express boot.
const healthRouter = require('../routes/health');

function invokeHealth() {
  return new Promise((resolve) => {
    const req = { method: 'GET', url: '/', headers: {} };
    const res = {
      _status: 200,
      _body: null,
      status(code) { this._status = code; return this; },
      json(body) { this._body = body; resolve({ status: this._status, body }); return this; },
    };
    // Express router accepts (req, res, next) — we provide a noop next.
    healthRouter.handle(req, res, () => resolve({ status: 404, body: null }));
  });
}

test('GET /api/health → 200 + ok:true after initDB', async () => {
  await initDB();
  const r = await invokeHealth();
  assert.strictEqual(r.status, 200, `status should be 200, got ${r.status}`);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.db, 'ok');
  assert.strictEqual(typeof r.body.uptimeSec, 'number');
  assert.ok(r.body.engine, 'engine field present');
});

test('GET /api/health body never contains subscriptionUrl / token / password', async () => {
  const r = await invokeHealth();
  const json = JSON.stringify(r.body);
  assert.ok(!/subscriptionUrl/i.test(json), 'must not leak subscriptionUrl');
  assert.ok(!/token/i.test(json), 'must not leak token (field name)');
  assert.ok(!/password/i.test(json), 'must not leak password');
});

test('GET /api/health proxy field is the subset, not the full getState()', async () => {
  const r = await invokeHealth();
  if (r.body.proxy) {
    const keys = Object.keys(r.body.proxy);
    // Whitelist: enabled / currentNode / available / jpEnabled / jpCurrentNode / jpAvailable
    for (const k of keys) {
      assert.ok(
        ['enabled', 'currentNode', 'available', 'jpEnabled', 'jpCurrentNode', 'jpAvailable'].includes(k),
        `unexpected proxy key in /api/health: ${k}`,
      );
    }
  }
});
