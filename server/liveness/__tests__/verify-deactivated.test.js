const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { verifyDeactivated } = require('../checker');

function fakeChild({ stdoutLines = [], stderr = '', errorEvent = null }) {
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

const account = { email: 'a@x.com', client_id: 'c', refresh_token: 'r' };

test('verifyDeactivated: stdout deactivated → status deactivated', async () => {
  const r = await verifyDeactivated(account, {
    spawnImpl: fakeSpawn({ stdoutLines: ['{"status":"deactivated","reason":"account_deactivated"}'] }),
  });
  assert.strictEqual(r.status, 'deactivated');
  assert.strictEqual(r.reason, 'account_deactivated');
});

test('verifyDeactivated: stdout active → status active', async () => {
  const r = await verifyDeactivated(account, {
    spawnImpl: fakeSpawn({ stdoutLines: ['{"status":"active","reason":null}'] }),
  });
  assert.strictEqual(r.status, 'active');
});

test('verifyDeactivated: stdout error → status error', async () => {
  const r = await verifyDeactivated(account, {
    spawnImpl: fakeSpawn({ stdoutLines: ['{"status":"error","reason":"homepage failed"}'] }),
  });
  assert.strictEqual(r.status, 'error');
  assert.match(r.reason, /homepage failed/);
});

test('verifyDeactivated: spawn ENOENT → status error spawn error', async () => {
  const err = new Error('spawn py ENOENT'); err.code = 'ENOENT';
  const r = await verifyDeactivated(account, {
    spawnImpl: fakeSpawn({ errorEvent: err }),
  });
  assert.strictEqual(r.status, 'error');
  assert.match(r.reason, /spawn error/);
});

test('verifyDeactivated: stdout unparsable → status error unparsable', async () => {
  const r = await verifyDeactivated(account, {
    spawnImpl: fakeSpawn({ stdoutLines: ['not json'], stderr: 'Traceback no curl_cffi' }),
  });
  assert.strictEqual(r.status, 'error');
  assert.match(r.reason, /unparsable/);
});

test('verifyDeactivated: onLog callback forwards Python {"log": ...} lines', async () => {
  const logs = [];
  await verifyDeactivated(account, {
    spawnImpl: fakeSpawn({
      stdoutLines: [
        '{"log":"  [Deactivated] Step 0: Homepage..."}',
        '{"log":"  [Deactivated] Step 2: Authorize -> /email-verification (not deactivated)"}',
        '{"status":"active","reason":null}',
      ],
    }),
    onLog: (level, msg) => logs.push({ level, msg }),
  });
  assert.strictEqual(logs.length, 2);
  assert.strictEqual(logs[0].level, 'info');
  assert.match(logs[0].msg, /Step 0: Homepage/);
  assert.match(logs[1].msg, /Step 2: Authorize/);
});
