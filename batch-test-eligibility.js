// 批量测试账号 v2.18.2 拿 $0 资格
const path = require('path');
const os = require('os');
const fs = require('fs');

const EMAILS = (process.env.EMAILS || '').split(',').filter(Boolean);
if (EMAILS.length === 0) { console.error('Set EMAILS=a@b.com,c@d.com'); process.exit(1); }

async function loginGetToken(email) {
  const { accountsDB } = require('./server/db');
  const { launchChrome, waitForCDP } = require('./server/chrome');
  const { loginAccount } = require('./login');
  const account = accountsDB.get(email);
  if (!account) return { error: 'not in DB' };
  account.loginType = account.login_type || 'outlook';
  const port = 19999;
  const tempDir = path.join(os.tmpdir(), 'be-' + Date.now());
  const proc = launchChrome(port, tempDir, { proxyServer: 'http://127.0.0.1:7891' });
  try {
    const browser = await waitForCDP(port);
    const r = await loginAccount(browser, account);
    try { await browser.close(); } catch {}
    try { proc.kill(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    if (r.status !== 'success' || !r.accessToken) return { error: r.reason || r.status };
    return { token: r.accessToken };
  } catch (e) {
    try { proc.kill(); } catch {}
    return { error: e.message.slice(0, 60) };
  }
}

async function fetchCheckoutAndProbe(token, email) {
  const { fetchCheckoutLink } = require('./server/chatgpt-checkout');
  const r = await fetchCheckoutLink(token);
  if (!r.link) return { error: 'no link: ' + (r.raw || '').slice(0, 60) };

  // 渲染拿 init
  const { launchChrome, waitForCDP } = require('./server/chrome');
  const port = 19888;
  const tempDir = path.join(os.tmpdir(), 'pe-' + Date.now());
  const proc = launchChrome(port, tempDir, { proxyServer: 'http://127.0.0.1:7890' });
  try {
    const browser = await waitForCDP(port);
    const page = browser.contexts()[0].pages()[0] || await browser.contexts()[0].newPage();
    let init = null;
    page.on('response', async (resp) => {
      if (resp.url().includes('/payment_pages/') && resp.url().includes('/init') && !init) {
        try { init = JSON.parse(await resp.text()); } catch {}
      }
    });
    await page.goto(r.link, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r2 => setTimeout(r2, 12000));
    try { await browser.close(); } catch {}
    try { proc.kill(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    if (!init) return { link: r.link, error: 'no init captured' };
    const inv = init.invoice || {};
    return {
      link: r.link,
      amount_due_cents: inv.amount_due,
      currency: inv.currency,
      pm: init.payment_method_types,
      coupons: (inv.total_discount_amounts || []).map(d => d.coupon?.name),
    };
  } catch (e) {
    try { proc.kill(); } catch {}
    return { error: e.message.slice(0, 60) };
  }
}

(async () => {
  const { initDB } = require('./server/db');
  await initDB();

  const results = [];
  for (const email of EMAILS) {
    console.log(`\n=== ${email} ===`);
    console.log('  Login...');
    const { token, error: loginErr } = await loginGetToken(email);
    if (loginErr) {
      console.log('  Login FAIL:', loginErr);
      results.push({ email, status: 'login_fail', reason: loginErr });
      continue;
    }
    console.log('  Login OK, fetching checkout...');
    const p = await fetchCheckoutAndProbe(token, email);
    if (p.error) {
      console.log('  Probe ERR:', p.error);
      results.push({ email, status: 'probe_fail', reason: p.error });
      continue;
    }
    const totalUsd = (p.amount_due_cents || 0) / 100;
    const eligible = p.amount_due_cents === 0;
    console.log(`  ${p.currency?.toUpperCase()} ${totalUsd.toFixed(2)} | coupons: [${p.coupons.join(',')}] | pm: ${JSON.stringify(p.pm)}`);
    console.log(`  → ${eligible ? '✅ ELIGIBLE ($0)' : '❌ NOT ELIGIBLE ($' + totalUsd + ')'}`);
    results.push({ email, total: totalUsd, eligible, coupons: p.coupons });
  }

  console.log('\n\n=== SUMMARY ===');
  for (const r of results) {
    if (r.status) console.log(`  ${r.email.padEnd(40)} | ${r.status} (${r.reason})`);
    else console.log(`  ${r.email.padEnd(40)} | $${r.total.toFixed(2)} ${r.eligible ? '✅' : '❌'}`);
  }
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
