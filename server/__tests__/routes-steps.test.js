// server/__tests__/routes-steps.test.js
// Tests for GET /api/accounts/:email/steps
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');

// ── 1. Redirect data.db to a temp file ──────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-steps-test-'));
const fakeDb = path.join(tmpDir, 'data.db');
const realPath = require('path');
const origJoin = realPath.join;
realPath.join = function (...args) {
  if (args[args.length - 1] === 'data.db') return fakeDb;
  return origJoin.apply(this, args);
};
const { initDB, stepStateDB, logsDB, save } = require('../db');
realPath.join = origJoin;

// ── 2. Stub config.json so accounts router can read protocolMode ─────────────
// The accounts router reads ../../config.json relative to server/routes/
// We write a fake one into the tmpDir and monkey-patch fs.readFileSync.
const fakeConfigPath = path.join(tmpDir, 'config.json');
fs.writeFileSync(fakeConfigPath, JSON.stringify({ protocolMode: true }));

const origReadFileSync = fs.readFileSync;
fs.readFileSync = function (p, enc) {
  // Intercept the config.json read from the accounts route
  if (typeof p === 'string' && p.endsWith('config.json') && !p.includes('package')) {
    return origReadFileSync(fakeConfigPath, enc);
  }
  return origReadFileSync.apply(this, arguments);
};

// ── 3. Mount the accounts router ─────────────────────────────────────────────
const accountsRouter = require('../routes/accounts');

