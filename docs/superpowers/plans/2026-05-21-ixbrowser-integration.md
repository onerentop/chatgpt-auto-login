# ixbrowser Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the BitBrowser fingerprint-browser integration (shipped at v2.11.0) with an ixbrowser equivalent. Mechanical migration: same one-shot lifecycle, same payment-phase contract, different API client and on-the-wire shapes.

**Architecture:** `git mv server/bitbrowser.js → server/ixbrowser.js` and rewrite against the ixbrowser local HTTP API at port 53200. Update `protocol-engine.js`'s require + branch flag + log labels. Update `web/src/views/Config.vue`'s indented form section. 23 unit tests carry over with mechanical mock-shape edits.

**Tech Stack:** Node 22 (global `fetch`, built-in `node:test`), Playwright, Element Plus, Vue 3.

**Spec:** `docs/superpowers/specs/2026-05-21-ixbrowser-integration-design.md`
**Supersedes:** `docs/superpowers/specs/2026-05-21-bitbrowser-integration-design.md` (v2.11.0)
**Reference:** `E:\workspace\projects\ixbrowser-local-api-python` (official Python SDK)

---

## File Structure

| Path | Action | Responsibility |
| --- | --- | --- |
| `server/ixbrowser.js` | **Rename + rewrite** (was `server/bitbrowser.js`, ~165 lines) | ixbrowser API client. Exports `open({proxyServer})`, `healthCheck()`, `IxBrowserError`, `_deps`, `__internal`. |
| `server/ixbrowser.spec.js` | **Rename + rewrite** (was `server/bitbrowser.spec.js`, ~270 lines) | 23 unit tests using `node:test`. Mocks `fetch` and `connectOverCDP` via `_deps`. |
| `package.json` | **Modify** | `test` script path updated to point at the renamed spec file. |
| `config.json` | **Local edit (gitignored)** | Rename `bitbrowser` block → `ixbrowser`. Default `apiUrl` becomes `http://127.0.0.1:53200`. |
| `protocol-engine.js` | **Modify** | Require path, variable name, runtimeCfg key, log labels (5 small edits). |
| `web/src/views/Config.vue` | **Modify** | UI section heading + form field renames + save/load nested mapping. |
| `web/dist/` | **Rebuild (local only)** | Bundled assets reflect renamed section. Stays gitignored. |

---

## Task 1: Rename `bitbrowser` block in local `config.json` to `ixbrowser`

**Important:** `config.json` is in `.gitignore`. Same constraint as the BitBrowser plan — this is a **local-only edit**, never lands in git.

**Files:**
- Modify locally only: `config.json`

- [ ] **Step 1: Edit `config.json`**

Open `config.json`. Locate the existing `bitbrowser` block at the bottom (added during BitBrowser implementation):

```json
  "bitbrowser": {
    "enabled": true,
    "apiUrl": "http://127.0.0.1:54345",
    "openTimeoutMs": 30000
  }
```

Replace it with:

```json
  "ixbrowser": {
    "enabled": false,
    "apiUrl": "http://127.0.0.1:53200",
    "openTimeoutMs": 30000
  }
```

Three changes: key renamed, `enabled` reset to `false` (so we start from kill-switch state and re-enable after testing), `apiUrl` port `54345` → `53200`.

- [ ] **Step 2: Verify the JSON parses**

```
node -e "JSON.parse(require('fs').readFileSync('config.json','utf-8')); console.log('ok')"
```

Expected output: `ok`

- [ ] **Step 3: Do NOT commit**

`config.json` is gitignored. Leave the file as a working-tree modification only.

---

## Task 2: Port `server/bitbrowser.{js,spec.js}` → `server/ixbrowser.{js,spec.js}` (atomic)

This task touches three files in a single commit so the project is never in a broken state. `git mv` preserves blame history.

**Files:**
- Rename + rewrite: `server/bitbrowser.js` → `server/ixbrowser.js`
- Rename + rewrite: `server/bitbrowser.spec.js` → `server/ixbrowser.spec.js`
- Modify: `package.json` (test script path)

- [ ] **Step 1: Rename the implementation file**

```
git mv server/bitbrowser.js server/ixbrowser.js
```

- [ ] **Step 2: Replace `server/ixbrowser.js` with the ported version**

Overwrite the entire contents of `server/ixbrowser.js` with:

```js
// ixbrowser local API client.
// Reference: E:\workspace\projects\ixbrowser-local-api-python (official Python SDK).
// Endpoints used:
//   POST /api/v2/profile-create
//   POST /api/v2/profile-open
//   POST /api/v2/profile-close
//   POST /api/v2/profile-delete
//   POST /api/v2/profile-list  (healthCheck only)

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const deps = {
  fetch: (...args) => globalThis.fetch(...args),
  connectOverCDP: async (url) => {
    const { chromium } = require('playwright');
    return chromium.connectOverCDP(url);
  },
};

// Read fresh on every call: the UI writes config.json at runtime, and a new
// value must take effect without a server restart. Do not cache.
function readCfg() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')).ixbrowser || {}; }
  catch { return {}; }
}

function getApiBase(override) {
  const raw = override || readCfg().apiUrl || 'http://127.0.0.1:53200';
  return raw.trim().replace(/\/+$/, '');
}

function parseProxy(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('ixbrowser: proxyServer is required (got empty/undefined)');
  }
  let u;
  try { u = new URL(url); }
  catch { throw new Error(`ixbrowser: malformed proxyServer "${url}"`); }
  const scheme = u.protocol.replace(/:$/, '');
  if (!['http', 'https', 'socks5'].includes(scheme)) {
    throw new Error(`ixbrowser: unsupported proxy scheme "${scheme}"`);
  }
  if (!u.hostname || !u.port) {
    throw new Error(`ixbrowser: proxyServer "${url}" missing host or port`);
  }
  return { proxy_type: scheme, proxy_ip: u.hostname, proxy_port: u.port };
}

class IxBrowserError extends Error {
  constructor(kind, msg) { super(msg); this.kind = kind; }
}

async function request(pathname, body, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await deps.fetch(`${getApiBase()}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
  } catch (e) {
    const code = e.code || e.cause?.code || '';
    if (code === 'ECONNREFUSED' || e.name === 'AbortError' || /fetch failed/i.test(e.message)) {
      throw new IxBrowserError('IxBrowserUnavailable', `ixbrowser unavailable: ${getApiBase()}`);
    }
    throw new IxBrowserError('IxBrowserApiError', `ixbrowser request error: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new IxBrowserError('IxBrowserApiError', `ixbrowser HTTP ${res.status} on ${pathname}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!json.error || json.error.code !== 0) {
    const msg = json.error?.message || `error.code=${json.error?.code}`;
    throw new IxBrowserError('IxBrowserApiError', `ixbrowser API: ${String(msg).slice(0, 80)}`);
  }
  return json.data || {};
}

