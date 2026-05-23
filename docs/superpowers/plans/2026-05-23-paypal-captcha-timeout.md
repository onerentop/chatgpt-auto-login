# PayPal Slider CAPTCHA 90s Human-Wait Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect PayPal slider CAPTCHA on `paypal.com/agreements/approve`, give the human 90 seconds to drag the slider, otherwise mark the account `paypal_captcha` and proceed to the next account.

**Architecture:** Single-helper + single-branch addition in `payment.js`; two-line wiring change each in `protocol-engine.js` and `server/engine.js`; two-entry registration in `web/src/status.js`. No new files, no new dependencies, no automated CAPTCHA bypass.

**Tech Stack:** Node 18+, Playwright (CDP attach to real Chrome), Vue 3 + Element Plus dashboard. Project has **no JS unit-test framework** installed; verification is `node --check` (syntax) + `npm run build` (frontend) + manual / synthetic smoke per task.

**Spec:** `docs/superpowers/specs/2026-05-23-paypal-captcha-timeout-design.md`

---

## File map

| File | Change |
|---|---|
| `payment.js` | Add `waitForCaptchaResolution` helper near line 585 (just before `autoPayment`). Add new `else if` branch in first wait loop (lines 604-623) for `paypal.com/agreements/approve` URL dwell-time detection. Return `{ success: false, status: 'paypal_captcha', reason: ... }` on timeout. |
| `protocol-engine.js` | Insert new `else if (paymentResult.status)` branch between `notFreeTrial` (line 423-425) and default error (line 426-430). |
| `server/engine.js` | Add `let paymentStatus = '';` at line 386. Set `paymentStatus = payResult.status \|\| '';` inside try at line ~391. Change `finalResult.status = 'error'` at line 410 to `finalResult.status = paymentStatus \|\| 'error'`. |
| `web/src/status.js` | Add `paypal_captcha: 'warning'` to `TYPE_MAP` and `paypal_captcha: 'PayPal人机验证'` to `LABEL_MAP`. Do NOT add to `ERROR_STATUSES`. |

---

## Task 1: payment.js — CAPTCHA detection + helper

**Files:**
- Modify: `payment.js:585` (insert helper above `autoPayment`)
- Modify: `payment.js:604-623` (extend first wait loop)

The helper and the branch are committed together because each is useless without the other.

- [ ] **Step 1: Insert `waitForCaptchaResolution` helper before `autoPayment`**

In `payment.js`, find the line `async function autoPayment(page, phoneConfig) {` (currently line 586). Insert the following block on the blank line immediately above it (currently line 585):

