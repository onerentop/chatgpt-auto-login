# BitBrowser Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the native Chrome window in `protocol-engine.js`'s payment phase with a BitBrowser fingerprint-browser window opened via its local HTTP API at `127.0.0.1:54345`, behind a feature flag.

**Architecture:** A new `server/bitbrowser.js` module wraps BitBrowser's `/browser/update`, `/browser/open`, `/browser/close`, `/browser/delete` calls and returns a `{ browser, close() }` session compatible with the existing Playwright-driven payment code. `protocol-engine.js` branches on `config.bitbrowser.enabled`: original `launchChrome` path when off, new module when on.

**Tech Stack:** Node 22 (global `fetch`, built-in `node:test`), Playwright (existing), Element Plus (existing front-end), Vue 3 (existing).

**Spec:** `docs/superpowers/specs/2026-05-21-bitbrowser-integration-design.md`

---

## File Structure

| Path | Action | Responsibility |
| --- | --- | --- |
| `server/bitbrowser.js` | **Create** (~150 lines) | BitBrowser API client. Exports `open({ proxyServer })`, `healthCheck()`, plus `_deps` and `__internal` for tests. |
| `server/bitbrowser.spec.js` | **Create** (~180 lines) | Unit tests using `node:test`. Mocks `fetch` and `connectOverCDP` via `_deps`. |
| `package.json` | **Modify** | Add `"test"` script: `node --test server/bitbrowser.spec.js`. |
| `config.json` | **Modify** | Add `bitbrowser` block with `enabled: false`, `apiUrl`, `openTimeoutMs`. |
| `protocol-engine.js` | **Modify** (lines 92–94, 130–138, 297–347, 376–380) | Branch payment phase on flag; integrate session lifecycle into `stop()` and final cleanup. |
| `web/src/views/Config.vue` | **Modify** | Add 指纹浏览器 section mirroring 代理 section. |
| `web/dist/` | **Rebuild (local only)** | Bundled assets are gitignored — each environment runs `npm run build` from `web/` after pulling. |

---

## Task 1: Add `bitbrowser` block to local `config.json`

**Important:** `config.json` is in `.gitignore` (contains Discord token + SMS API key). **Do not commit it.** The downstream code in Task 7 step 4 reads `runtimeCfg.bitbrowser && runtimeCfg.bitbrowser.enabled` — if the block is absent, `useBitBrowser` is `false` and the original Chrome path runs unchanged. So this task is a **local-only edit** required for the user to enable the feature in Task 9; it never lands in git.

**Files:**
- Modify locally only: `config.json` (add new top-level `bitbrowser` object after `proxy`)

- [ ] **Step 1: Edit `config.json`**

Open `config.json`. Find the line containing the closing brace of the `proxy` object. Add a comma after it, then append the `bitbrowser` block. The final file should look like (only the tail differs):

```json
  "proxy": {
    "enabled": false,
    "subscriptionUrl": "https://my.ssonenetwork.com/ssone/6d931da31a613680b436093b8a373c59",
    "regionFilter": "US",
    "rotationStrategy": "random"
  },
  "bitbrowser": {
    "enabled": false,
    "apiUrl": "http://127.0.0.1:54345",
    "openTimeoutMs": 30000
  }
}
```

- [ ] **Step 2: Verify the JSON parses**

Run:

```
node -e "JSON.parse(require('fs').readFileSync('config.json','utf-8')); console.log('ok')"
```

Expected output: `ok`

- [ ] **Step 3: Do NOT commit**

`config.json` is gitignored. Leave the file as a working-tree modification only.

---

## Task 2: Wire up `node:test` runner

**Files:**
- Modify: `package.json` (add `test` script)

- [ ] **Step 1: Add the test script**

In `package.json`, locate the `"scripts"` object and add a `"test"` entry. The other scripts should remain untouched. Example, only the relevant block:

```json
"scripts": {
  "start": "node server/index.js",
  "test": "node --test server/bitbrowser.spec.js"
}
```

