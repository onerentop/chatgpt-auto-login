#!/usr/bin/env node
// T3 acceptance using an existing account from DB.
// 自动 login → fetchCheckoutLink → Chrome+CDP 渲染验证 ¥0。
// 不走 PayPal，不修改账号状态。
//
// Usage (PowerShell):
//   $env:TEST_EMAIL = "AlexisOlsen5333@outlook.com"
//   node verify-t3-account.js
//
// Optional:
//   $env:KEEP_BROWSER = "1"

const path = require('path');
const os = require('os');
const fs = require('fs');

const EMAIL = (process.env.TEST_EMAIL || '').trim();
if (!EMAIL) {
  console.error('ERROR: $env:TEST_EMAIL required');
  process.exit(1);
}
const KEEP = !!process.env.KEEP_BROWSER;

const ROOT = __dirname;

(async () => {
  const { initDB, accountsDB } = require('./server/db');
  const proxy = require('./server/proxy');
  const { launchChrome, waitForCDP } = require('./server/chrome');
  const { loginAccount } = require('./login');
  const { fetchCheckoutLink } = require('./server/chatgpt-checkout');

  await initDB();
  const account = accountsDB.get(EMAIL);
  if (!account) {
    console.error(`ERROR: account ${EMAIL} not in DB`);
    process.exit(2);
  }
  // engine 用 account.loginType（camelCase），DB 字段是 login_type（snake_case），手动对齐
  account.loginType = account.login_type || account.loginType;
  console.log(`Account: ${account.email} | loginType: ${account.loginType} | refresh_token: ${(account.refresh_token||'').length} chars`);

  console.log('\n=== Step 1/5: Bootstrap proxy ===');
  await proxy.refresh();
  const st0 = proxy.getState();
  console.log(`Main: enabled=${st0.enabled} available=${st0.available} currentNode=${st0.currentNode}`);
  console.log(`JP  : enabled=${st0.jp.enabled} available=${st0.jp.available} currentNode=${st0.jp.currentNode}`);
  if (!st0.jp.enabled) {
    console.error(`FAIL: JP channel not enabled. lastError=${st0.jp.lastError}`);
    process.exit(3);
  }
  // 若首节点是 datacenter 类，rotate 到含 "动态家宽" 的
  const RES_PAT = /动态家宽|住宅|residential/i;
  if (!RES_PAT.test(st0.jp.currentNode)) {
    console.log('Switching JP to residential node...');
    const next = await proxy.rotateJp();
    console.log(`Rotated to: ${next}`);
  }
  console.log(`JP exit IP: ${await proxy.detectJpExit()}`);

  console.log('\n=== Step 2/5: Launch Chrome for login ===');
  const loginPort = 19790;
  const loginTemp = path.join(os.tmpdir(), 'verify-t3-login-' + Date.now());
  // v2.42: 不再显式传 proxyServer，launchChrome 默认读 process.env.HTTPS_PROXY
  const loginChrome = launchChrome(loginPort, loginTemp, {});

  let accessToken = '';
  let renderProc = null;
  let renderTemp = '';
  let exitCode = 0;
  try {
    const browser = await waitForCDP(loginPort);

    console.log('\n=== Step 3/5: Run loginAccount() ===');
    const loginResult = await loginAccount(browser, account);
    console.log(`Login status: ${loginResult.status}`);
    console.log(`accessToken: ${loginResult.accessToken ? loginResult.accessToken.slice(0,30) + '...' : '(empty)'}`);
    console.log(`session.account.planType: ${loginResult.session?.account?.planType || '?'}`);
    console.log(`session.chatgpt_plan_type: ${loginResult.session?.chatgpt_plan_type || '?'}`);

    if (loginResult.status !== 'success' || !loginResult.accessToken) {
      console.error(`FAIL: login did not produce accessToken. reason=${loginResult.reason || '?'}`);
      try { await browser.close(); } catch {}
      try { loginChrome.kill(); } catch {}
      try { fs.rmSync(loginTemp, { recursive: true, force: true }); } catch {}
      await proxy.stop();
      process.exit(4);
    }
    accessToken = loginResult.accessToken;
    const planType = (loginResult.session?.account?.planType || loginResult.session?.chatgpt_plan_type || 'free').toLowerCase();
    console.log(`Plan: ${planType}`);
    if (['plus', 'pro', 'team', 'enterprise'].includes(planType)) {
      console.error(`SKIP: account is already ${planType} - cannot get trial link`);
      try { await browser.close(); } catch {}
      try { loginChrome.kill(); } catch {}
      try { fs.rmSync(loginTemp, { recursive: true, force: true }); } catch {}
      await proxy.stop();
      process.exit(5);
    }

    try { await browser.close(); } catch {}
    try { loginChrome.kill(); } catch {}
    try { fs.rmSync(loginTemp, { recursive: true, force: true }); } catch {}

    console.log('\n=== Step 4/5: Call fetchCheckoutLink (JP-KDDI 7891) ===');
    const r = await fetchCheckoutLink(accessToken);
    console.log(`link: ${r.link || '(empty)'}`);
    console.log(`raw : ${(r.raw||'').slice(0,200)}`);
    if (!r.link) {
      console.error('FAIL: no checkout link');
      await proxy.stop();
      process.exit(6);
    }
    if (/WARN: jp_channel_disabled/.test(r.raw||'')) {
      console.error('FAIL: fell back to main proxy');
      await proxy.stop();
      process.exit(7);
    }

    console.log('\n=== Step 5/5: Render link in Chrome via JP 7891 ===');
    const renderPort = 19791;
    renderTemp = path.join(os.tmpdir(), 'verify-t3-render-' + Date.now());
    renderProc = launchChrome(renderPort, renderTemp, { proxyServer: 'http://127.0.0.1:7891' });
    const browser2 = await waitForCDP(renderPort);
    const ctx2 = browser2.contexts()[0];
    const page2 = ctx2.pages()[0] || await ctx2.newPage();
    await page2.goto(r.link, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page2.waitForFunction(
      () => document.body && /[¥$0]|Free trial|Total due today|per month/i.test(document.body.innerText || ''),
      { timeout: 25000 }
    ).catch(() => console.log('  (timed out waiting for price markers)'));

    const text = await page2.evaluate(() => document.body.innerText || '');
    console.log('\n=== Rendered text (first 2500 chars) ===');
    console.log(text.slice(0, 2500));

    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    const textPath = path.join(ROOT, `verify-t3-${EMAIL.split('@')[0]}-${ts}.txt`);
    const shotPath = path.join(ROOT, `verify-t3-${EMAIL.split('@')[0]}-${ts}.png`);
    fs.writeFileSync(textPath, text);
    await page2.screenshot({ path: shotPath, fullPage: true });
    console.log(`\nEvidence saved:`);
    console.log(`  ${textPath}`);
    console.log(`  ${shotPath}`);

    const patterns = [
      [/free trial/i, 'free trial'],
      [/¥\s*0(?!\d)/, '¥0'],
      [/\$0(?!\d)/, '$0'],
      [/0[.,]00\s*(?:JPY|¥|USD|\$)?/i, '0.00 amount'],
      [/Total due today.{0,40}(?:¥|\$)?\s*0/i, 'Total due today: 0'],
      [/¥\s*[1-9][\d,]*/, '¥ NON-ZERO (paid)'],
      [/\$\s*[1-9][\d,]*/, '$ NON-ZERO (paid)'],
      [/2,?727/, '¥2,727 (post-trial paid)'],
      [/per month/i, 'per month'],
    ];
    console.log('\n=== Markers ===');
    const hits = [];
    for (const [re,label] of patterns) {
      const m = text.match(re); if (m) hits.push({label, match: m[0]});
    }
    hits.forEach(h => console.log(`  HIT  ${h.label}: "${h.match}"`));
    if (!hits.length) console.log('  (none - see screenshot)');

    const trialHit = hits.some(h => /free trial|^¥0$|^\$0$|0\.00 amount|Total due today: 0/i.test(h.label));
    const paidHit = hits.some(h => /NON-ZERO|2,?727/i.test(h.label));
    console.log('\n=== Verdict ===');
    if (trialHit && !paidHit) {
      console.log('  ✓ PASS: ¥0 / Free trial detected.');
    } else if (paidHit) {
      console.log('  ✗ FAIL: paid amount detected (account already used trial).');
      exitCode = 10;
    } else {
      console.log('  ? UNCERTAIN: inspect screenshot manually.');
      exitCode = 11;
    }

    if (!KEEP) try { await browser2.close(); } catch {}
  } catch (e) {
    console.error('Error:', e.message);
    console.error(e.stack);
    exitCode = 99;
  } finally {
    if (!KEEP) {
      if (renderProc) try { renderProc.kill(); } catch {}
      if (renderTemp) try { fs.rmSync(renderTemp, { recursive: true, force: true }); } catch {}
    }
    await proxy.stop();
  }
  process.exit(exitCode);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
