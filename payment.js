const fs = require('fs');
const path = require('path');
const { randomDelay } = require('./utils');

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log(`config.json not found, creating template at ${CONFIG_PATH}`);
    const tpl = { threads: 1, phoneSlots: [{ phone: '1234567890', smsApiUrl: '' }], cardNumber: '1234561234568888', cardExpiry: '03 / 30', cardCvv: '996' };
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
  } catch {
    return { street: '123 Main St', city: 'New York', state: 'New York', zip: '10001' };
  }
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
  } catch {
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
  } catch {
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
      } catch {}
    }
    const texts = ['下一页', 'Next', 'Subscribe', 'Pay', 'Continue', 'Agree', '订阅', '同意'];
    for (const t of texts) {
      try {
        const btn = page.locator(`button:has-text("${t}")`).first();
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          if (await btn.isEnabled()) { await btn.click(); return true; }
        }
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// ========== Page Handlers ==========

async function handleOpenAIPage(page) {
  console.log('    [Pay] OpenAI/Stripe page detected');
  await randomDelay(2000, 3000);

  // Step 0: Inject CSS to hide Google autocomplete (before any interaction)
  await page.addStyleTag({ content: '.AddressAutocomplete-results,.pac-container{display:none!important;height:0!important;overflow:hidden!important;pointer-events:none!important}' }).catch(() => {});

  // Step 1: Click PayPal with real Playwright mouse event (not JS .click())
  console.log('    [Pay] Selecting PayPal...');
  let ppClicked = false;
  // Find the PayPal text element and get its bounding box for a real click
  const ppLoc = page.locator('text=PayPal').first();
  try {
    await ppLoc.waitFor({ state: 'visible', timeout: 5000 });
    const box = await ppLoc.boundingBox();
    if (box) {
      // Click the center of the PayPal text
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      ppClicked = true;
      console.log('    [Pay] PayPal clicked (mouse)');
    }
  } catch {}
  if (!ppClicked) {
    // Fallback: try clicking parent containers
    try { await page.locator('div:has(> span:text("PayPal"))').first().click(); ppClicked = true; } catch {}
  }
  if (!ppClicked) {
    try { await page.getByText('PayPal', { exact: true }).click(); ppClicked = true; } catch {}
  }
  console.log('    [Pay] PayPal selected:', ppClicked);

  // Verify PayPal is actually selected — if not, reload and retry once
  await randomDelay(2000, 3000);
  const hasError = await page.locator('text=支付方式 必填').or(page.locator('text=Payment method required')).isVisible({ timeout: 1000 }).catch(() => false);
  if (hasError || !ppClicked) {
    console.log('    [Pay] PayPal not selected, reloading page to retry...');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await randomDelay(3000, 4000);
    // Retry PayPal click
    const ppRetry = page.locator('text=PayPal').first();
    try {
      const box = await ppRetry.boundingBox();
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      console.log('    [Pay] PayPal retry clicked');
    } catch {}
    await randomDelay(2000, 3000);
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
      var el = document.getElementById(id);
      if (!el) {
        // Try by selector
        var selects = document.querySelectorAll('select');
        for (var s = 0; s < selects.length; s++) {
          for (var i = 0; i < selects[s].options.length; i++) {
            if (selects[s].options[i].text.toLowerCase().includes(text.toLowerCase())) {
              el = selects[s];
              break;
            }
          }
          if (el) break;
        }
      }
      if (!el) return false;
      for (var i = 0; i < el.options.length; i++) {
        if (el.options[i].text.toLowerCase().includes(text.toLowerCase()) || el.options[i].value.toLowerCase().includes(text.toLowerCase())) {
          el.value = el.options[i].value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          log.push('select=' + el.options[i].text);
          return true;
        }
      }
      return false;
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
  await clickSubmit(page);
  console.log('    [Pay] OpenAI page submitted');
}

async function handlePayPalLogin(page) {
  console.log('    [Pay] PayPal login page detected');
  await randomDelay(2000, 3000);

  const email = randEmail();
  console.log('    [Pay] Email:', email);
  await fillInput(page, '#email', email);
  await randomDelay(800, 1200);
  await clickSubmit(page);
  console.log('    [Pay] PayPal login submitted');
}

async function handlePayPalCheckout(page, phoneOverride, smsOverride) {
  console.log('    [Pay] PayPal checkout page detected');
  await randomDelay(2000, 3000);

  // Set country to US
  const changed = await page.evaluate(() => {
    const c = document.getElementById('country');
    if (c && c.value !== 'US') {
      c.value = 'US';
      c.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  });
  if (changed) {
    console.log('    [Pay] Country → US');
    await randomDelay(2000, 3000);
  }

  const addr = await fetchAddress();
  const email = randEmail();
  const password = randPass();
  console.log('    [Pay] Email:', email);
  console.log('    [Pay] Address:', JSON.stringify(addr));

  await fillInput(page, '#email', email);
  await fillInput(page, '#phone', phoneOverride || CONFIG.phone);
  await fillInput(page, '#cardNumber', CONFIG.cardNumber);
  await fillInput(page, '#cardExpiry', CONFIG.cardExpiry);
  await fillInput(page, '#cardCvv', CONFIG.cardCvv);
  await fillInput(page, '#password', password);
  await fillInput(page, '#firstName', 'James');
  await fillInput(page, '#lastName', 'Smith');
  await fillInput(page, '#billingLine1', addr.street);
  await fillInput(page, '#billingCity', addr.city);
  await fillInput(page, '#billingPostalCode', addr.zip);
  await selectOption(page, '#billingState', addr.state);

  await randomDelay(500, 1000);
  await clickSubmit(page);
  console.log('    [Pay] PayPal checkout submitted');

  // Handle SMS verification code dialog
  await handleSmsVerification(page, smsOverride);
}

async function handleSmsVerification(page, smsOverride) {
  const SMS_URL = smsOverride || CONFIG.smsApiUrl;
  if (!SMS_URL) return;

  await randomDelay(2000, 3000);

  // Check if SMS code dialog appeared ("Enter your code")
  const codeDialog = page.locator('text=Enter your code').or(page.locator('text=输入验证码').or(page.locator('text=输入你的验证码')));
  const dialogVisible = await codeDialog.isVisible({ timeout: 8000 }).catch(() => false);
  if (!dialogVisible) {
    console.log('    [Pay] No SMS verification dialog detected');
    return;
  }

  console.log('    [Pay] SMS verification dialog detected, polling for code...');

  // Poll SMS API for the verification code (retry up to 30 times, every 3s = ~90s)
  let smsCode = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const res = await fetch(SMS_URL);
      const text = await res.text();
      console.log(`    [Pay] SMS API attempt ${attempt + 1}: ${text.slice(0, 100)}`);

      // Extract 6-digit code from response
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
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
}

// ========== Main Auto-Pay ==========

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
  for (let round = 0; round < 15; round++) {
    await randomDelay(2000, 3000);
    const currentUrl = page.url();

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
  }
  if (!paypalHandled) console.log('    [Pay] PayPal flow not detected, continuing...');

  console.log('    [Pay] Auto-payment flow completed');
}

module.exports = { autoPayment, CONFIG };
