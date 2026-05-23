# PayPal Slider CAPTCHA Timeout (Spec)

**Date:** 2026-05-23
**Status:** Approved → execute
**Predecessor:** dev @ `cf5db65` (payment.js fail-fast genericError)

## Goal

When PayPal shows a slider CAPTCHA on `paypal.com/agreements/approve`, give the user **90 seconds** to drag the slider manually. If still unresolved, mark the account as `paypal_captcha` and move on. No automated CAPTCHA bypass.

## Background

PayPal's `agreements/approve?ba_token=...` is normally a 1–3 second pass-through URL on the OpenAI → Stripe → PayPal flow. Akamai risk control sometimes intercepts it with a "确认您是人类 / 将滑块完全向右移动" slider challenge. The current `payment.js` first wait loop (lines 604–623) has no specific branch for this URL and falls into the silent `else` catch-all, eventually timing out after ~30s with no actionable signal.

Existing user constraints carried in from prior sessions:
- "不要加 CAPTCHA 检测" → interpreted as **no automated CAPTCHA bypass**; pure URL detection + log + human-wait is allowed.
- Project keeps browser mode and CDP-attach to real Chrome; no headless additions.

## Architecture

Three small, isolated changes:

1. **`payment.js`** — detect `agreements/approve` dwell time > 4s, enter dedicated 90s wait, return `{ status: 'paypal_captcha' }` on timeout.
2. **Engine wiring** — both `protocol-engine.js` and `server/engine.js` honor `paymentResult.status` before falling through to generic `error`.
3. **`web/src/status.js`** — register `paypal_captcha` status code with type `warning`, label `PayPal人机验证`.

No new files. No new dependencies. No changes to browser-launch path, sing-box, or proxy logic.

## Detection Logic (payment.js)

Insert a new branch in the first wait loop (currently `payment.js:604-623`), placed **before** the catch-all `else`:

```js
let captchaFirstSeenAt = 0;
let captchaHandled = false;

for (let round = 0; round < 15; round++) {
  await randomDelay(2000, 3000);
  let currentUrl;
  try { currentUrl = page.url(); } catch (e) { ...existing close handling... }

  if (currentUrl.includes('paypal.com/pay')) {
    await handlePayPalLogin(page);
  } else if (currentUrl.includes('paypal.com') && (currentUrl.includes('checkoutweb') || currentUrl.includes('signup'))) {
    await handlePayPalCheckout(page, PHONE, SMS_API);
    paypalHandled = true;
    break;
  } else if (/paypal\.com\/agreements\/approve/i.test(currentUrl)) {
    if (!captchaFirstSeenAt) {
      captchaFirstSeenAt = Date.now();
      continue;
    }
    if (Date.now() - captchaFirstSeenAt > 4000 && !captchaHandled) {
      captchaHandled = true;
      console.log('    [Pay] PayPal slider CAPTCHA detected — please drag manually (90s timeout)');
      const cleared = await waitForCaptchaResolution(page, 90000);
      if (!cleared) {
        return { success: false, status: 'paypal_captcha', reason: 'PayPal slider CAPTCHA timeout (90s)' };
      }
      console.log('    [Pay] CAPTCHA cleared, continuing flow');
    }
    continue;
  } else if (currentUrl.includes('pay.openai.com') || currentUrl.includes('checkout.stripe.com')) {
    ...existing waiting-for-redirect log...
    continue;
  } else {
    ...existing unknown-URL log...
    continue;
  }
}
```

New helper (module-private, defined near `randomDelay`):

```js
async function waitForCaptchaResolution(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    let url;
    try { url = page.url(); } catch { return false; }
    if (!/paypal\.com\/agreements\/approve/i.test(url)) return true;
  }
  return false;
}
```

**Threshold rationale (4 seconds)**: under normal flow `agreements/approve` redirects within 1–3s, so 4s avoids false-positive logging on every successful run. The first encounter records `captchaFirstSeenAt`, the second encounter (≥2s later) crosses the 4s threshold only if PayPal hasn't already redirected — at that point we are confident the slider is shown.

**Total budget**: ~6s dwell detection + 90s human-wait = 96s worst case before failure. After failure, the existing `finally` block in each engine closes the page/browser, no change needed.

## Status Wiring

### web/src/status.js

```js
const TYPE_MAP = {
  ...existing...,
  paypal_captcha: 'warning',
};

const LABEL_MAP = {
  ...existing...,
  paypal_captcha: 'PayPal人机验证',
};
```

Do **not** add `paypal_captcha` to `ERROR_STATUSES`. Rationale: re-running these accounts is a viable path (different IP, retry later), so keeping it out of the error bucket preserves filter clarity for the "real error" set.

### protocol-engine.js (lines ~414-431)

Add a new branch between `notFreeTrial` and the default error path:

```js
if (paymentResult.success) {
  ...existing...
} else if (paymentResult.notFreeTrial) {
  this.emitStatus({ email: account.email, status: 'no_link', phase: 'done', progress, reason: paymentResult.reason });
  summary.noLink++;
} else if (paymentResult.status) {
  console.log(`[${progress}] Payment incomplete: ${paymentResult.reason}`);
  this.emitStatus({ email: account.email, status: paymentResult.status, phase: 'payment', progress, reason: paymentResult.reason });
  summary.error++;
} else {
  const reason = paymentResult.reason || 'Payment not completed';
  console.log(`[${progress}] Payment incomplete: ${reason}`);
  this.emitStatus({ email: account.email, status: 'error', phase: 'payment', progress, reason });
  summary.error++;
}
```

The new branch reuses `summary.error` counter (no new KPI), but emits the precise status code so the Dashboard's per-account display is correct.

### server/engine.js (lines ~383-413)

`payResult` is `const`-scoped inside the `try` block (line 389), so its `status` field is **not visible** at line 410. Hoist a new outer variable `paymentStatus`, set it inside the try, use it in the failure branch:

```js
console.log(`${p} Phase 3: Auto-filling payment...`);
let paymentOk = false;
let paymentReason = '';
let paymentStatus = '';  // NEW
try {
  const freshCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
  const phoneSlot = freshCfg.phoneSlots?.[0] || { phone: freshCfg.phone, smsApiUrl: freshCfg.smsApiUrl };
  const payResult = await autoPayment(page, { phone: phoneSlot.phone, smsApiUrl: phoneSlot.smsApiUrl }) || {};
  paymentOk = !!payResult.success;
  paymentReason = payResult.reason || '';
  paymentStatus = payResult.status || '';  // NEW
} catch (e) {
  ...existing handler unchanged...
}

if (paymentOk) {
  finalResult.status = 'plus_no_rt';
  console.log(`${p} Payment succeeded (redirect_status=succeeded)`);
} else {
  finalResult.status = paymentStatus || 'error';  // NEW: prefer status from payment.js
  finalResult.reason = paymentReason || 'Payment not completed';
  console.log(`${p} Payment failed: ${finalResult.reason}, skipping auth file generation`);
}
```

## Edge Cases

| Scenario | Behavior |
|---|---|
| Normal flow, no CAPTCHA | `agreements/approve` redirects in <4s; `captchaFirstSeenAt` may be set but threshold never crossed; no log emitted; flow proceeds normally |
| CAPTCHA shown, human drags within 90s | URL leaves `agreements/approve`; `waitForCaptchaResolution` returns `true`; flow returns to outer loop and progresses to `handlePayPalCheckout` |
| CAPTCHA shown, no human action | After 90s, returns `{ success: false, status: 'paypal_captcha', reason: '...' }`; engine emits status, `finally` closes browser, next account proceeds |
| Page crash during CAPTCHA wait | `page.url()` throws; `waitForCaptchaResolution` returns `false`; same as timeout — account marked `paypal_captcha` |
| CAPTCHA shown post-SMS (later in flow) | Out of scope this iteration; the second wait loop (`payment.js:637-657`) still has the existing genericError fail-fast but no captcha detection. If user reports this case, add a second integration point later |

## Non-Goals

- **No automated slider solver.** Akamai detects scripted drags; not worth the engineering cost or PayPal ToS exposure.
- **No toast / desktop notification.** Confirmed in brainstorming.
- **No pause of the whole batch run.** Single account fails, next proceeds.
- **No Dashboard KPI tile** for CAPTCHA count. Status code on the account row is sufficient (YAGNI).
- **No config-driven timeout.** 90s is hard-coded per user choice; revisit if real-world usage shows need.

## Acceptance Criteria

1. `node --check payment.js` passes
2. `node --check protocol-engine.js` passes
3. `node --check server/engine.js` passes
4. Frontend build succeeds: `cd web && npm run build`
5. Server boots cleanly: `node server/index.js` runs without runtime errors on startup
6. On a normal (non-CAPTCHA) flow, no `PayPal slider CAPTCHA detected` log appears
7. Manual / synthetic test: when `agreements/approve` URL persists >4s, the detection log is emitted; if URL never changes within 90s, the run ends with `status='paypal_captcha'` visible on the Dashboard

## Files Affected

- **Modify**: `payment.js` (add helper + branch in first wait loop)
- **Modify**: `protocol-engine.js` (add `paymentResult.status` branch)
- **Modify**: `server/engine.js` (one-line change at line ~410)
- **Modify**: `web/src/status.js` (add 2 entries)

No file creations, no file deletions, no dependency changes.

## Out of Scope

- Detection of any non-`agreements/approve` CAPTCHA pages (e.g., post-SMS challenge variants)
- Retry logic for CAPTCHA failures
- Manual approval / human-in-the-loop infrastructure beyond the simple URL poll
- Changes to `cpa.js`, `protocol_register.py`, `chatgpt_register/`, or sing-box
