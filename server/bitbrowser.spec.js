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

describe('open() — happy path', () => {
  test('opens, returns session with browser+close, cleans up fully', async () => {
    const calls = [];
    bb._deps.fetch = async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), body });
      if (String(url).endsWith('/browser/update'))
        return { ok: true, json: async () => ({ success: true, data: { id: 'abc-123' } }) };
      if (String(url).endsWith('/browser/open'))
        return { ok: true, json: async () => ({ success: true, data: { http: '127.0.0.1:54678' } }) };
      if (String(url).endsWith('/browser/close'))
        return { ok: true, json: async () => ({ success: true }) };
      if (String(url).endsWith('/browser/delete'))
        return { ok: true, json: async () => ({ success: true }) };
      throw new Error(`unexpected url ${url}`);
    };
    let cdpClosed = false;
    bb._deps.connectOverCDP = async (url) => {
      assert.equal(url, 'http://127.0.0.1:54678');
      return { close: async () => { cdpClosed = true; } };
    };

    const session = await bb.open({ proxyServer: 'http://127.0.0.1:7890' });
    assert.ok(session.browser, 'session.browser is set');
    assert.equal(typeof session.close, 'function');

    await session.close();

    assert.equal(cdpClosed, true, 'browser.close was awaited');
    const paths = calls.map(c => c.url.split('/').slice(-2).join('/'));
    assert.deepEqual(paths, ['browser/update', 'browser/open', 'browser/close', 'browser/delete']);

    // Verify proxy fields on the update call
    const update = calls.find(c => c.url.endsWith('/browser/update')).body;
    assert.equal(update.proxyMethod, 2);
    assert.equal(update.proxyType, 'http');
    assert.equal(update.host, '127.0.0.1');
    assert.equal(update.port, '7890');
    assert.match(update.name, /^pay-/);
  });

  test('session.close() is idempotent — second call is a no-op', async () => {
    const calls = [];
    bb._deps.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/browser/update'))
        return { ok: true, json: async () => ({ success: true, data: { id: 'idem-1' } }) };
      if (String(url).endsWith('/browser/open'))
        return { ok: true, json: async () => ({ success: true, data: { http: '127.0.0.1:54678' } }) };
      return { ok: true, json: async () => ({ success: true }) };
    };
    let closeCount = 0;
    bb._deps.connectOverCDP = async () => ({ close: async () => { closeCount++; } });

    const session = await bb.open({ proxyServer: 'http://127.0.0.1:7890' });
    await session.close();
    await session.close();   // second call must not retrigger any HTTP or browser.close
    assert.equal(closeCount, 1, 'browser.close called only once');
    const paths = calls.map(u => u.split('/').slice(-2).join('/'));
    assert.deepEqual(paths, ['browser/update', 'browser/open', 'browser/close', 'browser/delete']);
  });
});

describe('open() — error paths', () => {
  test('ECONNREFUSED on /browser/update → BitBrowserUnavailable, no cleanup calls', async () => {
    const calls = [];
    bb._deps.fetch = async (url) => {
      calls.push(String(url));
      const e = new Error('fetch failed'); e.cause = { code: 'ECONNREFUSED' };
      throw e;
    };
    bb._deps.connectOverCDP = async () => assert.fail('should not be called');

    await assert.rejects(
      () => bb.open({ proxyServer: 'http://127.0.0.1:7890' }),
      (e) => e instanceof bb.BitBrowserError && e.kind === 'BitBrowserUnavailable',
    );
    // Only the update call was attempted; no close/delete because no id was issued
    assert.deepEqual(calls.map(u => u.split('/').slice(-2).join('/')), ['browser/update']);
  });

  test('update returns success:false → BitBrowserApiError, no close/delete (no id)', async () => {
    const calls = [];
    bb._deps.fetch = async (url) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ success: false, msg: 'quota exceeded' }) };
    };
    bb._deps.connectOverCDP = async () => assert.fail('should not be called');

    await assert.rejects(
      () => bb.open({ proxyServer: 'http://127.0.0.1:7890' }),
      (e) => e instanceof bb.BitBrowserError && e.kind === 'BitBrowserApiError' && /quota/.test(e.message),
    );
    assert.deepEqual(calls.map(u => u.split('/').slice(-2).join('/')), ['browser/update']);
  });

  test('open ok but connectOverCDP rejects → CDPConnectFailed, close+delete invoked', async () => {
    const calls = [];
    bb._deps.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/browser/update'))
        return { ok: true, json: async () => ({ success: true, data: { id: 'xyz' } }) };
      if (String(url).endsWith('/browser/open'))
        return { ok: true, json: async () => ({ success: true, data: { http: '127.0.0.1:54678' } }) };
      return { ok: true, json: async () => ({ success: true }) };
    };
    bb._deps.connectOverCDP = async () => { throw new Error('connect refused'); };

    await assert.rejects(
      () => bb.open({ proxyServer: 'http://127.0.0.1:7890' }),
      (e) => e instanceof bb.BitBrowserError && e.kind === 'CDPConnectFailed',
    );
    const paths = calls.map(u => u.split('/').slice(-2).join('/'));
    assert.deepEqual(paths, ['browser/update', 'browser/open', 'browser/close', 'browser/delete']);
  });

  test('cleanup tolerance: browser.close throws → delete still attempted', async () => {
    const calls = [];
    bb._deps.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/browser/update'))
        return { ok: true, json: async () => ({ success: true, data: { id: 'q1' } }) };
      if (String(url).endsWith('/browser/open'))
        return { ok: true, json: async () => ({ success: true, data: { http: '127.0.0.1:54678' } }) };
      return { ok: true, json: async () => ({ success: true }) };
    };
    bb._deps.connectOverCDP = async () => ({ close: async () => { throw new Error('already dead'); } });

    const session = await bb.open({ proxyServer: 'http://127.0.0.1:7890' });
    await session.close(); // must not throw
    const paths = calls.map(u => u.split('/').slice(-2).join('/'));
    assert.deepEqual(paths, ['browser/update', 'browser/open', 'browser/close', 'browser/delete']);
  });

  test('open() throws if proxyServer empty', async () => {
    await assert.rejects(
      () => bb.open({ proxyServer: '' }),
      /proxy/i,
    );
  });
});
