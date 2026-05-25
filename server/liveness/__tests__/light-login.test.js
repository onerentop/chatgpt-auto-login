// 注意：此文件 monkey-patch Module.prototype.require 拦截 child_process.spawn，
// 必须串行执行（不能加 --concurrency）。当前 npm test 默认串行；若未来加并发，
// 这里的 mock 会泄漏到其他测试文件的 spawn 调用。

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

// ---------------------------------------------------------------------------
// Browser-path tests (restored from commit 2696666, v2.26 Phase A)
// These cover the Playwright lightLogin branch (protocolMode: false/undefined).
// The spawn mock above intercepts child_process but only activates when
// protocolMode=true — browser tests are unaffected.
// ---------------------------------------------------------------------------

function fakeBrowser(scenario) {
  return {
    close: async () => {},
    newContext: async () => ({
      close: async () => {},
      newPage: async () => ({
        close: async () => {},
        goto: async (url) => {
          if (scenario === 'proxy-reset') { throw new Error('net::ERR_CONNECTION_RESET'); }
        },
        fill: async () => {},
        click: async () => {},
        url: () => scenario === 'bad-password' ? 'https://auth.openai.com/u/login/password?error=invalid' : 'https://chatgpt.com/',
        waitForURL: async () => {
          if (scenario === 'captcha') throw new Error('Timeout: waitForURL captcha');
        },
        waitForSelector: async () => {
          if (scenario === 'otp-timeout') throw new Error('Timeout waiting for OTP input');
        },
        request: {
          get: async (url) => {
            if (scenario === 'no-session') return { status: () => 200, json: async () => null };
            if (scenario === 'ok') return {
              status: () => 200,
              json: async () => ({
                accessToken: 'eyJ.test.sig',
                user: { id: 'user-x', email: 'a@x.com' },
                expires: '2026-06-07T12:00:00Z',
              }),
            };
            throw new Error('unreachable');
          },
        },
      }),
    }),
  };
}

const fakeOtp = {
  ok: async () => '123456',
  timeout: async () => { throw new Error('IMAP timeout'); },
};

test('happy path: returns accessToken/accountId/expiresAtIso', async () => {
  const r = await lightLogin(
    { email: 'a@x.com', password: 'p', login_type: 'outlook', client_id: 'c', refresh_token: 'r' },
    { protocolMode: false, playwrightConnect: async () => fakeBrowser('ok'), getOtp: fakeOtp.ok }
  );
  assert.strictEqual(r.accessToken, 'eyJ.test.sig');
  assert.ok(r.expiresAtIso.includes('+08:00'), 'expiresAtIso is CST');
});

test('bad password rejects with bad password', async () => {
  await assert.rejects(
    lightLogin({ email: 'a@x.com', password: 'wrong', login_type: 'outlook', client_id: 'c', refresh_token: 'r' },
      { protocolMode: false, playwrightConnect: async () => fakeBrowser('bad-password'), getOtp: fakeOtp.ok }),
    /bad password/
  );
});

test('OTP timeout rejects with otp timeout', async () => {
  await assert.rejects(
    lightLogin({ email: 'a@x.com', password: 'p', login_type: 'outlook', client_id: 'c', refresh_token: 'r' },
      { protocolMode: false, playwrightConnect: async () => fakeBrowser('otp-timeout'), getOtp: fakeOtp.timeout }),
    /otp timeout/
  );
});

test('captcha rejects with captcha', async () => {
  await assert.rejects(
    lightLogin({ email: 'a@x.com', password: 'p', login_type: 'outlook', client_id: 'c', refresh_token: 'r' },
      { protocolMode: false, playwrightConnect: async () => fakeBrowser('captcha'), getOtp: fakeOtp.ok }),
    /captcha/
  );
});

test('null session rejects with no session', async () => {
  await assert.rejects(
    lightLogin({ email: 'a@x.com', password: 'p', login_type: 'outlook', client_id: 'c', refresh_token: 'r' },
      { protocolMode: false, playwrightConnect: async () => fakeBrowser('no-session'), getOtp: fakeOtp.ok }),
    /no session/
  );
});

test('proxy reset rejects with proxy reset', async () => {
  await assert.rejects(
    lightLogin({ email: 'a@x.com', password: 'p', login_type: 'outlook', client_id: 'c', refresh_token: 'r' },
      { protocolMode: false, playwrightConnect: async () => fakeBrowser('proxy-reset'), getOtp: fakeOtp.ok }),
    /proxy reset/
  );
});

test('missing password rejects with no password', async () => {
  await assert.rejects(
    lightLogin({ email: 'a@x.com', password: '', login_type: 'outlook' },
      { protocolMode: false, playwrightConnect: async () => fakeBrowser('ok'), getOtp: fakeOtp.ok }),
    /no password/
  );
});

test('outlook account missing IMAP creds rejects with outlook oauth missing', async () => {
  await assert.rejects(
    lightLogin({ email: 'noimap@outlook.com', password: 'p', login_type: 'outlook' },
      { protocolMode: false, playwrightConnect: async () => fakeBrowser('ok'), getOtp: fakeOtp.ok }),
    /outlook oauth missing/
  );
});

// Belt-and-suspenders restore: process.on('exit') above is the safety net for
// abrupt termination; this test() runs at the end of THIS file's test
// queue, restoring require before any subsequent test file loads.
test('cleanup: restore Module.prototype.require', () => {
  Module.prototype.require = origRequire;
});
