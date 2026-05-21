# BitBrowser Integration — Payment Phase Browser Replacement

**Date:** 2026-05-21
**Status:** Approved
**Scope:** Replace the native Chrome window used during the PayPal payment
phase in protocol-register mode with a BitBrowser fingerprint-browser window
opened via BitBrowser's local HTTP API.
**API reference:** https://doc2.bitbrowser.cn/jiekou.html

---

## 1. Goal

Currently `protocol-engine.js:304` spawns a Google Chrome process in
incognito mode to drive the PayPal checkout page. This makes payment
flows recognizable to PayPal's anti-automation systems because every
window leaves the same Chrome fingerprint (only `--user-data-dir` differs).

After this change, the payment phase opens its browser by calling the
BitBrowser local API. BitBrowser supplies a randomized, account-isolated
browser profile per call, and Playwright drives it through the CDP
debug endpoint that `/browser/open` returns.

Out of scope: `server/engine.js` browser-mode login. That path stays on
native Chrome — see Section 9.

## 2. Constraints

1. Only the payment phase changes. Protocol registration (`curl_cffi`)
   and browser-mode login (`server/engine.js`) are untouched.
2. Each payment uses a fresh, one-shot BitBrowser configuration:
   create → open → use → close → delete. No persistent
   account ↔ BitBrowser binding.
3. The BitBrowser window's outbound traffic must traverse the existing
   sing-box proxy at `http://127.0.0.1:7890`. The proxy module
   (`server/proxy/*`) is unchanged; rotation continues to happen
   between accounts in `protocol-engine.js`'s batch loop.
4. If BitBrowser's local client is not running, the current account
   fails with status `error` and the batch continues. No fallback to
   native Chrome.
5. A boolean feature flag (`config.bitbrowser.enabled`) preserves the
   original Chrome path so the change is reversible without a
   redeploy.

## 3. Architecture

```
protocol-engine.js  (payment phase, ~10 lines)
        │
        │ if (cfg.bitbrowser.enabled)
        ▼
server/bitbrowser.js  (new, ~120 lines)
        │   open({ proxyServer }) → { browser, close() }
        │   healthCheck()         → boolean
        │
        │ HTTP fetch (Node 22 global)
        ▼
BitBrowser local client  (http://127.0.0.1:54345)
        │ launches isolated Chrome profile
        │ exposes CDP debug port
        ▼
Playwright connectOverCDP  → drives PayPal checkout
```

The new `server/bitbrowser.js` exposes exactly two functions to the rest
of the codebase:

* `open({ proxyServer })` — returns `{ browser, close }`, where `browser`
  is a Playwright `Browser` instance and `close()` tears down both the
  Playwright connection and the BitBrowser-side configuration.
* `healthCheck()` — non-throwing ping used once per batch.

`protocol-engine.js`'s try/finally block at the payment phase is
modified minimally: it stores the returned session object instead of
the `chromeProc` / `browser` / `tempDir` triple, and the finally block
calls `await session.close()` instead of the three separate cleanups.

## 4. Data Flow

### 4.1 Open a window

```
POST http://127.0.0.1:54345/browser/update
body:
  {
    "name":        "pay-{timestamp}-{batchIndex}",
    "remark":      "auto-pay",
    "proxyMethod": 2,                  // 2 = custom proxy
    "proxyType":   "http",
    "host":        "127.0.0.1",
    "port":        "7890",
    "browserFingerPrint": { "ostype": "PC", "version": "136" }
  }

response:
  { "success": true, "data": { "id": "<uuid>" } }
```

Notes:

* `proxyMethod: 2` plus separate `host` / `port` is BitBrowser's
  required shape for a custom proxy. Passing a full URL string does
  not work.
* `browserFingerPrint` is intentionally minimal — let BitBrowser
  randomize the rest (canvas, WebGL, fonts, screen, etc.) on every
  call.
* The window name embeds a timestamp so leaked configurations are
  easy to spot manually in the BitBrowser console.

```
POST http://127.0.0.1:54345/browser/open
body: { "id": "<uuid>" }

response:
  {
    "success": true,
    "data": {
      "http":   "127.0.0.1:54678",        // CDP debug endpoint
      "ws":     "ws://127.0.0.1:54678/devtools/browser/...",
      "driver": "C:\\Path\\To\\chromedriver.exe"
    }
  }
```

