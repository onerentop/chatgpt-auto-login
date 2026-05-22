# Checkout Link via Python `curl_cffi` — Design

**Date:** 2026-05-22
**Status:** Approved
**Author:** brainstorming session
**Supersedes:** `2026-05-22-chatgpt-direct-payment-link-design.md` (the design was correct in intent but assumed the IP region matters; testing showed otherwise)

## Background

The previous design (v2.16.0) replaced the broken Discord bot with a direct call to `chatgpt.com/backend-api/payments/checkout` via undici. The implementation was wired correctly — proxy switch/restore logs appeared as expected — but the production smoke test failed with `ERROR: fetch failed` on every JP node.

Diagnostic testing on 2026-05-22 revealed two independent root causes that, together, invalidate the JP-node-pool architecture:

1. **The server does not check the request IP region.** A POST to `/backend-api/payments/checkout` from a US exit IP with `billing_details.country: 'JP'` in the body returns a valid `pay.openai.com/c/pay/cs_live_...` link with the `plus-1-month-free` promo applied — exactly the same outcome the JP-IP path was meant to produce. The user's claim "only JP nodes have the link" was rooted in the Discord bot's behavior; the bot itself was likely calling from a US-region server with `country: 'JP'` in the body.

2. **undici is blocked by Cloudflare for chatgpt.com requests regardless of IP.** Same endpoint, same accessToken, same US exit node — undici returns HTTP 403 with a Cloudflare challenge HTML page; `curl_cffi` with Chrome JA3 impersonation returns 200 with the link. Cloudflare's bot detection is fingerprinting the TLS handshake / HTTP/2 frame patterns, and undici's defaults don't pass.

The JP-IP nodes are still unreachable to chatgpt.com (datacenter-IP ban), but that no longer matters — the call works from US.

## Goal

Replace the undici-based checkout caller with a Python `curl_cffi` subprocess that uses Chrome impersonation to pass Cloudflare. Remove the now-unnecessary JP-node-pool plumbing.

The external API of `fetchCheckoutLink(accessToken, opts)` stays unchanged so that the two engines (`server/engine.js`, `protocol-engine.js`) and their Discord-fallback branching require no further changes.

## Scope

In scope:
- New file: `checkout_link.py` (~50 lines) — pure CLI script, reads JSON on stdin, writes JSON lines on stdout. Mirrors the spawn protocol of `protocol_register.py`.
- Rewrite: `server/chatgpt-checkout.js` — drop undici, spawn the Python script. Keep the `fetchCheckoutLink` exported signature identical.
- Remove from `server/proxy/index.js`: `_state.checkoutRegionKeyword`, `_state.checkoutNodeTags`, the dual-pool merge in `refresh()`, the `withCheckoutNode(fn)` function, and its export.
- Simplify call sites in `server/engine.js` and `protocol-engine.js`: drop the `proxyMgr.withCheckoutNode(...)` wrapper around `fetchCheckoutLink`.
- Remove from `web/src/views/Config.vue`: the `proxyCheckoutRegionFilter` form field, its load/save wiring, and its UI input.
- `npm uninstall undici` and remove from `package.json` / `package-lock.json`.

Out of scope:
- Discord fallback path — unchanged, still gated by `paymentLinkSource: 'discord'`.
- `protocol_register.py` itself — unchanged. The new script duplicates ~6 lines of Chrome-version constants but keeps each script focused.
- The user's local `config.json` — if it still contains `proxy.checkoutRegionFilter`, the proxy module simply ignores it. No migration needed.

## Why a New Python Script Instead of Extending `protocol_register.py`

`protocol_register.py` is already ~880 lines and handles a complex login flow (PKCE, OTP, sentinel tokens, IMAP). Mixing in a single one-shot POST for checkout would mean either:
- Adding a `mode` flag plus all the branching glue — couples unrelated concerns
- Embedding the checkout call into the main login flow — forces the engine pipeline to fetch links inline with login, defeating the existing Discord-fallback design

