// v2.42 Task 7 — buildSingboxConfig urltest 模板单测
//
// 覆盖：main / jp outbound 是 urltest 类型 + interval/tolerance 参数 + excludeNodes
// 从 urltest.outbounds 排除 + 双端口 inbound + route rules 引用对应 tag。
//
// 关于历史 selector 行为的回归覆盖在 index.test.js 已经被改成 urltest 断言。

const test = require('node:test');
const assert = require('node:assert');
const { buildSingboxConfig } = require('../index');

const mainNodes = [
  { type: 'vless', tag: 'n1', server: '1.1.1.1', server_port: 443 },
  { type: 'vless', tag: 'n2', server: '2.2.2.2', server_port: 443 },
  { type: 'vless', tag: 'n3', server: '3.3.3.3', server_port: 443 },
];
const jpNodes = [{ type: 'vless', tag: 'jp1', server: '4.4.4.4', server_port: 443 }];

test('buildSingboxConfig: main outbound 是 urltest 类型 + 防抖参数齐全', () => {
  const cfg = buildSingboxConfig({ mainNodes, jpNodes });
  const main = cfg.outbounds.find(o => o.tag === 'main');
  assert.ok(main, 'main outbound 存在');
  assert.strictEqual(main.type, 'urltest');
  assert.strictEqual(main.interval, '3m');
  assert.strictEqual(main.tolerance, 50);
  assert.strictEqual(main.idle_timeout, '30m');
  assert.strictEqual(main.url, 'https://www.gstatic.com/generate_204');
  // urltest.outbounds 是节点 tag 字符串列表（不是节点对象）
  assert.deepStrictEqual(main.outbounds, ['n1', 'n2', 'n3']);

  // JP 通道同样是 urltest
  const jp = cfg.outbounds.find(o => o.tag === 'jp');
  assert.ok(jp, 'jp outbound 存在');
  assert.strictEqual(jp.type, 'urltest');
  assert.deepStrictEqual(jp.outbounds, ['jp1']);
});

test('buildSingboxConfig: excludeNodes 从 urltest.outbounds 排除 + 节点本身 outbound 也不生成', () => {
  const cfg = buildSingboxConfig({ mainNodes, jpNodes, excludeNodes: ['n2'] });

  // urltest.outbounds 不再引用 n2
  const main = cfg.outbounds.find(o => o.tag === 'main');
  assert.deepStrictEqual(main.outbounds, ['n1', 'n3']);

  // 节点 n2 本身的 outbound 定义也不在 cfg.outbounds 里（否则 sing-box 会
  // 警告 "unused outbound"，且后续 banFromUrltest 重生成时 list 会膨胀）。
  const n2 = cfg.outbounds.find(o => o.tag === 'n2');
  assert.strictEqual(n2, undefined, 'banned 节点本身的 outbound 也被移除');

  // 未被排除的节点 outbound 仍在
  assert.ok(cfg.outbounds.find(o => o.tag === 'n1'));
  assert.ok(cfg.outbounds.find(o => o.tag === 'n3'));
});

test('buildSingboxConfig: 双端口 inbound + route rule 把 mixed-7890/7891 分别导到 main/jp', () => {
  const cfg = buildSingboxConfig({ mainNodes, jpNodes });

  // 两个 mixed inbound，端口分别 7890 / 7891
  assert.strictEqual(cfg.inbounds.length, 2);
  assert.ok(cfg.inbounds.some(i => i.listen_port === 7890 && i.tag === 'mixed-7890'));
  assert.ok(cfg.inbounds.some(i => i.listen_port === 7891 && i.tag === 'mixed-7891'));

  // route.rules 必含 mixed-7890→main、mixed-7891→jp 两条（顺序无所谓）。
  // 全局 sniff action 是 sing-box 1.11+ 的实现细节，单独验证 inbound 路由存在性即可。
  const routes = cfg.route.rules.filter(r => r.inbound);
  const mainRoute = routes.find(r => r.inbound === 'mixed-7890');
  const jpRoute = routes.find(r => r.inbound === 'mixed-7891');
  assert.deepStrictEqual(mainRoute, { inbound: 'mixed-7890', outbound: 'main' });
  assert.deepStrictEqual(jpRoute, { inbound: 'mixed-7891', outbound: 'jp' });
});
