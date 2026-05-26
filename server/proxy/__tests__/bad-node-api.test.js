// v2.42 Task 9: POST /api/proxy/bad-node + /unban-node 路由测试
//
// 业务遇 Cloudflare 403 / rate_limited 等显式失败时 fire-and-forget 调这个 API。
// server 自己查 getActiveNode(channel) 后 ban。durationMinutes 默认 5 分钟。

const test = require('node:test');
const assert = require('node:assert');

function freshApp({ proxyMock, dbMock }) {
  // db / proxy 都 pin 到 require.cache —— 路由内的 lazy require('../db') 也读到 mock。
  const dbPath = require.resolve('../../db');
  const proxyPath = require.resolve('../../proxy');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };
  require.cache[proxyPath] = { id: proxyPath, filename: proxyPath, loaded: true, exports: proxyMock };
  delete require.cache[require.resolve('../../routes/proxy')];
  const router = require('../../routes/proxy');
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

function mkProxyMock({ activeNode = 'us-mock-1', state = {} } = {}) {
  const calls = [];
  return {
    calls,
    getActiveNode: async (channel) => { calls.push({ fn: 'getActiveNode', channel }); return activeNode; },
    banFromUrltest: async (node, dur) => { calls.push({ fn: 'banFromUrltest', node, dur }); },
    unbanNode: async (node) => { calls.push({ fn: 'unbanNode', node }); },
    // 路由其它端点用得着的 stub
    getState: () => ({ badNodes: {}, jp: { badNodes: {} }, ...state }),
    blacklistManually: () => {}, removeFromBlacklist: () => {}, clearBlacklist: () => {},
    refresh: async () => 0, stop: async () => {}, rotate: async () => '', switchTo: async () => '',
    markBad: () => {}, markJpBad: () => {}, rotateJp: async () => '',
    detectExit: async () => '', detectJpExit: async () => '',
  };
}

function mkDbMock() {
  const dbCalls = [];
  return {
    dbCalls,
    proxyDB: {
      banNode: (tag, reason, untilMs, channel) => dbCalls.push({ fn: 'banNode', tag, reason, untilMs, channel }),
      unbanNode: (tag, channel) => dbCalls.push({ fn: 'unbanNode', tag, channel }),
      listBanned: () => [],
    },
  };
}

test('POST /bad-node: reason=cloudflare_403 → ban 当前 active 节点 + DB 持久化', async () => {
  const proxyMock = mkProxyMock({ activeNode: 'us-mock-1' });
  const dbMock = mkDbMock();
  const app = freshApp({ proxyMock, dbMock });

  const r = await request(app, 'POST', '/api/proxy/bad-node', {
    reason: 'cloudflare_403', channel: 'main', durationMinutes: 3,
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.banned, 'us-mock-1');
  assert.match(r.body.until, /^\d{4}-\d{2}-\d{2}T/);

  // proxyMgr 调用顺序：getActiveNode → banFromUrltest
  const fns = proxyMock.calls.map(c => c.fn);
  assert.deepStrictEqual(fns, ['getActiveNode', 'banFromUrltest']);
  assert.strictEqual(proxyMock.calls[0].channel, 'main');
  assert.strictEqual(proxyMock.calls[1].node, 'us-mock-1');
  assert.strictEqual(proxyMock.calls[1].dur, 3);

  // DB 持久化也调了
  assert.strictEqual(dbMock.dbCalls.length, 1);
  assert.strictEqual(dbMock.dbCalls[0].fn, 'banNode');
  assert.strictEqual(dbMock.dbCalls[0].tag, 'us-mock-1');
  assert.strictEqual(dbMock.dbCalls[0].reason, 'cloudflare_403');
  assert.strictEqual(dbMock.dbCalls[0].channel, 'main');
});

test('POST /bad-node: 不传 durationMinutes 默认 5 分钟', async () => {
  const proxyMock = mkProxyMock({ activeNode: 'us-2' });
  const dbMock = mkDbMock();
  const app = freshApp({ proxyMock, dbMock });
  const r = await request(app, 'POST', '/api/proxy/bad-node', { reason: 'rate_limited' });
  assert.strictEqual(r.status, 200);
  // banFromUrltest 调用拿到 dur=5
  const banCall = proxyMock.calls.find(c => c.fn === 'banFromUrltest');
  assert.strictEqual(banCall.dur, 5);
});

test('POST /bad-node: unknown reason → 400 + valid 列表', async () => {
  const proxyMock = mkProxyMock();
  const dbMock = mkDbMock();
  const app = freshApp({ proxyMock, dbMock });
  const r = await request(app, 'POST', '/api/proxy/bad-node', { reason: 'bogus' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.error, 'unknown reason');
  assert.ok(Array.isArray(r.body.valid));
  assert.ok(r.body.valid.includes('cloudflare_403'));
  // 没有调用 getActiveNode/banFromUrltest
  assert.strictEqual(proxyMock.calls.length, 0);
});

test('POST /bad-node: 非法 channel → 400', async () => {
  const proxyMock = mkProxyMock();
  const dbMock = mkDbMock();
  const app = freshApp({ proxyMock, dbMock });
  const r = await request(app, 'POST', '/api/proxy/bad-node', { reason: 'custom', channel: 'us' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /channel/);
});

test('POST /bad-node: getActiveNode 返 null（无 active 节点）→ ok 但 banned=null', async () => {
  const proxyMock = mkProxyMock({ activeNode: null });
  const dbMock = mkDbMock();
  const app = freshApp({ proxyMock, dbMock });
  const r = await request(app, 'POST', '/api/proxy/bad-node', { reason: 'openai_403', channel: 'jp' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.banned, null);
  // 没调 banFromUrltest（无节点可 ban）
  assert.ok(!proxyMock.calls.some(c => c.fn === 'banFromUrltest'));
  // 也没调 DB 持久化
  assert.strictEqual(dbMock.dbCalls.length, 0);
});

test('POST /unban-node: 调 proxy.unbanNode + DB.unbanNode', async () => {
  const proxyMock = mkProxyMock();
  const dbMock = mkDbMock();
  const app = freshApp({ proxyMock, dbMock });
  const r = await request(app, 'POST', '/api/proxy/unban-node', { node: 'us-1', channel: 'main' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.ok(proxyMock.calls.some(c => c.fn === 'unbanNode' && c.node === 'us-1'));
  assert.ok(dbMock.dbCalls.some(c => c.fn === 'unbanNode' && c.tag === 'us-1' && c.channel === 'main'));
});

test('POST /unban-node: 缺 node → 400', async () => {
  const proxyMock = mkProxyMock();
  const dbMock = mkDbMock();
  const app = freshApp({ proxyMock, dbMock });
  const r = await request(app, 'POST', '/api/proxy/unban-node', {});
  assert.strictEqual(r.status, 400);
  assert.strictEqual(proxyMock.calls.length, 0);
});
