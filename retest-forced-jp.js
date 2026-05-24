// 用已有 token 文件，强制 7891 JP 重测
// usage: node retest-forced-jp.js <token-file>
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const TOKEN_FILE = process.argv[2];
if (!TOKEN_FILE || !fs.existsSync(TOKEN_FILE)) {
  console.error('usage: node retest-forced-jp.js <token-file.txt>');
  process.exit(1);
}
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
const JP_PROXY = 'http://127.0.0.1:7891';

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
  const port = 19883;
  const tempDir = path.join(os.tmpdir(), 'rt-' + Date.now());
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
  console.log(`=== ${TOKEN_FILE} (forced 7891 JP) ===`);
  console.log('Token len=', TOKEN.length);

  const r = await fetchCheckoutForced(TOKEN, JP_PROXY);
  if (!r.link) {
    console.error('❌ no link:', (r.raw || '').slice(0, 200));
    process.exit(1);
  }
  console.log('Link OK:', r.link.slice(0, 80) + '...');

  const init = await renderProbe(r.link);
  if (!init) { console.log('❌ no init'); return; }
  const inv = init.invoice || {};
  console.log(`\n>>> amount_due=${inv.amount_due} ${inv.currency?.toUpperCase()} | PayPal=${init.payment_method_types?.includes('paypal')?'✅':'❌'} | coupons=[${(inv.total_discount_amounts||[]).map(d=>d.coupon?.name).join(',')}]`);
  console.log(`>>> ${inv.amount_due === 0 ? '🎉 $0' : '$' + (inv.amount_due/100).toFixed(2)}`);
  console.log(`\nLink: ${r.link}`);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