async function healthCheck() {
  // /api/v2/profile-list is a primary documented endpoint; any HTTP response
  // (including error.code !== 0) means the daemon is alive. Only network-level
  // failure flips false. 3s timeout prevents a hung daemon blocking batch start
  // for ~21s (OS TCP timeout).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await deps.fetch(`${getApiBase()}/api/v2/profile-list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: 1, limit: 1 }),
      signal: ctrl.signal,
    });
    return !!res;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function open({ proxyServer } = {}) {
  const proxy = parseProxy(proxyServer); // throws on empty/malformed before any HTTP
  const cfg = readCfg();
  const openTimeoutMs = Number(cfg.openTimeoutMs) || 30000;

  let profile_id = null;
  let opened = false;
  let browser = null;

  const close = async () => {
    if (browser)    { try { await browser.close(); } catch {} browser = null; }
    if (opened)     { try { await request('/api/v2/profile-close', { profile_id }); } catch {} opened = false; }
    if (profile_id) {
      try { await request('/api/v2/profile-delete', { profile_id }); }
      catch (e) { console.log(`[ixbrowser] delete failed: ${e.message?.slice(0, 80)}`); }
      profile_id = null;
    }
  };

  try {
    // 1. Create a one-shot profile.
    const createBody = {
      name: `pay-${Date.now()}`,
      note: 'auto-pay',
      site_id: 22,   // 22 = blank page (Consts.DEFAULT_SITE_ID_BLANK_PAGE in the Python SDK)
      color: '#1E90FF',
      proxy_config: {
        proxy_mode: 2,   // 2 = custom (Consts.PROXY_MODE_CUSTOM)
        ...proxy,        // { proxy_type, proxy_ip, proxy_port }
      },
    };
    const createData = await request('/api/v2/profile-create', createBody);
    // The Python SDK's create_profile returns the raw 'data' field, but the spec
    // notes the exact id field name is empirically unconfirmed. Accept either.
    profile_id = createData.profile_id || createData.id;
    if (!profile_id) throw new IxBrowserError('IxBrowserApiError', '/profile-create did not return profile_id');

    // 2. Launch and obtain CDP endpoint.
    // /profile-open cold-starts a Chrome subprocess on the ixbrowser side, which
    // can take 10-15s on first launch. Pass openTimeoutMs (default 30s) so we
    // don't trip the request() 15s default and misclassify a slow launch as
    // IxBrowserUnavailable. Mark opened=true BEFORE awaiting: if the request
    // succeeds but we error out mid-launch, close() needs to call /profile-close
    // to terminate the partially-launched window.
    opened = true;
    const openData = await request('/api/v2/profile-open', {
      profile_id,
      load_extensions: true,
      load_profile_info_page: false,
      cookies_backup: false,
      args: ['--disable-extension-welcome-page'],
    }, openTimeoutMs);
    const debugging_address = openData.debugging_address;
    if (!debugging_address) throw new IxBrowserError('IxBrowserApiError', '/profile-open did not return debugging_address');
    const cdpUrl = debugging_address.startsWith('http') ? debugging_address : `http://${debugging_address}`;

    // 3. Connect Playwright with a hard timeout budget.
    // Capture the timer so we can clear it if connectOverCDP wins the race —
    // otherwise the setTimeout keeps the event loop alive for openTimeoutMs and
    // its rejection becomes a deferred rejection on a Promise nobody is listening to.
    let cdpTimer;
    browser = await Promise.race([
      deps.connectOverCDP(cdpUrl),
      new Promise((_, rej) => {
        cdpTimer = setTimeout(
          () => rej(new IxBrowserError('CDPConnectFailed', `connectOverCDP timeout after ${openTimeoutMs}ms`)),
          openTimeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(cdpTimer))
      .catch((e) => {
        if (e instanceof IxBrowserError) throw e;
        throw new IxBrowserError('CDPConnectFailed', `connectOverCDP failed: ${e.message?.slice(0, 80)}`);
      });

    return { browser, close };
  } catch (e) {
    await close();
    throw e;
  }
}

module.exports = {
  open,
  healthCheck,
  IxBrowserError,
  _deps: deps,
  __internal: { parseProxy, readCfg, getApiBase, request },
};
```

- [ ] **Step 3: Rename the test file**

```
git mv server/bitbrowser.spec.js server/ixbrowser.spec.js
```

- [ ] **Step 4: Replace `server/ixbrowser.spec.js` with the ported tests**

Overwrite the entire contents of `server/ixbrowser.spec.js` with:

```js
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const bb = require('./ixbrowser');

// Snapshot real deps once and restore before every test so _deps stays clean
// across describe blocks and any future spec files.
const realDeps = { ...bb._deps };
beforeEach(() => { Object.assign(bb._deps, realDeps); });

describe('parseProxy', () => {
  test('parses http://host:port', () => {
    const out = bb.__internal.parseProxy('http://127.0.0.1:7890');
    assert.deepEqual(out, { proxy_type: 'http', proxy_ip: '127.0.0.1', proxy_port: '7890' });
  });

  test('parses https scheme', () => {
    const out = bb.__internal.parseProxy('https://proxy.example.com:8443');
    assert.deepEqual(out, { proxy_type: 'https', proxy_ip: 'proxy.example.com', proxy_port: '8443' });
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
    assert.deepEqual(out, { proxy_type: 'socks5', proxy_ip: '127.0.0.1', proxy_port: '1080' });
  });
});

describe('healthCheck()', () => {
  test('returns true on 200', async () => {
    bb._deps.fetch = async () => ({ ok: true, status: 200, json: async () => ({ error: { code: 0 } }) });
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
    assert.equal(bb.__internal.getApiBase('http://127.0.0.1:53200'), 'http://127.0.0.1:53200');
  });
  test('strips a single trailing slash', () => {
    assert.equal(bb.__internal.getApiBase('http://127.0.0.1:53200/'), 'http://127.0.0.1:53200');
  });
  test('strips multiple trailing slashes', () => {
    assert.equal(bb.__internal.getApiBase('http://127.0.0.1:53200//'), 'http://127.0.0.1:53200');
  });
  test('trims leading and trailing whitespace', () => {
    assert.equal(bb.__internal.getApiBase('  http://127.0.0.1:53200  '), 'http://127.0.0.1:53200');
  });
  test('preserves a subpath', () => {
    assert.equal(bb.__internal.getApiBase('http://127.0.0.1:53200/v1/'), 'http://127.0.0.1:53200/v1');
  });
});

describe('open() — happy path', () => {
  test('opens, returns session with browser+close, cleans up fully', async () => {
    const calls = [];
    bb._deps.fetch = async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), body });
      if (String(url).endsWith('/api/v2/profile-create'))
        return { ok: true, json: async () => ({ error: { code: 0 }, data: { profile_id: 123 } }) };
      if (String(url).endsWith('/api/v2/profile-open'))
        return { ok: true, json: async () => ({ error: { code: 0 }, data: { debugging_address: '127.0.0.1:54678' } }) };
      if (String(url).endsWith('/api/v2/profile-close'))
        return { ok: true, json: async () => ({ error: { code: 0 } }) };
      if (String(url).endsWith('/api/v2/profile-delete'))
        return { ok: true, json: async () => ({ error: { code: 0 } }) };
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
    const paths = calls.map(c => c.url.split('/').slice(-1)[0]);
    assert.deepEqual(paths, ['profile-create', 'profile-open', 'profile-close', 'profile-delete']);

    // Verify proxy fields on the create call (nested under proxy_config)
    const create = calls.find(c => c.url.endsWith('/api/v2/profile-create')).body;
    assert.equal(create.proxy_config.proxy_mode, 2);
    assert.equal(create.proxy_config.proxy_type, 'http');
    assert.equal(create.proxy_config.proxy_ip, '127.0.0.1');
    assert.equal(create.proxy_config.proxy_port, '7890');
    assert.match(create.name, /^pay-/);
  });

  test('session.close() is idempotent — second call is a no-op', async () => {
    const calls = [];
    bb._deps.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/api/v2/profile-create'))
        return { ok: true, json: async () => ({ error: { code: 0 }, data: { profile_id: 555 } }) };
      if (String(url).endsWith('/api/v2/profile-open'))
        return { ok: true, json: async () => ({ error: { code: 0 }, data: { debugging_address: '127.0.0.1:54678' } }) };
      return { ok: true, json: async () => ({ error: { code: 0 } }) };
    };
    let closeCount = 0;
    bb._deps.connectOverCDP = async () => ({ close: async () => { closeCount++; } });

    const session = await bb.open({ proxyServer: 'http://127.0.0.1:7890' });
    await session.close();
    await session.close();
    assert.equal(closeCount, 1, 'browser.close called only once');
    const paths = calls.map(u => u.split('/').slice(-1)[0]);
    assert.deepEqual(paths, ['profile-create', 'profile-open', 'profile-close', 'profile-delete']);
  });
});

