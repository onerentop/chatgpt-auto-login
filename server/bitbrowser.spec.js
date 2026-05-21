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
    assert.throws(() => bb.__internal.parseProxy(''), /proxy/i);
  });

  test('throws on undefined', () => {
    assert.throws(() => bb.__internal.parseProxy(undefined), /proxy/i);
  });

  test('throws on malformed url', () => {
    assert.throws(() => bb.__internal.parseProxy('not a url'), /proxy/i);
  });
});
