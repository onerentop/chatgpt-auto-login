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

const baseMocks = (nodes, switchCalls = []) => ({
  subscription: {
    fetchAndParse: async () => nodes,
    filterByRegion: (all) => all,
    filterByJpKddi: () => [],
    filterByWhitelist: () => [],
  },
  singbox: { start: async () => {}, stop: async () => {} },
  clashApi: { switchSelector: async (tag, node) => { switchCalls.push([tag, node]); } },
  blacklist: { __setDb: () => {}, add: () => {}, remove: () => {}, removeAll: () => {}, loadAll: () => [], pruneExpired: () => {} },
  configJson: {
    proxy: { enabled: true, subscriptionUrl: 'http://x', regionFilter: 'US', rotationStrategy: 'sequential', jpCheckout: { enabled: false } },
  },
});

test('PX-3: refresh() syncs Clash selector to currentNode when rotationIndex != 0', async () => {
  const nodes = Array.from({ length: 5 }, (_, i) => ({ type: 'ss', tag: `us-${i}` }));
  const switchCalls = [];
  const p = freshProxyWithMocks(baseMocks(nodes, switchCalls));
  await p.refresh();
  // rotate twice → rotationIndex = 2, currentNode = us-2
  await p.rotate();
  await p.rotate();
  assert.strictEqual(p.getState().rotationIndex, 2);
  assert.strictEqual(p.getState().currentNode, 'us-2');
  const switchCountBeforeRefresh = switchCalls.length;
  // Now refresh — currentNode should remain us-2 AND clashApi.switchSelector
  // should be called at least once to sync the selector (the existing
  // rotate() calls already triggered switches; the new sync call should
  // happen on top of those).
  await p.refresh();
  assert.strictEqual(p.getState().currentNode, 'us-2', 'currentNode preserved across refresh');
  const newSyncCalls = switchCalls.slice(switchCountBeforeRefresh);
  assert.ok(
    newSyncCalls.some(([_, node]) => node === 'us-2'),
    `refresh() should call switchSelector with us-2 to sync, got: ${JSON.stringify(newSyncCalls)}`,
  );
});

test('PX-3: refresh() does NOT sync when rotationIndex === 0 (singbox default already matches)', async () => {
  const nodes = Array.from({ length: 5 }, (_, i) => ({ type: 'ss', tag: `us-${i}` }));
  const switchCalls = [];
  const p = freshProxyWithMocks(baseMocks(nodes, switchCalls));
  await p.refresh();
  // rotationIndex stays at 0; refresh again
  const before = switchCalls.length;
  await p.refresh();
  const after = switchCalls.slice(before);
  assert.strictEqual(after.length, 0, `no selector sync call when index=0, got: ${JSON.stringify(after)}`);
});

test('PX-5: rotate() preserves manual blacklist when clearing all-bad pool', async () => {
  const nodes = [
    { type: 'ss', tag: 'a' },
    { type: 'ss', tag: 'b' },
  ];
  const switchCalls = [];
  const p = freshProxyWithMocks(baseMocks(nodes, switchCalls));
  await p.refresh();
  // Manually blacklist 'a', auto-blacklist 'b' via 3 failures
  p.blacklistManually('a', 'main');
  p.recordBadAttempt('b', 'main', 'fail1');
  p.recordBadAttempt('b', 'main', 'fail2');
  p.recordBadAttempt('b', 'main', 'fail3');
  // Now both are bad. rotate() should clear only the auto entry (b),
  // and pick a from the remaining (since after clearing autos, only 'a' is
  // still bad, then rotate would still find no non-bad nodes, and fall to
  // the last-resort clear. Let me re-check the logic...)
  //
  // Actually:
  //  - bad: { a: manual, b: auto }
  //  - rotate first pass: cycle a, b — both bad → nextTag=null
  //  - autoTags = [b]; clear b → bad: { a: manual }
  //  - second loop: cycle b first (index++), b is not bad → nextTag = b
  //  - sets currentNode = b
  await p.rotate();
  const state = p.getState();
  // 'a' should still be manually blacklisted (not cleared)
  assert.ok(Object.keys(state.badNodes).includes('a'), `manual entry 'a' must survive, badNodes: ${Object.keys(state.badNodes)}`);
  // 'b' should have been auto-cleared
  assert.ok(!Object.keys(state.badNodes).includes('b'), `auto entry 'b' should be cleared`);
  // currentNode is 'b' (the only non-bad)
  assert.strictEqual(state.currentNode, 'b');
});

test('PX-5: rotate() falls back to full clear when only manual bans remain', async () => {
  const nodes = [
    { type: 'ss', tag: 'a' },
    { type: 'ss', tag: 'b' },
  ];
  const switchCalls = [];
  const p = freshProxyWithMocks(baseMocks(nodes, switchCalls));
  await p.refresh();
  // Both manually blacklisted — there are no auto entries to clear, but
  // we still must not deadlock with empty rotation. Fallback clears all.
  p.blacklistManually('a', 'main');
  p.blacklistManually('b', 'main');
  await p.rotate();
  const state = p.getState();
  assert.strictEqual(Object.keys(state.badNodes).length, 0, 'fallback clears everything');
  assert.ok(['a', 'b'].includes(state.currentNode), `currentNode should be a or b, got: ${state.currentNode}`);
});
