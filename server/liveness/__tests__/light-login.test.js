// Tests for protocolLightLogin spawn glue in light-login.js.
// Mocks child_process.spawn to verify Node-side behavior without launching Python.

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const Module = require('module');

// Per-test mock for child_process.spawn injected via Module._cache override
let mockSpawn = null;
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'child_process') {
    return { spawn: mockSpawn || origRequire.call(this, 'child_process').spawn };
  }
  return origRequire.apply(this, arguments);
};

// Load light-login fresh so it picks up our mocked require
delete require.cache[require.resolve('../light-login')];
const { lightLogin, protocolLightLogin, LivenessLoginNotImplementedError } = require('../light-login');

// Restore real require for other tests after this file runs
process.on('exit', () => { Module.prototype.require = origRequire; });

function fakeChild({ stdoutTerminal = null, stderr = '', spawnError = null }) {
  const cp = new EventEmitter();
  cp.stdout = new EventEmitter();
  cp.stderr = new EventEmitter();
  cp.kill = () => {};
  cp.stdin = {
    write: () => {},
    end: () => {
      if (spawnError) {
        setImmediate(() => cp.emit('error', spawnError));
        return;
      }
      setImmediate(() => {
        if (stdoutTerminal) cp.stdout.emit('data', Buffer.from(stdoutTerminal + '\n'));
        if (stderr) cp.stderr.emit('data', Buffer.from(stderr));
        cp.emit('close', 0);
      });
    },
  };
  return cp;
}

test('P1 protocolMode=true + no password → throws "no password" without spawn', async () => {
  let spawned = false;
  mockSpawn = () => { spawned = true; return fakeChild({}); };
  await assert.rejects(
    () => lightLogin({ email: 'a@x.com', login_type: 'outlook' }, { protocolMode: true }),
    /no password/,
  );
  assert.strictEqual(spawned, false, 'spawn must NOT be called when pre-flight fails');
});

test('P2 outlook account missing client_id → throws "outlook oauth missing"', async () => {
  let spawned = false;
  mockSpawn = () => { spawned = true; return fakeChild({}); };
  await assert.rejects(
    () => lightLogin(
      { email: 'a@outlook.com', password: 'pwd', login_type: 'outlook' },
      { protocolMode: true },
    ),
    /outlook oauth missing/,
  );
  assert.strictEqual(spawned, false);
});

test('P3 spawn returns status:ok → resolves with {accessToken,accountId,expiresAtIso}', async () => {
  mockSpawn = () => fakeChild({
    stdoutTerminal: JSON.stringify({
      status: 'ok',
      accessToken: 'eyJ.test',
      accountId: 'acc_123',
      expiresAtIso: '2026-08-22T12:00:00+08:00',
    }),
  });
  const result = await lightLogin(
    { email: 'a@x.com', password: 'pwd', login_type: 'google', totp_secret: 'JBSW' },
    { protocolMode: true },
  );
  assert.strictEqual(result.accessToken, 'eyJ.test');
  assert.strictEqual(result.accountId, 'acc_123');
  assert.strictEqual(result.expiresAtIso, '2026-08-22T12:00:00+08:00');
});

test('P4 spawn returns status:error reason:"bad password" → rejects with Error.message containing "bad password"', async () => {
  mockSpawn = () => fakeChild({
    stdoutTerminal: JSON.stringify({ status: 'error', reason: 'bad password' }),
  });
  await assert.rejects(
    () => lightLogin(
      { email: 'a@x.com', password: 'wrong', login_type: 'google', totp_secret: 'JBSW' },
      { protocolMode: true },
    ),
    /bad password/,
  );
});

test('P5 spawn error event (ENOENT) → rejects with LivenessLoginNotImplementedError', async () => {
  const enoent = new Error('spawn py ENOENT');
  enoent.code = 'ENOENT';
  mockSpawn = () => fakeChild({ spawnError: enoent });
  try {
    await lightLogin(
      { email: 'a@x.com', password: 'pwd', login_type: 'google', totp_secret: 'JBSW' },
      { protocolMode: true },
    );
    assert.fail('expected rejection');
  } catch (e) {
    assert.strictEqual(e.name, 'LivenessLoginNotImplementedError');
  }
});