Then `chromium.connectOverCDP('http://' + data.http)` returns the
Playwright `Browser` that the payment code drives unchanged. The
BitBrowser-assigned debug port replaces the previous `9222 + i`
scheme — port collisions become impossible.

### 4.2 Close a window

```
await browser.close()                       // Playwright side
POST /browser/close  { "id": "<uuid>" }     // BitBrowser side
POST /browser/delete { "ids": ["<uuid>"] }  // remove the config
```

All three calls run inside `session.close()` regardless of which
previous step succeeded — see Section 5 for the best-effort policy.

## 5. Error Handling

Three error classes, three handling rules:

| Error class | Trigger | Handling |
| --- | --- | --- |
| `BitBrowserUnavailable` | `/browser/update` returns ECONNREFUSED or exceeds a 5s timeout | Account → `error`; log line `[Pay] BitBrowser unavailable: 127.0.0.1:54345`; the existing per-batch cooldown counter (3 consecutive errors) will halt the batch automatically — no new pause logic needed. |
| `BitBrowserApiError` | API returns HTTP non-200, or body `{ success: false, msg }` | Account → `error`; log includes `msg.slice(0, 80)`; if an `id` was already allocated, best-effort `/browser/delete` it. |
| `CDPConnectFailed` | `/browser/open` succeeded but `chromium.connectOverCDP` cannot reach the returned `http` address within `openTimeoutMs` | Account → `error`; must call `/browser/close` then `/browser/delete` to prevent leaked configs in BitBrowser's console. |

The cleanup function inside `session.close()` is intentionally
permissive. The three booleans (`browser`, `windowOpen`, `id`) are
set incrementally as the open flow progresses — `id` after
`/browser/update` succeeds, `windowOpen` after `/browser/open`
succeeds, `browser` after `connectOverCDP` resolves — so a failure
midway through `open()` cleans up exactly what was actually created
and nothing else.

```
async function close() {
  if (browser)    try { await browser.close() }              catch {}
  if (windowOpen) try { await api.close({ id })  }           catch {}
  if (id)         try { await api.delete({ ids: [id] }) }    catch (e) {
    console.log('[BitBrowser] delete failed:', e.message)    // warn only
  }
}
```

Two invariants:

1. `session.close()` never throws — the caller's try/finally is
   already accounting for the operation result.
2. Even if Playwright cleanup fails (e.g. the browser process already
   crashed), the BitBrowser configuration deletion is still
   attempted. This prevents accumulation of `pay-*` zombie configs.

### 5.1 Batch-level pre-flight

At the start of `runBatch` in `protocol-engine.js`, after the existing
proxy refresh, the engine calls `bitbrowser.healthCheck()` once.

* On success: `console.log('[BitBrowser] ready')`, continue.
* On failure: `console.log('[BitBrowser] unavailable; payment will
  fail per account')`, **continue anyway**.

The reason for "continue anyway" is that protocol registration itself
does not need BitBrowser — a user may legitimately run a batch only to
collect `plus_no_rt` access tokens without upgrading any account. The
per-account failure path in Section 5.3 still triggers and surfaces
the issue clearly.

If `config.bitbrowser.enabled` is `false`, the pre-flight is skipped
entirely.

## 6. Configuration

`config.json` gains one new top-level key, parallel to the existing
`proxy` block:

```json
{
  "proxy": { "...": "..." },
  "bitbrowser": {
    "enabled":        false,
    "apiUrl":         "http://127.0.0.1:54345",
    "openTimeoutMs":  30000
  }
}
```

| Field | Purpose | Default |
| --- | --- | --- |
| `enabled` | Feature flag. `false` → original `launchChrome` path is used unchanged. Provides a kill switch without a code deploy. | `false` |
| `apiUrl` | BitBrowser local API base URL. Exposed for the rare port-customization case. | `http://127.0.0.1:54345` |
| `openTimeoutMs` | Max time between `/browser/open` succeeding and `connectOverCDP` resolving. BitBrowser cold-starts Chrome itself, so the budget is larger than the native path's 15s. | `30000` |

`server/routes/config.js`'s PUT handler already merges arbitrary
nested objects, so no route change is needed.

### 6.1 Frontend (`web/src/views/Config.vue`)

Add a new section "指纹浏览器（BitBrowser）" below the "代理 / 节点轮换"
section, mirroring its layout:

* Switch: `bitbrowser.enabled`
* Input:  `bitbrowser.apiUrl`
* Number input (optional/advanced): `bitbrowser.openTimeoutMs`

