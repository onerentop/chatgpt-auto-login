// 用 osxti6295 的 token 走 v2.18.2 (country=US/USD/plus-1-month-free) 拿 link
// proxy: 7891 JP-KDDI (fetchCheckoutLink 默认走 JP)
// 然后渲染（7890 US）看 invoice
const path = require('path');
const os = require('os');
const fs = require('fs');

const TOKEN_FILE = 'token-osxti6295.txt';

async function renderProbe(link) {
  const { launchChrome, waitForCDP } = require('./server/chrome');
  const port = 19885;
  const tempDir = path.join(os.tmpdir(), 'rg-' + Date.now());
  const proc = launchChrome(port, tempDir, { proxyServer: 'http://127.0.0.1:7890' });
  try {
    const browser = await waitForCDP(port);
    const page = browser.contexts()[0].pages()[0] || await browser.contexts()[0].newPage();
    let init = null;
    page.on('response', async (resp) => {
      const u = resp.url();
      if (u.includes('/payment_pages/') && u.includes('/init') && !init) {
        try { init = JSON.parse(await resp.text()); } catch {}
      }
    });
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 12000));
    try { await browser.close(); } catch {}
    try { proc.kill(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    return init;
  } catch (e) {
    try { proc.kill(); } catch {}
    return null;
  }
}

(async () => {
  const { initDB } = require('./server/db');
  await initDB();
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  console.log('Token loaded, len=', token.length);

  const { fetchCheckoutLink } = require('./server/chatgpt-checkout');
  console.log('\nFetching link via 7891 JP-KDDI (country=US, currency=USD, promo=plus-1-month-free)...');
  const r = await fetchCheckoutLink(token);
  if (!r.link) {
    console.error('❌ no link:', (r.raw || '').slice(0, 300));
    process.exit(1);
  }
  console.log('\n✅ LINK:');
  console.log(r.link);

  console.log('\nRendering via 7890 US...');
  const init = await renderProbe(r.link);
  if (!init) { console.log('  ❌ no init captured'); return; }
  const inv = init.invoice || {};
  const amount = inv.amount_due;
  const cur = inv.currency;
  const pm = init.payment_method_types;
  const coupons = (inv.total_discount_amounts || []).map(d => d.coupon?.name);

  console.log('\n=========== RESULT ===========');
  console.log(`amount_due:  ${amount} ${cur?.toUpperCase()} (= ${cur === 'usd' ? '$' + (amount/100).toFixed(2) : amount + ' ' + cur?.toUpperCase()})`);
  console.log(`PayPal:      ${pm && pm.includes('paypal') ? '✅ YES' : '❌ NO'}`);
  console.log(`Coupons:     ${coupons.length ? coupons.join(', ') : '(none)'}`);
  console.log(`Eligible:    ${amount === 0 ? '✅ $0 (有资格)' : '❌ paid ($' + (amount/100).toFixed(2) + ')'}`);
  console.log('==============================');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
