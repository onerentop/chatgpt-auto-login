const test = require('node:test');
const assert = require('node:assert');
const proxy = require('../index');

// v2.42 Task 7: outbound 从 selector 改成 urltest, tag 重命名为 main/jp,
// inbound tag 重命名为 mixed-7890/mixed-7891。下面这批测试保留场景覆盖，
// 但断言都迁移到了新模型。urltest 特定参数（interval/tolerance/excludeNodes）
// 的细节测试在 build-singbox-urltest.test.js。

test('buildSingboxConfig: 仅 US 池时只有一个 inbound', () => {
  const us = [{ type: 'shadowsocks', tag: 'us-1' }, { type: 'shadowsocks', tag: 'us-2' }];
  const cfg = proxy.buildSingboxConfig(us, null);
  assert.strictEqual(cfg.inbounds.length, 1);
  assert.strictEqual(cfg.inbounds[0].listen_port, 7890);
  assert.strictEqual(cfg.inbounds[0].tag, 'mixed-7890');
  assert.strictEqual(cfg.inbounds[0].sniff, undefined, 'legacy inbound sniff field removed');
  // 规则：全局 sniff action + 主通道 inbound→main 路由（无 JP 时只有这两条）
  const inboundRoutes = cfg.route.rules.filter(r => r.inbound);
  assert.deepStrictEqual(inboundRoutes, [{ inbound: 'mixed-7890', outbound: 'main' }]);
  assert.strictEqual(cfg.route.final, 'main');
  const urltestTags = cfg.outbounds.filter(o => o.type === 'urltest').map(o => o.tag);
  assert.deepStrictEqual(urltestTags, ['main']);
});

test('buildSingboxConfig: us + jp 池有两个 inbound + 路由规则', () => {
  const us = [{ type: 'shadowsocks', tag: 'us-1' }];
  const jp = [{ type: 'shadowsocks', tag: 'jp-KDDI-01' }];
  const cfg = proxy.buildSingboxConfig(us, jp);
  assert.strictEqual(cfg.inbounds.length, 2);
  // JP inbound 是 mixed-7891
  const jpInbound = cfg.inbounds.find(i => i.listen_port === 7891);
  assert.strictEqual(jpInbound.tag, 'mixed-7891');
  assert.strictEqual(jpInbound.sniff, undefined, 'legacy inbound sniff field removed');
  // 两条 inbound 路由都在（main 和 jp）
  const inboundRoutes = cfg.route.rules.filter(r => r.inbound);
  assert.strictEqual(inboundRoutes.length, 2);
  assert.ok(inboundRoutes.find(r => r.inbound === 'mixed-7890' && r.outbound === 'main'));
  assert.ok(inboundRoutes.find(r => r.inbound === 'mixed-7891' && r.outbound === 'jp'));
  const urltestTags = cfg.outbounds.filter(o => o.type === 'urltest').map(o => o.tag).sort();
  assert.deepStrictEqual(urltestTags, ['jp', 'main']);
  const jpGroup = cfg.outbounds.find(o => o.tag === 'jp');
  assert.deepStrictEqual(jpGroup.outbounds, ['jp-KDDI-01']);
  // urltest 不需要 `default` 字段（selector 才有）
  assert.strictEqual(jpGroup.default, undefined);
});

test('buildSingboxConfig: jp 数组为空数组时视为无 JP（不加 inbound）', () => {
  const us = [{ type: 'shadowsocks', tag: 'us-1' }];
  const cfg = proxy.buildSingboxConfig(us, []);
  assert.strictEqual(cfg.inbounds.length, 1);
  const inboundRoutes = cfg.route.rules.filter(r => r.inbound);
  assert.deepStrictEqual(inboundRoutes, [{ inbound: 'mixed-7890', outbound: 'main' }]);
});

test('buildSingboxConfig: outbounds 含 direct + block 兜底', () => {
  const cfg = proxy.buildSingboxConfig([{ type: 'shadowsocks', tag: 'us-1' }], null);
  const tags = cfg.outbounds.map(o => o.tag);
  assert.ok(tags.includes('direct'));
  assert.ok(tags.includes('block'));
});

