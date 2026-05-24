// 批量重测：3 个账号 login → 强制 7891 JP 调 checkout → 渲染
// gexi, qnke, hprfvxml
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const EMAILS = [
  'gexi4056685@outlook.com',
  'qnke4812473@outlook.com',
  'hprfvxml12008@outlook.com',
];
const JP_PROXY = 'http://127.0.0.1:7891';
const US_PROXY = 'http://127.0.0.1:7890';

async function loginGetToken(email) {
  const { accountsDB } = require('./server/db');
  const { launchChrome, waitForCDP } = require('./server/chrome');
  const { loginAccount } = require('./login');
  const account = accountsDB.get(email);
  if (!account) throw new Error('not in DB');
  account.loginType = account.login_type || 'outlook';
  const port = 19992;
  const tempDir = path.join(os.tmpdir(), 'rb-' + Date.now());
  const proc = launchChrome(port, tempDir, { proxyServer: JP_PROXY });
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

function fetchCheckoutForced(token, proxy) {
  return new Promise((resolve) => {
    const py = spawn('py', ['-3', 'checkout_link.py'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const t = setTimeout(() => { py.kill(); resolve({ link: '', raw: 'timeout' }); }, 60000);
    py.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n').filter(l => l.trim())) {
        try {
          const p = JSON.parse(line);
          if (p.log) console.log(p.log);
          else stdout = line;
        } catch { stdout = line; }
      }
    });
    py.stderr.on('data', (d) => { stderr += d.toString(); });
    py.on('close', () => {
      clearTimeout(t);
      try { resolve(JSON.parse(stdout)); }
      catch { resolve({ link: '', raw: stderr.slice(-200) }); }
    });
    py.stdin.write(JSON.stringify({
      access_token: token,
      country: 'US', currency: 'USD',
      promo_id: 'plus-1-month-free',
      proxy,
    }));
    py.stdin.end();
  });
}

async function renderProbe(link) {
  const { launchChrome, waitForCDP } = require('./server/chrome');
  const port = 19881;
  const tempDir = path.join(os.tmpdir(), 'rp-' + Date.now());
  const proc = launchChrome(port, tempDir, { proxyServer: US_PROXY });
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
  const results = [];
  for (const email of EMAILS) {
    console.log(`\n========== ${email} ==========`);
    let token;
    try {
      console.log('Login via 7891 JP-KDDI...');
      token = await loginGetToken(email);
      console.log('  ✓ token len=', token.length);
    } catch (e) {
      console.log('  ✗ Login FAIL:', e.message);
      results.push({ email, error: 'login: ' + e.message });
      continue;
    }
    console.log('Forced 7891 JP checkout (country=US, USD)...');
    const r = await fetchCheckoutForced(token, JP_PROXY);
    if (!r.link) {
      console.log('  ✗ no link:', (r.raw || '').slice(0, 100));
      results.push({ email, error: 'no link' });
      continue;
    }
    console.log('  ✓ link OK');
    console.log('Rendering via 7890 US...');
    let init = await renderProbe(r.link);
    if (!init) {
      // 重试一次
      console.log('  render retry...');
      init = await renderProbe(r.link);
    }
    if (!init) {
      results.push({ email, link: r.link, error: 'render fail' });
      continue;
    }
    const inv = init.invoice || {};
    const amount = inv.amount_due;
    const cur = inv.currency;
    const pm = init.payment_method_types;
    const coupons = (inv.total_discount_amounts || []).map(d => d.coupon?.name);
    console.log(`  >>> amount_due=${amount} ${cur?.toUpperCase()} | PayPal=${pm?.includes('paypal')?'✓':'✗'} | coupons=[${coupons.join(',')}]`);
    results.push({ email, link: r.link, amount, cur, pm, coupons });
  }

  console.log('\n\n========== SUMMARY (强制 7891 JP-KDDI) ==========');
  for (const r of results) {
    if (r.error) {
      console.log(`${r.email.padEnd(38)} | ERROR: ${r.error}`);
      continue;
    }
    const display = r.cur === 'usd' ? `$${(r.amount / 100).toFixed(2)}` : `${r.amount} ${r.cur?.toUpperCase()}`;
    const free = r.amount === 0 ? '🎉 $0' : '❌ paid';
    const hasPaypal = r.pm?.includes('paypal') ? 'PayPal✓' : 'PayPal✗';
    const hasCoupon = r.coupons.length ? `coupon` : 'no-coupon';
    console.log(`${r.email.padEnd(38)} | ${display.padEnd(10)} | ${free.padEnd(8)} | ${hasPaypal} | ${hasCoupon}`);
  }

  console.log('\n=== Links ===');
  for (const r of results) {
    if (r.link) console.log(`${r.email}: ${r.link}`);
  }
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
