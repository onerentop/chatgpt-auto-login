#!/usr/bin/env node
/**
 * paypal_rpa.js — Isolated PayPal sub-flow RPA via headed Chromium.
 *
 * Spawned as a Node subprocess by server/paypal-rpa.js. Owns its own
 * Chromium instance with playwright-core, isolated profile dir per
 * invocation. Returns the chatgpt.com agreement approval URL once
 * PayPal completes its handoff back.
 *
 * stdin:  JSON  { paypal_url, phone, sms_api_url, proxy, worker_id, approval_url_pattern }
 * stdout: single JSON line  { status:'success'|'error', data?:{chatgpt_approval_url}, reason?, detail? }
 * stderr: human log lines (prefixed [PayPalRPA])
 *
 * Reference: Gpt-Agreement-Payment/CTF-pay/scripts/paypal_node_rpa.js (architecture)
 *            payment.js v2.14 baseline (current repo) for PayPal selector/timing logic.
 *
 * IMPORTANT v2.14 baseline notes:
 *  - The 12 PayPal checkout fields are filled SEQUENTIALLY (one await per field).
 *    Earlier v2.15 attempted Promise.all parallel fills; that broke PayPal's React
 *    form state and was reverted in v2.19.1. DO NOT re-introduce Promise.all here.
 *  - PayPal fraud detection penalizes headless mode; headless: false is mandatory.
 *  - Each invocation uses a fresh persistent context dir (no cookie carryover).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { chromium } = require('playwright-core');

// Detect primary screen size (Windows). Returns { width, height } or fallback.
function getPrimaryScreenSize() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; Write-Output ($b.Width.ToString()+\'x\'+$b.Height.ToString())"',
      { encoding: 'utf8', timeout: 3000, windowsHide: true }
    ).trim();
    const m = out.match(/(\d+)x(\d+)/);
    if (m) return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
  } catch {}
  return { width: 1920, height: 1080 };  // sane fallback
}

function log(msg) {
  console.error(`[PayPalRPA] ${msg}`);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

function randomDelay(minMs, maxMs) {
  const d = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((r) => setTimeout(r, d));
}

// ============================================================
// Helpers ported from payment.js v2.14 (self-contained)
// ============================================================

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
      log(`Address fetch: ${e.message?.slice(0, 60)}`);
      if (retry < 2) await new Promise((r) => setTimeout(r, 2000));
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
    log(`fillInput ${selector}: ${e.message?.slice(0, 60)}`);
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
      for (let i = 0; i < el.options.length; i++) {
        if (el.options[i].text.toLowerCase().includes(txt.toLowerCase()) ||
            el.options[i].value.toLowerCase().includes(txt.toLowerCase())) {
          el.value = el.options[i].value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
      }
    }, { sel: selector, txt: text });
    return true;
  } catch (e) {
    log(`selectOption ${selector}: ${e.message?.slice(0, 60)}`);
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
      } catch (e) { log(`Submit btn: ${e.message?.slice(0, 60)}`); }
    }
    const texts = ['訂閱', '订阅', '下一页', 'Next', 'Subscribe', 'Pay', 'Continue', 'Agree', '同意'];
    for (const t of texts) {
      try {
        const btn = page.locator(`button:has-text("${t}")`).first();
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          if (await btn.isEnabled()) { await btn.click(); return true; }
        }
      } catch (e) { log(`Submit text btn: ${e.message?.slice(0, 60)}`); }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// ============================================================
// PayPal page handlers (transcribed from payment.js v2.14 baseline)
// ============================================================

async function handlePayPalLogin(page) {
  log('PayPal login page detected');
  await randomDelay(2000, 3000);

  const email = randEmail();
  log(`Email: ${email}`);
  await fillInput(page, '#email', email);
  await randomDelay(800, 1200);
  await clickSubmit(page);
  log('PayPal login submitted');
}

async function handlePayPalCheckout(page, phone) {
  log('PayPal checkout page detected');
  await randomDelay(2000, 3000);

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
    }, { timeout: 8000 }).then((h) => h.jsonValue()).catch(() => null);
    if (!appeared) {
      log('WARNING: no country <select> found after 8s — aborting');
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
    const ok = await page.waitForFunction((sel) => {
      const c = document.querySelector(sel);
      return c && c.value === 'US';
    }, countrySel, { timeout: 10000 }).then(() => true).catch(() => false);
    if (ok) {
      log(`Country: ${initial} -> US (via ${countrySel})`);
    } else {
      const stuck = await page.evaluate((sel) => document.querySelector(sel)?.value, countrySel);
      log(`WARNING: country still "${stuck}" after switch attempt; aborting fill`);
      throw new Error(`Failed to switch country to US (stuck at "${stuck}")`);
    }
    // Give the dependent fields (state options, address schema) a beat to repaint.
    await randomDelay(1500, 2500);
  } else if (initial === 'US') {
    log('Country already US');
  }

  // Final guard: double-check country is US before filling. Catches any race where
  // PayPal's React re-rendered the select back to the geo-detected default.
  const finalCountry = await page.evaluate(() => {
    const sels = ['#country', '#countryCode', 'select[name="country"]', 'select[name="countryCode"]', 'select[id*="ountry"]'];
    for (const sel of sels) { const el = document.querySelector(sel); if (el?.tagName === 'SELECT') return el.value || 'UNKNOWN'; }
    return 'US';  // no select found = probably already removed by PayPal, assume US
  });
  if (finalCountry !== 'US') {
    log(`FINAL CHECK FAILED: country is "${finalCountry}" — aborting fill`);
    throw new Error(`Country reverted to "${finalCountry}" before fill`);
  }

  const addr = await fetchAddress();
  const email = randEmail();
  const password = randPass();
  log(`Email: ${email}`);
  log(`Address: ${JSON.stringify(addr)}`);

  // === Sequential 12-field fill (v2.14 baseline — DO NOT parallelize) ===
  const results = {};
  results.email = await fillInput(page, '#email', email);
  results.phone = await fillInput(page, '#phone', phone);
  const card = randCard();
  log(`Card: ${card.number.slice(0, 4)}****${card.number.slice(-4)}`);
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
  const filled = Object.entries(results).filter(([, v]) => v).map(([k]) => k);
  const missed = Object.entries(results).filter(([, v]) => !v).map(([k]) => k);
  log(`Filled: ${filled.join(', ') || 'none'}`);
  if (missed.length) log(`MISSED: ${missed.join(', ')}`);

  // Submit with card-decline retry (up to 3 different cards)
  for (let cardAttempt = 0; cardAttempt < 3; cardAttempt++) {
    if (cardAttempt > 0) {
      const newCard = randCard();
      log(`Retry card #${cardAttempt + 1}: ${newCard.number.slice(0, 4)}****${newCard.number.slice(-4)}`);
      await fillInput(page, '#cardNumber', newCard.number);
      await fillInput(page, '#cardExpiry', newCard.expiry);
      await fillInput(page, '#cardCvv', newCard.cvv);
      await randomDelay(500, 1000);
    }
    await randomDelay(500, 1000);
    const ppSubmitted = await clickSubmit(page);
    if (!ppSubmitted) log('Submit button not found/clickable');
    log('PayPal checkout submitted');

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
      return patterns.some((p) => text.includes(p));
    }).catch(() => false);

    if (!declined) {
      log('No card decline detected, proceeding');
      break;
    }
    log(`Card declined (attempt ${cardAttempt + 1}/3)`);
    if (cardAttempt === 2) {
      log('All 3 cards declined — throwing paypal_card_declined');
      throw new Error('paypal_card_declined');
    }
  }
}

async function handleSmsVerification(page, smsApiUrl) {
  if (!smsApiUrl) {
    log('No SMS API URL provided, skipping SMS check');
    return false;
  }

  await randomDelay(2000, 3000);

  // Check if SMS code dialog appeared ("Enter your code")
  const codeDialog = page.locator('text=Enter your code')
    .or(page.locator('text=输入验证码')
      .or(page.locator('text=输入你的验证码')));
  const dialogVisible = await codeDialog.isVisible({ timeout: 8000 }).catch(() => false);
  if (!dialogVisible) {
    log('No SMS verification dialog detected');
    return false;
  }

  log('SMS verification dialog detected, polling for code...');

  // Poll SMS API for the verification code (retry up to 30 times, every 3s = ~90s)
  let smsCode = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const res = await fetch(smsApiUrl, { signal: AbortSignal.timeout(10000) });
      const text = await res.text();
      log(`SMS API attempt ${attempt + 1}: ${text.slice(0, 100)}`);

      // Extract 6-digit code from response
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
      const match = dataStr.match(/\b(\d{6})\b/);
      if (match) {
        smsCode = match[1];
        log(`Got SMS code: ${smsCode}`);
        break;
      }
    } catch (e) {
      log(`SMS API error: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  if (!smsCode) {
    log('Failed to get SMS code after 30 attempts');
    throw new Error('sms_fetch_fail');
  }

  // Fill in the 6-digit code (individual input boxes preferred, fallback to keyboard)
  const codeInputs = page.locator('input[type="tel"], input[type="text"], input[type="number"]')
    .filter({ has: page.locator('xpath=ancestor::*[contains(@class,"code") or contains(@class,"otp") or contains(@class,"pin")]') });
  const codeCount = await codeInputs.count().catch(() => 0);

  if (codeCount >= 6) {
    for (let i = 0; i < 6; i++) {
      await codeInputs.nth(i).fill(smsCode[i]);
      await randomDelay(100, 200);
    }
    log('SMS code filled (individual boxes)');
  } else {
    await page.keyboard.type(smsCode, { delay: 100 });
    log('SMS code typed');
  }

  await randomDelay(2000, 3000);
  // Code might auto-submit, or we need to click a button
  await clickSubmit(page);
  log('SMS verification submitted');
  return true;
}

// ============================================================
// Main PayPal flow
// ============================================================

async function runPayPalFlow(page, opts) {
  log(`Phase 0: navigate to PayPal URL (${opts.paypal_url.slice(0, 80)})`);
  await page.goto(opts.paypal_url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // === Phase 1: PayPal page state machine ===
  // After landing, PayPal can show either:
  //   - login form (paypal.com/pay)              -> handlePayPalLogin
  //   - guest checkout (paypal.com/checkoutweb)  -> handlePayPalCheckout (the 12-field form)
  // Loop a few rounds because PayPal does several internal redirects.
  log('Phase 1: PayPal page state loop');
  let checkoutHandled = false;
  for (let round = 0; round < 15; round++) {
    await randomDelay(2000, 3000);
    let currentUrl;
    try { currentUrl = page.url(); } catch (e) {
      log(`Page closed/crashed: ${e.message?.slice(0, 40)}`);
      throw new Error('paypal_page_closed');
    }

    if (currentUrl.includes('paypal.com/pay')) {
      await handlePayPalLogin(page);
    } else if (currentUrl.includes('paypal.com') && (currentUrl.includes('checkoutweb') || currentUrl.includes('signup'))) {
      await handlePayPalCheckout(page, opts.phone);
      checkoutHandled = true;
      break;
    } else {
      // Mid-redirect or unknown — keep waiting
      if (round % 3 === 2) log(`Page: ${currentUrl.slice(0, 60)}...`);
    }
  }
  if (!checkoutHandled) {
    log('PayPal checkout page never reached');
    throw new Error('paypal_checkout_not_reached');
  }

  // === Phase 2: SMS verification (if PayPal shows it) ===
  log('Phase 2: SMS verification');
  await handleSmsVerification(page, opts.sms_api_url);

  // === Phase 3: Wait for redirect back to chatgpt.com (or pay.openai.com success) ===
  const approvalPattern = opts.approval_url_pattern || 'chatgpt\\.com';
  log(`Phase 3: waiting for ${approvalPattern}`);
  const approvalUrlRe = new RegExp(approvalPattern);

  // Use a wait loop rather than waitForURL alone — PayPal often goes through
  // pay.openai.com with redirect_status=succeeded as an intermediate step.
  // Also fail-fast on PayPal genericError (risk control rejection) — saves
  // ~2 min vs waiting for the full 120s approval_timeout.
  let approvalUrl = null;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    let currentUrl;
    try { currentUrl = page.url(); } catch { break; }
    if (approvalUrlRe.test(currentUrl)) {
      approvalUrl = currentUrl;
      log(`Got approval URL: ${approvalUrl.slice(0, 100)}`);
      break;
    }
    if (/paypal\.com\/checkoutweb\/genericError/i.test(currentUrl)) {
      log(`PayPal risk-control rejected the transaction (genericError): ${currentUrl.slice(0, 100)}`);
      throw new Error('paypal_generic_error');
    }
    if (currentUrl.includes('pay.openai.com') && currentUrl.includes('redirect_status=succeeded')) {
      log(`Saw pay.openai.com redirect_status=succeeded, continuing to chatgpt.com...`);
      // give a few more seconds for the chatgpt.com hop
    }
  }
  if (!approvalUrl) {
    throw new Error('approval_timeout');
  }
  return approvalUrl;
}

// ============================================================
// Entry point
// ============================================================

(async () => {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', reason: 'paypal_bad_input', detail: e.message }));
    process.exit(0);
  }

  // Minimal input shape validation
  if (!input || typeof input !== 'object' || typeof input.paypal_url !== 'string' || !input.paypal_url) {
    console.log(JSON.stringify({ status: 'error', reason: 'paypal_bad_input', detail: 'missing paypal_url' }));
    process.exit(0);
  }

  // Window: quarter of primary screen, top-left corner.
  const screen = getPrimaryScreenSize();
  const winW = Math.floor(screen.width / 2);
  const winH = Math.floor(screen.height / 2);
  log(`screen=${screen.width}x${screen.height}, window=${winW}x${winH}@0,0`);

  let browser;
  let context;
  try {
    // True incognito: chromium.launch() + newContext() — memory-only, no disk profile.
    // Matches server/chrome.js convention of passing --incognito to PipelineEngine's Chrome.
    browser = await chromium.launch({
      headless: false,  // critical: PayPal fraud detection penalizes headless
      proxy: input.proxy ? { server: input.proxy } : undefined,
      args: [
        '--incognito',
        '--disable-blink-features=AutomationControlled',
        `--window-size=${winW},${winH}`,
        '--window-position=0,0',
      ],
    });
    context = await browser.newContext({
      viewport: { width: winW, height: winH - 80 },  // leave room for browser chrome
    });
    const page = await context.newPage();

    // Inject CSS to hide CAPTCHA / autocomplete overlays
    await page.addStyleTag({
      content: '#captcha-standalone,.captcha-overlay,.captcha-container,.AddressAutocomplete-results,.pac-container{display:none!important;height:0!important;overflow:hidden!important;pointer-events:none!important}',
    }).catch(() => {});

    const approvalUrl = await runPayPalFlow(page, input);
    console.log(JSON.stringify({ status: 'success', data: { chatgpt_approval_url: approvalUrl } }));
  } catch (e) {
    let reason = 'paypal_rpa_error';
    const msg = e.message || '';
    if (/sms_fetch_fail/.test(msg)) reason = 'sms_fetch_fail';
    else if (/sms verification/i.test(msg)) reason = 'sms_verification_fail';
    else if (/paypal_generic_error/.test(msg)) reason = 'paypal_generic_error';
    else if (/approval_timeout/.test(msg) || /Timeout.*waiting for navigation/i.test(msg) || /Timeout.*waitForURL/i.test(msg)) reason = 'approval_timeout';
    else if (/paypal_card_declined/.test(msg)) reason = 'paypal_card_declined';
    else if (/paypal_checkout_not_reached/.test(msg)) reason = 'paypal_checkout_not_reached';
    else if (/country/i.test(msg)) reason = 'paypal_country_fail';
    else if (/paypal_page_closed/.test(msg)) reason = 'paypal_page_closed';
    log(`ERROR: reason=${reason} detail=${msg.slice(0, 200)}`);
    console.log(JSON.stringify({ status: 'error', reason, detail: msg.slice(0, 200) }));
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
})();