test('buildSingboxConfig: 仅 JP 池（主代理 off）不监听 7890，final 切到 jp', () => {
  const jp = [{ type: 'shadowsocks', tag: 'jp-KDDI-01' }, { type: 'shadowsocks', tag: 'jp-KDDI-02' }];
  const cfg = proxy.buildSingboxConfig(null, jp);
  assert.strictEqual(cfg.inbounds.length, 1);
  assert.strictEqual(cfg.inbounds[0].tag, 'mixed-7891');
  assert.strictEqual(cfg.inbounds[0].listen_port, 7891);
  const urltestTags = cfg.outbounds.filter(o => o.type === 'urltest').map(o => o.tag);
  assert.deepStrictEqual(urltestTags, ['jp']);
  assert.strictEqual(cfg.route.final, 'jp');
  const inboundRoutes = cfg.route.rules.filter(r => r.inbound);
  assert.deepStrictEqual(inboundRoutes, [{ inbound: 'mixed-7891', outbound: 'jp' }]);
});

test('buildSingboxConfig: us=[] + jp=[] 抛错（无意义启动）', () => {
  assert.throws(() => proxy.buildSingboxConfig(null, null), /至少需要一个有节点/);
  assert.throws(() => proxy.buildSingboxConfig([], []), /至少需要一个有节点/);
});

test('pickJpNodes: whitelist 非空时优先使用白名单', () => {
  const all = [{ tag: 'nodeA' }, { tag: 'KDDI-1' }, { tag: 'KDDI-2' }];
  const r = proxy.pickJpNodes(all, { enabled: true, keyword: 'KDDI', whitelist: ['nodeA'] });
  assert.strictEqual(r.usedWhitelist, true);
  assert.strictEqual(r.filtered.length, 1);
  assert.strictEqual(r.filtered[0].tag, 'nodeA');
  assert.deepStrictEqual(r.misses, []);
});

test('pickJpNodes: whitelist 空 → keyword 分支', () => {
  const all = [{ tag: 'nodeA' }, { tag: 'KDDI-1' }, { tag: 'KDDI-2' }];
  const r = proxy.pickJpNodes(all, { enabled: true, keyword: 'KDDI', whitelist: [] });
  assert.strictEqual(r.usedWhitelist, false);
  assert.strictEqual(r.filtered.length, 2);
  assert.strictEqual(r.filtered[0].tag, 'KDDI-1');
  assert.deepStrictEqual(r.misses, []);
});

test('pickJpNodes: enabled=false 返回空', () => {
  const all = [{ tag: 'KDDI-1' }];
  const r = proxy.pickJpNodes(all, { enabled: false, keyword: 'KDDI', whitelist: ['KDDI-1'] });
  assert.deepStrictEqual(r.filtered, []);
  assert.strictEqual(r.usedWhitelist, false);
  assert.deepStrictEqual(r.misses, []);
});

test('pickJpNodes: whitelist 含不存在 tag 时收集 misses', () => {
  const all = [{ tag: 'nodeA' }];
  const r = proxy.pickJpNodes(all, { enabled: true, keyword: 'KDDI', whitelist: ['nodeA', 'unknown1', 'unknown2'] });
  assert.strictEqual(r.usedWhitelist, true);
  assert.strictEqual(r.filtered.length, 1);
  assert.strictEqual(r.filtered[0].tag, 'nodeA');
  assert.deepStrictEqual(r.misses, ['unknown1', 'unknown2']);
});

test('pickJpNodes: whitelist 非数组（字符串误填）视为空 → fallback keyword 分支', () => {
  const all = [{ tag: 'nodeA' }, { tag: 'KDDI-1' }];
  const r = proxy.pickJpNodes(all, { enabled: true, keyword: 'KDDI', whitelist: 'KDDI' });
  assert.strictEqual(r.usedWhitelist, false);
  assert.strictEqual(r.filtered.length, 1);
  assert.strictEqual(r.filtered[0].tag, 'KDDI-1');
});

// ============== U1-U10: blacklist counter API ==============
// Use a fresh require for the proxy module (it caches state internally) plus
// mock blacklist module so persistence calls don't blow up in unit tests.

const Module = require('module');

function freshProxy({ blacklistMock } = {}) {
  const origRequire = Module.prototype.require;
  const blMock = blacklistMock || { add: () => {}, remove: () => {}, removeAll: () => {}, loadAll: () => [], pruneExpired: () => {}, __setDb: () => {} };
  Module.prototype.require = function (id) {
    if (id === './blacklist') return blMock;
    return origRequire.apply(this, arguments);
  };
  delete require.cache[require.resolve('../index')];
  delete require.cache[require.resolve('../blacklist')];
  const p = require('../index');
  Module.prototype.require = origRequire;
  return p;
}