fs.readFileSync = origReadFileSync; // restore immediately — route only reads at request time

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountsRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function fetchJson(port, method, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method }, (r) => {
      let buf = '';
      r.on('data', (c) => buf += c);
      r.on('end', () => {
        resolve({ status: r.statusCode, json: buf ? JSON.parse(buf) : null });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

let server, port;

// ── Tests ─────────────────────────────────────────────────────────────────────

test('setup: init DB', async () => {
  await initDB();
  await save.flush();
});

test('setup: start express server', async () => {
  const s = await startServer();
  server = s.server;
  port = s.port;
  assert.ok(port > 0);
});

test('GET /:email/steps — unrun account returns all steps as pending with empty logs', async () => {
  const email = 'fresh@example.com';
  const r = await fetchJson(port, 'GET', `/api/accounts/${encodeURIComponent(email)}/steps`);
  assert.strictEqual(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.json)}`);
  assert.strictEqual(r.json.email, email);
  assert.ok(Array.isArray(r.json.steps), 'steps should be an array');
  // protocol pipeline: login, plan-check, paypal-fetch, paypal-verify, paypal-pay, paypal-pkce
  assert.ok(r.json.steps.length >= 4, `expected >=4 steps, got ${r.json.steps.length}`);
  for (const step of r.json.steps) {
    assert.strictEqual(step.status, 'pending', `step ${step.stepId} should be pending`);
    assert.strictEqual(step.reason, '');
    assert.deepStrictEqual(step.logs, []);
  }
  // Steps must have stepId and label
  assert.ok(r.json.steps[0].stepId, 'first step should have stepId');
  assert.ok(r.json.steps[0].label, 'first step should have label');
});

test('GET /:email/steps — step with stepStateDB row shows its status', async () => {
  const email = 'seeded@example.com';
  // Seed a step state for 'login' step
  stepStateDB.set(email, 'login', { status: 'success', startedAt: '2026-05-30T10:00:00.000Z', finishedAt: '2026-05-30T10:00:05.000Z' });
  await save.flush();

  const r = await fetchJson(port, 'GET', `/api/accounts/${encodeURIComponent(email)}/steps`);
  assert.strictEqual(r.status, 200);
  const loginStep = r.json.steps.find(s => s.stepId === 'login');
  assert.ok(loginStep, 'login step should exist');
  assert.strictEqual(loginStep.status, 'success');
  assert.strictEqual(loginStep.startedAt, '2026-05-30T10:00:00.000Z');
  assert.strictEqual(loginStep.finishedAt, '2026-05-30T10:00:05.000Z');
});

test('GET /:email/steps — step with logs shows them filtered by phase', async () => {
  const email = 'logged@example.com';
  const ts1 = '2026-05-30T10:01:00.000Z';
  const ts2 = '2026-05-30T10:01:01.000Z';
  const ts3 = '2026-05-30T10:02:00.000Z';
  // Add logs for 'login' phase and a different phase 'plan-check'
  logsDB.add(email, 'login', 'Login started', ts1, 'run1');
  logsDB.add(email, 'login', 'Login succeeded', ts2, 'run1');
  logsDB.add(email, 'plan-check', 'Plan check ok', ts3, 'run1');
  await save.flush();

  const r = await fetchJson(port, 'GET', `/api/accounts/${encodeURIComponent(email)}/steps`);
  assert.strictEqual(r.status, 200);

  const loginStep = r.json.steps.find(s => s.stepId === 'login');
  assert.ok(loginStep, 'login step should exist');
  assert.strictEqual(loginStep.logs.length, 2, 'login step should have 2 logs');
  assert.strictEqual(loginStep.logs[0].message, 'Login started');
  assert.strictEqual(loginStep.logs[1].message, 'Login succeeded');

  const planStep = r.json.steps.find(s => s.stepId === 'plan-check');
  assert.ok(planStep, 'plan-check step should exist');
  assert.strictEqual(planStep.logs.length, 1, 'plan-check step should have 1 log');
  assert.strictEqual(planStep.logs[0].message, 'Plan check ok');
});

test('GET /:email/steps — steps are in pipeline order (login first)', async () => {
  const email = 'order@example.com';
  const r = await fetchJson(port, 'GET', `/api/accounts/${encodeURIComponent(email)}/steps`);
  assert.strictEqual(r.status, 200);
  // First step of protocol+paypal pipeline is always 'login'
  assert.strictEqual(r.json.steps[0].stepId, 'login', 'first step should be login');
});

test('GET /:email/steps — URL-encoded email is decoded correctly', async () => {
  const email = 'test+user@example.com';
  const r = await fetchJson(port, 'GET', `/api/accounts/${encodeURIComponent(email)}/steps`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.email, email);
});

test('GET /:email/steps — failed step shows reason', async () => {
  const email = 'failed@example.com';
  stepStateDB.set(email, 'paypal-fetch', { status: 'failed', reason: 'no jp proxy', startedAt: '2026-05-30T11:00:00.000Z', finishedAt: '2026-05-30T11:00:01.000Z' });
  await save.flush();

  const r = await fetchJson(port, 'GET', `/api/accounts/${encodeURIComponent(email)}/steps`);
  assert.strictEqual(r.status, 200);
  const fetchStep = r.json.steps.find(s => s.stepId === 'paypal-fetch');
  assert.ok(fetchStep, 'paypal-fetch step should exist');
  assert.strictEqual(fetchStep.status, 'failed');
  assert.strictEqual(fetchStep.reason, 'no jp proxy');
});

test('engine.start accepts 3rd opts arg without throwing synchronously', () => {
  // Light smoke test: confirm start() signature accepts a 3rd opts argument
  // (all params have defaults so Function.length is 0, but the source text confirms
  // the signature).  We verify the call does not throw synchronously.
  const { ProtocolEngine } = require('../../protocol-engine');
  const engine = new ProtocolEngine();
  // Verify the function is declared with 3 parameters (all defaults → length = 0,
  // but toString() shows the full signature).
  const src = engine.start.toString();
  assert.ok(
    /async start\s*\(\s*startFrom\s*=/.test(src),
    'start() should be an async function with startFrom parameter',
  );
  assert.ok(
    /opts\s*=\s*\{\}/.test(src),
    'start() should accept opts = {} as 3rd parameter',
  );
  // Calling with opts must not throw synchronously (async failure due to missing
  // chrome/python is expected and irrelevant here).
  let threw = false;
  try {
    const p = engine.start(0, null, { forceStepId: undefined });
    // Detach the promise — we don't care about the async result
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {
    threw = true;
  }
  assert.strictEqual(threw, false, 'start(0, null, {forceStepId:undefined}) must not throw synchronously');
  // Clean up: force-stop so the engine doesn't linger
  try { engine.stop().catch(() => {}); } catch {}
});

test('teardown: close server', (t, done) => {
  server.close(done);
});
