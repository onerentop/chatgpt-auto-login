const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { probe, decodeJwtExp, mapPlanType, mapTerminal } = require('../checker');

function jwtWithExp(expSec) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url');
  return `${header}.${payload}.sig`;
}

// Build a fake child-process that emits the given JSON-lines on stdout
// then closes. Mirrors enough of the real ChildProcess interface for checker.js.
function fakeChild({ stdoutLines = [], stderr = '', errorEvent = null, holdOpen = false }) {
  const cp = new EventEmitter();
  cp.stdout = new EventEmitter();
  cp.stderr = new EventEmitter();
  cp.stdin = {
    write: () => {},
    end: () => {
      if (errorEvent) {
        setImmediate(() => cp.emit('error', errorEvent));
        return;
      }
      if (holdOpen) return;  // never close — used for timeout test
      setImmediate(() => {
        for (const line of stdoutLines) cp.stdout.emit('data', Buffer.from(line + '\n'));
        if (stderr) cp.stderr.emit('data', Buffer.from(stderr));
        cp.emit('close');
      });
    },
  };
  cp.kill = () => {};
  return cp;
}

function fakeSpawn(opts) {
  return () => fakeChild(opts);
}

// === Pure helper unit tests (no spawn) ===

test('decodeJwtExp parses exp from JWT payload', () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  assert.strictEqual(decodeJwtExp(jwtWithExp(exp)), exp);
});

test('decodeJwtExp returns 0 on malformed JWT', () => {
  assert.strictEqual(decodeJwtExp('not-a-jwt'), 0);
  assert.strictEqual(decodeJwtExp(''), 0);
});

test('mapPlanType: plus → alive_status=plus', () => {
  assert.deepStrictEqual(mapPlanType('plus'), { alive_status: 'plus', alive_reason: 'check ok' });
});

test('mapPlanType: free → canceled', () => {
  assert.deepStrictEqual(mapPlanType('free'), { alive_status: 'canceled', alive_reason: 'no plus' });
});

test('mapPlanType: team/enterprise → canceled w/ plan name', () => {
  assert.deepStrictEqual(mapPlanType('team'), { alive_status: 'canceled', alive_reason: 'plan: team' });
});

// === probe() tests with spawnImpl injection ===

test('probe: JWT already expired returns token_expired without spawning', async () => {
  let spawnCalls = 0;
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) - 10), {
    spawnImpl: () => { spawnCalls++; return fakeChild({ stdoutLines: [] }); },
  });
  assert.strictEqual(r.alive_status, 'token_expired');
  assert.strictEqual(spawnCalls, 0, 'spawn should NOT be called for locally-expired JWT');
});

test('probe: ok 200 plan_type=plus → plus', async () => {
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), {
    spawnImpl: fakeSpawn({ stdoutLines: ['{"status":"ok","http":200,"plan_type":"plus","reason":null}'] }),
  });
  assert.strictEqual(r.alive_status, 'plus');
});

test('probe: ok 200 plan_type=free → canceled', async () => {
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), {
    spawnImpl: fakeSpawn({ stdoutLines: ['{"status":"ok","http":200,"plan_type":"free","reason":null}'] }),
  });
  assert.strictEqual(r.alive_status, 'canceled');
});

test('probe: error 401 → token_expired', async () => {
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), {
    spawnImpl: fakeSpawn({ stdoutLines: ['{"status":"error","http":401,"plan_type":null,"reason":"token_expired"}'] }),
  });
  assert.strictEqual(r.alive_status, 'token_expired');
});

test('probe: error 403 cloudflare → proxy_error (network layer, not account)', async () => {
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), {
    spawnImpl: fakeSpawn({ stdoutLines: ['{"status":"error","http":403,"plan_type":null,"reason":"cloudflare blocked"}'] }),
  });
  assert.strictEqual(r.alive_status, 'proxy_error');
  assert.match(r.alive_reason, /cloudflare/);
});

test('probe: error 403 account_forbidden → login_fail', async () => {
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), {
    spawnImpl: fakeSpawn({ stdoutLines: ['{"status":"error","http":403,"plan_type":null,"reason":"account forbidden"}'] }),
  });
  assert.strictEqual(r.alive_status, 'login_fail');
});

test('probe: error 503 → network_error', async () => {
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), {
    spawnImpl: fakeSpawn({ stdoutLines: ['{"status":"error","http":503,"plan_type":null,"reason":"http 503"}'] }),
  });
  assert.strictEqual(r.alive_status, 'network_error');
});

test('probe: spawn ENOENT (Python not in PATH) → network_error', async () => {
  const err = new Error('spawn py ENOENT');
  err.code = 'ENOENT';
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), {
    spawnImpl: fakeSpawn({ errorEvent: err }),
  });
  assert.strictEqual(r.alive_status, 'network_error');
  assert.match(r.alive_reason, /spawn error/);
});

test('probe: stdout unparsable → network_error with stderr tail', async () => {
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), {
    spawnImpl: fakeSpawn({ stdoutLines: ['this is not json'], stderr: 'Traceback ModuleNotFoundError curl_cffi' }),
  });
  assert.strictEqual(r.alive_status, 'network_error');
  assert.match(r.alive_reason, /unparsable/);
});