test('U1 recordBadAttempt 第 1、2 次不入黑名单', { skip: 'v2.42 Task 8: recordBadAttempt 已 stub 化（urltest 取代投票）' }, () => {
  const p = freshProxy();
  const r1 = p.recordBadAttempt('us-1', 'main', 'tls');
  assert.strictEqual(r1.blacklisted, false);
  assert.strictEqual(r1.count, 1);
  const r2 = p.recordBadAttempt('us-1', 'main', 'tls');
  assert.strictEqual(r2.blacklisted, false);
  assert.strictEqual(r2.count, 2);
  assert.strictEqual(p.isBad('us-1'), false);
});

test('U2 recordBadAttempt 连续 3 次：入黑名单，failCount 清零', { skip: 'v2.42 Task 8: recordBadAttempt 已 stub 化' }, () => {
  const calls = [];
  const blMock = { add: (tag, ch, ttl, reason, src) => calls.push({ tag, ch, ttl, reason, src }), remove: () => {}, removeAll: () => {}, loadAll: () => [], pruneExpired: () => {}, __setDb: () => {} };
  const p = freshProxy({ blacklistMock: blMock });
  p.recordBadAttempt('us-1', 'main', 'tls');
  p.recordBadAttempt('us-1', 'main', 'tls');
  const r3 = p.recordBadAttempt('us-1', 'main', 'tls');
  assert.strictEqual(r3.blacklisted, true);
  assert.strictEqual(r3.count, 3);
  assert.strictEqual(p.isBad('us-1'), true);
  assert.strictEqual(calls.length, 1, '应调一次 blacklist.add');
  assert.strictEqual(calls[0].src, 'auto');
  const r4 = p.recordBadAttempt('us-1', 'main', 'tls');
  assert.strictEqual(r4.count, 1, '入黑名单后 failCount 已清零');
});

test('U3 2 次 bad + 1 次 good + 1 次 bad：不入黑名单', { skip: 'v2.42 Task 8: recordBadAttempt 已 stub 化' }, () => {
  const p = freshProxy();
  p.recordBadAttempt('us-1', 'main', 'tls');
  p.recordBadAttempt('us-1', 'main', 'tls');
  p.recordGoodAttempt('us-1', 'main');
  const r = p.recordBadAttempt('us-1', 'main', 'tls');
  assert.strictEqual(r.blacklisted, false);
  assert.strictEqual(r.count, 1, 'good 之后 bad 计数从 1 重新开始');
});

test('U4 main 与 jp 通道独立计数（同 tag）', { skip: 'v2.42 Task 8: recordBadAttempt 已 stub 化' }, () => {
  const p = freshProxy();
  p.recordBadAttempt('node-X', 'main', 'a');
  p.recordBadAttempt('node-X', 'main', 'a');
  p.recordBadAttempt('node-X', 'jp', 'b');
  assert.strictEqual(p.isBad('node-X'), false);
  assert.strictEqual(p.isJpBad('node-X'), false);
  p.recordBadAttempt('node-X', 'main', 'a');
  assert.strictEqual(p.isBad('node-X'), true);
  assert.strictEqual(p.isJpBad('node-X'), false, 'jp 通道独立');
});

test('U5 blacklistManually 立即入黑名单且清掉计数器', { skip: 'v2.42 Task 8: failCount 已删（recordBadAttempt 是 stub）' }, () => {
  const calls = [];
  const blMock = { add: (tag, ch, ttl, reason, src) => calls.push({ tag, ch, ttl, reason, src }), remove: () => {}, removeAll: () => {}, loadAll: () => [], pruneExpired: () => {}, __setDb: () => {} };
  const p = freshProxy({ blacklistMock: blMock });
  p.recordBadAttempt('us-1', 'main', 'tls');
  p.blacklistManually('us-1', 'main', 60000, 'manual disable');
  assert.strictEqual(p.isBad('us-1'), true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].src, 'manual');
  p.removeFromBlacklist('us-1', 'main');
  const r = p.recordBadAttempt('us-1', 'main', 'tls');
  assert.strictEqual(r.count, 1, 'manual 入黑名单时也应清 failCount');
});