(Preserve any existing scripts. Just add the `"test"` line — with a leading comma after the previous entry if needed.)

- [ ] **Step 2: Verify the test runner is reachable**

Create an empty placeholder so the runner has something to load:

```
node -e "require('fs').writeFileSync('server/bitbrowser.spec.js', '')"
npm test
```

Expected: `node --test` reports `tests 0  pass 0  fail 0` (or similar — the important part is no error about missing files).

- [ ] **Step 3: Commit**

```
git add package.json server/bitbrowser.spec.js
git commit -m "test: add node:test runner for server/bitbrowser.spec.js"
```

---

## Task 3: Implement and test `parseProxy`

**Files:**
- Create: `server/bitbrowser.js`
- Modify: `server/bitbrowser.spec.js`

- [ ] **Step 1: Write the failing tests**

Replace the contents of `server/bitbrowser.spec.js` with:

```js
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
```

- [ ] **Step 2: Run tests, expect failure**

```
npm test
```

Expected: `Cannot find module './bitbrowser'` (because the file does not exist yet).

- [ ] **Step 3: Create `server/bitbrowser.js` with just enough to pass**

Create `server/bitbrowser.js` with:

```js
// BitBrowser local API client.
// API docs: https://doc2.bitbrowser.cn/jiekou.html

function parseProxy(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('BitBrowser: proxyServer is required (got empty/undefined)');
  }
  let u;
  try { u = new URL(url); }
  catch { throw new Error(`BitBrowser: malformed proxyServer "${url}"`); }
  const scheme = u.protocol.replace(/:$/, '');
  if (!['http', 'https', 'socks5'].includes(scheme)) {
    throw new Error(`BitBrowser: unsupported proxy scheme "${scheme}"`);
  }
  if (!u.hostname || !u.port) {
    throw new Error(`BitBrowser: proxyServer "${url}" missing host or port`);
  }
  return { proxyType: scheme, host: u.hostname, port: u.port };
}

module.exports = {
  __internal: { parseProxy },
};
```

- [ ] **Step 4: Run tests, expect pass**

```
npm test
```

Expected: 5 passing tests, 0 failures.

- [ ] **Step 5: Commit**

```
git add server/bitbrowser.js server/bitbrowser.spec.js
git commit -m "feat(bitbrowser): parseProxy helper + tests"
```

---

## Task 4: Implement `healthCheck()` with tests

**Files:**
- Modify: `server/bitbrowser.js`
- Modify: `server/bitbrowser.spec.js`

- [ ] **Step 1: Add failing tests**

Append to `server/bitbrowser.spec.js`:

```js
describe('healthCheck()', () => {
  test('returns true on 200', async () => {
    bb._deps.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
    assert.equal(await bb.healthCheck(), true);
  });

  test('returns false on network error', async () => {
    bb._deps.fetch = async () => { const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; };
    assert.equal(await bb.healthCheck(), false);
  });

  test('returns false on non-200', async () => {
    bb._deps.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    assert.equal(await bb.healthCheck(), false);
  });

  test('never throws', async () => {
    bb._deps.fetch = async () => { throw new Error('boom'); };
    await assert.doesNotReject(bb.healthCheck());
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

```
npm test
```

Expected: tests fail because `bb.healthCheck` and `bb._deps` are undefined.

- [ ] **Step 3: Extend `server/bitbrowser.js` to make tests pass**

Replace the full contents of `server/bitbrowser.js` with:

```js
// BitBrowser local API client.
// API docs: https://doc2.bitbrowser.cn/jiekou.html

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

function readCfg() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')).bitbrowser || {}; }
  catch { return {}; }
}

function getApiBase() {
  return (readCfg().apiUrl || 'http://127.0.0.1:54345').replace(/\/$/, '');
}

