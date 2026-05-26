const test = require('node:test');
const assert = require('node:assert');

// Mock global fetch
const _origFetch = global.fetch;
function mockFetch(fn) { global.fetch = fn; }
function restoreFetch() { global.fetch = _origFetch; }

test('fetchWithRetry: HTTP 403 Cloudflare → 调 bad-node + throw proxy_blocked', async () => {
  const badNodeCalls = [];
  mockFetch(async (url, opts) => {
    if (String(url).includes('/api/proxy/bad-node')) {
      badNodeCalls.push(JSON.parse(opts.body));
      return { ok: true };
    }
    return {
      status: 403,
      clone() {
        return { text: async () => '<html>Just a moment...</html>' };
      },
    };
  });
  try {
    const { fetchWithRetry } = require('../with-retry');
    await assert.rejects(
      fetchWithRetry('http://example.com'),
      /proxy_blocked.*cloudflare/i
    );
    // 给 fire-and-forget 上报一点时间
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(badNodeCalls.length, 1);
    assert.strictEqual(badNodeCalls[0].reason, 'cloudflare_403');
  } finally {
    restoreFetch();
  }
});

test('fetchWithRetry: HTTP 429 → 调 bad-node rate_limited + throw', async () => {
  const badNodeCalls = [];
  mockFetch(async (url, opts) => {
    if (String(url).includes('/api/proxy/bad-node')) {
      badNodeCalls.push(JSON.parse(opts.body));
      return { ok: true };
    }
    return { status: 429, clone() { return { text: async () => '' }; } };
  });
  try {
    delete require.cache[require.resolve('../with-retry')];
    const { fetchWithRetry } = require('../with-retry');
    await assert.rejects(fetchWithRetry('http://example.com', {}, { channel: 'jp' }), /rate_limited/i);
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(badNodeCalls.length, 1);
    assert.strictEqual(badNodeCalls[0].reason, 'rate_limited');
    assert.strictEqual(badNodeCalls[0].channel, 'jp');
  } finally {
    restoreFetch();
  }
});

test('fetchWithRetry: ECONNRESET retry 1 次后上报 connection_reset + throw', async () => {
  const badNodeCalls = [];
  let callCount = 0;
  mockFetch(async (url, opts) => {
    if (String(url).includes('/api/proxy/bad-node')) {
      badNodeCalls.push(JSON.parse(opts.body));
      return { ok: true };
    }
    callCount++;
    throw new Error('ECONNRESET');
  });
  try {
    delete require.cache[require.resolve('../with-retry')];
    const { fetchWithRetry } = require('../with-retry');
    await assert.rejects(fetchWithRetry('http://example.com'), /ECONNRESET/);
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(callCount, 2, 'retry 后总共调用 2 次');
    assert.strictEqual(badNodeCalls.length, 1);
    assert.strictEqual(badNodeCalls[0].reason, 'connection_reset');
  } finally {
    restoreFetch();
  }
});

test('fetchWithRetry: 正常 200 直接返回，不调 bad-node', async () => {
  const badNodeCalls = [];
  mockFetch(async (url, opts) => {
    if (String(url).includes('/api/proxy/bad-node')) {
      badNodeCalls.push(JSON.parse(opts.body));
      return { ok: true };
    }
    return { status: 200, json: async () => ({ ok: true }) };
  });
  try {
    delete require.cache[require.resolve('../with-retry')];
    const { fetchWithRetry } = require('../with-retry');
    const r = await fetchWithRetry('http://example.com');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(badNodeCalls.length, 0);
  } finally {
    restoreFetch();
  }
});