test('U6 removeFromBlacklist 联动持久化层', () => {
  const removes = [];
  const blMock = { add: () => {}, remove: (tag, ch) => removes.push({ tag, ch }), removeAll: () => {}, loadAll: () => [], pruneExpired: () => {}, __setDb: () => {} };
  const p = freshProxy({ blacklistMock: blMock });
  p.blacklistManually('us-1', 'main', 60000, 'm');
  p.removeFromBlacklist('us-1', 'main');
  assert.strictEqual(p.isBad('us-1'), false);
  assert.deepStrictEqual(removes, [{ tag: 'us-1', ch: 'main' }]);
});

test('U7 isBad 对过期 entry：删除内存 + 调 blacklist.remove，返回 false', () => {
  const removes = [];
  const blMock = { add: () => {}, remove: (tag, ch) => removes.push({ tag, ch }), removeAll: () => {}, loadAll: () => [], pruneExpired: () => {}, __setDb: () => {} };
  const p = freshProxy({ blacklistMock: blMock });
  p.blacklistManually('us-1', 'main', -1000, 'expired');
  const v = p.isBad('us-1');
  assert.strictEqual(v, false);
  assert.deepStrictEqual(removes, [{ tag: 'us-1', ch: 'main' }]);
});

test('U8 getState().badNodes shape 为 {tag: {expiresAt, reason, source}}', () => {
  const p = freshProxy();
  p.blacklistManually('us-1', 'main', 60000, 'm', 'manual');
  const state = p.getState();
  const entry = state.badNodes['us-1'];
  assert.strictEqual(typeof entry, 'object');
  assert.strictEqual(typeof entry.expiresAt, 'number');
  assert.strictEqual(entry.reason, 'm');
  assert.strictEqual(entry.source, 'manual');
});

test('U9 isProxyNetError 命中 / 不命中', () => {
  const p = freshProxy();
  assert.ok(p.isProxyNetError('ECONNRESET'));
  assert.ok(p.isProxyNetError('connect ETIMEDOUT 1.2.3.4:443'));
  assert.ok(p.isProxyNetError('socket hang up'));
  assert.ok(p.isProxyNetError('getaddrinfo ENOTFOUND foo'));
  assert.ok(p.isProxyNetError('ECONNREFUSED'));
  assert.ok(p.isProxyNetError('net::ERR_TUNNEL_CONNECTION_FAILED'));
  assert.ok(p.isProxyNetError('net::ERR_PROXY_CONNECTION_FAILED'));
  assert.strictEqual(p.isProxyNetError('account_deactivated'), false);
  assert.strictEqual(p.isProxyNetError('invalid password'), false);
  assert.strictEqual(p.isProxyNetError(''), false);
  assert.strictEqual(p.isProxyNetError(null), false);
});

test('U10 FAIL_THRESHOLD 通过 module export 可读', () => {
  const p = freshProxy();
  assert.strictEqual(p.FAIL_THRESHOLD, 3);
});

test('U2-fix-I2 recordBadAttempt 拒绝非法 channel', () => {
  const p = freshProxy();
  assert.throws(() => p.recordBadAttempt('us-1', 'JP', 'tls'), /channel must be/);
  assert.throws(() => p.recordBadAttempt('us-1', 'us', 'tls'), /channel must be/);
  assert.throws(() => p.recordBadAttempt('us-1', undefined, 'tls'), /channel must be/);
});

test('U2-fix-I3 getState 不再 mutate state（只投影）', () => {
  const p = freshProxy();
  // 手动塞一个过期 entry 到 badNodes（绕过 _addToBlacklist 的当前路径，模拟内存中的过期残留）
  // 通过 blacklistManually + 负 TTL 来制造过期：
  p.blacklistManually('us-expired', 'main', -1000, 'old');
  // 此时 isBad 还没被调用过，过期 entry 仍在 Map 中
  const stateBefore = p.getState();
  assert.strictEqual(stateBefore.badNodes['us-expired'], undefined, '投影时已过期 entry 被排除');
  // 再次调用 getState 应该不报错且行为一致（证明没 mutate）
  const stateAfter = p.getState();
  assert.strictEqual(stateAfter.badNodes['us-expired'], undefined);
});

