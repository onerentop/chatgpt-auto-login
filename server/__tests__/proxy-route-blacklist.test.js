const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

function freshApp({ proxyMock, dbMock }) {
  // db.js 在 routes/proxy.js 里是 lazy-require（handler 内），所以 Module.prototype.require hook
  // 在 freshApp 退出后已恢复，无法拦截 lazy 调用。改用 require.cache pinning。
  const dbPath = require.resolve('../db');
  delete require.cache[dbPath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: dbMock || { proxyDB: { listBanned: () => [], unbanNode: () => {}, banNode: () => {} } },
  };
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

test('GET /blacklist 返回 main + jp 两数组 (v2.42.1: DB-backed superset schema)', async () => {
  const expiresAt = Date.now() + 60000;
  // v2.42.1: GET /blacklist 已改为从 proxyDB.listBanned(channel) 读，不再读 proxy.getState().badNodes。
  const dbMock = {
    proxyDB: {
      listBanned: (channel) => {
        if (channel === 'main') return [{ tag: 'us-1', reason: 'tls', expires_at: expiresAt }];
        if (channel === 'jp') return [{ tag: 'jp-1', reason: 'empty', expires_at: expiresAt + 1000 }];
        return [];
      },
      unbanNode: () => {},
      banNode: () => {},
    },
  };
  const proxyMock = mkProxyMock({ badNodes: {}, jp: { badNodes: {} } });
  const app = freshApp({ proxyMock, dbMock });
  const r = await request(app, 'GET', '/api/proxy/blacklist');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.main.length, 1);
  // 新 schema 字段
  assert.strictEqual(r.body.main[0].node, 'us-1');
  assert.strictEqual(r.body.main[0].reason, 'tls');
  assert.ok(typeof r.body.main[0].bannedUntil === 'string' && r.body.main[0].bannedUntil.includes('T'));
  assert.ok(typeof r.body.main[0].addedAt === 'number');
  // v2.30 向后兼容字段（部分老前端 / 测试仍读）
  assert.strictEqual(r.body.main[0].tag, 'us-1');
  assert.strictEqual(r.body.main[0].source, 'auto');
  assert.ok(r.body.main[0].ttlRemainingMs > 0 && r.body.main[0].ttlRemainingMs <= 60000);
  // JP channel
  assert.strictEqual(r.body.jp.length, 1);
  assert.strictEqual(r.body.jp[0].node, 'jp-1');
  assert.strictEqual(r.body.jp[0].reason, 'empty');
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
