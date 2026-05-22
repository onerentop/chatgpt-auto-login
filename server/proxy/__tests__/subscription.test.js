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
