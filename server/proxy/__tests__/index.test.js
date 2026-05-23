const test = require('node:test');
const assert = require('node:assert');
const proxy = require('../index');

test('buildSingboxConfig: 仅 US 池时只有一个 inbound', () => {
  const us = [{ type: 'shadowsocks', tag: 'us-1' }, { type: 'shadowsocks', tag: 'us-2' }];
  const cfg = proxy.buildSingboxConfig(us, null);
  assert.strictEqual(cfg.inbounds.length, 1);
  assert.strictEqual(cfg.inbounds[0].listen_port, 7890);
  assert.strictEqual(cfg.inbounds[0].sniff, undefined, 'legacy inbound sniff field removed');
  // rules[0] is the global sniff action; no other rules when JP is off
  assert.strictEqual(cfg.route.rules.length, 1);
  assert.deepStrictEqual(cfg.route.rules[0], { action: 'sniff' });
  assert.strictEqual(cfg.route.final, 'auto-rotate');
  const selectorTags = cfg.outbounds.filter(o => o.type === 'selector').map(o => o.tag);
  assert.deepStrictEqual(selectorTags, ['auto-rotate']);
});

test('buildSingboxConfig: us + jp 池有两个 inbound + 路由规则', () => {
  const us = [{ type: 'shadowsocks', tag: 'us-1' }];
  const jp = [{ type: 'shadowsocks', tag: 'jp-KDDI-01' }];
  const cfg = proxy.buildSingboxConfig(us, jp);
  assert.strictEqual(cfg.inbounds.length, 2);
  assert.strictEqual(cfg.inbounds[1].tag, 'in-jp');
  assert.strictEqual(cfg.inbounds[1].listen_port, 7891);
  assert.strictEqual(cfg.inbounds[1].sniff, undefined, 'legacy inbound sniff field removed');
  // rules[0] is the global sniff action; rules[1] is the JP route
  assert.strictEqual(cfg.route.rules.length, 2);
  assert.deepStrictEqual(cfg.route.rules[0], { action: 'sniff' });
  assert.deepStrictEqual(cfg.route.rules[1], { inbound: 'in-jp', outbound: 'jp-checkout' });
  const selectorTags = cfg.outbounds.filter(o => o.type === 'selector').map(o => o.tag);
  assert.deepStrictEqual(selectorTags, ['auto-rotate', 'jp-checkout']);
  const jpSelector = cfg.outbounds.find(o => o.tag === 'jp-checkout');
  assert.deepStrictEqual(jpSelector.outbounds, ['jp-KDDI-01']);
  assert.strictEqual(jpSelector.default, 'jp-KDDI-01');
});

test('buildSingboxConfig: jp 数组为空数组时视为无 JP（不加 inbound）', () => {
  const us = [{ type: 'shadowsocks', tag: 'us-1' }];
  const cfg = proxy.buildSingboxConfig(us, []);
  assert.strictEqual(cfg.inbounds.length, 1);
  // Only the global sniff rule remains; no JP-specific routing
  assert.strictEqual(cfg.route.rules.length, 1);
  assert.deepStrictEqual(cfg.route.rules[0], { action: 'sniff' });
});

test('buildSingboxConfig: outbounds 含 direct + block 兜底', () => {
  const cfg = proxy.buildSingboxConfig([{ type: 'shadowsocks', tag: 'us-1' }], null);
  const tags = cfg.outbounds.map(o => o.tag);
  assert.ok(tags.includes('direct'));
  assert.ok(tags.includes('block'));
});

test('buildSingboxConfig: 仅 JP 池（主代理 off）不监听 7890，final 切到 jp-checkout', () => {
  const jp = [{ type: 'shadowsocks', tag: 'jp-KDDI-01' }, { type: 'shadowsocks', tag: 'jp-KDDI-02' }];
  const cfg = proxy.buildSingboxConfig(null, jp);
  assert.strictEqual(cfg.inbounds.length, 1);
  assert.strictEqual(cfg.inbounds[0].tag, 'in-jp');
  assert.strictEqual(cfg.inbounds[0].listen_port, 7891);
  const selectorTags = cfg.outbounds.filter(o => o.type === 'selector').map(o => o.tag);
  assert.deepStrictEqual(selectorTags, ['jp-checkout']);
  assert.strictEqual(cfg.route.final, 'jp-checkout');
  // rules[0] sniff action, rules[1] JP route
  assert.strictEqual(cfg.route.rules.length, 2);
  assert.deepStrictEqual(cfg.route.rules[0], { action: 'sniff' });
  assert.deepStrictEqual(cfg.route.rules[1], { inbound: 'in-jp', outbound: 'jp-checkout' });
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