function parseProxy(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('BitBrowser: proxyServer is required (got empty/undefined)');
  }
  let u;
  try { u = new URL(url); }
  catch { throw new Error(`BitBrowser: malformed proxyServer "${url}"`); }
  const scheme = u.protocol.replace(/:$/, '');
  if (!['http', 'https', 'socks5'].includes(scheme)) {
    throw new Error(`BitBrowser: unsupported proxy scheme "${scheme}"`);
  }
  if (!u.hostname || !u.port) {
    throw new Error(`BitBrowser: proxyServer "${url}" missing host or port`);
  }
  return { proxyType: scheme, host: u.hostname, port: u.port };
}

async function healthCheck() {
  // /browser/list is a primary documented endpoint; any HTTP response (not ECONNREFUSED)
  // means the daemon is alive. We don't care about pagination success, only reachability.
  try {
    const res = await deps.fetch(`${getApiBase()}/browser/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: 0, pageSize: 1 }),
    });
    return !!(res && typeof res.status === 'number');
  } catch {
    return false;
  }
}

module.exports = {
  healthCheck,
  _deps: deps,
  __internal: { parseProxy, readCfg, getApiBase },
};
```

- [ ] **Step 4: Run tests, expect pass**

```
npm test
```

Expected: 9 passing tests (5 parseProxy + 4 healthCheck), 0 failures.

- [ ] **Step 5: Commit**

```
git add server/bitbrowser.js server/bitbrowser.spec.js
git commit -m "feat(bitbrowser): healthCheck + config reader"
```

---

## Task 5: Implement `open()` happy path

**Files:**
- Modify: `server/bitbrowser.js`
- Modify: `server/bitbrowser.spec.js`

- [ ] **Step 1: Add failing test**

Append to `server/bitbrowser.spec.js`:

```js
// ---- Helpers shared by open() tests ----
function makeFetchMock(scriptedResponses) {
  // scriptedResponses: array of { matchPath, body }
  // Each call consumes the next item; if matchPath is set, asserts the URL contains it.
  let i = 0;
  return async (url, init) => {
    const step = scriptedResponses[i++];
    if (!step) throw new Error(`fetch called too many times (call ${i}, url=${url})`);
    if (step.matchPath && !String(url).includes(step.matchPath)) {
      throw new Error(`expected path containing "${step.matchPath}", got ${url}`);
    }
    if (step.throw) throw step.throw;
    return {
      ok: step.ok !== false,
      status: step.status || 200,
      json: async () => step.body,
    };
  };
}

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
});
```

- [ ] **Step 2: Run tests, expect failure**

```
npm test
```

Expected: failure — `bb.open is not a function`.

- [ ] **Step 3: Add `open()` implementation**

In `server/bitbrowser.js`, add this `request` helper and `open` function. Insert the `request` helper after `getApiBase()` and the `open` function after `healthCheck`. Also export `open`:

```js
// Add after getApiBase():
class BitBrowserError extends Error {
  constructor(kind, msg) { super(msg); this.kind = kind; }
}

async function request(pathname, body, timeoutMs = 5000) {
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
      throw new BitBrowserError('BitBrowserUnavailable', `BitBrowser unavailable: ${getApiBase()}`);
    }
    throw new BitBrowserError('BitBrowserApiError', `BitBrowser request error: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new BitBrowserError('BitBrowserApiError', `BitBrowser HTTP ${res.status} on ${pathname}`);
  }
  const json = await res.json().catch(() => ({}));
  if (json && json.success === false) {
    throw new BitBrowserError('BitBrowserApiError', `BitBrowser API: ${String(json.msg || 'unknown').slice(0, 80)}`);
  }
  return json.data || {};
}

// Add after healthCheck():
async function open({ proxyServer } = {}) {
  const proxy = parseProxy(proxyServer); // throws on empty/malformed
  const cfg = readCfg();
  const openTimeoutMs = Number(cfg.openTimeoutMs) || 30000;

  let id = null;
  let windowOpen = false;
  let browser = null;

  const close = async () => {
    if (browser)    { try { await browser.close(); } catch {} }
    if (windowOpen) { try { await request('/browser/close', { id }); } catch {} }
    if (id) {
      try { await request('/browser/delete', { ids: [id] }); }
      catch (e) { console.log(`[BitBrowser] delete failed: ${e.message?.slice(0, 80)}`); }
    }
  };

  try {
    // 1. Create a one-shot profile
    const updateBody = {
      name: `pay-${Date.now()}`,
      remark: 'auto-pay',
      proxyMethod: 2,
      proxyType: proxy.proxyType,
      host: proxy.host,
      port: proxy.port,
      browserFingerPrint: { ostype: 'PC', version: '136' },
    };
    const updateData = await request('/browser/update', updateBody);
    id = updateData.id;
    if (!id) throw new BitBrowserError('BitBrowserApiError', '/browser/update did not return data.id');

    // 2. Launch and obtain CDP endpoint
    const openData = await request('/browser/open', { id });
    windowOpen = true;
    const http = openData.http;
    if (!http) throw new BitBrowserError('BitBrowserApiError', '/browser/open did not return data.http');
    const cdpUrl = http.startsWith('http') ? http : `http://${http}`;

    // 3. Connect Playwright with a hard timeout budget
    browser = await Promise.race([
      deps.connectOverCDP(cdpUrl),
      new Promise((_, rej) => setTimeout(
        () => rej(new BitBrowserError('CDPConnectFailed', `connectOverCDP timeout after ${openTimeoutMs}ms`)),
        openTimeoutMs,
      )),
    ]).catch((e) => {
      if (e instanceof BitBrowserError) throw e;
      throw new BitBrowserError('CDPConnectFailed', `connectOverCDP failed: ${e.message?.slice(0, 80)}`);
    });

    return { browser, close };
  } catch (e) {
    await close();
    throw e;
  }
}

// In module.exports, add `open` and `BitBrowserError`:
module.exports = {
  open,
  healthCheck,
  BitBrowserError,
  _deps: deps,
  __internal: { parseProxy, readCfg, getApiBase, request },
};
```

- [ ] **Step 4: Run tests, expect pass**

```
npm test
```

Expected: 10 passing tests, 0 failures.

- [ ] **Step 5: Commit**

```
git add server/bitbrowser.js server/bitbrowser.spec.js
git commit -m "feat(bitbrowser): open() happy path with full lifecycle"
```

---

## Task 6: Add `open()` error-path tests

**Files:**
- Modify: `server/bitbrowser.spec.js`

- [ ] **Step 1: Add failing tests**

Append to `server/bitbrowser.spec.js`:

```js
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
```

- [ ] **Step 2: Run tests**

```
npm test
```

Expected: all 5 new tests pass (the existing implementation from Task 5 already handles these paths). 15 passing tests total. If any of the 5 new tests fail, the implementation in Task 5 is wrong — re-read `request()` and `open()`'s error mapping before fixing.

- [ ] **Step 3: Commit**

```
git add server/bitbrowser.spec.js
git commit -m "test(bitbrowser): error paths + cleanup tolerance"
```

---

## Task 7: Branch payment phase in `protocol-engine.js`

**Files:**
- Modify: `protocol-engine.js:13` (add bitbrowser require)
- Modify: `protocol-engine.js:92–94` (add `this._session` field)
- Modify: `protocol-engine.js:130–138` (stop() also closes session)
- Modify: `protocol-engine.js` after line 197 (pre-flight)
- Modify: `protocol-engine.js:297–347` (branch open + finally)
- Modify: `protocol-engine.js:376–380` (final cleanup also closes session)

- [ ] **Step 1: Add the require at the top**

Find line 13 (`const { launchChrome, waitForCDP } = require('./server/chrome');`) and add a new line below it:

```js
const bitbrowser = require('./server/bitbrowser');
```

- [ ] **Step 2: Initialize the session field**

Find the constructor area around line 92 (`this._chromeProc = null;`). After `this._tempDir = null;` on line 94, add a new line:

```js
this._session = null;
```

So the block now reads:

```js
this._chromeProc = null;
this._browser = null;
this._tempDir = null;
this._session = null;
```

- [ ] **Step 3: Update `stop()` to also close BitBrowser sessions**

Find the `stop()` method (around lines 130–139). Replace its body with:

```js
stop() {
  if (this.status !== 'idle') {
    this.stopFlag = true;
    if (this._pyProc) try { this._pyProc.kill(); } catch {}
    if (this._chromeProc) try { this._chromeProc.kill(); } catch {}
    if (this._browser) try { this._browser.close(); } catch {}
    if (this._session) try { this._session.close(); } catch {}
    if (this._gw) try { this._gw.cleanup(); } catch {}
    if (this._tempDir) try { fs.rmSync(this._tempDir, { recursive: true, force: true }); } catch {}
    this._pyProc = null; this._chromeProc = null; this._browser = null;
    this._gw = null; this._tempDir = null; this._session = null;
  }
}
```

- [ ] **Step 4: Add the pre-flight check**

Find the line `console.log('[Proto-Engine] Discord connected!');` (around line 198). Insert after it:

```js
      const useBitBrowser = !!(runtimeCfg.bitbrowser && runtimeCfg.bitbrowser.enabled);
      if (useBitBrowser) {
        const ok = await bitbrowser.healthCheck();
        console.log(ok
          ? '[BitBrowser] ready'
          : '[BitBrowser] unavailable; payment will fail per account');
      }
```

- [ ] **Step 5: Replace the payment open + finally block**

Find the payment block (lines 297–347). The replacement lets `bitbrowser.open()` throw on failure; the surrounding outer `try { ... } catch { ... summary.error++; ... } finally { cleanup }` already increments the error counter and emits status uniformly. This is preferable to a local `.catch(...)+continue` because it lets the existing consecutive-errors cooldown counter (3 strikes → 5-10min pause) observe the failure, halting the batch when BitBrowser is unavailable — exactly as spec §5.1 promises. The finally block is safe when `session` is `null` (the cleanup branch checks).

Replace this entire region (lines 297 down to the closing `}` of the `finally` block around line 347):

```js
        // Step 3: Payment (fresh Chrome for each account)
        const port = 9222 + i;
        const tempDir = path.join(os.tmpdir(), `proto-pay-${Date.now()}-${i}`);
        let chromeProc = null, browser = null;
        try {
          this.emitStatus({ email: account.email, status: 'running', phase: 'payment', progress });
          console.log(`[${progress}] Opening payment: ${link.slice(0, 60)}...`);
          chromeProc = launchChrome(port, tempDir, { proxyServer: proxyMgr.getProxyUrl() || undefined });
          browser = await waitForCDP(port);
          this._chromeProc = chromeProc;
          this._browser = browser;
          this._tempDir = tempDir;

          const ctx = browser.contexts()[0];
          // ... (rest of payment, unchanged — page.goto, autoPayment, success/fail emits) ...
        } catch (e) {
          console.log(`[${progress}] ${account.email} error: ${e.message?.slice(0, 80)}`);
          this.emitStatus({ email: account.email, status: 'error', phase: 'payment', progress, reason: e.message });
          summary.error++;
        } finally {
          if (browser) try { await browser.close(); } catch {}
          if (chromeProc) try { chromeProc.kill(); } catch {}
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
          this._browser = null; this._chromeProc = null; this._tempDir = null;
        }
