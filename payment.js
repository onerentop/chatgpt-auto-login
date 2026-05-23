const fs = require('fs');
const path = require('path');
const { randomDelay } = require('./utils');
const { waitForPageReady, PROFILES } = require('./payment-readiness');

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log(`config.json not found, creating template at ${CONFIG_PATH}`);
    const tpl = { threads: 1, phoneSlots: [{ phone: '1234567890', smsApiUrl: '' }] };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(tpl, null, 2));
    return tpl;
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  // Backward compat: old single phone → phoneSlots array
  if (!cfg.phoneSlots && cfg.phone) {
    cfg.phoneSlots = [{ phone: cfg.phone, smsApiUrl: cfg.smsApiUrl || '' }];
  }
  if (!cfg.threads) cfg.threads = 1;
  // Default phone/smsApiUrl from first slot (for backward compat)
  if (cfg.phoneSlots?.length > 0) {
    cfg.phone = cfg.phone || cfg.phoneSlots[0].phone;
    cfg.smsApiUrl = cfg.smsApiUrl || cfg.phoneSlots[0].smsApiUrl;
  }
  return cfg;
}

const CONFIG = loadConfig();

function randCard() {
  const prefixes = ['4', '4', '4', '51', '52', '53', '54', '55'];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  let number = prefix;
  while (number.length < 15) number += Math.floor(Math.random() * 10);
  let sum = 0;
  for (let i = 0; i < number.length; i++) {
    let d = parseInt(number[number.length - 1 - i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  number += (10 - (sum % 10)) % 10;
  const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
  const year = String(new Date().getFullYear() + 2 + Math.floor(Math.random() * 4)).slice(-2);
  const cvv = String(Math.floor(Math.random() * 900) + 100);
  return { number, expiry: `${month} / ${year}`, cvv };
}

function randEmail() {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let e = '';
  for (let i = 0; i < 16; i++) e += c[Math.floor(Math.random() * c.length)];
  return e + '@gmail.com';
}

function randPass() {
  const L = 'abcdefghijklmnopqrstuvwxyz', U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const D = '0123456789', S = '!@#$%^', A = L + U + D + S;
  let p = L[Math.floor(Math.random() * 26)] + U[Math.floor(Math.random() * 26)] + D[Math.floor(Math.random() * 10)] + S[Math.floor(Math.random() * 6)];
  for (let i = 4; i < 14; i++) p += A[Math.floor(Math.random() * A.length)];
  return p.split('').sort(() => Math.random() - 0.5).join('');
}

async function fetchAddress() {
  // Retry up to 3 times (multi-thread may hit rate limit)
  for (let retry = 0; retry < 3; retry++) {
    try {
      const res = await fetch('https://www.meiguodizhi.com/api/v1/dz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/', method: 'address' }),
      });
      const d = await res.json();
      const a = d.address || d;
      return {
        street: a.Address || a.street || '123 Main St',
        city: a.City || a.city || 'New York',
        state: a.State_Full || a.State || a.state || 'New York',
        zip: (a.Zip_Code || a.zip || '10001').substring(0, 5),
      };
    } catch (e) {
      console.log(`    [Pay] Address fetch: ${e.message?.slice(0, 60)}`);
      if (retry < 2) await new Promise(r => setTimeout(r, 2000));
    }
  }
  return { street: '123 Main St', city: 'New York', state: 'New York', zip: '10001' };
}

async function fillInput(page, selector, value) {
  try {
    const el = page.locator(selector).first();
    const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
    if (!visible) return false;
    await el.click();
    await el.fill(value);
    await el.dispatchEvent('change');
    await el.dispatchEvent('blur');
    return true;
  } catch (e) {
    console.log(`    [Pay] fillInput ${selector}: ${e.message?.slice(0, 60)}`);
    return false;
  }
}

