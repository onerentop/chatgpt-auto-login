const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const bb = require('./bitbrowser');

// Snapshot real deps once and restore before every test so _deps stays clean
// across describe blocks and any future spec files.
const realDeps = { ...bb._deps };
beforeEach(() => { Object.assign(bb._deps, realDeps); });

describe('parseProxy', () => {
  test('parses http://host:port', () => {
    const out = bb.__internal.parseProxy('http://127.0.0.1:7890');
    assert.deepEqual(out, { proxyType: 'http', host: '127.0.0.1', port: '7890' });
  });

  test('parses https scheme', () => {
    const out = bb.__internal.parseProxy('https://proxy.example.com:8443');
    assert.deepEqual(out, { proxyType: 'https', host: 'proxy.example.com', port: '8443' });
  });

  test('throws on empty string', () => {
    assert.throws(() => bb.__internal.parseProxy(''), /required/i);
  });

  test('throws on undefined', () => {
    assert.throws(() => bb.__internal.parseProxy(undefined), /required/i);
  });

  test('throws on malformed url', () => {
    assert.throws(() => bb.__internal.parseProxy('not a url'), /malformed/i);
  });

  test('throws on missing port', () => {
    assert.throws(() => bb.__internal.parseProxy('http://127.0.0.1'), /missing host or port/i);
  });

  test('parses socks5 scheme', () => {
    const out = bb.__internal.parseProxy('socks5://127.0.0.1:1080');
    assert.deepEqual(out, { proxyType: 'socks5', host: '127.0.0.1', port: '1080' });
  });
});

describe('healthCheck()', () => {
  test('returns true on 200', async () => {
    bb._deps.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
    assert.equal(await bb.healthCheck(), true);
  });

  test('returns false on network error', async () => {
    bb._deps.fetch = async () => { const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; };
    assert.equal(await bb.healthCheck(), false);
  });

  test('returns true on any HTTP response (even 500)', async () => {
    bb._deps.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    assert.equal(await bb.healthCheck(), true);
  });

  test('never throws', async () => {
    bb._deps.fetch = async () => { throw new Error('boom'); };
    await assert.doesNotReject(bb.healthCheck());
  });
});

describe('getApiBase()', () => {
  test('returns default when no apiUrl provided', () => {
    assert.equal(bb.__internal.getApiBase('http://127.0.0.1:54345'), 'http://127.0.0.1:54345');
  });
  test('strips a single trailing slash', () => {
    assert.equal(bb.__internal.getApiBase('http://127.0.0.1:54345/'), 'http://127.0.0.1:54345');
  });
  test('strips multiple trailing slashes', () => {
    assert.equal(bb.__internal.getApiBase('http://127.0.0.1:54345//'), 'http://127.0.0.1:54345');
  });
  test('trims leading and trailing whitespace', () => {
    assert.equal(bb.__internal.getApiBase('  http://127.0.0.1:54345  '), 'http://127.0.0.1:54345');
  });
  test('preserves a subpath', () => {
    assert.equal(bb.__internal.getApiBase('http://127.0.0.1:54345/v1/'), 'http://127.0.0.1:54345/v1');
  });
});