```js
// Poll the page URL while the user manually drags the PayPal slider CAPTCHA.
// Returns true if the URL leaves paypal.com/agreements/approve before timeoutMs
// (user dragged slider, PayPal redirected onward), false otherwise.
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

- [ ] **Step 2: Add dwell-time tracking variables before the first wait loop**

Locate the first wait loop currently starting at `payment.js:604` (`for (let round = 0; round < 15; round++) {`). The two lines above it (currently 602-603) are:

```js
  // After OpenAI submit, PayPal redirect can take 5-15 seconds
  let paypalHandled = false;
```

Add two more `let` declarations right after `let paypalHandled = false;`:

```js
  let paypalHandled = false;
  let captchaFirstSeenAt = 0;
  let captchaHandled = false;
```

- [ ] **Step 3: Insert the agreements/approve detection branch inside the first wait loop**

Inside the first wait loop body, find the existing branch structure (currently lines 609-623):

```js
    if (currentUrl.includes('paypal.com/pay')) {
      await handlePayPalLogin(page);
    } else if (currentUrl.includes('paypal.com') && (currentUrl.includes('checkoutweb') || currentUrl.includes('signup'))) {
      await handlePayPalCheckout(page, PHONE, SMS_API);
      paypalHandled = true;
      break;
    } else if (currentUrl.includes('pay.openai.com') || currentUrl.includes('checkout.stripe.com')) {
      // Still on OpenAI/Stripe, waiting for redirect
      if (round % 3 === 2) console.log('    [Pay] Waiting for PayPal redirect...');
      continue;
    } else {
      // Unknown URL — might be mid-redirect, keep waiting
      if (round % 3 === 2) console.log('    [Pay] Page: ' + currentUrl.slice(0, 60) + '...');
      continue;
    }
```

Insert a new `else if` branch for `paypal.com/agreements/approve` **between the `checkoutweb/signup` branch and the `pay.openai.com/checkout.stripe.com` branch**. The result must look exactly like:

```js
    if (currentUrl.includes('paypal.com/pay')) {
      await handlePayPalLogin(page);
    } else if (currentUrl.includes('paypal.com') && (currentUrl.includes('checkoutweb') || currentUrl.includes('signup'))) {
      await handlePayPalCheckout(page, PHONE, SMS_API);
      paypalHandled = true;
      break;
    } else if (/paypal\.com\/agreements\/approve/i.test(currentUrl)) {
      // agreements/approve is normally a 1-3s pass-through URL. If we are still
      // here after 4s, Akamai slider CAPTCHA was almost certainly shown.
      if (!captchaFirstSeenAt) {
        captchaFirstSeenAt = Date.now();
      } else if (Date.now() - captchaFirstSeenAt > 4000 && !captchaHandled) {
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
      // Still on OpenAI/Stripe, waiting for redirect
      if (round % 3 === 2) console.log('    [Pay] Waiting for PayPal redirect...');
      continue;
    } else {
      // Unknown URL — might be mid-redirect, keep waiting
      if (round % 3 === 2) console.log('    [Pay] Page: ' + currentUrl.slice(0, 60) + '...');
      continue;
    }
```

- [ ] **Step 4: Verify syntax**

Run:
```bash
node --check payment.js
```

Expected: exit code 0, no output. If you see a `SyntaxError`, re-check brace balance in the inserted branch.

- [ ] **Step 5: Sanity-check the new branch position**

Run:
```bash
grep -n "agreements/approve\|waitForCaptchaResolution" payment.js
```

Expected output (line numbers shift by ~12 due to inserts; exact line numbers may differ):

```
585:async function waitForCaptchaResolution(page, timeoutMs) {
590:    if (!/paypal\.com\/agreements\/approve/i.test(url)) return true;
617:    } else if (/paypal\.com\/agreements\/approve/i.test(currentUrl)) {
```

If the `else if` line is **not between** the `checkoutweb/signup` branch and the `pay.openai.com` branch, the order is wrong — fix before committing.

- [ ] **Step 6: Commit**

```bash
git add payment.js
git commit -m "feat(payment): 90s human-wait for PayPal slider CAPTCHA

When paypal.com/agreements/approve persists >4s (vs the normal <3s
pass-through), assume Akamai slider CAPTCHA was shown. Log a clear
hint asking the user to drag the slider, then poll the URL for up
to 90s. If the URL leaves agreements/approve in time, continue the
normal PayPal flow. Otherwise return status='paypal_captcha' so the
engine can mark the account as needing human attention and move on.

No automated slider solver — per long-standing project policy."
```

---

## Task 2: protocol-engine.js — honor paymentResult.status

**Files:**
- Modify: `protocol-engine.js:414-431`

- [ ] **Step 1: Insert the paymentResult.status branch**

In `protocol-engine.js`, find the block currently at lines 414-431:

```js
          if (paymentResult.success) {
            if (runtimeCfg.enableOAuth) {
              console.log(`[${progress}] Running PKCE via protocol...`);
              await this._finalizePkce(account, result, progress);
            } else {
              saveCPAAuthFile(account.email, result.accessToken, result.session);
              this.emitStatus({ email: account.email, status: 'plus_no_rt', phase: 'done', progress });
            }
            summary.success++;
          } else if (paymentResult.notFreeTrial) {
            this.emitStatus({ email: account.email, status: 'no_link', phase: 'done', progress, reason: paymentResult.reason });
            summary.noLink++;
          } else {
            const reason = paymentResult.reason || 'Payment not completed';
            console.log(`[${progress}] Payment incomplete: ${reason}`);
            this.emitStatus({ email: account.email, status: 'error', phase: 'payment', progress, reason });
            summary.error++;
          }
```

Insert a new `else if` between the `notFreeTrial` branch and the default `else`. The result must be:

```js
          if (paymentResult.success) {
            if (runtimeCfg.enableOAuth) {
              console.log(`[${progress}] Running PKCE via protocol...`);
              await this._finalizePkce(account, result, progress);
            } else {
              saveCPAAuthFile(account.email, result.accessToken, result.session);
              this.emitStatus({ email: account.email, status: 'plus_no_rt', phase: 'done', progress });
            }
            summary.success++;
          } else if (paymentResult.notFreeTrial) {
            this.emitStatus({ email: account.email, status: 'no_link', phase: 'done', progress, reason: paymentResult.reason });
            summary.noLink++;
          } else if (paymentResult.status) {
            const reason = paymentResult.reason || 'Payment not completed';
            console.log(`[${progress}] Payment incomplete: ${reason}`);
            this.emitStatus({ email: account.email, status: paymentResult.status, phase: 'payment', progress, reason });
            summary.error++;
          } else {
            const reason = paymentResult.reason || 'Payment not completed';
            console.log(`[${progress}] Payment incomplete: ${reason}`);
            this.emitStatus({ email: account.email, status: 'error', phase: 'payment', progress, reason });
            summary.error++;
          }
```

- [ ] **Step 2: Verify syntax**

Run:
```bash
node --check protocol-engine.js
```

Expected: exit code 0, no output.

- [ ] **Step 3: Sanity-check branch order**

Run:
```bash
grep -n "paymentResult.success\|paymentResult.notFreeTrial\|paymentResult.status" protocol-engine.js
```

Expected (exact line numbers may differ slightly):

```
414:          if (paymentResult.success) {
423:          } else if (paymentResult.notFreeTrial) {
426:          } else if (paymentResult.status) {
```

If `paymentResult.status` appears before `paymentResult.notFreeTrial`, the branches are reversed — fix.

- [ ] **Step 4: Commit**

```bash
git add protocol-engine.js
git commit -m "feat(protocol-engine): forward paymentResult.status to emitStatus

Adds an else-if branch between notFreeTrial and the default error
path so payment.js can communicate fine-grained failure modes (like
paypal_captcha) directly to the Dashboard. summary.error counter is
reused — no new KPI bucket per spec."
```

---

## Task 3: server/engine.js — hoist paymentStatus

**Files:**
- Modify: `server/engine.js:384-413`

`payResult` is `const`-scoped inside the try block, so its `.status` field is not visible at line 410. Hoist a new outer variable `paymentStatus`, set it inside the try, use it in the failure branch.

- [ ] **Step 1: Add paymentStatus declaration**

In `server/engine.js`, find lines 384-385:

```js
                let paymentOk = false;
                let paymentReason = '';
```

Add one new declaration immediately after:

```js
                let paymentOk = false;
                let paymentReason = '';
                let paymentStatus = '';
```

- [ ] **Step 2: Capture status inside the try block**

Find the try block starting at line 386. The current inside-try section reads:

```js
                try {
                  const freshCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
                  const phoneSlot = freshCfg.phoneSlots?.[0] || { phone: freshCfg.phone, smsApiUrl: freshCfg.smsApiUrl };
                  const payResult = await autoPayment(page, { phone: phoneSlot.phone, smsApiUrl: phoneSlot.smsApiUrl }) || {};
                  paymentOk = !!payResult.success;
                  paymentReason = payResult.reason || '';
                } catch (e) {
```

Add one line after `paymentReason = payResult.reason || '';`:

```js
                try {
                  const freshCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
                  const phoneSlot = freshCfg.phoneSlots?.[0] || { phone: freshCfg.phone, smsApiUrl: freshCfg.smsApiUrl };
                  const payResult = await autoPayment(page, { phone: phoneSlot.phone, smsApiUrl: phoneSlot.smsApiUrl }) || {};
                  paymentOk = !!payResult.success;
                  paymentReason = payResult.reason || '';
                  paymentStatus = payResult.status || '';
                } catch (e) {
```

- [ ] **Step 3: Use paymentStatus in the failure branch**

Find the if/else block currently at lines 406-413:

```js
                if (paymentOk) {
                  finalResult.status = 'plus_no_rt';
                  console.log(`${p} Payment succeeded (redirect_status=succeeded)`);
                } else {
                  finalResult.status = 'error';
                  finalResult.reason = paymentReason || 'Payment not completed';
                  console.log(`${p} Payment failed: ${finalResult.reason}, skipping auth file generation`);
                }
```

Change the failure branch's status assignment to prefer `paymentStatus`:

```js
                if (paymentOk) {
                  finalResult.status = 'plus_no_rt';
                  console.log(`${p} Payment succeeded (redirect_status=succeeded)`);
                } else {
                  finalResult.status = paymentStatus || 'error';
                  finalResult.reason = paymentReason || 'Payment not completed';
                  console.log(`${p} Payment failed: ${finalResult.reason}, skipping auth file generation`);
                }
```

- [ ] **Step 4: Verify syntax**

Run:
```bash
node --check server/engine.js
```

Expected: exit code 0, no output.

- [ ] **Step 5: Sanity-check**

Run:
```bash
grep -n "paymentStatus\|payResult.status" server/engine.js
```

Expected (exact line numbers may differ slightly):

```
386:                let paymentStatus = '';
393:                  paymentStatus = payResult.status || '';
410:                  finalResult.status = paymentStatus || 'error';
```

- [ ] **Step 6: Commit**

```bash
git add server/engine.js
git commit -m "feat(engine): forward payResult.status into finalResult.status

payResult is const-scoped inside the try block, so its status field
was not reachable in the failure branch. Hoist a paymentStatus
variable, set it inside the try, and prefer it over generic 'error'
in the failure assignment. Enables paypal_captcha (and any future
payment-specific status) to surface on the Dashboard."
```

---

## Task 4: web/src/status.js — register paypal_captcha

**Files:**
- Modify: `web/src/status.js`

- [ ] **Step 1: Add TYPE_MAP entry**

In `web/src/status.js`, find the `TYPE_MAP` object (currently lines 3-14):

```js
const TYPE_MAP = {
  idle: 'info',
  running: '',
  plus: 'success',
  plus_no_rt: 'warning',
  no_link: 'warning',
  error: 'danger',
  deactivated: 'danger',
  no_jp_proxy: 'warning',
  no_promo: 'info',
  verify_error: 'danger',
}
```

Add `paypal_captcha: 'warning',` as the last entry (before the closing brace):

```js
const TYPE_MAP = {
  idle: 'info',
  running: '',
  plus: 'success',
  plus_no_rt: 'warning',
  no_link: 'warning',
  error: 'danger',
  deactivated: 'danger',
  no_jp_proxy: 'warning',
  no_promo: 'info',
  verify_error: 'danger',
  paypal_captcha: 'warning',
}
```

- [ ] **Step 2: Add LABEL_MAP entry**

Find the `LABEL_MAP` object (currently lines 16-27):

```js
const LABEL_MAP = {
  idle: '空闲',
  running: '运行中',
  plus: 'Plus(有RT)',
  plus_no_rt: 'Plus(无RT)',
  no_link: '无链接',
  error: '错误',
  deactivated: '已删除',
  no_jp_proxy: 'JP节点不可用',
  no_promo: '无0元资格',
  verify_error: 'Stripe验证失败',
}
```

Add `paypal_captcha: 'PayPal人机验证',` as the last entry:

```js
const LABEL_MAP = {
  idle: '空闲',
  running: '运行中',
  plus: 'Plus(有RT)',
  plus_no_rt: 'Plus(无RT)',
  no_link: '无链接',
  error: '错误',
  deactivated: '已删除',
  no_jp_proxy: 'JP节点不可用',
  no_promo: '无0元资格',
  verify_error: 'Stripe验证失败',
  paypal_captcha: 'PayPal人机验证',
}
```

**Do NOT add `paypal_captcha` to `ERROR_STATUSES`** — per spec, the status remains re-runnable and is excluded from the error filter set.

- [ ] **Step 3: Sanity-check**

Run:
```bash
grep -n "paypal_captcha\|ERROR_STATUSES" web/src/status.js
```

Expected:

```
14:  paypal_captcha: 'warning',
28:  paypal_captcha: 'PayPal人机验证',
38:export const ERROR_STATUSES = ['error', 'no_link', 'deactivated', 'no_promo']
```

The `ERROR_STATUSES` line must NOT contain `paypal_captcha`. If it does, remove it.

- [ ] **Step 4: Rebuild frontend**

Run:
```bash
cd web && npm run build && cd ..
```

Expected: build finishes with no errors. `web/dist/index.html` is regenerated.

- [ ] **Step 5: Commit**

```bash
git add web/src/status.js web/dist
git commit -m "feat(web): register paypal_captcha status (warning, PayPal人机验证)

Adds the status code to TYPE_MAP (warning) and LABEL_MAP. Deliberately
not added to ERROR_STATUSES so accounts that hit CAPTCHA stay outside
the error filter — they are re-runnable after the user changes IP /
retries."
```

---

## Task 5: End-to-end smoke validation

**Files:** none modified. Verification only.

- [ ] **Step 1: Syntax-check all touched JS files**

Run:
```bash
node --check payment.js && node --check protocol-engine.js && node --check server/engine.js && echo ALL_OK
```

Expected output (single line):
```
ALL_OK
```

If any file errors, return to the relevant task and fix.

- [ ] **Step 2: Confirm frontend build artifact contains the new label**

Run:
```bash
grep -l "PayPal人机验证" web/dist/assets/*.js | head -1
```

Expected: prints one filename like `web/dist/assets/index-abc123.js`. If nothing matches, rebuild via `cd web && npm run build && cd ..`.

- [ ] **Step 3: Boot the server briefly to confirm no runtime regression**

Run:
```bash
node server/index.js
```

Wait for the line `Server running on http://localhost:3000` then press Ctrl+C. Expected lines on stdout (any order):

```
Server running on http://localhost:3000
[Proxy] sing-box running: main=:7890(...) jp=:7891(...)
```

No `SyntaxError`, `ReferenceError`, or `Cannot find module` should appear. If anything is thrown on startup, fix before declaring the task complete.

- [ ] **Step 4: Synthetic confirmation of detection logic (optional but recommended)**

This step verifies the new branch fires without needing to actually trigger a real PayPal CAPTCHA. Run a one-off Node REPL check that the regex matches the expected URL:

```bash
node -e "console.log(/paypal\.com\/agreements\/approve/i.test('https://www.paypal.com/agreements/approve?ba_token=BA-8SL87305FP968654V'))"
```

Expected output: `true`.

Then check it does NOT match the post-CAPTCHA URLs:

```bash
node -e "console.log(/paypal\.com\/agreements\/approve/i.test('https://www.paypal.com/checkoutweb/signup'))"
```

Expected output: `false`.

- [ ] **Step 5: Final git log review**

Run:
```bash
git log --oneline -5
```

Expected: top 4 commits are (newest first) the four feature commits from Tasks 1-4, with the prior `cf5db65 fix(payment): fail-fast on PayPal genericError ...` as the 5th. If commit count or order looks wrong, investigate before merging anywhere.

No commit for this task (verification only).

---

## Self-review notes

**Spec coverage:**
- `payment.js` detection + helper + return shape → Task 1 ✓
- `protocol-engine.js` wiring → Task 2 ✓
- `server/engine.js` wiring + scope fix → Task 3 ✓
- `web/src/status.js` registration → Task 4 ✓
- All acceptance criteria (1-7) → covered by Task 5 ✓
- Edge cases (page crash, normal flow, post-SMS CAPTCHA): the first two are handled by the implementation; post-SMS is explicitly out-of-scope per spec, no task needed.

**No placeholders:** every step contains the actual code or command to run, with expected outputs.

**Type consistency:** `paymentResult.status` (protocol-engine), `payResult.status` (server/engine) — both refer to the same field on the same return value from `autoPayment`. The variable name difference is preserved from existing code (each engine uses its own local name). The downstream destination `finalResult.status` / emitted status payload uses the same code `'paypal_captcha'` throughout.
