#!/usr/bin/env node
// 给一个 pay.openai.com 链接，渲染并点击 "View details" 展开明细，验证 ¥0。
// 复用 7891 JP 代理（必须先有 server 启动 + jp.enabled）。
//
// Usage:
//   $env:TEST_URL = "https://pay.openai.com/c/pay/cs_live_..."
//   node verify-t3-render-only.js

const path = require('path');
const os = require('os');
const fs = require('fs');

const URL = (process.env.TEST_URL || '').trim();
if (!URL) {
  console.error('ERROR: $env:TEST_URL required');
  process.exit(1);
}

(async () => {
  const { launchChrome, waitForCDP } = require('./server/chrome');
  const proxy = require('./server/proxy');

  // Bootstrap JP proxy if not already up
  let owned = false;
  if (!proxy.getJpProxyUrl()) {
    console.log('Starting proxy...');
    await proxy.refresh();
    if (!/动态家宽|住宅|residential/i.test(proxy.getState().jp.currentNode)) {
      await proxy.rotateJp();
    }
    owned = true;
    console.log('JP exit:', await proxy.detectJpExit());
  }

  const port = 19792;
  const tempDir = path.join(os.tmpdir(), 'render-only-' + Date.now());
  const chromeProc = launchChrome(port, tempDir, { proxyServer: 'http://127.0.0.1:7891' });
  let exitCode = 0;

  try {
    const browser = await waitForCDP(port);
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('Page loaded, waiting for Stripe app to settle...');
    // Wait for Stripe app to fully render (networkidle takes too long; wait for visible price text)
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 5000)); // additional buffer for price shimmer

    // Try to click "View details"
    console.log('Looking for "View details" / "Details"…');
    const viewBtn = page.locator(
      'button:has-text("View details"), button:has-text("Details"), [data-testid="view-details"], a:has-text("Details")'
    ).first();
    const visible = await viewBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (visible) {
      await viewBtn.click().catch((e) => console.log('  click error:', e.message));
      console.log('  Clicked View details');
      await new Promise(r => setTimeout(r, 3000));
    } else {
      console.log('  View details button not found, scrolling for details…');
    }

    // Scroll order summary area into view
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise(r => setTimeout(r, 1500));

    const text = await page.evaluate(() => document.body.innerText || '');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const textPath = path.join(__dirname, `render-only-${ts}.txt`);
    const shotPath = path.join(__dirname, `render-only-${ts}.png`);
    fs.writeFileSync(textPath, text);
    await page.screenshot({ path: shotPath, fullPage: true });
    console.log(`\nEvidence saved:`);
    console.log(`  ${textPath}`);
    console.log(`  ${shotPath}`);

    console.log('\n=== Full rendered text ===');
    console.log(text);

    console.log('\n=== Marker scan ===');
    const patterns = [
      [/free trial/i, 'free trial'],
      [/¥\s*0(?!\d)/, '¥0 (zero)'],
      [/\$0(?!\d)/, '$0 (zero)'],
      [/0[.,]00\s*(?:JPY|¥|USD|\$)?/i, '0.00 amount'],
      [/Total due today.{0,40}(?:¥|\$)?\s*0/i, 'Total due today: 0'],
      [/Due today/i, 'Due today (any)'],
      [/coupon/i, 'coupon mention'],
      [/Subtotal/i, 'Subtotal'],
      [/Discount/i, 'Discount'],
      [/after coupon expires/i, 'after coupon expires (promo indicator)'],
      [/¥\s*[1-9][\d,]*/, '¥ NON-ZERO'],
      [/2,?727/, '¥2,727'],
    ];
    const hits = [];
    for (const [re, label] of patterns) {
      const m = text.match(re);
      if (m) hits.push({ label, match: m[0] });
    }
    hits.forEach(h => console.log(`  HIT  ${h.label}: "${h.match}"`));

    const isFreeTrial = hits.some(h => /free trial|¥0 \(zero\)|0\.00 amount|Total due today: 0/i.test(h.label));
    const isPromoLink = hits.some(h => /coupon|after coupon expires/i.test(h.label));
    const onlyPaid = hits.some(h => /NON-ZERO|2,?727/i.test(h.label)) && !isFreeTrial && !isPromoLink;

    console.log('\n=== Verdict ===');
    if (isFreeTrial) {
      console.log('  ✓ PASS: explicit free-trial markers detected.');
    } else if (isPromoLink) {
      console.log('  ⚠ LIKELY-PASS: link is a promo (coupon) link; ¥0 likely hidden behind View details collapse');
      console.log('    Manually verify by opening the PNG screenshot.');
    } else if (onlyPaid) {
      console.log('  ✗ FAIL: paid amount, no coupon indicator.');
      exitCode = 10;
    } else {
      console.log('  ? UNCERTAIN');
      exitCode = 11;
    }

    if (!process.env.KEEP_BROWSER) await browser.close();
  } catch (e) {
    console.error(e);
    exitCode = 99;
  } finally {
    if (!process.env.KEEP_BROWSER) {
      try { chromeProc.kill(); } catch {}
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
    if (owned) await proxy.stop();
  }
  process.exit(exitCode);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
