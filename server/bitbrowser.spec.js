const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const bb = require('./bitbrowser');

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
