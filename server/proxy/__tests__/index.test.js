const test = require('node:test');
const assert = require('node:assert');
const proxy = require('../index');

test('buildSingboxConfig: 仅 US 池时只有一个 inbound', () => {
  const us = [{ type: 'shadowsocks', tag: 'us-1' }, { type: 'shadowsocks', tag: 'us-2' }];
  const cfg = proxy.buildSingboxConfig(us, null);
  assert.strictEqual(cfg.inbounds.length, 1);
  assert.strictEqual(cfg.inbounds[0].listen_port, 7890);
  assert.strictEqual(cfg.route.rules.length, 0);
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
  assert.strictEqual(cfg.route.rules.length, 1);
  assert.deepStrictEqual(cfg.route.rules[0], { inbound: 'in-jp', outbound: 'jp-checkout' });
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
  assert.strictEqual(cfg.route.rules.length, 0);
});

test('buildSingboxConfig: outbounds 含 direct + block 兜底', () => {
  const cfg = proxy.buildSingboxConfig([{ type: 'shadowsocks', tag: 'us-1' }], null);
  const tags = cfg.outbounds.map(o => o.tag);
  assert.ok(tags.includes('direct'));
  assert.ok(tags.includes('block'));
});