A standalone ~50-line `checkout_link.py` keeps the spawn protocol identical (stdin JSON in / stdout JSON lines out), reuses the same `curl_cffi` Chrome impersonation pattern, and is independently testable.

## Architecture

### Data flow

```
engine.js / protocol-engine.js
    ↓ await fetchCheckoutLink(loginResult.accessToken)
server/chatgpt-checkout.js   (Node side — spawn wrapper)
    ↓ spawn 'py -3 checkout_link.py'  (stdin JSON)
checkout_link.py             (Python side — curl_cffi)
    ↓ curl_cffi.post() with impersonate=chrome131 via sing-box proxy
chatgpt.com/backend-api/payments/checkout
    ↑ 200 + body containing pay.openai.com URL
checkout_link.py             outputs {"status":"success","link":"...","raw":"..."}
server/chatgpt-checkout.js   parses stdout → returns {link, title:'', raw}
engine.js                    treats same as before — opens link in browser
```

### Component boundaries

```
checkout_link.py
  • Single responsibility: POST /backend-api/payments/checkout, return link
  • Stateless — every invocation independent
  • Same proxy as caller (passed via stdin)
  • Retry on TLS errors (3 attempts with different Chrome versions)

server/chatgpt-checkout.js
  • Thin Node→Python adapter
  • 60s timeout (more than enough for one POST + 3 internal retries)
  • Returns {link, title, raw} shape — identical to current (and to discord-gateway's getPaymentLink)

server/proxy/index.js (simplified)
  • Single node pool (US) — back to pre-v2.16.0 architecture
  • Loses: checkoutRegionKeyword, checkoutNodeTags, withCheckoutNode export
```

## File-Level Changes

| File | Status | Change |
|---|---|---|
| `checkout_link.py` | **NEW** | ~50 lines; the script body |
| `server/chatgpt-checkout.js` | **REWRITE** | undici → spawn wrapper |
| `server/proxy/index.js` | **MODIFY** | Remove dual-pool fields, refresh logic, `withCheckoutNode`, export |
| `server/engine.js` | **MODIFY** | One-line change — unwrap `withCheckoutNode` |
| `protocol-engine.js` | **MODIFY** | One-line change — unwrap `withCheckoutNode` |
| `web/src/views/Config.vue` | **MODIFY** | Remove `proxyCheckoutRegionFilter` field + UI |
| `package.json` | **MODIFY** | `npm uninstall undici` |
| `package-lock.json` | **MODIFY** | Same |
| `server/discord-gateway.js` | unchanged | Still used as Discord fallback |
| `protocol_register.py` | unchanged | Independent |
| `config.json` (user-local) | unchanged | Stale `checkoutRegionFilter` field tolerated |

## The Python Script (`checkout_link.py`)

```python
#!/usr/bin/env python3
"""Fetch ChatGPT Plus checkout link via curl_cffi (Chrome JA3 fingerprint).
Input: JSON on stdin  { access_token, country, currency, promo_id, proxy }
Output: JSON lines on stdout — log lines as {"log":"..."}, final as {"status":...}
"""
import sys, json, random, re
from curl_cffi import requests as cr

_CHROME = ['chrome146', 'chrome142', 'chrome136', 'chrome133a', 'chrome131', 'chrome124']

def _log(m):
    print(json.dumps({"log": f"  [Checkout] {m}"}), flush=True)

def main():
    inp = json.loads(sys.stdin.read())
    token = inp['access_token']
    body = {
        "entry_point": "all_plans_pricing_modal",
        "plan_name": "chatgptplusplan",
        "billing_details": {
            "country": inp.get('country', 'JP'),
            "currency": inp.get('currency', 'JPY'),
        },
        "cancel_url": "https://chatgpt.com/#pricing",
        "checkout_ui_mode": "hosted",
        "promo_campaign": {
            "promo_campaign_id": inp.get('promo_id', 'plus-1-month-free'),
            "is_coupon_from_query_param": False,
        },
    }
    proxies = {'http': inp['proxy'], 'https': inp['proxy']} if inp.get('proxy') else None

    for attempt in range(3):
        imp = random.choice(_CHROME)
        _log(f"Attempt {attempt+1}/3 with impersonate={imp}")
        try:
            r = cr.post(
                "https://chatgpt.com/backend-api/payments/checkout",
                json=body,
                headers={'Authorization': f'Bearer {token}', 'Accept': 'application/json'},
                impersonate=imp,
                proxies=proxies,
                timeout=20,
            )
            text = r.text
            m = re.search(r'https://pay\.openai\.com[^\s"\\)]+', text)
            if m:
                print(json.dumps({"status": "success", "link": m.group(0), "raw": text[:500]}))
                return
            _log(f"No link in response (status={r.status_code}): {text[:120]}")
            if r.status_code in (401, 403):
                print(json.dumps({"status": "no_link", "link": "", "raw": text[:500]}))
                return
        except Exception as e:
            _log(f"Retry-able error: {str(e)[:80]}")
    print(json.dumps({"status": "error", "error": "All 3 attempts failed"}))

if __name__ == "__main__":
    main()
```

