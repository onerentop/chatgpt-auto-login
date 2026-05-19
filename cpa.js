const { randomDelay } = require('./utils');
const { authenticator } = require('otplib');
const { CONFIG } = require('./payment');

const CPA_URL = CONFIG.cpaUrl || '';
const CPA_KEY = CONFIG.cpaKey || '';

async function typeHuman(page, text) {
  for (const c of text) await page.keyboard.type(c, { delay: 50 + Math.random() * 80 });
}

async function registerToCPA(browser, email, account) {
  console.log(`    [CPA] Starting CPA OAuth for ${email}...`);

  const context = browser.contexts()[0];

  // Close all extra tabs left from payment flow (PayPal etc.)
  const allPages = context.pages();
  if (allPages.length > 1) {
    console.log(`    [CPA] Closing ${allPages.length - 1} extra tab(s)...`);
    for (let i = 1; i < allPages.length; i++) {
      await allPages[i].close().catch(() => {});
    }
  }
  const cpaPage = context.pages()[0] || await context.newPage();

  try {
    // Step 1: Login to CPA
    console.log('    [CPA] Logging into CPA...');
    await cpaPage.goto(CPA_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await randomDelay(1000, 1500);

    const keyInput = cpaPage.getByRole('textbox', { name: /管理密钥/i });
    await keyInput.waitFor({ state: 'visible', timeout: 10000 });
    await keyInput.fill(CPA_KEY);
    await randomDelay(500, 800);
    await cpaPage.getByRole('button', { name: /^登录$/i }).click();
    await randomDelay(2000, 3000);
    console.log('    [CPA] Logged in.');

    // Step 2: Navigate to OAuth page
    console.log('    [CPA] Opening OAuth page...');
    await cpaPage.getByRole('link', { name: 'OAuth 登录' }).click();
    await randomDelay(1500, 2000);

    // Step 3: Click "开始 Codex 登录"
    console.log('    [CPA] Starting Codex OAuth...');
    await cpaPage.getByRole('button', { name: /开始 Codex 登录/i }).click();
    await randomDelay(2000, 3000);

    // Wait for auth URL to appear
    await cpaPage.locator('text=https://auth.openai.com').first().waitFor({ state: 'visible', timeout: 10000 });
    console.log('    [CPA] Auth URL generated.');

    // Step 4: Set up listener for new tab BEFORE clicking "打开链接"
    let callbackUrl = null;

    // Intercept localhost:1455 on ALL pages in this context
    await context.route('http://localhost:1455/**', (route) => {
      callbackUrl = route.request().url();
      console.log('    [CPA] Captured callback URL!');
      route.abort();
    });

    // Click "打开链接" - scroll into view and click via JS if needed
    console.log('    [CPA] Clicking "打开链接"...');
    const clicked = await cpaPage.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        if (b.textContent.includes('打开链接') || b.textContent.includes('Open')) {
          b.scrollIntoView();
          b.click();
          return b.textContent.trim();
        }
      }
      return null;
    });
    console.log('    [CPA] Button click result:', clicked);

    const authPage = await context.waitForEvent('page', { timeout: 15000 });

    console.log('    [CPA] Auth tab opened:', authPage.url().slice(0, 60) + '...');
    await randomDelay(2000, 3000);

    // Step 5: Handle full login flow in auth tab
    let step = 'start'; // start → google_clicked → email → password → totp → consent → done
    for (let i = 0; i < 15; i++) {
      if (callbackUrl) break;
      try { if (authPage.isClosed()) break; } catch { break; }
      const currentUrl = authPage.url().catch ? '' : authPage.url();
      if (currentUrl.includes('localhost:1455')) { callbackUrl = currentUrl; break; }

      // A0. OpenAI choose-an-account page → click the account
      if (currentUrl.includes('auth.openai.com') && currentUrl.includes('choose-an-account')) {
        // Click the account matching our email, or click the first account
        const acctBtn = authPage.locator('button, a, div[role="button"]').filter({ hasText: new RegExp(account.email.split('@')[0], 'i') }).first();
        if (await acctBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await acctBtn.click();
          console.log('    [CPA] Selected account by email');
          step = 'consent';
          await randomDelay(2000, 3000);
          continue;
        }
        // Fallback: click first account option
        const firstAcct = authPage.locator('[class*="account"], [class*="option"], button').first();
        if (await firstAcct.isVisible({ timeout: 2000 }).catch(() => false)) {
          await firstAcct.click();
          console.log('    [CPA] Selected first account');
          step = 'consent';
          await randomDelay(2000, 3000);
          continue;
        }
      }

      // A1. OpenAI login page → for Outlook use email+OTP, for Google use "Continue with Google"
      if (currentUrl.includes('auth.openai.com') && (step === 'start' || step === 'consent')) {
        const isOutlook = account.loginType === 'outlook';

        if (isOutlook) {
          // Enter email in the email field
          const emailField = authPage.locator('input[type="email"], input[name="email"]').first();
          if (await emailField.isVisible({ timeout: 2000 }).catch(() => false)) {
            await emailField.click();
            await typeHuman(authPage, account.email);
            await randomDelay(500, 800);
            const contBtn = authPage.locator('button').filter({ hasText: /继续|Continue/i }).first();
            await contBtn.click();
            console.log('    [CPA] Entered email (Outlook)');
            step = 'outlook_email';
            await randomDelay(2000, 3000);
            continue;
          }
        }

        // Google path
        const googleBtn = authPage.locator('button, a').filter({ hasText: /Google/i }).first();
        if (await googleBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await authPage.waitForLoadState('networkidle').catch(() => {});
          await authPage.waitForTimeout(2000);
          await googleBtn.click({ force: true });
          step = 'google_clicked';
          console.log('    [CPA] Clicked "Continue with Google"');
          await randomDelay(2000, 3000);
          continue;
        }
      }

      // A2. Outlook OTP flow on auth.openai.com
      if (currentUrl.includes('auth.openai.com') && step === 'outlook_email' && account.loginType === 'outlook') {
        // Switch to OTP if on password page
        const otpSwitch = authPage.locator('button, a').filter({ hasText: /一次性验证码|one-time code/i }).first();
        if (await otpSwitch.isVisible({ timeout: 2000 }).catch(() => false)) {
          await otpSwitch.click();
          console.log('    [CPA] Switched to OTP');
          await randomDelay(2000, 3000);
        }

        // Get OTP from IMAP
        const codeInput = authPage.locator('input[name="code"], input[type="text"]').first();
        if (await codeInput.isVisible({ timeout: 3000 }).catch(() => false)) {
          console.log('    [CPA] Fetching OTP for auth...');
          const { ImapFlow } = require('imapflow');
          const tokenBody = new URLSearchParams({ client_id: account.client_id, grant_type: 'refresh_token', refresh_token: account.refresh_token, scope: 'https://outlook.office.com/IMAP.AccessAsUser.All' });
          const tokenRes = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', { method: 'POST', body: tokenBody });
          const tokenData = await tokenRes.json();
          if (tokenData.access_token) {
            let baseline = 0;
            try {
              const pre = new ImapFlow({ host: 'outlook.office365.com', port: 993, secure: true, auth: { user: account.email, accessToken: tokenData.access_token }, logger: false });
              await pre.connect();
              const lock = await pre.getMailboxLock('INBOX');
              const s = Math.max(1, pre.mailbox.exists - 9);
              for await (const m of pre.fetch({ seq: `${s}:*` }, { uid: true })) { if (m.uid > baseline) baseline = m.uid; }
              lock.release(); await pre.logout();
            } catch {}

            let otp = null;
            for (let a = 0; a < 20; a++) {
              let client;
              try {
                client = new ImapFlow({ host: 'outlook.office365.com', port: 993, secure: true, auth: { user: account.email, accessToken: tokenData.access_token }, logger: false });
                await client.connect();
                const lock = await client.getMailboxLock('INBOX');
                for await (const msg of client.fetch({ uid: `${baseline + 1}:*` }, { envelope: true, source: true, uid: true })) {
                  if (msg.uid <= baseline) continue;
                  const subject = msg.envelope?.subject || '';
                  if (subject.includes('ChatGPT') || subject.includes('验证') || subject.includes('OpenAI')) {
                    const src = msg.source?.toString() || '';
                    const html = src.indexOf('<html') > -1 ? src.slice(src.indexOf('<html')).replace(/<[^>]+>/g, ' ') : src;
                    const match = html.match(/\b(\d{6})\b/);
                    if (match) { otp = match[1]; console.log(`    [CPA] Got OTP: ${otp}`); }
                  }
                }
                lock.release(); await client.logout();
              } catch { try { await client?.logout(); } catch {} }
              if (otp) break;
              if (a % 5 === 4) console.log(`    [CPA] OTP attempt ${a + 1}/20...`);
              await new Promise(r => setTimeout(r, 3000));
            }

            if (otp) {
              await authPage.evaluate((code) => {
                var inp = document.querySelector('input[name="code"], input[type="text"]');
                if (inp) { var ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; ns.call(inp, code); inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); }
              }, otp);
              await randomDelay(500, 800);
              await authPage.evaluate(() => { var b = document.querySelectorAll('button'); for (var i = 0; i < b.length; i++) { if (b[i].textContent.trim() === '继续' || b[i].textContent.trim() === 'Continue') { b[i].click(); return; } } });
              console.log('    [CPA] OTP submitted');
              step = 'consent';
              await randomDelay(2000, 3000);
              continue;
            }
          }
        }
      }

      // B. Google pages
      if (currentUrl.includes('accounts.google.com') && account) {
        // B1. Email page
        if (step === 'google_clicked' || step === 'start') {
          const emailInput = authPage.locator('input[type="email"], #identifierId').first();
          if (await emailInput.isVisible({ timeout: 2000 }).catch(() => false)) {
            await emailInput.click();
            await typeHuman(authPage, account.email);
            await randomDelay(500, 800);
            await authPage.locator('#identifierNext').first().click();
            step = 'email';
            console.log('    [CPA] Entered email');
            await randomDelay(2000, 3000);
            continue;
          }
        }

        // B2. Password page
        if (step === 'email') {
          await authPage.waitForLoadState('domcontentloaded').catch(() => {});
          const pwInput = authPage.locator('input[type="password"]').first();
          if (await pwInput.isVisible({ timeout: 5000 }).catch(() => false)) {
            await pwInput.click();
            await typeHuman(authPage, account.password);
            await randomDelay(500, 800);
            await authPage.locator('#passwordNext').first().click();
            step = 'password';
            console.log('    [CPA] Entered password');
            await randomDelay(2000, 3000);
            continue;
          }
        }

        // B3. TOTP
        if (step === 'password') {
          await authPage.waitForLoadState('domcontentloaded').catch(() => {});
          const totpInput = authPage.locator('input#totpPin, input[name="totpPin"], input[type="tel"]').first();
          if (await totpInput.isVisible({ timeout: 5000 }).catch(() => false)) {
            const code = authenticator.generate(account.totp_secret);
            await totpInput.click();
            await typeHuman(authPage, code);
            await randomDelay(500, 800);
            await authPage.locator('#totpNext, button:has-text("Next"), button:has-text("下一步")').first().click();
            step = 'totp';
            console.log('    [CPA] Entered TOTP:', code);
            await randomDelay(2000, 3000);
            continue;
          }

          // "Try another way" → authenticator
          const tryAnother = authPage.locator('button, a').filter({ hasText: /try another|其他方式|其他验证/i }).first();
          if (await tryAnother.isVisible({ timeout: 2000 }).catch(() => false)) {
            await tryAnother.click();
            await randomDelay(1000, 1500);
            const authOpt = authPage.locator('li, div[role="link"], button, a').filter({ hasText: /authenticator|验证器|身份验证器/i }).first();
            if (await authOpt.isVisible({ timeout: 2000 }).catch(() => false)) {
              await authOpt.click();
              await randomDelay(1000, 1500);
            }
            continue;
          }
        }
      }

      // C. OAuth consent page
      const btnTexts = ['Allow', 'Continue', 'Authorize', '允许', '继续', '授权', '同意', '계속', '下一步'];
      for (const txt of btnTexts) {
        try {
          const btn = authPage.getByRole('button', { name: txt });
          if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
            await btn.click();
            step = 'consent';
            console.log(`    [CPA] Clicked "${txt}"`);
            await randomDelay(2000, 3000);
            break;
          }
        } catch {}
      }
      await randomDelay(2000, 3000);
    }

    // Wait more for redirect if needed
    if (!callbackUrl) {
      for (let i = 0; i < 15; i++) {
        if (callbackUrl) break;
        try {
          const u = authPage.url();
          if (u.includes('localhost:1455')) { callbackUrl = u; break; }
        } catch { break; }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    // Debug screenshot before closing
    const { screenshotPath } = require('./utils');
    try { await authPage.screenshot({ path: screenshotPath(email + '_cpa_auth'), fullPage: false }); } catch {}
    await authPage.close().catch(() => {});

    // Remove the route interceptor
    await context.unroute('http://localhost:1455/**').catch(() => {});

    if (!callbackUrl) {
      console.log('    [CPA] Failed to capture callback URL');
      return false;
    }
    console.log('    [CPA] Callback:', callbackUrl.slice(0, 80) + '...');

    // Step 6: Submit callback URL to CPA page
    console.log('    [CPA] Submitting callback URL...');
    await cpaPage.bringToFront();
    const callbackInput = cpaPage.getByRole('textbox', { name: /回调 URL/i });
    await callbackInput.waitFor({ state: 'visible', timeout: 5000 });
    await callbackInput.fill(callbackUrl);
    await randomDelay(500, 800);

    await cpaPage.getByRole('button', { name: /提交回调 URL/i }).click();
    await randomDelay(2000, 3000);

    // Check result
    const pageText = await cpaPage.textContent('body').catch(() => '');
    if (pageText.includes('成功') || pageText.includes('success') || pageText.includes('已保存') || pageText.includes('完成')) {
      console.log('    [CPA] OAuth credentials saved!');
    } else {
      console.log('    [CPA] Submitted. Check CPA for result.');
    }

    return true;
  } catch (error) {
    console.log(`    [CPA] Error: ${error.message}`);
    return false;
  } finally {
    // Don't close - it's the main page, browser will be killed by index.js
  }
}

module.exports = { registerToCPA };
