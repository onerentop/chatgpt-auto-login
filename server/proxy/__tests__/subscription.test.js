const test = require('node:test');
const assert = require('node:assert');
const { filterByJpKddi } = require('../subscription');

test('filterByJpKddi: 匹配 tag 包含 KDDI (case-insensitive)', () => {
  const input = [
    { tag: 'jp-KDDI-01' },
    { tag: 'US-LA' },
    { tag: 'kddi住宅' },
    { tag: 'JP-Tokyo' },
  ];
  const out = filterByJpKddi(input);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].tag, 'jp-KDDI-01');
  assert.strictEqual(out[1].tag, 'kddi住宅');
});

test('filterByJpKddi: 无匹配返回空数组', () => {
  const input = [{ tag: 'US-LA' }, { tag: 'HK-01' }];
  assert.deepStrictEqual(filterByJpKddi(input), []);
});

test('filterByJpKddi: 空输入返回空数组', () => {
  assert.deepStrictEqual(filterByJpKddi([]), []);
});

test('filterByJpKddi: 自定义 keyword', () => {
  const input = [{ tag: 'JP-Tokyo-home' }, { tag: 'US-LA' }];
  const out = filterByJpKddi(input, 'home');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].tag, 'JP-Tokyo-home');
});

test('filterByJpKddi: keyword 含正则元字符不爆炸', () => {
  const input = [{ tag: 'a.b' }, { tag: 'ab' }];
  const out = filterByJpKddi(input, 'a.b');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].tag, 'a.b');
});

const { filterByWhitelist } = require('../subscription');

test('filterByWhitelist: 精确匹配指定 tag', () => {
  const input = [
    { tag: 'nodeA' }, { tag: 'nodeB' }, { tag: 'nodeC' },
  ];
  const out = filterByWhitelist(input, ['nodeA', 'nodeC']);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].tag, 'nodeA');
  assert.strictEqual(out[1].tag, 'nodeC');
});

test('filterByWhitelist: 空白名单返回空数组', () => {
  const input = [{ tag: 'nodeA' }, { tag: 'nodeB' }];
  assert.deepStrictEqual(filterByWhitelist(input, []), []);
});

test('filterByWhitelist: 白名单含订阅没有的 tag 时静默跳过', () => {
  const input = [{ tag: 'nodeA' }];
  const out = filterByWhitelist(input, ['nodeA', 'nodeX']);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].tag, 'nodeA');
});

test('filterByWhitelist: 白名单全部不命中返回空数组', () => {
  const input = [{ tag: 'nodeA' }];
  assert.deepStrictEqual(filterByWhitelist(input, ['nodeX', 'nodeY']), []);
});

test('filterByWhitelist: 含重复/null/空字符串/undefined 时去重并剔除非字符串', () => {
  const input = [{ tag: 'nodeA' }, { tag: 'nodeB' }];
  const out = filterByWhitelist(input, ['nodeA', 'nodeA', null, '', undefined, 'nodeB']);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].tag, 'nodeA');
  assert.strictEqual(out[1].tag, 'nodeB');
});

test('filterByWhitelist: tag 含中文/空格/括号特殊字符精确匹配', () => {
  const fullTag = 'jp-KDDI-动态家宽-108.4 (topren) [VLESS-Reality]';
  const input = [{ tag: fullTag }, { tag: 'pro-家庭宽带-日本KDDI-2x' }];
  const out = filterByWhitelist(input, [fullTag]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].tag, fullTag);
});
