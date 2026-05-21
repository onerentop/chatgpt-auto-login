# ixbrowser Integration — Payment Phase Browser Replacement

**Date:** 2026-05-21
**Status:** Approved
**Scope:** Replace the BitBrowser integration completed earlier today with
an ixbrowser-based fingerprint window. The payment-phase contract in
`protocol-engine.js` is unchanged: open a browser, drive PayPal via
Playwright, close.
**Supersedes:** `2026-05-21-bitbrowser-integration-design.md` (v2.11.0).
**API reference:** `E:\workspace\projects\ixbrowser-local-api-python` —
official Python SDK, examples in `examples/profile_create.py`,
`profile_open.py`, `profile_open_with_random_fingerprint.py`.

---

## 1. Goal

The BitBrowser integration shipped at v2.11.0 worked but is unwanted: the
user has chosen ixbrowser as the fingerprint-browser vendor going
forward. This spec captures the migration plan. Functionally the
payment-phase behavior is identical (one-shot fingerprint window per
account, sing-box-routed proxy, Playwright over CDP); only the
underlying API client and its on-the-wire shapes change.

Out of scope: the proxy module, payment flow, protocol-register
pipeline, and Chrome-mode login path all stay exactly as they are.

## 2. Constraints

1. The payment-phase contract from `protocol-engine.js` does not
   change. The branching condition becomes
   `config.ixbrowser.enabled` instead of `config.bitbrowser.enabled`.
2. Same one-shot lifecycle as BitBrowser: create → open → use → close
   → delete per account. The user explicitly chose this over
   single-profile reuse with random-fingerprint, even though
   `profile-open-with-random-fingerprint` is available — sticking with
   the BitBrowser flow keeps the engine code identical between
   vendors.
3. The sing-box proxy at `http://127.0.0.1:7890` continues to feed
   every window. ixbrowser receives it as a nested `proxy_config`
   object with `proxy_mode: 2` (custom).
4. BitBrowser code is removed entirely. `server/bitbrowser.js`,
   `server/bitbrowser.spec.js`, the `bitbrowser` config key, and the
   BitBrowser UI section in `Config.vue` all go away. The history is
   preserved in git for reference.
5. Feature flag `config.ixbrowser.enabled` (default `false`) preserves
   the native-Chrome path as a kill switch.

## 3. Architecture

```
protocol-engine.js  (payment phase)
        │
        │ if (cfg.ixbrowser.enabled)
        ▼
server/ixbrowser.js  (new, replaces server/bitbrowser.js)
        │   open({ proxyServer }) → { browser, close() }
        │   healthCheck()         → boolean
        │
        │ HTTP fetch (Node 22 global)
        ▼
ixbrowser local client  (http://127.0.0.1:53200)
        │ launches isolated Chrome profile
        │ exposes CDP debug endpoint via debugging_address
        ▼
Playwright connectOverCDP  → drives PayPal checkout
```

The module exports the same surface as `bitbrowser.js`:

* `open({ proxyServer })` — returns `{ browser, close }`, where
  `browser` is a Playwright `Browser` instance and `close()` tears
  down both the Playwright connection and the ixbrowser-side profile.
* `healthCheck()` — non-throwing daemon ping, used once per batch.

`_deps` (overridable `fetch` + `connectOverCDP`) and the `__internal`
test-export surface carry over unchanged.

## 4. Data Flow

### 4.1 Create a profile

```
POST http://127.0.0.1:53200/api/v2/profile-create
body:
  {
    "name":    "pay-{timestamp}",
    "note":    "auto-pay",
    "site_id": 22,                          // 22 = blank page
    "color":   "#1E90FF",
    "proxy_config": {
      "proxy_mode": 2,                       // 2 = custom
      "proxy_type": "http",
      "proxy_ip":   "127.0.0.1",
      "proxy_port": "7890"
    }
  }

response:
  { "error": { "code": 0 }, "data": { "profile_id": 123 } }
```

Differences from BitBrowser:

* Endpoint is `/api/v2/profile-create`, not `/browser/update`.
* Proxy fields are nested under `proxy_config` and renamed
  (`proxy_mode/proxy_type/proxy_ip/proxy_port`).