test('U11 clearBlacklist syncs DB (no resurrection on restart)', () => {
  const removeAllCalls = [];
  const blMock = {
    add: () => {}, remove: () => {},
    removeAll: (ch) => removeAllCalls.push(ch),
    loadAll: () => [], pruneExpired: () => {}, __setDb: () => {},
  };
  const p = freshProxy({ blacklistMock: blMock });
  p.blacklistManually('node-a', 'main', 60000, 'x');
  p.clearBlacklist('main');
  assert.strictEqual(p.isBad('node-a'), false);
  assert.deepStrictEqual(removeAllCalls, ['main']);
});

// ============== W1-W7: pickMainNodes — main-channel whitelist ==============

test('W1 pickMainNodes: whitelist 非空时优先使用白名单', () => {
  const all = [{ tag: 'nodeA' }, { tag: 'us-LA-1' }, { tag: 'us-NY-2' }];
  const r = proxy.pickMainNodes(all, { regionFilter: 'US', whitelist: ['nodeA'] });
  assert.strictEqual(r.usedWhitelist, true);
  assert.strictEqual(r.filtered.length, 1);
  assert.strictEqual(r.filtered[0].tag, 'nodeA');
  assert.deepStrictEqual(r.misses, []);
});

test('W2 pickMainNodes: whitelist 空 → regionFilter 关键字分支', () => {
  const all = [{ tag: 'nodeA' }, { tag: 'us-LA-1' }, { tag: 'us-NY-2' }];
  const r = proxy.pickMainNodes(all, { regionFilter: 'US', whitelist: [] });
  assert.strictEqual(r.usedWhitelist, false);
  assert.strictEqual(r.filtered.length, 2);  // us-LA-1, us-NY-2 命中 US_PATTERNS
  assert.deepStrictEqual(r.misses, []);
});

test('W3 pickMainNodes: cfg null/undefined 返回空', () => {
  assert.deepStrictEqual(proxy.pickMainNodes([{ tag: 'x' }], null),
    { filtered: [], misses: [], usedWhitelist: false });
  assert.deepStrictEqual(proxy.pickMainNodes([{ tag: 'x' }], undefined),
    { filtered: [], misses: [], usedWhitelist: false });
});

test('W4 pickMainNodes: whitelist 含不存在 tag 时收集 misses', () => {
  const all = [{ tag: 'nodeA' }];
  const r = proxy.pickMainNodes(all, { regionFilter: 'US', whitelist: ['nodeA', 'gone-1', 'gone-2'] });
  assert.strictEqual(r.usedWhitelist, true);
  assert.strictEqual(r.filtered.length, 1);
  assert.strictEqual(r.filtered[0].tag, 'nodeA');
  assert.deepStrictEqual(r.misses, ['gone-1', 'gone-2']);
});

test('W5 pickMainNodes: whitelist 非数组（字符串误填）视为空 → fallback regionFilter', () => {
  const all = [{ tag: 'nodeA' }, { tag: 'us-LA-1' }];
  const r = proxy.pickMainNodes(all, { regionFilter: 'US', whitelist: 'US' });
  assert.strictEqual(r.usedWhitelist, false);
  assert.strictEqual(r.filtered.length, 1);
  assert.strictEqual(r.filtered[0].tag, 'us-LA-1');
});

test("W6 pickMainNodes: 双空 (whitelist=[], regionFilter='') → 全部节点", () => {
  const all = [{ tag: 'nodeA' }, { tag: 'us-LA-1' }, { tag: 'jp-1' }];
  const r = proxy.pickMainNodes(all, { regionFilter: '', whitelist: [] });
  assert.strictEqual(r.usedWhitelist, false);
  assert.strictEqual(r.filtered.length, 3);  // 全部通过
  assert.deepStrictEqual(r.misses, []);
});

test('W7 pickMainNodes: regionFilter 字段缺失 → 默认 US', () => {
  const all = [{ tag: 'nodeA' }, { tag: 'us-LA-1' }];
  const r = proxy.pickMainNodes(all, { whitelist: [] });  // regionFilter undefined
  assert.strictEqual(r.usedWhitelist, false);
  assert.strictEqual(r.filtered.length, 1);  // 默认 US 过滤
  assert.strictEqual(r.filtered[0].tag, 'us-LA-1');
});