## The Node Wrapper (`server/chatgpt-checkout.js` — full rewrite)

```js
// Spawn checkout_link.py to fetch a pay.openai.com link via Python curl_cffi
// (Chrome JA3 fingerprint). undici is blocked by Cloudflare; curl_cffi passes.
const { spawn } = require('child_process');
const path = require('path');
const proxyMgr = require('./proxy');

const SCRIPT = path.join(__dirname, '..', 'checkout_link.py');

function fetchCheckoutLink(accessToken, opts = {}) {
  return new Promise((resolve) => {
    const py = spawn('py', ['-3', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; py.kill();
      resolve({ link: '', title: '', raw: 'ERROR: Python timeout (60s)' });
    }, 60000);

    const input = JSON.stringify({
      access_token: accessToken,
      country: opts.country || 'JP',
      currency: opts.currency || 'JPY',
      promo_id: opts.promoCampaignId || 'plus-1-month-free',
      proxy: proxyMgr.getProxyUrl(),
    });

    let stdout = '';
    let stderr = '';
    py.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n').filter(l => l.trim())) {
        try {
          const p = JSON.parse(line);
          if (p.log) console.log(p.log);
          else stdout = line;
        } catch {
          stdout = line;
        }
      }
    });
    py.stderr.on('data', (data) => { stderr += data.toString(); });
    py.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      try {
        const r = JSON.parse(stdout);
        resolve({ link: r.link || '', title: '', raw: r.raw || r.error || '' });
      } catch {
        resolve({ link: '', title: '', raw: `ERROR: ${stderr.slice(-200) || 'Python parse failed'}` });
      }
    });
    py.stdin.write(input);
    py.stdin.end();
  });
}

module.exports = { fetchCheckoutLink };
```

## Proxy Module Changes

In `server/proxy/index.js`:

1. **Remove fields** from `_state` initialization:
   - `checkoutRegionKeyword: '日本'`
   - `checkoutNodeTags: []`

2. **Revert `refresh()`** to the single-pool form:
   - Remove the `_state.checkoutRegionKeyword = cfg.checkoutRegionFilter || '日本';` line
   - Remove the `checkoutFiltered = filterByRegion(all, _state.checkoutRegionKeyword)` block
   - Remove the `merged = [...filtered]` de-dup loop
   - Restore the original `_state.outbounds = filtered;` / `buildSingboxConfig(filtered)` lines

3. **Delete the `withCheckoutNode(fn)` function entirely**.

4. **Remove `withCheckoutNode`** from `module.exports`.

## Engine Call-Site Simplification

`server/engine.js` (around line 298-303):
```js
// Before
discord = await proxyMgr.withCheckoutNode(
  () => fetchCheckoutLink(loginResult.accessToken)
);
// After
discord = await fetchCheckoutLink(loginResult.accessToken);
```