describe('open() — error paths', () => {
  test('ECONNREFUSED on /profile-create → IxBrowserUnavailable, no cleanup calls', async () => {
    const calls = [];
    bb._deps.fetch = async (url) => {
      calls.push(String(url));
      const e = new Error('fetch failed'); e.cause = { code: 'ECONNREFUSED' };
      throw e;
    };
    bb._deps.connectOverCDP = async () => assert.fail('should not be called');

    await assert.rejects(
      () => bb.open({ proxyServer: 'http://127.0.0.1:7890' }),
      (e) => e instanceof bb.IxBrowserError && e.kind === 'IxBrowserUnavailable',
    );
    // Only the create call was attempted; no close/delete because no profile_id was issued
    assert.deepEqual(calls.map(u => u.split('/').slice(-1)[0]), ['profile-create']);
  });

  test('create returns error.code != 0 → IxBrowserApiError, no close/delete', async () => {
    const calls = [];
    bb._deps.fetch = async (url) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ error: { code: 5001, message: '已超过免费用户每天最大创建窗口数' } }) };
    };
    bb._deps.connectOverCDP = async () => assert.fail('should not be called');

    await assert.rejects(
      () => bb.open({ proxyServer: 'http://127.0.0.1:7890' }),
      (e) => e instanceof bb.IxBrowserError && e.kind === 'IxBrowserApiError' && /已超过/.test(e.message),
    );
    assert.deepEqual(calls.map(u => u.split('/').slice(-1)[0]), ['profile-create']);
  });

  test('open ok but connectOverCDP rejects → CDPConnectFailed, close+delete invoked', async () => {
    const calls = [];
    bb._deps.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/api/v2/profile-create'))
        return { ok: true, json: async () => ({ error: { code: 0 }, data: { profile_id: 7 } }) };
      if (String(url).endsWith('/api/v2/profile-open'))
        return { ok: true, json: async () => ({ error: { code: 0 }, data: { debugging_address: '127.0.0.1:54678' } }) };
      return { ok: true, json: async () => ({ error: { code: 0 } }) };
    };
    bb._deps.connectOverCDP = async () => { throw new Error('connect refused'); };

    await assert.rejects(
      () => bb.open({ proxyServer: 'http://127.0.0.1:7890' }),
      (e) => e instanceof bb.IxBrowserError && e.kind === 'CDPConnectFailed',
    );
    const paths = calls.map(u => u.split('/').slice(-1)[0]);
    assert.deepEqual(paths, ['profile-create', 'profile-open', 'profile-close', 'profile-delete']);
  });

  test('cleanup tolerance: browser.close throws → delete still attempted', async () => {
    const calls = [];
    bb._deps.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/api/v2/profile-create'))
        return { ok: true, json: async () => ({ error: { code: 0 }, data: { profile_id: 9 } }) };
      if (String(url).endsWith('/api/v2/profile-open'))
        return { ok: true, json: async () => ({ error: { code: 0 }, data: { debugging_address: '127.0.0.1:54678' } }) };
      return { ok: true, json: async () => ({ error: { code: 0 } }) };
    };
    bb._deps.connectOverCDP = async () => ({ close: async () => { throw new Error('already dead'); } });

    const session = await bb.open({ proxyServer: 'http://127.0.0.1:7890' });
    await session.close();
    const paths = calls.map(u => u.split('/').slice(-1)[0]);
    assert.deepEqual(paths, ['profile-create', 'profile-open', 'profile-close', 'profile-delete']);
  });

  test('open() throws if proxyServer empty', async () => {
    await assert.rejects(
      () => bb.open({ proxyServer: '' }),
      /required/i,
    );
  });
});
```

- [ ] **Step 5: Update `package.json` test script**

Find the `"test"` line in `scripts`:

```json
"test": "node --test server/bitbrowser.spec.js"
```

Replace with:

```json
"test": "node --test server/ixbrowser.spec.js"
```

- [ ] **Step 6: Run unit tests**

```
npm test
```

Expected: **23 passing tests, 0 failures.** (Same count as v2.11.0's BitBrowser tests — the migration preserves coverage.)

If any test fails, the most likely cause is a typo in the mechanical rewrite. Re-check the failing test's mock response shape and assertion field names against the corresponding section of `docs/superpowers/specs/2026-05-21-ixbrowser-integration-design.md`.

- [ ] **Step 7: Commit (single atomic commit)**

```
git add server/ixbrowser.js server/ixbrowser.spec.js package.json
git commit -m "refactor(ixbrowser): port server/bitbrowser → server/ixbrowser"
```

The `git mv` from steps 1 and 3 should appear in the diff as renames (with %similarity > 0 for blame continuity).

---

## Task 3: Wire `protocol-engine.js` to ixbrowser

**Files:**
- Modify: `protocol-engine.js` (5 small edits, all mechanical renames)

Find each of the 5 locations below and apply the edit. None of the surrounding logic changes.

- [ ] **Step 1: Update the require**

Find:

```js
const bitbrowser = require('./server/bitbrowser');
```

Replace with:

```js
const ixbrowser = require('./server/ixbrowser');
```

- [ ] **Step 2: Update the pre-flight block (after Discord-connected log)**

Find:

```js
      const useBitBrowser = !!(runtimeCfg.bitbrowser && runtimeCfg.bitbrowser.enabled);
      if (useBitBrowser) {
        const ok = await bitbrowser.healthCheck();
        console.log(ok
          ? '[BitBrowser] ready'
          : '[BitBrowser] unavailable; payment will fail per account');
      }
