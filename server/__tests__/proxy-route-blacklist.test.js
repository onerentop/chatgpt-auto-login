const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

function freshApp({ proxyMock }) {
  const origRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === '../proxy') return proxyMock;
    return origRequire.apply(this, arguments);
  };
  delete require.cache[require.resolve('../routes/proxy')];
  const router = require('../routes/proxy');
  Module.prototype.require = origRequire;
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/proxy', router);
  return app;
}

async function request(app, method, url, body) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { 'content-type': 'application/json' } }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

function mkProxyMock(state) {
  const calls = [];
  return {
    calls,
    getState: () => state,
    blacklistManually: (tag, channel, ttlMs, reason) => calls.push({ fn: 'blacklistManually', tag, channel, ttlMs, reason }),
    removeFromBlacklist: (tag, channel) => calls.push({ fn: 'removeFromBlacklist', tag, channel }),
    clearBlacklist: (channel) => calls.push({ fn: 'clearBlacklist', channel }),
    // Stubs for unrelated endpoints that exist on the router but we don't exercise here
    refresh: async () => 0, stop: async () => {}, rotate: async () => '', switchTo: async () => '',
    markBad: () => {}, markJpBad: () => {}, rotateJp: async () => '',
    detectExit: async () => '', detectJpExit: async () => '',
  };
}

test('GET /blacklist 返回 main + jp 两数组，含 ttlRemainingMs', async () => {
  const expiresAt = Date.now() + 60000;
  const state = {
    badNodes: { 'us-1': { expiresAt, reason: 'tls', source: 'auto' } },
    jp: { badNodes: { 'jp-1': { expiresAt: expiresAt + 1000, reason: 'empty', source: 'manual' } } },
  };
  const proxyMock = mkProxyMock(state);
  const app = freshApp({ proxyMock });
  const r = await request(app, 'GET', '/api/proxy/blacklist');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.main.length, 1);
  assert.strictEqual(r.body.main[0].tag, 'us-1');
  assert.strictEqual(r.body.main[0].reason, 'tls');
  assert.strictEqual(r.body.main[0].source, 'auto');
  assert.ok(r.body.main[0].ttlRemainingMs > 0 && r.body.main[0].ttlRemainingMs <= 60000);
  assert.strictEqual(r.body.jp.length, 1);
  assert.strictEqual(r.body.jp[0].source, 'manual');
});

test('POST /blacklist/add 校验 + 透传到 proxy.blacklistManually', async () => {
  const proxyMock = mkProxyMock({ badNodes: {}, jp: { badNodes: {} } });
  const app = freshApp({ proxyMock });
  let r = await request(app, 'POST', '/api/proxy/blacklist/add', { channel: 'main' });
  assert.strictEqual(r.status, 400);
  r = await request(app, 'POST', '/api/proxy/blacklist/add', { tag: 'x', channel: 'us' });
  assert.strictEqual(r.status, 400);
  r = await request(app, 'POST', '/api/proxy/blacklist/add', { tag: 'us-1', channel: 'main', ttlMs: 12345, reason: 'manual' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { main: [], jp: [] });
  assert.deepStrictEqual(proxyMock.calls, [{ fn: 'blacklistManually', tag: 'us-1', channel: 'main', ttlMs: 12345, reason: 'manual' }]);
});

test('POST /blacklist/remove 校验 + 透传', async () => {
  const proxyMock = mkProxyMock({ badNodes: {}, jp: { badNodes: {} } });
  const app = freshApp({ proxyMock });
  let r = await request(app, 'POST', '/api/proxy/blacklist/remove', { tag: 'x' });
  assert.strictEqual(r.status, 400);
  r = await request(app, 'POST', '/api/proxy/blacklist/remove', { tag: 'us-1', channel: 'main' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(proxyMock.calls, [{ fn: 'removeFromBlacklist', tag: 'us-1', channel: 'main' }]);
});

test('POST /blacklist/clear 仅校验 channel', async () => {
  const proxyMock = mkProxyMock({ badNodes: {}, jp: { badNodes: {} } });
  const app = freshApp({ proxyMock });
  let r = await request(app, 'POST', '/api/proxy/blacklist/clear', {});
  assert.strictEqual(r.status, 400);
  r = await request(app, 'POST', '/api/proxy/blacklist/clear', { channel: 'jp' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(proxyMock.calls, [{ fn: 'clearBlacklist', channel: 'jp' }]);
});