`protocol-engine.js` (around line 309-311):
```js
// Before
r = await proxyMgr.withCheckoutNode(
  () => fetchCheckoutLink(result.accessToken)
);
// After
r = await fetchCheckoutLink(result.accessToken);
```

Both `.withCheckoutNode` calls are replaced with the direct call. The retry/timeout-handling around them stays as-is.

## Frontend Config Cleanup

In `web/src/views/Config.vue`:

1. Delete from the `form` reactive: the `proxyCheckoutRegionFilter: '日本'` field.
2. Delete from the config-load block: `if (cfg.proxy.checkoutRegionFilter !== undefined) form.proxyCheckoutRegionFilter = cfg.proxy.checkoutRegionFilter`.
3. Delete from the config-save block: `delete payload.proxyCheckoutRegionFilter;` and `checkoutRegionFilter: form.proxyCheckoutRegionFilter,`.
4. Delete the entire `<el-form-item label="Checkout 区域">...</el-form-item>` block in the template.
5. Rebuild `npm run build` in `web/`.

Keep the `paymentLinkSource` dropdown — Discord fallback still uses it.

## Dependency Cleanup

Run `npm uninstall undici` in the project root. Commit the resulting `package.json` and `package-lock.json` changes.

## Error Handling Matrix

| Scenario | `chatgpt-checkout.js` returns | Engine behavior |
|---|---|---|
| Python script returns 200 with link | `{link: 'https://pay.openai.com/...', raw}` | Open in browser, continue payment |
| Python returns status `no_link` (e.g. 401/403) | `{link: '', raw}` | `no_link` status emitted, account skipped |
| Python returns status `error` (3 retries exhausted) | `{link: '', raw: 'All 3 attempts failed'}` | Same as no_link path |
| Python subprocess times out at 60s | `{link: '', raw: 'ERROR: Python timeout (60s)'}` | Same as no_link path |
| Python crashes / can't parse JSON | `{link: '', raw: 'ERROR: <stderr tail>'}` | Same as no_link path |

The engine's existing `no_link` branch already handles "empty link" gracefully — no engine-side changes needed for error paths.

## Acceptance Criteria

1. **Functional smoke test**: with `paymentLinkSource: 'api'`, run one idle account through `protocol-engine`. Logs should show:
   ```
   [1/1] Checkout: <email>...
     [Checkout] Attempt 1/3 with impersonate=chromeXXX
   [1/1] Link: https://pay.openai.com/c/pay/cs_live_...
   ```
   Browser then opens the link and PayPal flow continues.

2. **Discord fallback unchanged**: with `paymentLinkSource: 'discord'`, the existing Gateway path runs (no Python spawn).

3. **No JP-pool remnants**: `git grep -i "checkout.region\|checkoutNodeTags\|withCheckoutNode"` returns no matches in `server/` or `protocol-engine.js`.

4. **No undici remnants**: `git grep undici` returns no matches in `server/` or `package.json` dependencies (the lockfile may still mention it transitively, but the top-level dep is gone).

5. **Web build clean**: `cd web && npm run build` succeeds with no errors.

## Risks

- **`py -3` on Windows vs. `python3` on Linux/Mac**: the existing `protocol_register.py` is spawned via `py -3`. We use the same launcher for `checkout_link.py`. Cross-platform compatibility inherits whatever `protocol_register.py` already supports (project is Windows-targeted per the env hints).

- **Cold-start overhead**: spawning a Python subprocess adds 200-500ms vs. an in-process HTTP call. Acceptable — one call per account, run sequentially.

- **OpenAI server-side change**: if OpenAI later does start checking IP region (e.g., as anti-abuse), this design degrades to no-link gracefully (the existing `no_link` branch). Re-adding JP-pool support would be straightforward — the proxy module's `switchTo`/`rotate` API is unchanged; we'd add a new `withCheckoutNode` helper. But not now (YAGNI).

- **Cloudflare may upgrade detection**: if undici starts working OR if curl_cffi starts failing, we revisit. Current evidence (2026-05-22) strongly favors curl_cffi.