async function selectOption(page, selector, text) {
  try {
    const el = page.locator(selector).first();
    const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
    if (!visible) return false;
    await page.evaluate(({ sel, txt }) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const q = txt.toLowerCase();
      let chosen = -1;
      for (let i = 0; i < el.options.length; i++) {
        if (el.options[i].text.toLowerCase() === q || el.options[i].value.toLowerCase() === q) {
          chosen = i; break;
        }
      }
      if (chosen === -1) {
        for (let i = 0; i < el.options.length; i++) {
          if (el.options[i].text.toLowerCase().includes(q) || el.options[i].value.toLowerCase().includes(q)) {
            chosen = i; break;
          }
        }
      }
      if (chosen === -1) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(el, el.options[chosen].value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, { sel: selector, txt: text });
    return true;
  } catch (e) {
    console.log(`    [Pay] selectOption ${selector}: ${e.message?.slice(0, 60)}`);
    return false;
  }
}

async function clickSubmit(page) {
  for (let retry = 0; retry < 10; retry++) {
    const selectors = [
      'button[data-testid="submit-button"]',
      'button[data-testid="hosted-payment-submit-button"]',
      'button[data-atomic-wait-intent="Submit_Email"]',
      'button.SubmitButton--complete',
    ];
    for (const sel of selectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
          if (await btn.isEnabled()) { await btn.click(); return true; }
        }
      } catch (e) { console.log(`    [Pay] Submit btn: ${e.message?.slice(0, 60)}`); }
    }
    const texts = ['訂閱', '订阅', '下一页', 'Next', 'Subscribe', 'Pay', 'Continue', 'Agree', '同意'];
    for (const t of texts) {
      try {
        const btn = page.locator(`button:has-text("${t}")`).first();
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          if (await btn.isEnabled()) { await btn.click(); return true; }
        }
      } catch (e) { console.log(`    [Pay] Submit text btn: ${e.message?.slice(0, 60)}`); }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// ========== Page Handlers ==========

async function handleOpenAIPage(page) {
  console.log('    [Pay] OpenAI/Stripe page detected');

  const r0 = await waitForPageReady(page, PROFILES.openai, { log: (m) => console.log('    ' + m) });
  if (!r0.ready) {
    console.log(`    [Pay] 警告：openai-stripe 页 60s 未就绪 missing=[${r0.missing.join(',')}]，仍尝试继续`);
  }

  // Step 0a: Detect if this is actually a $0 trial. Some Discord links lead to a
  // regular paid subscription page; we don't want to start filling cards on those.
  // Strategy: (1) look for a localized "Total due today" label and parse the amount
  // after it; (2) fallback — if no label matched but there ARE USD amounts on the
  // page AND none of them is $0, then there's no "free" anywhere → treat as paid.
  const scan = await page.evaluate(() => {
    const raw = document.body.innerText || '';
    // Normalize: NBSP → space, collapse whitespace
    const text = raw.replace(/ /g, ' ').replace(/[ \t]+/g, ' ');
    const labels = [
      '今天應付總額', '今日應付總額', '今天应付总额', '今日应付总额',
      '應付總額', '应付总额', '今日付款',
      'Total due today', "Today's total", 'Due today', 'Total due',
    ];
    let labelHit = null;
    for (const label of labels) {
      const idx = text.toLowerCase().indexOf(label.toLowerCase());
      if (idx === -1) continue;
      const after = text.slice(idx, idx + 200);
      const m = after.match(/(?:US\s*)?\$\s*([0-9]+(?:[.,][0-9]{2})?)/);
      if (m) { labelHit = { label, amount: parseFloat(m[1].replace(',', '.')) }; break; }
    }
    // Collect ALL USD amounts on the page (for fallback)
    const amountRe = /(?:US\s*)?\$\s*([0-9]+(?:[.,][0-9]{2})?)/g;
    const amounts = [];
    let m2;
    while ((m2 = amountRe.exec(text))) amounts.push(parseFloat(m2[1].replace(',', '.')));
    const hasZero = amounts.some(a => a === 0);
    return { labelHit, amounts, hasZero, textHead: text.slice(0, 300) };
  });
  if (scan.labelHit && scan.labelHit.amount > 0) {
    const e = new Error(`Not a free trial: "${scan.labelHit.label}" = $${scan.labelHit.amount}`);
    e.code = 'NOT_FREE_TRIAL';
    throw e;
  }
  if (scan.labelHit) {
    console.log(`    [Pay] Free trial confirmed (${scan.labelHit.label}: $${scan.labelHit.amount.toFixed(2)})`);
  } else if (scan.amounts.length > 0 && !scan.hasZero) {
    // No label matched, but every USD amount on the page is > 0 → no "$0 due today" anywhere.
    // A genuine free-trial page always renders a $0.00 line (either tax or total due today),
    // so this combination strongly indicates a paid subscription.
    const e = new Error(`Not a free trial (no $0 found; amounts: ${scan.amounts.join(', ')})`);
    e.code = 'NOT_FREE_TRIAL';
    throw e;
  } else {
    // Detector inconclusive — log what we saw so we can extend the label list / patterns next run.
    console.log(`    [Pay] Due-today label not matched. amounts=${JSON.stringify(scan.amounts.slice(0, 8))} hasZero=${scan.hasZero} head="${scan.textHead.slice(0, 120).replace(/\n/g, ' / ')}"`);
  }

  // Step 0b: Inject CSS to hide Google autocomplete (before any interaction)
  await page.addStyleTag({ content: '.AddressAutocomplete-results,.pac-container{display:none!important;height:0!important;overflow:hidden!important;pointer-events:none!important}' }).catch(() => {});

  // Step 1: Select PayPal via JS .click() on data-testid (proven to expand accordion)
  console.log('    [Pay] Selecting PayPal...');
  let ppClicked = await page.evaluate(() => {
    var sels = [
      '[data-testid="paypal-accordion-item-button"]',
      '#payment-method-accordion-item-title-paypal',
      '[id*="paypal"]',
      '[data-testid*="paypal"]',
    ];
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (el) { el.click(); return sels[i]; }
    }
    return null;
  }).catch(() => null);
  console.log('    [Pay] PayPal clicked:', ppClicked || 'FAILED');
  // Wait for accordion to expand (no double click — it would collapse it)

  // Verify billing form appears + key fields ready (state options loaded, terms checkbox attached)
  const r1 = await waitForPageReady(page, PROFILES.paypalAccordionExpanded, { log: (m) => console.log('    ' + m) });
  const formFound = r1.ready;
  if (!r1.ready) {
    console.log(`    [Pay] 警告：accordion 展开未就绪 missing=[${r1.missing.join(',')}]`);
  }
  if (!formFound) {
    console.log('    [Pay] Billing form not visible, reloading to retry...');
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    const r1a = await waitForPageReady(page, PROFILES.openai, { log: (m) => console.log('    ' + m) });
    if (!r1a.ready) console.log(`    [Pay] 警告：reload 后 openai 未就绪 missing=[${r1a.missing.join(',')}]`);
    ppClicked = await page.evaluate(() => { var el = document.querySelector('[data-testid="paypal-accordion-item-button"]') || document.querySelector('#payment-method-accordion-item-title-paypal'); if (el) { el.click(); return true; } return false; }).catch(() => false);
    console.log('    [Pay] PayPal retry:', ppClicked);
    const r1b = await waitForPageReady(page, PROFILES.paypalAccordionExpanded, { log: (m) => console.log('    ' + m) });
    if (!r1b.ready) console.log(`    [Pay] 警告：retry 后 accordion 未就绪 missing=[${r1b.missing.join(',')}]`);
  }

  const addr = await fetchAddress();
  console.log('    [Pay] Address:', JSON.stringify(addr));

  // Step 2: Fill address fields (after PayPal form has loaded)
  const fillResult = await page.evaluate((addr) => {
    var log = [];

    function fill(id, val) {
      var el = document.getElementById(id);
      if (!el) return false;
      var ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      ns.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      log.push(id + '=' + el.value);
      return true;
    }

    function fillSel(sel, val) {
      var el = document.querySelector(sel);
      if (!el) return false;
      // Focus first to trigger any lazy-load
      el.focus();
      var ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      ns.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      log.push(sel + '=' + el.value);
      return true;
    }

    function fillSelect(id, text) {
      // Exact-match-first avoids "Kansas" matching "Arkansas" via substring.
      // Native setter + input/change is required for React-managed Stripe form
      // to register the selection (plain el.value = ... is invisible to React).
      var q = text.toLowerCase();
      var el = document.getElementById(id);
      if (!el) {
        var selects = document.querySelectorAll('select');
        var fallback = null;
        for (var s = 0; s < selects.length && !el; s++) {
          for (var i = 0; i < selects[s].options.length; i++) {
            var t = selects[s].options[i].text.toLowerCase();
            if (t === q) { el = selects[s]; break; }
            if (!fallback && t.includes(q)) fallback = selects[s];
          }
        }
        if (!el) el = fallback;
      }
      if (!el) return false;
      var chosen = -1;
      for (var i = 0; i < el.options.length; i++) {
        if (el.options[i].text.toLowerCase() === q || el.options[i].value.toLowerCase() === q) {
          chosen = i; break;
        }
      }
      if (chosen === -1) {
        for (var i = 0; i < el.options.length; i++) {
          if (el.options[i].text.toLowerCase().includes(q) || el.options[i].value.toLowerCase().includes(q)) {
            chosen = i; break;
          }
        }
      }
      if (chosen === -1) return false;
      var setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(el, el.options[chosen].value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      log.push('select=' + el.options[chosen].text);
      return true;
    }

    // Fill address - try all known selectors
    fillSel('#billingAddressLine1', addr.street) || fillSel('input[name*="addressLine1"]', addr.street);
    fillSel('#billingLocality', addr.city) || fillSel('input[name*="locality"]', addr.city);
    fillSel('#billingPostalCode', addr.zip) || fillSel('input[name*="postalCode"]', addr.zip);
    fillSelect('billingAdministrativeArea', addr.state);

    // Check terms checkbox
    var cb = document.getElementById('termsOfServiceConsentCheckbox');
    if (!cb) {
      var cbs = document.querySelectorAll('input[type="checkbox"]');
      if (cbs.length > 0) cb = cbs[0];
    }
    if (cb && !cb.checked) {
      cb.click();
      log.push('checkbox=clicked');
    }

    // List all visible inputs for debug
    var inputs = document.querySelectorAll('input:not([type="hidden"]), select');
    var debug = [];
    for (var j = 0; j < inputs.length; j++) {
      debug.push((inputs[j].id || inputs[j].name || inputs[j].type) + ':' + (inputs[j].value || '').substring(0, 20));
    }
    log.push('fields=[' + debug.join(', ') + ']');

    return { log: log };
  }, addr);

  console.log('    [Pay] Inject step 2:', fillResult.log.join(', '));

  // Step 3: Wait a bit then click submit
  await randomDelay(1500, 2000);
  const submitted = await clickSubmit(page);
  if (!submitted) console.log('    [Pay] Submit button not found/clickable');
  console.log('    [Pay] OpenAI page submitted');
}

async function handlePayPalLogin(page) {
  console.log('    [Pay] PayPal login page detected');
  const r = await waitForPageReady(page, PROFILES.paypalLogin, { log: (m) => console.log('    ' + m) });
  if (!r.ready) {
    console.log(`    [Pay] 警告：paypal-login 60s 未就绪 missing=[${r.missing.join(',')}]，仍尝试继续`);
  }

  const email = randEmail();
  console.log('    [Pay] Email:', email);
  await fillInput(page, '#email', email);
  await randomDelay(800, 1200);
  await clickSubmit(page);
  console.log('    [Pay] PayPal login submitted');
}

async function handlePayPalCheckout(page, phoneOverride, smsOverride) {
  console.log('    [Pay] PayPal checkout page detected');
  const r = await waitForPageReady(page, PROFILES.paypalCheckout, { log: (m) => console.log('    ' + m) });
  if (!r.ready) {
    console.log(`    [Pay] 警告：paypal-checkout 60s 未就绪 missing=[${r.missing.join(',')}]，仍尝试继续`);
  }

  // Set country to US. PayPal uses different element IDs across A/B tests and
  // locale variants (#country, #countryCode, select[name="country"], etc.). We
  // try multiple selectors and wait for at least one to appear before switching.
  // If none is found or the switch doesn't stick, we abort rather than fill a
  // Chinese-schema form with US address data.
  const countryInfo = await page.evaluate(() => {
    const sels = ['#country', '#countryCode', 'select[name="country"]', 'select[name="countryCode"]', 'select[id*="ountry"]'];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el && el.tagName === 'SELECT') return { sel, value: el.value };
    }
    return null;
  });
  if (!countryInfo) {
    // Element not in DOM yet — wait up to 8s for any country <select> to appear.
    const appeared = await page.waitForFunction(() => {
      const sels = ['#country', '#countryCode', 'select[name="country"]', 'select[name="countryCode"]', 'select[id*="ountry"]'];
      for (const sel of sels) { const el = document.querySelector(sel); if (el?.tagName === 'SELECT') return sel; }
      return null;
    }, { timeout: 8000 }).then(h => h.jsonValue()).catch(() => null);
    if (!appeared) {
      console.log('    [Pay] WARNING: no country <select> found after 8s — aborting');
      throw new Error('PayPal country selector not found');
    }
  }
  // Re-read with the confirmed selector
  const { sel: countrySel, initial } = await page.evaluate(() => {
    const sels = ['#country', '#countryCode', 'select[name="country"]', 'select[name="countryCode"]', 'select[id*="ountry"]'];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el?.tagName === 'SELECT') return { sel, initial: el.value };
    }
    return { sel: null, initial: null };
  });
  if (initial !== null && initial !== 'US') {
    await page.evaluate((sel) => {
      const c = document.querySelector(sel);
      if (!c) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(c, 'US');
      c.dispatchEvent(new Event('input', { bubbles: true }));
      c.dispatchEvent(new Event('change', { bubbles: true }));
    }, countrySel);
    // Wait until React commits the new value (poll up to ~10s).
    // Playwright API: waitForFunction(fn, arg, options) — NOT (fn, options, arg)
    const ok = await page.waitForFunction((sel) => {
      const c = document.querySelector(sel);
      return c && c.value === 'US';
    }, countrySel, { timeout: 10000 }).then(() => true).catch(() => false);
    if (ok) {
      console.log(`    [Pay] Country: ${initial} → US (via ${countrySel})`);
    } else {
      const stuck = await page.evaluate((sel) => document.querySelector(sel)?.value, countrySel);
      console.log(`    [Pay] WARNING: country still "${stuck}" after switch attempt; aborting fill`);
      throw new Error(`Failed to switch country to US (stuck at "${stuck}")`);
    }
    // Wait for billing schema to repaint (state options, addressLine1, zip) after country switch.
    const rAfter = await waitForPageReady(page, PROFILES.paypalCheckoutAfterCountry, { log: (m) => console.log('    ' + m) });
    if (!rAfter.ready) {
      console.log(`    [Pay] 警告：切换国家后 billing schema 未就绪 missing=[${rAfter.missing.join(',')}]，仍尝试继续`);
    }
  } else if (initial === 'US') {
    console.log('    [Pay] Country already US');
    // Even when no switch happened, the billing form may not have rendered yet.
    const rAfter = await waitForPageReady(page, PROFILES.paypalCheckoutAfterCountry, { log: (m) => console.log('    ' + m) });
    if (!rAfter.ready) {
      console.log(`    [Pay] 警告：billing schema 未就绪 missing=[${rAfter.missing.join(',')}]，仍尝试继续`);
    }
  }

  // Final guard: double-check country is US before filling. Catches any race where
  // PayPal's React re-rendered the select back to the geo-detected default.
  const finalCountry = await page.evaluate(() => {
    const sels = ['#country', '#countryCode', 'select[name="country"]', 'select[name="countryCode"]', 'select[id*="ountry"]'];
    for (const sel of sels) { const el = document.querySelector(sel); if (el?.tagName === 'SELECT') return el.value || 'UNKNOWN'; }
    return 'US';  // no select found = probably already removed by PayPal, assume US
  });
  if (finalCountry !== 'US') {
    console.log(`    [Pay] FINAL CHECK FAILED: country is "${finalCountry}" — aborting fill`);
    throw new Error(`Country reverted to "${finalCountry}" before fill`);
  }

  const addr = await fetchAddress();
  const email = randEmail();
  const password = randPass();
  console.log('    [Pay] Email:', email);
  console.log('    [Pay] Address:', JSON.stringify(addr));

  const results = {};
  results.email = await fillInput(page, '#email', email);
  results.phone = await fillInput(page, '#phone', phoneOverride || CONFIG.phone);
  const card = randCard();
  console.log('    [Pay] Card:', card.number.slice(0, 4) + '****' + card.number.slice(-4));
  results.cardNumber = await fillInput(page, '#cardNumber', card.number);
  results.cardExpiry = await fillInput(page, '#cardExpiry', card.expiry);
  results.cardCvv = await fillInput(page, '#cardCvv', card.cvv);
  results.password = await fillInput(page, '#password', password);
  results.firstName = await fillInput(page, '#firstName', 'James');
  results.lastName = await fillInput(page, '#lastName', 'Smith');
  results.billingLine1 = await fillInput(page, '#billingLine1', addr.street);
  results.billingCity = await fillInput(page, '#billingCity', addr.city);
  results.billingZip = await fillInput(page, '#billingPostalCode', addr.zip);
  results.billingState = await selectOption(page, '#billingState', addr.state);
  const filled = Object.entries(results).filter(([,v]) => v).map(([k]) => k);
  const missed = Object.entries(results).filter(([,v]) => !v).map(([k]) => k);
  console.log(`    [Pay] Filled: ${filled.join(', ') || 'none'}`);
  if (missed.length) console.log(`    [Pay] MISSED: ${missed.join(', ')}`);

  // Submit with card-decline retry (up to 3 different cards)
  for (let cardAttempt = 0; cardAttempt < 3; cardAttempt++) {
    if (cardAttempt > 0) {
      const newCard = randCard();
      console.log(`    [Pay] Retry card #${cardAttempt + 1}: ${newCard.number.slice(0, 4)}****${newCard.number.slice(-4)}`);
      await fillInput(page, '#cardNumber', newCard.number);
      await fillInput(page, '#cardExpiry', newCard.expiry);
      await fillInput(page, '#cardCvv', newCard.cvv);
      await randomDelay(500, 1000);
    }
    await randomDelay(500, 1000);
    const ppSubmitted = await clickSubmit(page);
    if (!ppSubmitted) console.log('    [Pay] Submit button not found/clickable');
    console.log('    [Pay] PayPal checkout submitted');

    // Wait for error banner or page transition
    await randomDelay(3000, 5000);
    const declined = await page.evaluate(() => {
      const text = (document.body.innerText || '').toLowerCase();
      const patterns = [
        "weren't able to add this card",
        'unable to add this card',
        'card was declined',
        'card has been declined',
        'try a different card',
        'could not process',
        'transaction cannot be completed',
      ];
      return patterns.some(p => text.includes(p));
    }).catch(() => false);

    if (!declined) {
      console.log('    [Pay] No card decline detected, proceeding');
      break;
    }
    console.log(`    [Pay] Card declined (attempt ${cardAttempt + 1}/3)`);
    if (cardAttempt === 2) console.log('    [Pay] All 3 cards declined, continuing anyway');
  }

  // Handle SMS verification code dialog
  await handleSmsVerification(page, smsOverride);
}

