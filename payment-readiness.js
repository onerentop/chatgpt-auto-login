// payment-readiness.js — wait until a payment page (Stripe/PayPal/SMS dialog) is
// truly ready for automation: DOM has stopped mutating AND all critical elements
// are present/visible/interactive. Replaces fixed randomDelay-based waits in payment.js.

const PROFILES = {
  openai: {
    name: 'openai-stripe',
    stableWindowMs: 800,
    requiredElements: [
      { name: 'priceRendered', kind: 'js',
        check: () => /\$\s*[0-9]/.test(document.body.innerText || '') },
      { name: 'paymentAccordion', kind: 'attached',
        selector: '[data-testid="paypal-accordion-item-button"], [data-testid="card-accordion-item-button"], #payment-method-accordion-item-title-paypal' },
      { name: 'submitBtn', kind: 'attached',
        selector: 'button[data-testid="hosted-payment-submit-button"], button[data-testid="submit-button"]' },
    ],
  },
  paypalAccordionExpanded: {
    name: 'paypal-accordion-expanded',
    stableWindowMs: 500,
    elementTimeoutMs: 10000,
    requiredElements: [
      { name: 'addressLine1', kind: 'visible', selector: '#billingAddressLine1, input[name*="addressLine1"]' },
      { name: 'stateSelect', kind: 'select', selector: '#billingAdministrativeArea' },
      { name: 'termsCheckbox', kind: 'attached', selector: '#termsOfServiceConsentCheckbox, input[type="checkbox"]' },
    ],
  },
  paypalLogin: {
    name: 'paypal-login',
    stableWindowMs: 800,
    requiredElements: [
      { name: 'emailInput', kind: 'visible', selector: '#email' },
      { name: 'submitBtn', kind: 'attached', selector: 'button[data-testid="submit-button"], button[type="submit"]' },
    ],
  },
  paypalCheckout: {
    name: 'paypal-checkout',
    stableWindowMs: 1000,
    elementTimeoutMs: 8000,
    requiredElements: [
      { name: 'countrySelect', kind: 'selectAny',
        selectors: ['#country', '#countryCode', 'select[name="country"]', 'select[name="countryCode"]', 'select[id*="ountry"]'] },
      { name: 'emailInput',  kind: 'visible', selector: '#email' },
      { name: 'cardNumber',  kind: 'visible', selector: '#cardNumber' },
      { name: 'firstName',   kind: 'visible', selector: '#firstName' },
    ],
  },
  paypalCheckoutAfterCountry: {
    name: 'paypal-checkout-after-country',
    stableWindowMs: 1500,
    elementTimeoutMs: 8000,
    requiredElements: [
      { name: 'billingLine1', kind: 'visible', selector: '#billingLine1' },
      { name: 'billingState', kind: 'select',  selector: '#billingState' },
      { name: 'billingZip',   kind: 'visible', selector: '#billingPostalCode' },
    ],
  },
  smsDialog: {
    name: 'sms-dialog',
    stableWindowMs: 500,
    elementTimeoutMs: 8000,
    requiredElements: [
      { name: 'codeDialog', kind: 'text', anyOf: ['Enter your code', '输入验证码', '输入你的验证码'] },
      { name: 'codeInput', kind: 'visibleAny',
        selectors: ['input[autocomplete="one-time-code"]', 'input[type="tel"]', 'input[type="number"]'] },
    ],
  },
};

async function waitForDomStable(page, windowMs, deadline) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return false;
  // Playwright's page.evaluate(fn, arg) takes ONE argument — pack values into an object.
  const inject = async function injectedDomStable({ windowMs: _windowMs, maxMs: _maxMs }) {
    return await new Promise((resolve) => {
      let timer = null;
      let observer = null;
      const finish = (ok) => {
        if (timer) clearTimeout(timer);
        if (observer) try { observer.disconnect(); } catch (e) {}
        resolve(ok);
      };
      // Hard cap so observer never lingers past maxMs.
      const cap = setTimeout(() => finish(false), _maxMs);
      const reset = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { clearTimeout(cap); finish(true); }, _windowMs);
      };
      try {
        observer = new MutationObserver(reset);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
        reset();
      } catch (e) { clearTimeout(cap); resolve(true); }
    });
  };
  inject.__readinessRole = 'domStable';
  try {
    return await page.evaluate(inject, { windowMs, maxMs: remainingMs });
  } catch (e) {
    return false;
  }
}