```

with:

```js
        // Step 3: Payment (fresh browser for each account — Chrome or BitBrowser)
        const port = 9222 + i;
        const tempDir = path.join(os.tmpdir(), `proto-pay-${Date.now()}-${i}`);
        let chromeProc = null, browser = null, session = null;
        try {
          this.emitStatus({ email: account.email, status: 'running', phase: 'payment', progress });
          console.log(`[${progress}] Opening payment: ${link.slice(0, 60)}...`);
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
            chromeProc = launchChrome(port, tempDir, { proxyServer: proxyMgr.getProxyUrl() || undefined });
            browser = await waitForCDP(port);
            this._chromeProc = chromeProc;
            this._browser = browser;
            this._tempDir = tempDir;
          }

          const ctx = browser.contexts()[0];
          // ... (rest of payment, unchanged — page.goto, autoPayment, success/fail emits) ...
        } catch (e) {
          console.log(`[${progress}] ${account.email} error: ${e.message?.slice(0, 80)}`);
          this.emitStatus({ email: account.email, status: 'error', phase: 'payment', progress, reason: e.message });
          summary.error++;
        } finally {
          if (session) {
            try { await session.close(); } catch {}
          } else {
            if (browser) try { await browser.close(); } catch {}
            if (chromeProc) try { chromeProc.kill(); } catch {}
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
          }
          this._browser = null; this._chromeProc = null; this._tempDir = null; this._session = null;
        }
