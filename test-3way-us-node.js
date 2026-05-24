// 3-way 实验 v2：用 hprfvxml12008 + 7890 US 节点拿 link（绕过 proxyMgr）
// 注意：hprfvxml 资格已被前一次实验耗尽，本次主要看 PayPal/currency 规则
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const EMAIL = 'hprfvxml12008@outlook.com';
const US_PROXY = 'http://127.0.0.1:7890';
const COMBOS = [
  { label: 'A: JP / JPY', country: 'JP', currency: 'JPY' },
  { label: 'B: US / USD', country: 'US', currency: 'USD' },
  { label: 'C: JP / USD', country: 'JP', currency: 'USD' },
];

async function loginGetToken(email) {
  const { accountsDB } = require('./server/db');
  const { launchChrome, waitForCDP } = require('./server/chrome');
  const { loginAccount } = require('./login');
  const account = accountsDB.get(email);
  if (!account) throw new Error('account not in DB');
  account.loginType = account.login_type || 'outlook';
  const port = 19996;
  const tempDir = path.join(os.tmpdir(), 'tu-' + Date.now());
  const proc = launchChrome(port, tempDir, { proxyServer: US_PROXY });
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

function fetchCheckoutDirect(token, country, currency) {
  return new Promise((resolve) => {
    const SCRIPT = path.join(__dirname, 'checkout_link.py');
    const py = spawn('py', ['-3', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
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
      country, currency,
      promo_id: 'plus-1-month-free',
      proxy: US_PROXY,
    }));
    py.stdin.end();
  });
}

async function renderProbe(link) {
  const { launchChrome, waitForCDP } = require('./server/chrome');
  const port = 19887;
  const tempDir = path.join(os.tmpdir(), 'rd2-' + Date.now());
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

  console.log('=== Login hprfvxml12008 via 7890 US ===');
  let token;
  try { token = await loginGetToken(EMAIL); }
  catch (e) { console.error('Login FAIL:', e.message); process.exit(1); }
  console.log('OK, token len=', token.length);

  const results = [];
  for (const c of COMBOS) {
    console.log(`\n--- ${c.label} (via 7890 US) ---`);
    const r = await fetchCheckoutDirect(token, c.country, c.currency);
    if (!r.link) {
      console.log('  ❌ no link:', (r.raw || '').slice(0, 150));
      results.push({ ...c, error: r.raw });
      continue;
    }
    console.log('  link OK:', r.link.slice(0, 70) + '...');
    const init = await renderProbe(r.link);
    if (!init) { results.push({ ...c, link: r.link, error: 'no init' }); console.log('  ❌ no init'); continue; }
    const inv = init.invoice || {};
    const amount = inv.amount_due;
    const cur = inv.currency;
    const pm = init.payment_method_types;
    const coupons = (inv.total_discount_amounts || []).map(d => d.coupon?.name);
    console.log(`  💰 amount_due=${amount} ${cur?.toUpperCase()} | pm=${JSON.stringify(pm)} | coupons=[${coupons.join(',')}]`);
    results.push({ ...c, link: r.link, amount, cur, pm, coupons });
  }

  console.log('\n\n=========== SUMMARY (US 节点 7890) ===========');
  console.log('Account: hprfvxml12008 (注意：资格之前已耗尽)');
  console.log('Proxy: 7890 US (拿链接 + 渲染 都走 US)');
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