async function waitForPageReady(page, profile, opts = {}) {
  const totalTimeoutMs = opts.totalTimeoutMs || 60000;
  const elementTimeoutMs = profile.elementTimeoutMs || 5000;
  const log = opts.log || (() => {});
  const signal = opts.signal;
  const start = Date.now();
  const deadline = start + totalTimeoutMs;

  // Short-circuit if abort already fired. We log the same "Readiness timeout"
  // shape so callers/log-greppers see a consistent format, with missing=['aborted'].
  if (signal?.aborted) {
    log(`[Pay] Readiness aborted (${profile.name}) — signal already aborted`);
    return { ready: false, waitedMs: 0, missing: ['aborted'] };
  }

  // Concurrently run DOM-stability wait and all element checks. Element checks
  // get the smaller of their own timeout and the remaining budget so we never
  // exceed totalTimeoutMs.
  const domStablePromise = waitForDomStable(page, profile.stableWindowMs, deadline);
  const elementPromises = profile.requiredElements.map((spec) => {
    const remaining = Math.max(500, deadline - Date.now());
    return checkElement(page, spec, Math.min(elementTimeoutMs, remaining));
  });

  // Race the bulk-await against an abort promise so signal firing mid-wait
  // unwinds immediately instead of waiting for the underlying timeouts.
  const bulkPromise = Promise.all([
    domStablePromise,
    Promise.all(elementPromises),
  ]);
  const abortPromise = signal
    ? new Promise((_resolve, reject) => {
        const onAbort = () => {
          const e = new Error('Aborted');
          e.name = 'AbortError';
          reject(e);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      })
    : null;

  let domStableOk;
  let elementResults;
  try {
    [domStableOk, elementResults] = abortPromise
      ? await Promise.race([bulkPromise, abortPromise])
      : await bulkPromise;
  } catch (e) {
    if (e?.name === 'AbortError') {
      const waitedMs = Date.now() - start;
      log(`[Pay] Readiness aborted (${profile.name}) — signal fired mid-wait waited=${waitedMs}ms`);
      return { ready: false, waitedMs, missing: ['aborted'] };
    }
    throw e;
  }

  const missing = elementResults.filter((r) => !r.ok).map((r) => r.name);
  const ready = domStableOk && missing.length === 0;
  const waitedMs = Date.now() - start;

  if (ready) {
    log(`[Pay] Page ready (${profile.name}) in ${waitedMs}ms`);
  } else {
    log(`[Pay] Readiness timeout (${profile.name}) — missing=[${missing.join(',')}] domStable=${domStableOk} waited=${waitedMs}ms`);
  }
  return { ready, waitedMs, missing };
}

async function checkElement(page, spec, timeoutMs) {
  const fail = { name: spec.name, ok: false };
  const ok = { name: spec.name, ok: true };
  try {
    switch (spec.kind) {
      case 'visible': {
        const loc = page.locator(spec.selector).first();
        await loc.waitFor({ state: 'visible', timeout: timeoutMs });
        const enabled = await loc.isEnabled().catch(() => true);
        return enabled ? ok : fail;
      }
      case 'attached': {
        const loc = page.locator(spec.selector).first();
        await loc.waitFor({ state: 'attached', timeout: timeoutMs });
        return ok;
      }
      case 'select': {
        const loc = page.locator(spec.selector).first();
        await loc.waitFor({ state: 'visible', timeout: timeoutMs });
        const hasOptions = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return !!(el && el.tagName === 'SELECT' && el.options && el.options.length > 1);
        }, spec.selector);
        return hasOptions ? ok : fail;
      }
      case 'selectAny': {
        for (const sel of (spec.selectors || [])) {
          try {
            const loc = page.locator(sel).first();
            await loc.waitFor({ state: 'visible', timeout: Math.min(2000, timeoutMs) });
            const hasOptions = await page.evaluate((s) => {
              const el = document.querySelector(s);
              return !!(el && el.tagName === 'SELECT' && el.options && el.options.length > 1);
            }, sel);
            if (hasOptions) return ok;
          } catch (e) { /* try next */ }
        }
        return fail;
      }
      case 'visibleAny': {
        for (const sel of (spec.selectors || [])) {
          try {
            const loc = page.locator(sel).first();
            await loc.waitFor({ state: 'visible', timeout: Math.min(2000, timeoutMs) });
            return ok;
          } catch (e) { /* try next */ }
        }
        return fail;
      }
      case 'text': {
        for (const t of (spec.anyOf || [])) {
          try {
            await page.locator(`text=${t}`).first().waitFor({ state: 'visible', timeout: Math.min(2000, timeoutMs) });
            return ok;
          } catch (e) { /* try next */ }
        }
        return fail;
      }
      case 'js': {
        const result = await page.evaluate(spec.check).catch(() => false);
        return result ? ok : fail;
      }
      default:
        return fail;
    }
  } catch (e) {
    return fail;
  }
}

module.exports = { PROFILES, waitForPageReady, _internal: { waitForDomStable, checkElement } };