```

Important: the block between the `// ... (rest of payment, unchanged ...)` placeholder lines (the `const ctx = browser.contexts()[0]` line through the `paymentResult` handling at the end of the inner try) is **not** rewritten — keep it exactly as it was. Only the open/branch lines and the `finally` body change.

- [ ] **Step 6: Update the outer error catch on lines ~376–380**

Find the outer try/catch/finally near the bottom of `runBatch` (the catch is around line 373; the cleanup is around lines 376–380). Replace the cleanup block:

```js
      if (this._browser) try { await this._browser.close(); } catch {}
      if (this._chromeProc) try { this._chromeProc.kill(); } catch {}
      // ...
      if (this._tempDir) try { fs.rmSync(this._tempDir, { recursive: true, force: true }); } catch {}
      this._browser = null; this._chromeProc = null; this._gw = null; this._tempDir = null;
```

with:

```js
      if (this._browser) try { await this._browser.close(); } catch {}
      if (this._chromeProc) try { this._chromeProc.kill(); } catch {}
      if (this._session) try { await this._session.close(); } catch {}
      if (this._tempDir) try { fs.rmSync(this._tempDir, { recursive: true, force: true }); } catch {}
      this._browser = null; this._chromeProc = null; this._gw = null; this._tempDir = null; this._session = null;
```

