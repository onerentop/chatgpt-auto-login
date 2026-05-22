# ChatGPT Direct Payment Link — Replacing Discord Bot

**Date:** 2026-05-22
**Status:** Approved
**Author:** brainstorming session

## Background

The current pipeline fetches the ChatGPT Plus free-trial payment link via a third-party Discord bot. The bot accepts the user's `accessToken` through a modal and returns a `pay.openai.com/c/pay/cs_live_xxx` URL. That bot has stopped working — calls now return `Interaction 403 {"code": 50013, "message": "缺失权限"}` — and is outside our control to fix.

Investigation of the open-source extension [`suyancc/openai-plus-vxt`](https://github.com/suyancc/openai-plus-vxt) revealed that ChatGPT's own website calls a documented-by-reverse-engineering endpoint to create the same `pay.openai.com` checkout session. We can call it directly with the `accessToken` we already obtain during protocol login.

The promo we want (`plus-1-month-free`) is currently active only for buyers whose IP geolocates to Japan. So the call needs to be made through a Japan exit node while the rest of the pipeline (login, browser PayPal flow) stays on whatever node the user normally rotates through.

## Goal

Replace the Discord-bot link fetcher with a direct call to ChatGPT's `/backend-api/payments/checkout` endpoint, executed under a transient Japan-region proxy switch. Keep the Discord path available as a fallback behind a config toggle.

## The Endpoint

```
POST https://chatgpt.com/backend-api/payments/checkout
Authorization: Bearer {accessToken}
Content-Type: application/json
Accept: application/json
```

**Body for Plus 1-month-free:**

```json
{
  "entry_point": "all_plans_pricing_modal",
  "plan_name": "chatgptplusplan",
  "billing_details": { "country": "JP", "currency": "JPY" },
  "cancel_url": "https://chatgpt.com/#pricing",
  "checkout_ui_mode": "hosted",
  "promo_campaign": {
    "promo_campaign_id": "plus-1-month-free",
    "is_coupon_from_query_param": false
  }
}
```

**Response (on success):** JSON containing a `pay.openai.com/c/pay/cs_live_xxx` URL. The exact JSON shape isn't documented; we extract via regex to be forward-compatible with shape changes.

**Failure modes observed/expected:**
- 403 with reason → region mismatch or promo expired
- 401 → token rejected
- Non-200 with no `pay.openai.com` URL in body → treat as "no link"

## Scope

In scope:
- New module `server/chatgpt-checkout.js` — single function `fetchCheckoutLink(accessToken, opts)`.
- `server/proxy/index.js` — add `checkoutRegionFilter` config support, dual node pool, `withCheckoutNode(fn)` helper.
- `server/engine.js` and `protocol-engine.js` — switch link source based on config; default to new API path.
- `config.json` — two new fields (`paymentLinkSource`, `proxy.checkoutRegionFilter`) with sensible defaults.
- `web/src/views/Config.vue` — UI for the two new config fields.

Out of scope:
- Removing Discord code (kept as fallback under `paymentLinkSource: 'discord'`).
- Multi-region pool architecture beyond US (main) + JP (checkout).
- Per-account region selection.
- Renaming the engine-internal `discord` variable that now holds the API result — kept for minimal diff.

## Architecture

### Module Boundaries

```
server/chatgpt-checkout.js  (NEW)
  ↓ uses
server/proxy/index.js        (MODIFIED)
  • new exports: withCheckoutNode(fn)
  • new state: _state.checkoutNodeTags
  ↓ uses
server/proxy/clash-api.js    (unchanged — switchSelector)
server/proxy/subscription.js (unchanged — filterByRegion already supports custom keywords)

server/engine.js             (MODIFIED — link-source branch)
protocol-engine.js           (MODIFIED — link-source branch)
server/discord-gateway.js    (unchanged — kept as fallback)

config.json                  (extended)
web/src/views/Config.vue     (extended UI)
```

### Data Flow

```
1. Pipeline starts → proxyMgr.rotate() picks US node (existing behavior)
2. loginAccount(account) on US node → accessToken
3. paymentLinkSource decision:
     'api'     → 4a (default)
     'discord' → 4b (legacy)
4a. proxyMgr.withCheckoutNode(async () => {
       // sing-box selector → JP node
       return fetchCheckoutLink(accessToken);
       // POST chatgpt.com/backend-api/payments/checkout via JP IP
    })
    // sing-box selector restored to US node
4b. getPaymentLink(gw, accessToken) — Discord WebSocket path, unchanged
5. result.link → browser.goto(link) → autoPayment(page, ...) — unchanged
```

### Proxy Module Changes (`server/proxy/index.js`)

**New state:**
```js
let _state = {
  // ... existing fields ...
  checkoutRegionKeyword: '日本', // matches tags like "lite-日本02"
  checkoutNodeTags: [],          // subset of nodeTags matching the checkout region
};
```

**Refresh logic (modified):**

In `refresh()`, after the existing region filter loads main `outbounds`, ALSO compute `checkoutOutbounds = filterByRegion(all, checkoutRegionKeyword)` and merge them into the sing-box outbounds list (so the selector can switch to them). Maintain `_state.checkoutNodeTags` as a separate list. If no checkout nodes match, log a warning but don't fail refresh.

```js
const main = filterByRegion(all, _state.rotationKeyword);
const checkout = filterByRegion(all, _state.checkoutRegionKeyword);
const checkoutOnly = checkout.filter(o => !main.some(m => m.tag === o.tag));

_state.outbounds = [...main, ...checkoutOnly];   // all distinct outbounds loaded into sing-box
_state.nodeTags = main.map(o => o.tag);          // rotation pool (US only — unchanged)
_state.checkoutNodeTags = checkout.map(o => o.tag); // checkout pool (JP)
_state.rotationIndex = 0;
```

The user's existing rotation (`rotate()`) still cycles only through `_state.nodeTags`, so JP nodes never participate in normal rotation. They are reserved for `withCheckoutNode()` calls.

**New `withCheckoutNode(fn)` function:**

```js
async function withCheckoutNode(fn) {
  if (!_state.enabled) return await fn();  // no proxy at all — just run
  if (_state.checkoutNodeTags.length === 0) {
    console.log('[Proxy] No checkout-region nodes loaded; running on current node');
    return await fn();
  }
  const prevNode = _state.currentNode;
  const jpNode = _state.checkoutNodeTags[
    Math.floor(Math.random() * _state.checkoutNodeTags.length)
  ];
  try {
    await clashApi.switchSelector(SELECTOR_TAG, jpNode);
    _state.currentNode = jpNode;
    console.log(`[Proxy] Checkout switch → ${jpNode}`);
    return await fn();
  } finally {
    try {
      await clashApi.switchSelector(SELECTOR_TAG, prevNode);
      _state.currentNode = prevNode;
      console.log(`[Proxy] Checkout restore → ${prevNode}`);
    } catch (e) {
      console.log(`[Proxy] Checkout restore failed: ${e.message?.slice(0, 60)}`);
    }
  }
}
```

The `try/finally` guarantees the node is restored even if `fn()` throws.

**Exports:** add `withCheckoutNode` to the module's exports.

### New Module: `server/chatgpt-checkout.js`

```js
const proxyMgr = require('./proxy');

const ENDPOINT = 'https://chatgpt.com/backend-api/payments/checkout';

async function fetchCheckoutLink(accessToken, opts = {}) {
  const body = {
    entry_point: 'all_plans_pricing_modal',
    plan_name: 'chatgptplusplan',
    billing_details: {
      country: opts.country || 'JP',
      currency: opts.currency || 'JPY',
    },
    cancel_url: 'https://chatgpt.com/#pricing',
    checkout_ui_mode: 'hosted',
    promo_campaign: {
      promo_campaign_id: opts.promoCampaignId || 'plus-1-month-free',
      is_coupon_from_query_param: false,
    },
  };

  // undici is bundled with Node 22. ProxyAgent routes HTTPS through sing-box.
  const { ProxyAgent } = require('undici');
  const proxyUrl = proxyMgr.getProxyUrl();
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

  let r, text = '';
  try {
    r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      body: JSON.stringify(body),
      dispatcher,
    });
    text = await r.text();
  } catch (e) {
    return { link: '', title: '', raw: `ERROR: ${e.message?.slice(0, 200) || 'fetch failed'}` };
  }

  const linkMatch = text.match(/https:\/\/pay\.openai\.com[^\s"\\)]+/);
  if (!linkMatch) {
    console.log(`[Checkout] No link in response (status ${r.status}): ${text.slice(0, 200)}`);
  }
  return {
    link: linkMatch ? linkMatch[0] : '',
    title: '',
    raw: text.slice(0, 500),
  };
}

module.exports = { fetchCheckoutLink };
```

Return shape (`{ link, title, raw }`) matches the existing `getPaymentLink` from Discord exactly, so downstream code doesn't need to change.

### Engine Integration (both `engine.js` and `protocol-engine.js`)

Find the existing Discord call in each file (Phase 2 — payment link fetching):

```js
let discord;
for (let dRetry = 0; dRetry < 3; dRetry++) {
  try {
    if (dRetry > 0) console.log(`${p} Discord retry ${dRetry + 1}/3...`);
    discord = await getPaymentLink(gw, loginResult.accessToken);
    break;
  } catch (de) {
    // ... existing retry logic
  }
}
```

Replace with a branching wrapper:

```js
const linkSource = freshCfg.paymentLinkSource || 'api';
let discord;  // keep variable name to minimize downstream diff
for (let dRetry = 0; dRetry < 3; dRetry++) {
  try {
    if (dRetry > 0) console.log(`${p} Link fetch retry ${dRetry + 1}/3...`);
    if (linkSource === 'discord') {
      discord = await getPaymentLink(gw, loginResult.accessToken);
    } else {
      const { fetchCheckoutLink } = require('./chatgpt-checkout');
      discord = await proxyMgr.withCheckoutNode(() => fetchCheckoutLink(loginResult.accessToken));
    }
    break;
  } catch (de) {
    console.log(`${p} Link fetch error: ${de.message?.slice(0, 60)}`);
    if (dRetry < 2 && (de.message?.includes('Timeout') || de.message?.includes('fetch'))) {
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    throw de;
  }
}
```

**Gateway connection guard (both engines):** Both `engine.js` (line 168) and `protocol-engine.js` currently call `gw = await connectGateway()` unconditionally during pipeline startup. With the new branch, this WebSocket should only open when `linkSource === 'discord'`:

```js
let gw = null;
if (linkSource === 'discord') {
  gw = await connectGateway();
  this._gw = gw;
}
```

For `protocol-engine.js` also: rename the existing `Discord:` log prefix to `Link:` (or keep both branches' logs consistent: `[Discord]` vs `[Checkout]`) for accuracy. Don't churn the prefix in `engine.js` if it's only used in error messages — minimal-diff principle.

### Config Changes (`config.json`)

Add two new fields with defaults:

```json
{
  "paymentLinkSource": "api",
  "proxy": {
    "checkoutRegionFilter": "日本"
  }
}
```

Loader behavior:
- If `paymentLinkSource` is missing → default `'api'` (i.e. new accounts default to the new path)
- If `proxy.checkoutRegionFilter` is missing → default `'日本'` (matches tag-naming convention of Chinese proxy subscriptions)

### Frontend: `web/src/views/Config.vue`

Add a new section "支付链接来源 (Payment Link Source)":

```vue
<el-form-item label="链接来源">
  <el-select v-model="form.paymentLinkSource" style="width: 200px">
    <el-option label="ChatGPT API（推荐）" value="api" />
    <el-option label="Discord 机器人（后备）" value="discord" />
  </el-select>
  <el-text type="info" style="margin-left: 12px">
    API 路径直接调用 ChatGPT 内部接口，需 JP 节点
  </el-text>
</el-form-item>
```

Inside the proxy section, add:

```vue
<el-form-item label="Checkout 地区节点关键字">
  <el-input v-model="form.proxy.checkoutRegionFilter" placeholder="日本" style="width: 200px" />
  <el-text type="info" style="margin-left: 12px">
    临时切换到该地区节点抓取支付链接（默认 日本）
  </el-text>
</el-form-item>
```

The existing Discord fields (`discordToken`, `discordChannelId`, etc.) remain visible regardless of `paymentLinkSource` value — easier to switch back if the API breaks.

## Error Handling Matrix

| Scenario | Behavior |
|---|---|
| API returns 200 with `pay.openai.com` URL | Pass to browser flow (success) |
| API returns 200 without `pay.openai.com` URL | `{ link: '', raw }` → engine treats as `no_link` (same as current Discord-no-link path) |
| API returns 401 / 403 / non-2xx | Same — empty link returned, `raw` contains response text for debugging |
| Fetch throws (timeout, undici error) | `{ link: '', raw: 'ERROR: ...' }` → `no_link` |
| JP node pool empty | `withCheckoutNode` warns + runs on current node; API likely returns region-mismatch error → handled above |
| `switchSelector` fails | `finally` still attempts restore; if both fail, node state is "stuck on JP" until next `rotate()` resyncs |
| `paymentLinkSource === 'discord'` but Discord still broken | 3 retries then exit with the original 403 error — user gets the existing failure mode unchanged |

## Acceptance Criteria

1. With `paymentLinkSource: 'api'` and JP nodes available, run 1 account end-to-end: log shows `Checkout switch → lite-日本XX`, then a `pay.openai.com/c/pay/cs_live_xxx` URL is fetched, then `Checkout restore → lite-美国XX`, then browser PayPal flow runs (this part already validated by v2.15.0).
2. With `paymentLinkSource: 'discord'`, the existing Discord path still runs unchanged — verify by reading the engine logs (`getPaymentLink` invocation visible).
3. With proxy disabled (`proxy.enabled: false`), the API path still works (no proxy applied to undici fetch; node's default routing reaches chatgpt.com directly).
4. The pipeline restores the prior US node after `withCheckoutNode` even when `fetchCheckoutLink` throws — verified by a deliberate failure injection (e.g., temporarily setting an invalid endpoint URL in `chatgpt-checkout.js` to force a 404, observing the restore log line still appears).
5. UI dropdown switches `paymentLinkSource` and persists to config on save.

## File-Level Changes Summary

| File | Status | Change |
|---|---|---|
| `server/chatgpt-checkout.js` | NEW | `fetchCheckoutLink` exports |
| `server/proxy/index.js` | MODIFIED | dual pool, `withCheckoutNode`, new state, new config read |
| `server/engine.js` | MODIFIED | link-source branch in Phase 2 |
| `protocol-engine.js` | MODIFIED | link-source branch in Phase 2 |
| `server/discord-gateway.js` | unchanged | still imported by engines on `discord` path |
| `config.json` | MODIFIED | two new fields with defaults |
| `web/src/views/Config.vue` | MODIFIED | two new form fields |
| `server/routes/config.js` | possibly MODIFIED | accept the new fields on PUT (depends on whether it whitelists vs. merges) |

## Risks

- **Endpoint stability**: ChatGPT's internal API can change without notice. Mitigation: regex extraction (not strict JSON parsing), graceful empty-link fallback, Discord toggle as fallback.
- **JP-IP detection drift**: OpenAI could tighten geo-checks (e.g., looking for residential IPs only). Mitigation: graceful degrade — call still runs, just returns no link, account ends as `no_link`. Same outcome as current.
- **Proxy switch race during concurrent runs**: if the engine ever runs accounts in parallel within one process, two `withCheckoutNode` calls could collide (one's restore overwrites the other's switch). Current architecture runs accounts sequentially, so this isn't a current concern, but worth noting as a future constraint.
- **`undici.ProxyAgent` keepalive**: each `fetchCheckoutLink` call creates a fresh `ProxyAgent`. Slight overhead but no leak. Reusing a global agent across accounts is an optimization for later; not worth the complexity now.
