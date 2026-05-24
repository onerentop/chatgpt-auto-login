// 用一个 status=error 的账号 (ovjvant465198) 走 7891 JP 节点
// 测两组：(JP/JPY)、(US/USD)，对比金额/PayPal/coupon
const path = require('path');
const os = require('os');
const fs = require('fs');

const EMAIL = 'ovjvant465198@outlook.com';
const COMBOS = [
  { label: 'A: JP / JPY', country: 'JP', currency: 'JPY' },
  { label: 'B: US / USD', country: 'US', currency: 'USD' },
];

async function loginGetToken(email) {
  const { accountsDB } = require('./server/db');
  const { launchChrome, waitForCDP } = require('./server/chrome');
  const { loginAccount } = require('./login');
  const account = accountsDB.get(email);
  if (!account) throw new Error('account not in DB');
  account.loginType = account.login_type || 'outlook';
  const port = 19995;
  const tempDir = path.join(os.tmpdir(), 'te-' + Date.now());
  const proc = launchChrome(port, tempDir, { proxyServer: 'http://127.0.0.1:7891' });
  try {
    const browser = await waitForCDP(port);
    const r = await loginAccount(browser, account);
    try { await browser.close(); } catch {}
    try { proc.kill(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    if (r.status !== 'success' || !r.accessToken) throw new Error(r.reason || r.status);
    return r.accessToken;
  } catch (e) {
    try { proc.kill(); } catch {}
    throw e;
  }
}

async function renderProbe(link) {
  const { launchChrome, waitForCDP } = require('./server/chrome');
  const port = 19886;
  const tempDir = path.join(os.tmpdir(), 're-' + Date.now());
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
  const { initDB, statusDB } = require('./server/db');
  await initDB();

  const s = statusDB.get(EMAIL);
  console.log(`=== ${EMAIL} ===`);
  console.log(`  Status: ${s?.status}, Phase: ${s?.phase}, Reason: ${(s?.reason||'').slice(0,80)}`);

  console.log('\nLogin via 7891 JP-KDDI...');
  let token;
  try { token = await loginGetToken(EMAIL); }
  catch (e) { console.error('Login FAIL:', e.message); process.exit(1); }
  console.log('OK, token len=', token.length);

  const { fetchCheckoutLink } = require('./server/chatgpt-checkout');
  const results = [];

  for (const c of COMBOS) {
    console.log(`\n--- ${c.label} ---`);
    console.log(`  Fetching link via 7891 JP, country=${c.country} currency=${c.currency}...`);
    const r = await fetchCheckoutLink(token, { country: c.country, currency: c.currency });
    if (!r.link) {
      console.log('  ❌ no link:', (r.raw || '').slice(0, 150));
      results.push({ ...c, error: r.raw });
      continue;
    }
    console.log('  link OK:', r.link.slice(0, 70) + '...');
    console.log('  Rendering via 7890 US...');
    const init = await renderProbe(r.link);
    if (!init) {
      results.push({ ...c, link: r.link, error: 'no init' });
      console.log('  ❌ no init captured');
      continue;
    }
    const inv = init.invoice || {};
    const amount = inv.amount_due;
    const cur = inv.currency;
    const pm = init.payment_method_types;
    const coupons = (inv.total_discount_amounts || []).map(d => d.coupon?.name);
    console.log(`  💰 amount_due=${amount} ${cur?.toUpperCase()} | pm=${JSON.stringify(pm)} | coupons=[${coupons.join(',')}]`);
    results.push({ ...c, link: r.link, amount, cur, pm, coupons });
  }

  console.log('\n\n=========== SUMMARY ===========');
  console.log(`Account: ${EMAIL} (status=error, phase=payment)`);
  console.log('Proxy: 7891 JP-KDDI (拿链接) → 7890 US (渲染)');
  console.log();
  for (const r of results) {
    if (r.error) {
      console.log(`${r.label.padEnd(15)} | ERROR: ${(r.error || '').slice(0, 80)}`);
      continue;
    }
    const display = r.cur === 'usd' ? `$${(r.amount / 100).toFixed(2)}` : `${r.amount} ${r.cur?.toUpperCase()}`;
    const free = r.amount === 0 ? '✅ $0' : '❌ paid';
    const hasPaypal = r.pm && r.pm.includes('paypal') ? 'PayPal ✓' : 'PayPal ✗';
    const hasCoupon = r.coupons.length ? `coupon=[${r.coupons.join(',')}]` : 'no coupon';
    console.log(`${r.label.padEnd(15)} | ${display.padEnd(12)} | ${free} | ${hasPaypal} | ${hasCoupon}`);
  }
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
