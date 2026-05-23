const test = require('node:test');
const assert = require('node:assert');

// Mutate the proxy module's exports so chatgpt-checkout (which holds the
// same module cache reference) sees our stubbed jp/main URLs.
const proxyMgr = require('../proxy');
const { fetchCheckoutLink } = require('../chatgpt-checkout');

function withStubbedProxy({ jp, main }, fn) {
  const oJp = proxyMgr.getJpProxyUrl;
  const oMain = proxyMgr.getProxyUrl;
  const oState = proxyMgr.getState;
  proxyMgr.getJpProxyUrl = () => jp;
  proxyMgr.getProxyUrl = () => main;
  proxyMgr.getState = () => ({ jp: { currentNode: '' } });
  try { return fn(); }
  finally {
    proxyMgr.getJpProxyUrl = oJp;
    proxyMgr.getProxyUrl = oMain;
    proxyMgr.getState = oState;
  }
}

test('fetchCheckoutLink: jpUrl 为空时立即返回 noJpProxy:true，不启动 Python', async () => {
  const t0 = Date.now();
  let result;
  await withStubbedProxy({ jp: '', main: 'http://127.0.0.1:7890' }, async () => {
    result = await fetchCheckoutLink('fake-token');
  });
  const elapsed = Date.now() - t0;
  assert.strictEqual(result.link, '');
  assert.strictEqual(result.noJpProxy, true);
  assert.match(result.raw, /NO_JP_PROXY/);
  // 若误启动 Python，耗时 >500ms。早返回应在 50ms 内。
  assert.ok(elapsed < 500, `expected early return, elapsed=${elapsed}ms`);
});

test('fetchCheckoutLink: jpUrl 为空 + main 也为空 → 仍 noJpProxy（不回退 main）', async () => {
  let result;
  await withStubbedProxy({ jp: '', main: '' }, async () => {
    result = await fetchCheckoutLink('fake-token');
  });
  assert.strictEqual(result.link, '');
  assert.strictEqual(result.noJpProxy, true);
});