```

Replace with:

```js
      const useIxBrowser = !!(runtimeCfg.ixbrowser && runtimeCfg.ixbrowser.enabled);
      if (useIxBrowser) {
        const ok = await ixbrowser.healthCheck();
        console.log(ok
          ? '[ixbrowser] ready'
          : '[ixbrowser] unavailable; payment will fail per account');
      }
```

- [ ] **Step 3: Update the payment-phase branch**

Find:

```js
          if (useBitBrowser) {
            // Let open() throw on failure — the existing outer catch will record
            // summary.error++, emit status, and log uniformly. Letting the error
            // propagate also lets the consecutive-error cooldown counter see it
            // (see spec §5.1: "the existing per-batch cooldown counter ... will
            // halt the batch automatically").
            session = await bitbrowser.open({ proxyServer: proxyMgr.getProxyUrl() || '' });
            browser = session.browser;
            this._session = session;
          } else {
```

Replace with:

```js
          if (useIxBrowser) {
            // Let open() throw on failure — the existing outer catch will record
            // summary.error++, emit status, and log uniformly. Letting the error
            // propagate also lets the consecutive-error cooldown counter see it
            // (see spec §5.1: "the existing per-batch cooldown counter ... will
            // halt the batch automatically").
            session = await ixbrowser.open({ proxyServer: proxyMgr.getProxyUrl() || '' });
            browser = session.browser;
            this._session = session;
          } else {
```

Only two lines changed: `useBitBrowser` → `useIxBrowser`, `bitbrowser.open` → `ixbrowser.open`. The rest stays byte-identical.

- [ ] **Step 4: Smoke test that the file parses**

```
node -e "require('./protocol-engine.js'); console.log('ok')"
```

Expected output: `ok`. A SyntaxError or `MODULE_NOT_FOUND` for `./server/bitbrowser` means one of the renames was missed — re-run a grep:

```
grep -n -i bitbrowser protocol-engine.js
```

Expected: zero matches.

- [ ] **Step 5: Re-run unit tests as regression check**

```
npm test
```

Expected: 23 passing tests, unchanged from Task 2. (The engine doesn't affect the spec file, but this confirms the rename didn't break anything upstream.)

- [ ] **Step 6: Commit**

```
git add protocol-engine.js
git commit -m "refactor(ixbrowser): rename require/var/cfg-key/log-labels in protocol-engine"
```

---

## Task 4: Wire `web/src/views/Config.vue` to ixbrowser + rebuild dist

**Files:**
- Modify: `web/src/views/Config.vue`
- Rebuild locally: `web/dist/*` (gitignored — no commit)

- [ ] **Step 1: Rename form-field reactive keys**

Find the `reactive({` block and locate the three BitBrowser keys (added during v2.11.0 work):

```js
  bitbrowserEnabled: false,
  bitbrowserApiUrl: 'http://127.0.0.1:54345',
  bitbrowserOpenTimeoutMs: 30000,
```

Replace with:

```js
  ixbrowserEnabled: false,
  ixbrowserApiUrl: 'http://127.0.0.1:53200',
  ixbrowserOpenTimeoutMs: 30000,
```

- [ ] **Step 2: Rename the nested-config loader inside `onMounted`**

Find the existing `if (cfg.bitbrowser) { ... }` block:

```js
    if (cfg.bitbrowser) {
      if (cfg.bitbrowser.enabled !== undefined) form.bitbrowserEnabled = cfg.bitbrowser.enabled
      if (cfg.bitbrowser.apiUrl !== undefined) form.bitbrowserApiUrl = cfg.bitbrowser.apiUrl
      if (cfg.bitbrowser.openTimeoutMs !== undefined) form.bitbrowserOpenTimeoutMs = cfg.bitbrowser.openTimeoutMs
    }
```

Replace with:

```js
    if (cfg.ixbrowser) {
      if (cfg.ixbrowser.enabled !== undefined) form.ixbrowserEnabled = cfg.ixbrowser.enabled
      if (cfg.ixbrowser.apiUrl !== undefined) form.ixbrowserApiUrl = cfg.ixbrowser.apiUrl
      if (cfg.ixbrowser.openTimeoutMs !== undefined) form.ixbrowserOpenTimeoutMs = cfg.ixbrowser.openTimeoutMs
    }
```

- [ ] **Step 3: Rename the save-payload rebuild inside `handleSave`**

Find:

```js
    delete payload.bitbrowserEnabled
    delete payload.bitbrowserApiUrl
    delete payload.bitbrowserOpenTimeoutMs
    payload.bitbrowser = {
      enabled: form.bitbrowserEnabled,
      apiUrl: form.bitbrowserApiUrl,
      openTimeoutMs: Number(form.bitbrowserOpenTimeoutMs) || 30000,
    }
```

Replace with:

```js
    delete payload.ixbrowserEnabled
    delete payload.ixbrowserApiUrl
    delete payload.ixbrowserOpenTimeoutMs
    payload.ixbrowser = {
      enabled: form.ixbrowserEnabled,
      apiUrl: form.ixbrowserApiUrl,
      openTimeoutMs: Number(form.ixbrowserOpenTimeoutMs) || 30000,
    }
```

- [ ] **Step 4: Update the template section**

Find the existing template section:

```html
      <el-divider content-position="left">指纹浏览器（BitBrowser）</el-divider>
      <el-form-item label="启用 BitBrowser">
        <el-switch v-model="form.bitbrowserEnabled" />
        <span style="color:#909399;margin-left:8px;font-size:12px">开启后支付走 BitBrowser 指纹窗口（需要本地客户端运行）</span>
      </el-form-item>
      <el-form-item label="API 地址">
        <el-input v-model="form.bitbrowserApiUrl" placeholder="http://127.0.0.1:54345" />
      </el-form-item>
      <el-form-item label="打开超时 (ms)">
        <el-input-number v-model="form.bitbrowserOpenTimeoutMs" :min="5000" :step="1000" />
        <span style="color:#909399;margin-left:8px;font-size:12px">connectOverCDP 总超时，冷启动建议 30000+</span>
      </el-form-item>
```

Replace with:

```html
      <el-divider content-position="left">指纹浏览器（ixbrowser）</el-divider>
      <el-form-item label="启用 ixbrowser">
        <el-switch v-model="form.ixbrowserEnabled" />
        <span style="color:#909399;margin-left:8px;font-size:12px">开启后支付走 ixbrowser 指纹窗口（需要本地客户端运行）</span>
      </el-form-item>
      <el-form-item label="API 地址">
        <el-input v-model="form.ixbrowserApiUrl" placeholder="http://127.0.0.1:53200" />
      </el-form-item>
      <el-form-item label="打开超时 (ms)">
        <el-input-number v-model="form.ixbrowserOpenTimeoutMs" :min="5000" :step="1000" />
        <span style="color:#909399;margin-left:8px;font-size:12px">connectOverCDP 总超时，冷启动建议 30000+</span>
      </el-form-item>
```

- [ ] **Step 5: Grep for any leftover BitBrowser references**

```
grep -n -i bitbrowser web/src/views/Config.vue
```

Expected: zero matches.

- [ ] **Step 6: Build the front-end**

```
cd web
npm run build
```

Expected output: `✓ built in <N>s` and a freshly-named `dist/assets/Config-*.js` whose hash differs from before.

- [ ] **Step 7: Verify the bundle reflects the rename**

```
node -e "const fs=require('fs'),p=require('path'); const dir='web/dist/assets'; const f=fs.readdirSync(dir).find(n=>/^Config-.*\.js$/.test(n)); const s=fs.readFileSync(p.join(dir,f),'utf-8'); console.log('found:', f, 'ixbrowser:', /ixbrowser/i.test(s), 'leftover bitbrowser:', /bitbrowser/i.test(s));"
```

Expected output: `found: Config-XXXXXXXX.js ixbrowser: true leftover bitbrowser: false`.

A `true` on `leftover bitbrowser` means step 1-4 missed a reference — go back and grep the source.

- [ ] **Step 8: Commit (source only — dist is gitignored)**

```
git add web/src/views/Config.vue
git commit -m "refactor(ixbrowser): rename Config.vue section + fields from BitBrowser"
```

---

## Task 5: Manual integration verification

**Files:** No code changes — verification only.

Same 5 scenarios used to verify BitBrowser at v2.11.0. Each takes 2–5 minutes and uses 1 idle account (or repeats an already-tested email if no idle remain).

**Pre-conditions:**

1. ixbrowser desktop client is running on port 53200. Verify:
   ```
   (Invoke-WebRequest -Method POST -Uri http://127.0.0.1:53200/api/v2/profile-list -Body '{"page":1,"limit":1}' -ContentType 'application/json' -UseBasicParsing).StatusCode
   ```
   Expected: 200.

2. The local server is restarted to load the renamed module:
   ```
   # Stop the running server
   Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
   # Start fresh
   node server/index.js
   ```

3. The sing-box proxy is running and showing a US exit node (if testing payment flow that needs PayPal).

- [ ] **Scenario A — Regression: `enabled:false` uses native Chrome**

  1. Confirm `config.json` has `"ixbrowser": { "enabled": false, ... }`.
  2. Trigger a 1-account batch via the UI or:
     ```
     curl -s -X POST -H 'Content-Type: application/json' \
       -d '{"emails":["<one idle email>"]}' http://localhost:3000/api/execute
     ```
  3. Watch `server-test.log` (or the UI's Execute view).
  4. **Expected:**
     - Zero `[ixbrowser]` log lines.
     - Payment phase logs `[Pay] Starting auto-payment flow...` followed by the regular Chrome opening Stripe/PayPal.
     - Behavior identical to v2.11.0 with BitBrowser disabled.

- [ ] **Scenario B — ixbrowser unavailable (apiUrl points at empty port)**

  1. Edit `config.json`: temporarily set `"apiUrl": "http://127.0.0.1:53201"` (port that has nothing listening). Set `"enabled": true`.
  2. Restart server.
  3. Trigger a 1-account batch.
  4. **Expected:**
     - At batch start: `[ixbrowser] unavailable; payment will fail per account`.
     - In payment phase: log shows `error: ixbrowser unavailable: http://127.0.0.1:53201`.
     - Account status → `error`.
     - `consecutive errors: 1/3` line appears (proves the outer catch + cooldown counter pathway works).
  5. Restore `apiUrl` to `http://127.0.0.1:53200` afterwards.

- [ ] **Scenario C — ixbrowser running, payment opens via API**

  1. Confirm pre-conditions above. Edit `config.json`: `enabled: true`, `apiUrl: http://127.0.0.1:53200`. Restart server.
  2. Snapshot the existing `pay-*` profile count:
     ```
     curl -s -X POST http://127.0.0.1:53200/api/v2/profile-list -H "Content-Type: application/json" -d '{"page":1,"limit":100}' | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const j=JSON.parse(s);const list=j.data?.list||j.data||[];console.log('pay-* baseline:', list.filter(p=>/^pay-/.test(p.name||'')).length);});"
     ```
  3. Trigger a 1-account batch with a fresh or recently-failed email.
  4. **Expected:**
     - `[ixbrowser] ready` at batch start.
     - During payment: a `pay-<timestamp>` profile appears in ixbrowser's profile list.
     - After completion: `pay-*` count returns to baseline (the profile was deleted).

- [ ] **Scenario D — 5-account batch, zero leak**

  1. Same prep as C.
  2. Run a 5-account batch.
  3. After completion, run the snapshot command from Scenario C step 2.
  4. **Expected:** `pay-*` count equals the baseline from before the batch.

- [ ] **Scenario E — Stop mid-batch cleans up**

  1. Same prep as C.
  2. Start a 5-account batch.
  3. As soon as the 2nd account's `pay-*` profile appears, click 停止 in the UI (or `POST /api/execute/stop`).
  4. **Expected:** Within a few seconds the running `pay-*` profile is removed and the count returns to baseline.

If all 5 scenarios pass, tag the release:

```
git tag -a v2.12.0 -m "v2.12.0 — switch fingerprint browser from BitBrowser to ixbrowser"
```

(Do **not** push the tag without explicit user confirmation.)

If any scenario fails, the failure mode points at the responsible step:

| Failure | Look at |
| --- | --- |
| A regresses | Task 3 step 2 — the `useIxBrowser` flag |
| B: no error log | Task 2 — the `request()` error mapping |
| C: `data.profile_id` missing | Task 2 — the `createData.profile_id \|\| createData.id` fallback worked; if neither is present, the actual response shape differs from spec §10's prediction. Print `createData` to find the real field name. |
| C: window doesn't disappear | Task 2 — the `close()` ordering |
| D: leftover `pay-*` | Task 2 — cleanup tolerance |
| E: stop hangs | The pre-existing `stop()` in `protocol-engine.js` already calls `this._session.close()` — unchanged by this plan but verify with `grep -n 'this._session' protocol-engine.js`. If it's missing, that's a regression introduced earlier; restore it from the v2.11.0 commit. |

---

## Self-Review Notes

This plan covers every numbered section of the spec:

| Spec section | Plan task |
| --- | --- |
| §2.1 payment-phase contract unchanged | Task 3 (only renames, no logic change) |
| §2.2 same one-shot lifecycle | Task 2 — `open()` body |
| §2.3 sing-box reuse | Task 2 — `parseProxy` + `createBody.proxy_config` |
| §2.4 BitBrowser code removed | Tasks 2-4 — `git mv` deletes the old files |
| §2.5 feature flag preserves Chrome path | Task 1 + Task 3 step 2 (`useIxBrowser`) |
| §3 architecture | Tasks 2-4 |
| §4 data flow | Task 2 — `open()` happy path |
| §5 error handling | Task 2 — `request()` + close() invariants |
| §5.1 close() invariants | Task 2 — flag-progression comments in `open()` |
| §5.2 batch pre-flight | Task 3 step 2 |
| §6 config | Task 1 |
| §6.1 frontend rename | Task 4 |
| §7 module surface | Task 2 |
| §8.1 unit tests (23) | Task 2 step 4 |
| §8.2 manual scenarios A-E | Task 5 |
| §8.3 regression matrix | Task 3 step 5 + Task 5 scenario A |
| §10 OQ: `profile_id` vs `id` | Task 2 — `createData.profile_id \|\| createData.id` fallback |
| §10 OQ: daily-create limit | Task 5 scenario D will reveal; falls back to a future spec |