No "Test connection" button — BitBrowser's own console already
indicates whether its API is up; a duplicate test button in this UI
would be cosmetic.

The flat-vs-nested form-payload pattern already established for the
`proxy.*` fields is reused: load maps `cfg.bitbrowser.*` to flat
`form.bitbrowser*`; save rebuilds the nested object and removes the
flat fields before PUT.

## 7. Module Surface (`server/bitbrowser.js`)

Exported API:

```js
async function open({ proxyServer }) → {
  browser: import('playwright').Browser,
  close:   () => Promise<void>,
}

async function healthCheck() → boolean
```

Internal-only helpers (not exported):

* `request(path, body)` — wraps Node 22's global `fetch` with a 5s
  default timeout and unified error mapping
  (`BitBrowserUnavailable` / `BitBrowserApiError`).
* `parseProxy(url)` — `'http://127.0.0.1:7890'` →
  `{ host: '127.0.0.1', port: '7890', proxyType: 'http' }`.
  Throws on malformed input. If `url` is empty or undefined,
  `open()` itself rejects with a clear error rather than creating a
  direct-connect window — payment without the sing-box exit IP is
  guaranteed to be blocked by PayPal, so silently allowing it would
  waste a BitBrowser configuration and obscure the real cause.

Configuration is read from `config.json` on each `open()` call (not
cached) — this matches how `server/proxy/index.js` already reads
config, and lets a UI edit take effect on the next account without a
server restart.

## 8. Testing

### 8.1 Unit — `server/bitbrowser.spec.js` (new, ~80 lines)

Mock `global.fetch` and `playwright.chromium.connectOverCDP`. Cover:

1. Happy path → returned session can be closed; `update`, `open`,
   `close`, `delete` are each invoked once in the right order.
2. `/browser/update` returns ECONNREFUSED → throws
   `BitBrowserUnavailable`; `close` and `delete` are **not** called
   (nothing was created).
3. `/browser/update` returns `{ success: false, msg: 'quota' }` →
   throws `BitBrowserApiError`; `delete` still attempted with the
   absent id is **skipped** (no id to delete).
4. `/browser/open` returns ok but `connectOverCDP` rejects → throws
   `CDPConnectFailed`; both `close` and `delete` are invoked.
5. Cleanup tolerance: `browser.close` rejects → `delete` is still
   invoked.

The Playwright import itself is mocked at module level so the test
can run without a real Chrome on the machine.

### 8.2 Manual integration tests (1 account each)

| Scenario | Expected |
| --- | --- |
| `enabled:false` | Payment uses native Chrome; behavior identical to v2.10.0 (regression check). |
| `enabled:true`, BitBrowser running, sing-box running | Payment opens in a BitBrowser window; PayPal sees the sing-box exit IP; window and config are gone from BitBrowser's console after the run. |
| `enabled:true`, BitBrowser **not** running | Account → `error` with clear log line; no zombie config in BitBrowser. |
| 5-account batch with `enabled:true` | 0 leftover `pay-*` configs visible in BitBrowser console afterwards. |

### 8.3 Regression matrix

* Protocol registration still works (it never touched BitBrowser).
* Browser-mode login (`server/engine.js`) still works (not modified).
* Proxy module status / rotation unchanged.

## 9. Non-Goals

* No abstract `BrowserProvider` interface. Only one call site changes;
  a second implementation is hypothetical and would be over-engineering.
* No account ↔ BitBrowser persistence. Section 2 establishes one-shot
  windows; reusing fingerprints across runs is a different feature.
* No replacement of `server/engine.js`'s browser-mode login. That
  path is left on native Chrome and can be migrated in a future spec
  if needed.
* No BitBrowser-side proxy pool. The sing-box proxy is the single
  source of truth for outbound IP rotation.

## 10. Open Questions / Risks

* **API auth token.** The BitBrowser docs may or may not require an
  `Authorization` header for newer client versions. If a token is
  needed, `config.bitbrowser.token` will be added as an additional
  optional field at implementation time. Detection: the first
  `/browser/update` 401/403 in manual testing.
* **CDP `http` field format.** The exact response shape (`http` as
  `host:port` vs full URL) needs to be confirmed empirically on the
  first integration test. The module is written to accept either.
* **BitBrowser cold start.** First `/browser/open` after a fresh
  client boot can take ~10-15s. `openTimeoutMs: 30000` should cover
  this, but if it doesn't, raise the default rather than retry —
  retries while the client is still spawning a Chromium tend to
  produce duplicate windows.
