const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');

const livenessRoutes = require('../routes/liveness');

function startServer(router) {
  const app = express();
  app.use(express.json());
  app.use('/api/liveness', router);
  return new Promise((res) => {
    const server = app.listen(0, '127.0.0.1', () => res({ server, port: server.address().port }));
  });
}

function fetchJson(port, method, path, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (r) => {
      let buf = '';
      r.on('data', (c) => buf += c);
      r.on('end', () => res({ status: r.statusCode, json: buf ? JSON.parse(buf) : null }));
    });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

test('POST /start with no emails expands to all accounts', async () => {
  let captured;
  const fakeRunner = {
    start: (emails) => { captured = emails; return { batchId: 'b1', total: emails.length }; },
    stop: () => ({ stopped: 0 }),
    status: () => ({ running: false }),
  };
  const accountsDB = { list: () => [{ email: 'a@x.com' }, { email: 'b@x.com' }] };
  const { server, port } = await startServer(livenessRoutes(fakeRunner, accountsDB));
  const r = await fetchJson(port, 'POST', '/api/liveness/start', {});
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(captured, ['a@x.com', 'b@x.com']);
  server.close();
});

test('POST /start with explicit emails passes through', async () => {
  let captured;
  const fakeRunner = {
    start: (emails) => { captured = emails; return { batchId: 'b2', total: emails.length }; },
    stop: () => ({ stopped: 0 }),
    status: () => ({ running: false }),
  };
  const accountsDB = { list: () => [] };
  const { server, port } = await startServer(livenessRoutes(fakeRunner, accountsDB));
  const r = await fetchJson(port, 'POST', '/api/liveness/start', { emails: ['x@y.com'] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.batchId, 'b2');
  assert.deepStrictEqual(captured, ['x@y.com']);
  server.close();
});

test('POST /start returns 409 when runner already running', async () => {
  const fakeRunner = {
    start: () => { throw new Error('liveness already running'); },
    stop: () => ({ stopped: 0 }),
    status: () => ({ running: true }),
  };
  const accountsDB = { list: () => [{ email: 'a@x.com' }] };
  const { server, port } = await startServer(livenessRoutes(fakeRunner, accountsDB));
  const r = await fetchJson(port, 'POST', '/api/liveness/start', {});
  assert.strictEqual(r.status, 409);
  assert.match(r.json.error, /already running/);
  server.close();
});

test('GET /status returns runner snapshot', async () => {
  const fakeRunner = {
    start: () => ({}),
    stop: () => ({ stopped: 0 }),
    status: () => ({ running: true, batchId: 'b3', total: 5, done: 2, summary: { plus: 2 }, startedAt: '2026-05-24T01:00:00Z' }),
  };
  const accountsDB = { list: () => [] };
  const { server, port } = await startServer(livenessRoutes(fakeRunner, accountsDB));
  const r = await fetchJson(port, 'GET', '/api/liveness/status');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.batchId, 'b3');
  assert.strictEqual(r.json.done, 2);
  server.close();
});

test('POST /stop returns stopped count', async () => {
  const fakeRunner = {
    start: () => ({}),
    stop: () => ({ stopped: 7 }),
    status: () => ({ running: false }),
  };
  const accountsDB = { list: () => [] };
  const { server, port } = await startServer(livenessRoutes(fakeRunner, accountsDB));
  const r = await fetchJson(port, 'POST', '/api/liveness/stop');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.stopped, 7);
  server.close();
});