* `fingerprint_config` is omitted on purpose. Each new
  `profile-create` call generates a fresh fingerprint per profile by
  default — this is the entire point of a fingerprint browser. We
  do not need `profile-open-with-random-fingerprint`, which is for
  re-randomizing an existing profile between opens (a use case that
  doesn't apply since we destroy each profile after one account).
* The returned id is an integer `profile_id`, not a UUID string.

### 4.2 Open the profile

```
POST /api/v2/profile-open
body:
  {
    "profile_id":             123,
    "load_extensions":        true,
    "load_profile_info_page": false,
    "cookies_backup":         false,
    "args":                   ["--disable-extension-welcome-page"]
  }

response:
  {
    "error": { "code": 0 },
    "data":  {
      "webdriver":         "C:\\Path\\To\\chromedriver.exe",   // ignored
      "debugging_address": "127.0.0.1:9222"                     // no scheme prefix
    }
  }
```

Then `chromium.connectOverCDP('http://' + data.debugging_address)`.

### 4.3 Close the profile

```
POST /api/v2/profile-close
body: { "profile_id": 123 }
```

### 4.4 Delete the profile

```
POST /api/v2/profile-delete
body: { "profile_id": 123 }
```

### 4.5 Health check

```
POST /api/v2/profile-list
body: { "page": 1, "limit": 1 }              // ixbrowser is 1-based, uses limit not pageSize
```

Any HTTP response — even `error.code !== 0` — counts as "daemon
alive". Only TCP-level errors flip the gate.

### 4.6 Response parsing shape (the key behavioral change)

BitBrowser used `{ success: false, msg: '...' }` for business errors.
ixbrowser uses `{ error: { code: <int>, message: '...' } }` where
`code === 0` means success:

```js
if (!json.error || json.error.code !== 0) {
  throw new IxBrowserApiError(
    json.error?.message?.slice(0, 80) || `error.code=${json.error?.code}`
  );
}
return json.data || {};
```

## 5. Error Handling

Three error classes, same handling pattern as BitBrowser:

| Error class | Trigger | Handling |
| --- | --- | --- |
| `IxBrowserUnavailable` | `/profile-create` returns ECONNREFUSED or exceeds 15s | Account `error`; outer `catch` records `summary.error++`; `consecutiveErrors++` feeds the existing 3-strike cooldown. |
| `IxBrowserApiError` | HTTP non-200, or body `error.code !== 0` | Account `error`; log includes `error.message.slice(0, 80)`; if a `profile_id` was already allocated, best-effort `/profile-delete`. |
| `CDPConnectFailed` | `connectOverCDP` does not resolve within `openTimeoutMs` (default 30000) | Account `error`; must call `/profile-close` then `/profile-delete`. |

`open()` lets failures throw to the outer `try/catch` in
`protocol-engine.js`. The local `.catch()+continue` pattern from the
initial BitBrowser draft is **not** used — that pattern bypassed the
cooldown counter, a bug that was fixed before v2.11.0. Same fix
applies here.

### 5.1 `close()` invariants

Same idempotent pattern as BitBrowser, with renamed flags:

```js
async function close() {
  if (browser)    { try { await browser.close() }                  catch {} browser = null; }
  if (opened)     { try { await request('/api/v2/profile-close',  { profile_id }) } catch {} opened = false; }
  if (profile_id) {
    try { await request('/api/v2/profile-delete', { profile_id }); }
    catch (e) { console.log(`[ixbrowser] delete failed: ${e.message?.slice(0, 80)}`); }
    profile_id = null;
  }
}
```

The three flag-progression invariants are:

1. `profile_id` is set immediately after `/profile-create` resolves.
2. `opened` is set **before** `await /profile-open` — same optimistic
   placement learned during BitBrowser testing. If the call times out
   but ixbrowser launched Chrome in the background, `/profile-close`
   must still run to terminate the launcher.
3. `browser` is set only after `connectOverCDP` resolves.

`close()` never throws. Even if Playwright's `.close()` errors, the
ixbrowser-side `/profile-close` + `/profile-delete` still run.

### 5.2 Batch-level pre-flight

Same as BitBrowser: at `runBatch` start, after the existing proxy
refresh, call `ixbrowser.healthCheck()` once. Log `[ixbrowser] ready`
or `[ixbrowser] unavailable; payment will fail per account`. Continue
either way — the protocol-registration phase doesn't need ixbrowser,
so a user collecting access tokens without upgrading should not be
blocked.

If `config.ixbrowser.enabled` is `false`, the pre-flight is skipped.

## 6. Configuration

`config.json` replaces the `bitbrowser` block (which the user
manually deletes) with `ixbrowser`:

```json
{
  "proxy":      { "...": "..." },
  "ixbrowser":  {
    "enabled":       false,
    "apiUrl":        "http://127.0.0.1:53200",
    "openTimeoutMs": 30000
  }
}
```

| Field | Purpose | Default |
| --- | --- | --- |
| `enabled` | Kill switch — `false` runs original `launchChrome` path. | `false` |
| `apiUrl` | ixbrowser local API base. Port differs from BitBrowser. | `http://127.0.0.1:53200` |
| `openTimeoutMs` | Connection budget for the `connectOverCDP` after `/profile-open` returns. | `30000` |

`config.json` is gitignored (contains Discord/SMS secrets) and
remains so. The user is responsible for the rename in their local
copy. No migration script.

### 6.1 Frontend (`web/src/views/Config.vue`)

The existing "指纹浏览器（BitBrowser）" section is **renamed** to
"指纹浏览器（ixbrowser）" and its three form fields rename
`bitbrowser*` → `ixbrowser*`. The save/load mapping for nested
`cfg.ixbrowser.{enabled, apiUrl, openTimeoutMs}` mirrors the proxy
section pattern already established.

No test-connection button, no migration banner for the BitBrowser-era
config — keep the UI surface minimal.

## 7. Module Surface (`server/ixbrowser.js`)

Exported API — identical to the deleted `bitbrowser.js`:

```js
async function open({ proxyServer }) → {
  browser: import('playwright').Browser,
  close:   () => Promise<void>,
}

async function healthCheck() → boolean
```

Internal helpers (not exported, but reachable via `__internal` for
tests):

* `request(pathname, body, timeoutMs = 15000)` — wraps `globalThis.fetch`
  with a per-call AbortController. Maps `ECONNREFUSED` / `AbortError` /
  `fetch failed` to `IxBrowserUnavailable`; maps HTTP-non-200 and
  `error.code !== 0` to `IxBrowserApiError`. Returns `json.data || {}`
  on success.
* `parseProxy(url)` — unchanged from BitBrowser version, except the
  returned object now uses the ixbrowser field names
  (`proxy_type/proxy_ip/proxy_port`). Empty/undefined `url` throws
  with a clear message.
* `readCfg()` — `JSON.parse(fs.readFileSync('config.json')).ixbrowser
  || {}`. Read fresh on every call so UI edits apply without a
  restart.
* `getApiBase(override?)` — `(override || readCfg().apiUrl ||
  'http://127.0.0.1:53200').trim().replace(/\/+$/, '')`.

The `_deps` injection object stays — same testability pattern.

## 8. Testing

### 8.1 Unit — `server/ixbrowser.spec.js`

The 23 tests from `bitbrowser.spec.js` are ported with these
mechanical edits applied uniformly:

* URL path assertions: `browser/update` → `api/v2/profile-create`,
  `browser/open` → `api/v2/profile-open`,
  `browser/close` → `api/v2/profile-close`,
  `browser/delete` → `api/v2/profile-delete`.
* Mock response shapes: `{ success: true, data: { id: 'abc' } }` →
  `{ error: { code: 0 }, data: { profile_id: 123 } }`.
* Mock error shape: `{ success: false, msg: 'quota' }` →
  `{ error: { code: 5001, message: '已超过免费用户每天最大创建窗口数' } }`.
* `parseProxy` test expectations: returned object now has
  `{proxy_type, proxy_ip, proxy_port}` instead of `{proxyType, host,
  port}`.
* CDP field: `data.http` → `data.debugging_address` (still `host:port`
  without scheme; the module prepends `http://`).

After migration: **23 tests, same coverage, all green**.

### 8.2 Manual integration tests

Same 5 scenarios used to verify BitBrowser, re-run against ixbrowser:

| Scenario | Expected |
| --- | --- |
| A: `enabled:false` | Native Chrome path; zero `[ixbrowser]` log lines. |
| B: ixbrowser not running (point apiUrl at port 53201) | `[ixbrowser] unavailable` pre-flight log; per-account `IxBrowserUnavailable` error; cooldown counter ticks. |
| C: ixbrowser running, payment opens via API | `[ixbrowser] ready` pre-flight; `pay-*` profile appears in ixbrowser list during open, gone after close. |
| D: 5-batch zero leak | profile-list delta = 0 across the run. |
| E: stop mid-batch | the running `pay-*` profile is removed. |

### 8.3 Regression matrix

* Protocol registration (curl_cffi) unaffected — it never touched the
  fingerprint browser.
* Browser-mode login in `server/engine.js` unaffected — uses native
  Chrome.
* Sing-box proxy module + UI unchanged.

## 9. Non-Goals

* No abstract `BrowserProvider` interface. Only one call site
  changes; second implementations remain hypothetical and would be
  over-engineering.
* No backward compatibility with the BitBrowser config block. Users
  with the v2.11.0 `bitbrowser` key must rename it; this is a single
  manual edit and not worth a migration tool.
* No use of `profile-open-with-random-fingerprint`. The user
  explicitly preferred the BitBrowser-style one-shot lifecycle even
  though ixbrowser supports profile reuse with random fingerprints.
  A future spec can switch strategies if daily-create limits become a
  pain point.
* No port-discovery / auto-detection of ixbrowser's port. If the
  daemon listens on a non-default port, the user configures `apiUrl`
  in the UI.

## 10. Open Questions / Risks

* **`profile-create` response shape.** Reading the SDK's
  `create_profile` returns the raw `data` object. The exact field
  name (`profile_id` vs `id`) needs an empirical check at first run.
  If it's actually `id`, the module reads it as `data.id` and the
  spec's `data.profile_id` reference is wrong. Detection: first
  manual test of Scenario C.
* **Daily-create limit on ixbrowser free tier.** BitBrowser triggered
  it during Scenario E (the user ran out of the day's quota). The
  same constraint likely exists on ixbrowser. If it does, the
  fallback design (already documented in §9 as a future spec) is to
  switch to `profile-open-with-random-fingerprint` against one
  long-lived profile.
* **`error.code` non-zero on success-shape responses.** The Python
  SDK's `Utils.get_api_response` checks `result['error']['code'] ==
  0`. We mirror that. If any ixbrowser endpoint returns success but
  omits the `error` envelope (unlikely per the SDK code path), our
  parser would misclassify as `IxBrowserApiError`. Detection: any
  unexpected `error.code=undefined` in early integration testing.
* **`proxy_port` as string vs integer.** The SDK example
  (`profile_create.py:23`) uses string `'10808'`. We do the same to
  stay safe.
