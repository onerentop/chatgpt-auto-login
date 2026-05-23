const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

function freshProxyWithMocks({ subscription, singbox, clashApi, blacklist, configJson }) {
  const origRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === './subscription') return subscription;
    if (id === './singbox') return singbox;
    if (id === './clash-api') return clashApi;
    if (id === './blacklist') return blacklist;
    if (id === 'fs') {
      const fs = origRequire.call(this, 'fs');
      return {
        ...fs,
        readFileSync: (p, enc) => {
          if (typeof p === 'string' && p.endsWith('config.json')) return JSON.stringify(configJson);
          return fs.readFileSync(p, enc);
        },
      };
    }
    return origRequire.apply(this, arguments);
  };
  delete require.cache[require.resolve('../index')];
  delete require.cache[require.resolve('../blacklist')];
  const p = require('../index');
  Module.prototype.require = origRequire;
  return p;
}

const defaultMocks = (nodes) => ({
  subscription: {
    fetchAndParse: async () => nodes,
    filterByRegion: (all) => all,
    filterByJpKddi: () => [],
    filterByWhitelist: () => [],
  },
  singbox: { start: async () => {}, stop: async () => {} },
  clashApi: { switchSelector: async () => {} },
  blacklist: { __setDb: () => {}, add: () => {}, remove: () => {}, removeAll: () => {}, loadAll: () => [], pruneExpired: () => {} },
  configJson: {
    proxy: { enabled: true, subscriptionUrl: 'http://x', regionFilter: 'US', rotationStrategy: 'sequential', jpCheckout: { enabled: false } },
  },
});

test('R1 refresh 不重置 rotationIndex（节点池长度不变）', async () => {
  const nodes = Array.from({ length: 8 }, (_, i) => ({ type: 'ss', tag: `us-${i}` }));
  const p = freshProxyWithMocks(defaultMocks(nodes));
  await p.refresh();
  await p.rotate(); await p.rotate(); await p.rotate();
  const idxBefore = p.getState().rotationIndex;
  assert.strictEqual(idxBefore, 3);
  await p.refresh();
  const idxAfter = p.getState().rotationIndex;
  assert.strictEqual(idxAfter, 3, 'refresh 不应把 rotationIndex 重置到 0');
  assert.strictEqual(p.getState().currentNode, 'us-3', 'currentNode 应跟随 rotationIndex');
});

test('R2 refresh 后节点列表变短：rotationIndex 取模到合法范围', async () => {
  const nodes10 = Array.from({ length: 10 }, (_, i) => ({ type: 'ss', tag: `us-${i}` }));
  let currentNodes = nodes10;
  const mocks = defaultMocks(nodes10);
  mocks.subscription.fetchAndParse = async () => currentNodes;
  mocks.subscription.filterByRegion = (all) => all;
  const p = freshProxyWithMocks(mocks);
  await p.refresh();
  await p.rotate(); await p.rotate(); await p.rotate(); await p.rotate(); await p.rotate();
  await p.rotate(); await p.rotate();
  assert.strictEqual(p.getState().rotationIndex, 7);
  currentNodes = nodes10.slice(0, 3);
  await p.refresh();
  assert.strictEqual(p.getState().rotationIndex, 7 % 3, '应取模到 1');
  assert.strictEqual(p.getState().currentNode, 'us-1');
});

test('R3 refresh 后节点列表为空：rotationIndex 安全 reset 为 0', async () => {
  const mocks = defaultMocks([]);
  mocks.configJson.proxy.enabled = false;
  mocks.configJson.proxy.jpCheckout.enabled = true;
  mocks.subscription.fetchAndParse = async () => [{ type: 'ss', tag: 'jp-1' }];
  mocks.subscription.filterByJpKddi = (all) => all;
  mocks.configJson.proxy.jpCheckout.keyword = 'jp';
  const p = freshProxyWithMocks(mocks);
  await p.refresh();
  assert.strictEqual(p.getState().rotationIndex, 0);
  assert.strictEqual(p.getState().currentNode, '');
});

test('R4 refresh 后 currentNode 跟随 rotationIndex 而非 filtered[0]', async () => {
  const nodes = Array.from({ length: 5 }, (_, i) => ({ type: 'ss', tag: `us-${i}` }));
  const p = freshProxyWithMocks(defaultMocks(nodes));
  await p.refresh();
  await p.rotate(); await p.rotate();
  assert.strictEqual(p.getState().currentNode, 'us-2');
  await p.refresh();
  assert.strictEqual(p.getState().currentNode, 'us-2');
});

test('R5 hydrate：首次 refresh 从 DB 灌入黑名单', async () => {
  const mocks = defaultMocks([{ type: 'ss', tag: 'us-1' }]);
  const loadCalls = [];
  mocks.blacklist.loadAll = (ch) => {
    loadCalls.push(ch);
    if (ch === 'main') return [{ tag: 'us-old-bad', expiresAt: Date.now() + 600000, reason: 'persisted', source: 'auto' }];
    return [];
  };
  const p = freshProxyWithMocks(mocks);
  await p.refresh();
  assert.deepStrictEqual(loadCalls, ['main', 'jp'], '应读 main + jp 两次');
  assert.strictEqual(p.isBad('us-old-bad'), true);
  loadCalls.length = 0;
  await p.refresh();
  assert.strictEqual(loadCalls.length, 0, 'badNodes 非空时不再 hydrate');
});
