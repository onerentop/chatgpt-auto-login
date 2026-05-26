const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

function freshProxyWithMocks({ subscription, singbox, clashApi, blacklist, configJson }) {
  // Pin the mocked clash-api directly into require.cache so health-probe.js
  // (lazy-required from inside runHealthProbe()) also picks it up.
  const clashApiPath = require.resolve('../clash-api');
  delete require.cache[clashApiPath];
  require.cache[clashApiPath] = { id: clashApiPath, filename: clashApiPath, loaded: true, exports: clashApi };

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
  delete require.cache[require.resolve('../health-probe')];
  const p = require('../index');
  Module.prototype.require = origRequire;
  return p;
}

// Build a mock clashApi where node "good-*" returns 100ms delay, "bad-*" returns null (dead).
function makeClashWithProbeResults(map) {
  return {
    switchSelector: async () => {},
    testNodeDelay: async (tag) => map[tag] ?? null,
  };
}

const baseMocks = (nodes, probeMap = {}) => ({
  subscription: {
    fetchAndParse: async () => nodes,
    filterByRegion: (all) => all,
    filterByJpKddi: () => [],
    filterByWhitelist: () => [],
  },
  singbox: { start: async () => {}, stop: async () => {} },
  clashApi: makeClashWithProbeResults(probeMap),
  blacklist: { __setDb: () => {}, add: () => {}, remove: () => {}, removeAll: () => {}, loadAll: () => [], pruneExpired: () => {} },
  configJson: {
    proxy: {
      enabled: true,
      subscriptionUrl: 'http://x',
      regionFilter: 'US',
      rotationStrategy: 'sequential',
      jpCheckout: { enabled: false },
      activeHealthCheck: true,
    },
  },
});

test('PX-7: runHealthProbe 标 alive 节点为 alive，无响应为 dead', { skip: 'v2.42 Task 8: runHealthProbe / probeResults 已删（sing-box urltest 自做 latency probe）' }, async () => {
  const nodes = ['a', 'b', 'c'].map((tag) => ({ type: 'ss', tag }));
  const p = freshProxyWithMocks(baseMocks(nodes, { a: 120, b: null, c: 80 }));
  await p.refresh();
  await p.runHealthProbe();
  const s = p.getState();
  assert.strictEqual(s.probeResults.a.alive, true, 'a alive (120ms)');
  assert.strictEqual(s.probeResults.b.alive, false, 'b dead (null delay)');
  assert.strictEqual(s.probeResults.c.alive, true, 'c alive (80ms)');
  assert.strictEqual(s.probeSummary.alive, 2);
  assert.strictEqual(s.probeSummary.dead, 1);
  assert.strictEqual(s.probeSummary.total, 3);
});

test('PX-7: rotate() 在有 alive 节点时跳过 dead 节点', { skip: 'v2.42 Task 8: rotate / probeResults 已 stub 化' }, async () => {
  // sequence: a dead, b alive, c dead
  const nodes = ['a', 'b', 'c'].map((tag) => ({ type: 'ss', tag }));
  const p = freshProxyWithMocks(baseMocks(nodes, { a: null, b: 100, c: null }));
  await p.refresh();
  await p.runHealthProbe();
  // Pre-condition
  assert.strictEqual(p.getState().probeResults.a.alive, false);
  assert.strictEqual(p.getState().probeResults.b.alive, true);
  // rotate() should land on b (skipping a, c which are dead).
  // sequential: starts at index 0 → rotate increments to 1 (b)
  await p.rotate();
  assert.strictEqual(p.getState().currentNode, 'b');
});

test('PX-7: rotate() 回退到原逻辑 — 全部 dead 时不再跳', { skip: 'v2.42 Task 8: rotate / probeResults 已 stub 化' }, async () => {
  // All nodes dead by probe — rotate must still pick something.
  const nodes = ['a', 'b'].map((tag) => ({ type: 'ss', tag }));
  const p = freshProxyWithMocks(baseMocks(nodes, { a: null, b: null }));
  await p.refresh();
  await p.runHealthProbe();
  await p.rotate();
  assert.ok(['a', 'b'].includes(p.getState().currentNode), 'must pick some node');
});

test('PX-7: probeAllNodes 跳过 manual-blacklisted 节点 (shouldSkip)', { skip: 'v2.42 Task 8: runHealthProbe 已删' }, async () => {
  // Disable auto-probe via config so we control timing — blacklist before probe.
  const nodes = ['a', 'b'].map((tag) => ({ type: 'ss', tag }));
  const mocks = baseMocks(nodes, { a: 100, b: 80 });
  mocks.configJson.proxy.activeHealthCheck = false;
  const p = freshProxyWithMocks(mocks);
  await p.refresh();
  p.blacklistManually('a', 'main');  // manual ban — must precede probe
  await p.runHealthProbe();
  const s = p.getState();
  // 'a' should NOT have a probeResults entry (skipped via shouldSkip → isBad)
  assert.ok(!('a' in s.probeResults), 'manually-blacklisted "a" should not be probed');
  // 'b' should be alive
  assert.strictEqual(s.probeResults.b.alive, true);
});

test('PX-7: getState() exposes probeSummary as plain object', { skip: 'v2.42 Task 8: probeSummary 已从 getState 移除' }, () => {
  const nodes = ['a'].map((tag) => ({ type: 'ss', tag }));
  const p = freshProxyWithMocks(baseMocks(nodes, {}));
  const s = p.getState();
  assert.ok('probeSummary' in s);
  assert.strictEqual(typeof s.probeSummary, 'object');
  assert.ok('alive' in s.probeSummary);
  assert.ok('dead' in s.probeSummary);
  assert.ok('total' in s.probeSummary);
});