- [ ] **Step 7: Smoke test the file parses**

```
node -e "require('./protocol-engine.js'); console.log('ok')"
```

Expected output: `ok`. If a SyntaxError appears, re-read the edits — most likely an unmatched brace from the find-and-replace.

- [ ] **Step 8: Run the existing unit tests**

```
npm test
```

Expected: 15 tests pass (unaffected by `protocol-engine.js` changes — sanity check).

- [ ] **Step 9: Commit**

```
git add protocol-engine.js
git commit -m "feat(bitbrowser): branch payment phase on config.bitbrowser.enabled"
```

---

## Task 8: Frontend — add BitBrowser section in `Config.vue`

**Files:**
- Modify: `web/src/views/Config.vue`

- [ ] **Step 1: Add form fields**

Find the `reactive({` block (lines 105–122) and append three new keys before the closing `})`:

```js
  proxyEnabled: false,
  proxySubscriptionUrl: '',
  proxyRegionFilter: 'US',
  proxyRotationStrategy: 'sequential',
  bitbrowserEnabled: false,
  bitbrowserApiUrl: 'http://127.0.0.1:54345',
  bitbrowserOpenTimeoutMs: 30000,
})
```

- [ ] **Step 2: Map nested config on load**

Find the `if (cfg.proxy) { ... }` block inside `onMounted` (around lines 134–139). Add another block immediately after its closing `}`:

```js
    if (cfg.bitbrowser) {
      if (cfg.bitbrowser.enabled !== undefined) form.bitbrowserEnabled = cfg.bitbrowser.enabled
      if (cfg.bitbrowser.apiUrl !== undefined) form.bitbrowserApiUrl = cfg.bitbrowser.apiUrl
      if (cfg.bitbrowser.openTimeoutMs !== undefined) form.bitbrowserOpenTimeoutMs = cfg.bitbrowser.openTimeoutMs
    }
```

