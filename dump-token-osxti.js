const path = require('path');
const os = require('os');
const fs = require('fs');

const EMAIL = 'osxti6295@outlook.com';

(async () => {
  const { initDB, accountsDB, statusDB } = require('./server/db');
  const { launchChrome, waitForCDP } = require('./server/chrome');
  const { loginAccount } = require('./login');
  await initDB();
  const account = accountsDB.get(EMAIL);
  if (!account) { console.error('not in DB'); process.exit(1); }
  account.loginType = account.login_type || 'outlook';

  const s = statusDB.get(EMAIL);
  console.log(`=== ${EMAIL} ===`);
  console.log(`  status: ${s?.status}, phase: ${s?.phase}`);

  const port = 19993;
  const tempDir = path.join(os.tmpdir(), 'd2-' + Date.now());
  const proc = launchChrome(port, tempDir, { proxyServer: 'http://127.0.0.1:7891' });
  try {
    const browser = await waitForCDP(port);
    const r = await loginAccount(browser, account);
    try { await browser.close(); } catch {}
    try { proc.kill(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    if (r.status !== 'success' || !r.accessToken) {
      console.error('FAIL:', r.reason || r.status);
      process.exit(1);
    }
    const out = `token-${EMAIL.split('@')[0]}.txt`;
    fs.writeFileSync(out, r.accessToken);
    console.log('\n✅ Token written to:', path.resolve(out));
    console.log('   Length:', r.accessToken.length);
    console.log('   (没调用 checkout API，promo 资格未被消耗)');
  } catch (e) {
    try { proc.kill(); } catch {}
    console.error('ERR:', e.message);
    process.exit(1);
  }
})();
