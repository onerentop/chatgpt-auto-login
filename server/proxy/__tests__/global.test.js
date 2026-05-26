const test = require('node:test');
const assert = require('node:assert');

test('global.js: 设置 HTTPS_PROXY env 默认值', () => {
  // 清空 env 重新加载
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
  delete require.cache[require.resolve('../global')];
  const { SINGBOX_PROXY } = require('../global');
  assert.strictEqual(process.env.HTTPS_PROXY, SINGBOX_PROXY);
  assert.strictEqual(process.env.HTTP_PROXY, SINGBOX_PROXY);
  assert.match(SINGBOX_PROXY, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('global.js: 继承的 HTTPS_PROXY 被强制覆盖 + warning', () => {
  process.env.HTTPS_PROXY = 'http://127.0.0.1:7897';  // Clash port
  const warnLog = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnLog.push(String(msg));
  try {
    delete require.cache[require.resolve('../global')];
    const { SINGBOX_PROXY } = require('../global');
    assert.notStrictEqual(process.env.HTTPS_PROXY, 'http://127.0.0.1:7897', 'env 被强制覆盖');
    assert.strictEqual(process.env.HTTPS_PROXY, SINGBOX_PROXY);
    assert.ok(warnLog.some(m => /忽略继承/.test(m) && /7897/.test(m)), 'warning 输出含原 URL');
  } finally {
    console.warn = origWarn;
  }
});

test('global.js: NO_PROXY 含 127.0.0.1', () => {
  delete require.cache[require.resolve('../global')];
  require('../global');
  assert.match(process.env.NO_PROXY, /127\.0\.0\.1/);
});