- [ ] **Step 3: Rebuild nested object on save**

Find `handleSave` (around lines 155–176). After the `delete payload.proxyRotationStrategy` line and the `payload.proxy = {...}` assignment, add:

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

So `handleSave`'s try block becomes:

```js
  saving.value = true
  try {
    const payload = { ...form }
    delete payload.proxyEnabled
    delete payload.proxySubscriptionUrl
    delete payload.proxyRegionFilter
    delete payload.proxyRotationStrategy
    payload.proxy = {
      enabled: form.proxyEnabled,
      subscriptionUrl: form.proxySubscriptionUrl,
      regionFilter: form.proxyRegionFilter,
      rotationStrategy: form.proxyRotationStrategy,
    }
    delete payload.bitbrowserEnabled
    delete payload.bitbrowserApiUrl
    delete payload.bitbrowserOpenTimeoutMs
    payload.bitbrowser = {
      enabled: form.bitbrowserEnabled,
      apiUrl: form.bitbrowserApiUrl,
      openTimeoutMs: Number(form.bitbrowserOpenTimeoutMs) || 30000,
    }
    await api.put('/config', payload)
    ElMessage.success('配置已保存')
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '保存失败')
  } finally {
    saving.value = false
  }
```

- [ ] **Step 4: Add the template section**

In the template, find the closing `</el-form-item>` of the proxy status block (around line 90, the one containing `proxyStatus.lastError`). Immediately after it (still inside `<el-form>`), insert:

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

- [ ] **Step 5: Build the front-end**

```
cd web
npm run build
```

Expected output: `✓ built in <N>s` and a freshly-named `dist/assets/Config-*.js`.

- [ ] **Step 6: Verify the bundle reflects the change**

```
node -e "const fs=require('fs'),p=require('path'); const dir='web/dist/assets'; const f=fs.readdirSync(dir).find(n=>/^Config-.*\.js$/.test(n)); const s=fs.readFileSync(p.join(dir,f),'utf-8'); console.log('found:', f, 'contains bitbrowser:', /bitbrowser/i.test(s));"
```

Expected output: `found: Config-XXXXXXXX.js contains bitbrowser: true`

- [ ] **Step 7: Commit (source only — dist is gitignored)**

```
git add web/src/views/Config.vue
git commit -m "feat(bitbrowser): UI section in Config.vue"
```

`web/dist/` is in `.gitignore`. The freshly-built bundle stays on the local machine only; every environment that pulls this branch must run `cd web && npm run build` to produce its own dist before serving.

---

## Task 9: Manual integration verification

**Files:** No code changes — verification only.

These scenarios must pass before tagging a release. Each takes 2–5 minutes and uses 1 idle account from the database.