async function handleSmsVerification(page, smsOverride) {
  const SMS_URL = smsOverride || CONFIG.smsApiUrl;
  if (!SMS_URL) return;

  // SMS dialog is optional — readiness returning ready:false means no dialog
  // surfaced within the timeout; treat same as "no dialog detected".
  const rSms = await waitForPageReady(page, PROFILES.smsDialog,
    { totalTimeoutMs: 15000, log: (m) => console.log('    ' + m) });
  if (!rSms.ready) {
    console.log('    [Pay] No SMS verification dialog detected');
    return false;
  }

  console.log('    [Pay] SMS verification dialog detected, polling for code...');

  // Poll SMS API for the verification code (retry up to 30 times, every 3s = ~90s)
  let smsCode = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const res = await fetch(SMS_URL, { signal: AbortSignal.timeout(10000) });
      const text = await res.text();
      console.log(`    [Pay] SMS API attempt ${attempt + 1}: ${text.slice(0, 100)}`);

      // Extract 6-digit code from response
      let data;
      try { data = JSON.parse(text); } catch (e) { data = text; }
      const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
      const match = dataStr.match(/\b(\d{6})\b/);
      if (match) {
        smsCode = match[1];
        console.log(`    [Pay] Got SMS code: ${smsCode}`);
        break;
      }
    } catch (e) {
      console.log(`    [Pay] SMS API error: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  if (!smsCode) {
    console.log('    [Pay] Failed to get SMS code after 30 attempts');
    return;
  }

  // Fill in the 6-digit code (individual input boxes)
  const codeInputs = page.locator('input[type="tel"], input[type="text"], input[type="number"]').filter({ has: page.locator('xpath=ancestor::*[contains(@class,"code") or contains(@class,"otp") or contains(@class,"pin")]') });
  const codeCount = await codeInputs.count().catch(() => 0);

  if (codeCount >= 6) {
    // Individual digit boxes
    for (let i = 0; i < 6; i++) {
      await codeInputs.nth(i).fill(smsCode[i]);
      await randomDelay(100, 200);
    }
    console.log('    [Pay] SMS code filled (individual boxes)');
  } else {
    // Try typing the code directly (focused input)
    await page.keyboard.type(smsCode, { delay: 100 });
    console.log('    [Pay] SMS code typed');
  }

  await randomDelay(2000, 3000);
  // Code might auto-submit, or we need to click a button
  await clickSubmit(page);
  console.log('    [Pay] SMS verification submitted');
  return true;
}

// ========== Main Auto-Pay ==========

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

async function autoPayment(page, phoneConfig) {
  // phoneConfig: { phone, smsApiUrl } — thread-local override
  const PHONE = phoneConfig?.phone || CONFIG.phone;
  const SMS_API = phoneConfig?.smsApiUrl || CONFIG.smsApiUrl;
  console.log('    [Pay] Starting auto-payment flow...');

  // Inject CSS to hide CAPTCHA
  await page.addStyleTag({ content: '#captcha-standalone,.captcha-overlay,.captcha-container,.AddressAutocomplete-results{display:none!important;height:0!important;overflow:hidden!important}' }).catch(() => {});

  // Handle current page
  const url = page.url();
  if (url.includes('pay.openai.com') || url.includes('checkout.stripe.com')) {
    await handleOpenAIPage(page);
  }

  // Wait and handle PayPal pages as they come
  // After OpenAI submit, PayPal redirect can take 5-15 seconds
  let paypalHandled = false;
  let captchaFirstSeenAt = 0;
  let captchaHandled = false;
  for (let round = 0; round < 15; round++) {
    await randomDelay(2000, 3000);
    let currentUrl;
    try { currentUrl = page.url(); } catch (e) { console.log(`    [Pay] Page closed/crashed: ${e.message?.slice(0, 40)}`); break; }

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
  }
  if (!paypalHandled) {
    console.log('    [Pay] PayPal flow not detected, continuing...');
    console.log('    [Pay] Auto-payment flow completed');
    return { success: false, reason: 'PayPal not reached' };
  }

  // Wait for PayPal to finish processing and redirect back to pay.openai.com.
  // Also fail-fast on paypal.com/checkoutweb/genericError (risk-control rejection)
  // — saves ~30s vs waiting for the full 30s loop.
  console.log('    [Pay] Waiting for payment redirect...');
  let paymentSuccess = false;
  let genericError = false;
  for (let w = 0; w < 15; w++) {
    await new Promise(r => setTimeout(r, 2000));
    let currentUrl;
    try { currentUrl = page.url(); } catch { break; }
    if (currentUrl.includes('pay.openai.com') && currentUrl.includes('redirect_status=succeeded')) {
      console.log('    [Pay] Payment succeeded! (redirect_status=succeeded)');
      paymentSuccess = true;
      break;
    }
    if (currentUrl.includes('chatgpt.com')) {
      console.log('    [Pay] Redirected to chatgpt.com — payment likely succeeded');
      paymentSuccess = true;
      break;
    }
    if (/paypal\.com\/checkoutweb\/genericError/i.test(currentUrl)) {
      console.log(`    [Pay] PayPal risk-control rejected (genericError): ${currentUrl.slice(0, 80)}`);
      genericError = true;
      break;
    }
    if (w % 3 === 2) console.log(`    [Pay] Waiting... (${currentUrl.slice(0, 50)})`);
  }

  console.log('    [Pay] Auto-payment flow completed');
  return {
    success: paymentSuccess,
    reason: paymentSuccess ? '' : (genericError ? 'PayPal risk-control (genericError)' : 'Payment redirect not detected'),
  };
}

module.exports = { autoPayment, CONFIG };