- [ ] **Scenario A — Regression: `enabled:false` uses Chrome**

  1. Edit `config.json`: set `bitbrowser.enabled = false`.
  2. Restart server: kill any running `node server/index.js` and `node server/index.js > server.log 2>&1 &`.
  3. Trigger a 1-account batch via UI or:

     ```
     curl -s -X POST -H 'Content-Type: application/json' \
       -d '{"emails":["<one idle email>"]}' http://localhost:3000/api/execute
     ```

  4. Watch `server.log` (or the UI's Execute view).
  5. **Expected:** payment phase logs `Opening payment: …` followed by the regular Chrome opening Stripe/PayPal. No `[BitBrowser]` lines. Behavior matches v2.10.0.

- [ ] **Scenario B — BitBrowser not running**

  1. Confirm no BitBrowser app is open. `Test-NetConnection -ComputerName localhost -Port 54345 -WarningAction SilentlyContinue` should report `TcpTestSucceeded: False`.
  2. Edit `config.json`: set `bitbrowser.enabled = true`.
  3. Restart server.
  4. Trigger a 1-account batch.
  5. **Expected:**
     - Log shows `[BitBrowser] unavailable; payment will fail per account` at batch start.
     - When payment phase reaches: log shows `[Pay] BitBrowser: BitBrowser unavailable: http://127.0.0.1:54345` (or similar wording — the literal "BitBrowser unavailable" substring matters).
     - Account status → `error`.
     - No leaked configs (there is no BitBrowser client to leak into; this is enforced by the test in Task 5).

- [ ] **Scenario C — BitBrowser running, payment opens via API**

  1. Launch the BitBrowser desktop app and confirm the API is up: `(Invoke-WebRequest -Method POST -Uri http://127.0.0.1:54345/browser/list -Body '{"page":0,"pageSize":1}' -ContentType 'application/json' -UseBasicParsing).StatusCode` returns 200.
  2. Confirm sing-box is up (the UI's "代理状态" should show `enabled: true` with a current node). If not, click "应用并启动代理" first.
  3. Confirm `config.json` has `bitbrowser.enabled = true` and `proxy.enabled = true`.
  4. Restart server.
  5. Trigger a 1-account batch (use a fresh idle email).
  6. Watch the BitBrowser console: a `pay-<timestamp>` window appears, opens Stripe → PayPal, and **disappears** when the account finishes.
  7. **Expected:**
     - Log shows `[BitBrowser] ready` at batch start.
     - Payment runs in the BitBrowser window (visually distinct from native Chrome).
     - After completion, BitBrowser's profile list contains **0** `pay-*` entries.

- [ ] **Scenario D — 5-account batch, zero leaks**

  1. Same prep as Scenario C.
  2. Trigger a 5-account batch.
  3. Wait for completion.
  4. **Expected:** BitBrowser profile list contains 0 `pay-*` entries. Any non-zero count indicates a cleanup bug — re-read Task 5's `close()` implementation.

- [ ] **Scenario E — Stop mid-batch cleans up**

  1. Same prep as Scenario C.
  2. Trigger a 5-account batch.
  3. As soon as the 2nd account's BitBrowser window appears, stop the batch via the UI's "停止" button (or `POST /api/execute/stop`).
  4. **Expected:** No `pay-*` entries remain in BitBrowser; the running window closes within a few seconds.

If all 5 scenarios pass, the integration is verified. If any fail, the failure mode points directly at the responsible task:

| Failure | Look at |
| --- | --- |
| A regresses | Task 7 step 5: the `} else {` branch |
| B leaks logs to UI | Task 5: error wording in `request()` |
| C: window doesn't disappear | Task 5: `close()` order |
| D: leftover configs | Task 5: cleanup tolerance |
| E: stop hangs | Task 7 step 3: `stop()` calling `session.close()` |

- [ ] **Final commit (release marker)**

After all scenarios pass:

```
git tag -a v2.11.0 -m "v2.11.0 — BitBrowser integration for payment phase"
```

(Do **not** push the tag without explicit user confirmation.)

---

## Self-Review Notes

This plan covers every numbered section of the spec:

| Spec section | Plan task |
| --- | --- |
| §2.1 scope (payment only) | Task 7 step 5 (else-branch preserved) |
| §2.2 one-shot lifecycle | Task 5 `open()` + `close()` |
| §2.3 sing-box reuse | Task 5 `parseProxy` + `open()` proxy fields |
| §2.4 no fallback | Task 7 `continue` on BitBrowser open failure |
| §2.5 feature flag | Task 1 config + Task 7 `useBitBrowser` branch |
| §3 architecture | Tasks 3–6 (module), Task 7 (engine wire-up) |
| §4 data flow | Task 5 implementation, Task 6 error paths |
| §5 error handling | Task 6 error-path tests |
| §5.1 pre-flight | Task 7 step 4 |
| §6 config | Task 1 |
| §6.1 frontend | Task 8 |
| §7 module surface | Task 3 (parseProxy), Task 4 (healthCheck), Task 5 (open) |
| §8.1 unit tests | Tasks 3–6 |
| §8.2 manual tests | Task 9 |
| §8.3 regression | Task 9 Scenario A |
