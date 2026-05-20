const { generateTOTP, randomDelay, screenshotPath } = require('./utils');

const CHATGPT_URL = 'https://chatgpt.com';
const SESSION_URL = 'https://chatgpt.com/api/auth/session';
const CHECKOUT_URL = 'https://chatgpt.com/backend-api/payments/checkout';
const TIMEOUT = 60000;

async function loginAccount(browser, account) {
  const startTime = Date.now();
  const context = browser.contexts()[0] || await browser.newContext();
  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  let lastOtp = null;
  try {
    console.log(`  [1/10] Navigating to ChatGPT...`);
    await page.goto(CHATGPT_URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await randomDelay(1000, 2000);

    console.log(`  [2/10] Clicking Log in...`);
    // Try header login button first, then sidebar
    const headerBtn = page.locator('header button, header a, nav button, nav a').filter({ hasText: /^(Log\s*in|登录)$/i }).first();
    const testIdBtn = page.locator('[data-testid="login-button"]').first();
    const sidebarBtn = page.locator('aside button, [class*="sidebar"] button').filter({ hasText: /^(Log\s*in|登录)$/i }).first();
    for (const btn of [testIdBtn, headerBtn, sidebarBtn]) {
      try {
        const visible = await btn.isVisible({ timeout: 3000 }).catch(() => false);
        if (visible) {
          await btn.click();
          break;
        }
      } catch (e) { console.log(`[WARN] Login button click: ${e.message?.slice(0, 60)}`); }
    }
    // Wait for login dialog or page navigation
    await randomDelay(2000, 3000);

    const isOutlook = account.loginType === 'outlook';

    if (isOutlook) {
      // ========== Outlook Login Path ==========
      console.log(`  [3/10] Entering email (Outlook)...`);
      // Wait for login dialog with email input - retry clicking login up to 3 times
      const emailField = page.locator('dialog input[type="email"], dialog input, [role="dialog"] input, input[name="email"], input[placeholder*="邮件" i], input[placeholder*="email" i]').first();
      let emailVisible = false;
      for (let retry = 0; retry < 3 && !emailVisible; retry++) {
        emailVisible = await emailField.isVisible({ timeout: 5000 }).catch(() => false);
        if (!emailVisible) {
          console.log(`  [3/10] Dialog not found, retrying login click (${retry + 1}/3)...`);
          const retryBtn = page.locator('[data-testid="login-button"], button, a').filter({ hasText: /^(Log\s*in|登录)$/i }).first();
          try { await retryBtn.click(); await randomDelay(2000, 3000); } catch (e) { console.log(`[WARN] Retry login click: ${e.message?.slice(0, 60)}`); }
        }
      }
      if (!emailVisible) throw new Error('Email input not found');
      await emailField.click();
      await typeHumanLike(page, account.email);
      await randomDelay(800, 1200);

      // Click "继续" / "Continue"
      const continueBtn = page.locator('dialog button, [role="dialog"] button, form button').filter({ hasText: /^(继续|Continue)$/i }).first();
      await continueBtn.click();
      await randomDelay(2000, 3000);

      // ChatGPT may show: verification code page, create password page, or login password page
      console.log(`  [4/10] Waiting for auth page...`);
      await page.waitForLoadState('domcontentloaded');
      await randomDelay(2000, 3000);

      // If on "创建密码" or password page, click "使用一次性验证码" to switch to OTP
      const otpSwitchBtn = page.locator('button, a').filter({ hasText: /一次性验证码|one-time code|verification code/i }).first();
      if (await otpSwitchBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log(`  [4/10] Password page detected, switching to OTP...`);
        await otpSwitchBtn.click();
        await randomDelay(2000, 3000);
      }

      // Verify we're on the code entry page
      const codeSelector = 'input[name="code"], input[aria-label*="验证" i], input[aria-label*="code" i], input[placeholder*="验证码" i], input[placeholder*="code" i]';
      const codeInput = page.locator(codeSelector).first()
        .or(page.getByLabel(/验证码|code/i).first())
        .or(page.getByPlaceholder(/验证码|code/i).first());
      await codeInput.waitFor({ state: 'visible', timeout: 15000 });
      // Click resend immediately to trigger a fresh code
      try {
        const resendBtn = page.locator('button, a').filter({ hasText: /重新发送|Resend/i }).first();
        if (await resendBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await resendBtn.click();
          console.log(`  [4/10] Clicked resend to trigger fresh code`);
          await randomDelay(1000, 1500);
        }
      } catch (e) { console.log(`[WARN] Resend click: ${e.message?.slice(0, 60)}`); }
      console.log(`  [4/10] Code input found. Fetching code from Outlook...`);

      // Get IMAP baseline BEFORE polling
      const { ImapFlow } = require('imapflow');
      const tokenBody = new URLSearchParams({
        client_id: account.client_id,
        grant_type: 'refresh_token',
        refresh_token: account.refresh_token,
        scope: 'https://outlook.office.com/IMAP.AccessAsUser.All',
      });
      const tokenRes = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', { method: 'POST', body: tokenBody });
      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) throw new Error('IMAP token failed: ' + (tokenData.error || ''));
      console.log(`  [4/10] IMAP token obtained`);

      // Get baseline UID - scan last 10 messages for the TRUE highest UID
      let baselineUid = 0;
      try {
        const pre = new ImapFlow({ host: 'outlook.office365.com', port: 993, secure: true, auth: { user: account.email, accessToken: tokenData.access_token }, logger: false });
        pre.on('error', () => {});
        await pre.connect();
        const lock = await pre.getMailboxLock('INBOX');
        try {
          if (pre.mailbox.exists > 0) {
            const start = Math.max(1, pre.mailbox.exists - 9);
            for await (const m of pre.fetch({ seq: `${start}:*` }, { uid: true })) {
              if (m.uid > baselineUid) baselineUid = m.uid;
            }
          }
        } finally {
          lock.release();
        }
        pre.close();
      } catch (e) {
        // baseline fetch failed, continue with baselineUid = 0
      }
      console.log(`  [4/10] Baseline UID: ${baselineUid}`);

      // Poll IMAP + auto-click "重新发送" every 15s
      let otp = null;
      let lastResendTime = 0;
      for (let attempt = 0; attempt < 20; attempt++) {
        // Auto-click "重新发送" every 45 seconds
        const now = Date.now();
        if (now - lastResendTime > 45000) {
          try {
            const resendBtn = page.locator('button, a').filter({ hasText: /重新发送|Resend/i }).first();
            if (await resendBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
              await resendBtn.click();
              lastResendTime = now;
              if (attempt > 0) console.log(`  [4/10] Clicked resend`);
            }
          } catch (e) { console.log(`[WARN] Auto-resend: ${e.message?.slice(0, 60)}`); }
        }

        // Check IMAP for new email
        let client;
        try {
          client = new ImapFlow({ host: 'outlook.office365.com', port: 993, secure: true, auth: { user: account.email, accessToken: tokenData.access_token }, logger: false });
          client.on('error', () => {});
          await client.connect();
          const lock = await client.getMailboxLock('INBOX');
          try {
            for await (const msg of client.fetch({ uid: `${baselineUid + 1}:*` }, { envelope: true, source: true, uid: true })) {
              if (msg.uid <= baselineUid) continue;
              const subject = msg.envelope?.subject || '';
              if (subject.includes('openai') || subject.includes('验证') || subject.includes('ChatGPT') || subject.includes('代码') || subject.toLowerCase().includes('verify') || subject.toLowerCase().includes('openai')) {
                // Try subject first (e.g. "你的 OpenAI 代码为 382661")
                const subjectMatch = subject.match(/\b(\d{6})\b/);
                if (subjectMatch) { otp = subjectMatch[1]; console.log(`  [4/10] Got code from subject: ${otp} (UID:${msg.uid})`); break; }
                // Then try HTML body (skip headers to avoid false matches)
                const src = msg.source?.toString() || '';
                const htmlStart = src.indexOf('<html');
                const bodyText = htmlStart > -1
                  ? src.slice(htmlStart).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
                  : src;
                const match = bodyText.match(/\b(\d{6})\b/);
                if (match) { otp = match[1]; console.log(`  [4/10] Got code: ${otp} (UID:${msg.uid})`); break; }
              }
            }
          } finally { lock.release(); }
        } catch (e) {
          if (attempt === 0) console.log(`  [4/10] IMAP: ${e.message.slice(0, 60)}`);
        } finally {
          try { client?.close(); } catch {}
        }

        if (otp) break;
        if (attempt % 5 === 4) console.log(`  [4/10] Attempt ${attempt + 1}/20 - waiting...`);
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (!otp) throw new Error('Failed to get verification code from Outlook');

      // Enter code via JS injection (ChatGPT auth uses custom React components)
      lastOtp = otp;
      console.log(`  [5/10] Entering verification code: ${otp}`);
      const entered = await page.evaluate((code) => {
        // Find any visible input on the page
        var inputs = document.querySelectorAll('input');
        for (var i = 0; i < inputs.length; i++) {
          var inp = inputs[i];
          if (inp.offsetHeight > 0 && inp.type !== 'hidden') {
            var ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            ns.call(inp, code);
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            return 'filled:' + (inp.name || inp.type || inp.id);
          }
        }
        return null;
      }, otp);
      console.log(`  [5/10] JS fill result: ${entered}`);

      if (!entered) {
        // Fallback: keyboard type
        await page.keyboard.type(otp, { delay: 80 });
        console.log(`  [5/10] Typed via keyboard`);
      }

      await randomDelay(800, 1200);
      // Click continue button
      await page.evaluate(() => {
        var btns = document.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
          var t = btns[i].textContent.trim();
          if (t === '继续' || t === 'Continue') { btns[i].click(); return t; }
        }
      });
      console.log(`  [5/10] Code submitted`);
      await randomDelay(2000, 3000);

      // Handle any consent/prompt
      console.log(`  [6/10] Handling prompts...`);
      try {
        const consentBtn = page.locator('button').filter({ hasText: /继续|Continue|Accept|同意|是/i }).first();
        if (await consentBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await consentBtn.click();
          console.log(`  [6/10] Clicked consent`);
          await randomDelay(2000, 3000);
        }
      } catch (e) { console.log(`[WARN] Consent click: ${e.message?.slice(0, 60)}`); }

    } else {
      // ========== Google Login Path ==========
      console.log(`  [3/10] Clicking Continue with Google...`);
      const googleBtn = page.locator('dialog button, [role="dialog"] button, form button, button, a')
        .filter({ hasText: /Google/i }).first();
      let googleVisible = await googleBtn.isVisible({ timeout: 5000 }).catch(() => false);
      if (!googleVisible) {
        console.log(`  [3/10] Dialog not found, retrying login click...`);
        const retryBtn = page.locator('button, a').filter({ hasText: /^(Log\s*in|登录)$/i }).first();
        try { await retryBtn.click(); await randomDelay(2000, 3000); } catch (e) { console.log(`[WARN] Google retry click: ${e.message?.slice(0, 60)}`); }
        googleVisible = await googleBtn.isVisible({ timeout: 8000 }).catch(() => false);
      }
      if (!googleVisible) throw new Error('Google login button not found after retries');
      await googleBtn.click();
      await randomDelay(1000, 2000);

      console.log(`  [4/10] Entering email...`);
      await page.waitForLoadState('domcontentloaded');
      const emailInput = page.locator('input[type="email"], #identifierId').first();
      await emailInput.waitFor({ state: 'visible', timeout: 15000 });
      await emailInput.click();
      await typeHumanLike(page, account.email);
      await randomDelay(800, 1500);
      await page.locator('#identifierNext').first().click();
      await randomDelay(1000, 2000);

      console.log(`  [5/10] Entering password...`);
      await page.waitForLoadState('domcontentloaded');
      const passwordInput = page.locator('input[type="password"], input[name="Passwd"]').first();
      await passwordInput.waitFor({ state: 'visible', timeout: 15000 });
      await passwordInput.click();
      await typeHumanLike(page, account.password);
      await randomDelay(800, 1500);
      await page.locator('#passwordNext').first().click();
      await randomDelay(2000, 3000);

      console.log(`  [6/10] Handling 2FA...`);
      await page.waitForLoadState('domcontentloaded');
      await handleTOTP(page, account.totp_secret);

      await randomDelay(1000, 2000);
      try {
        const consentBtn = page.locator('button, div[role="button"]').filter({
          hasText: /^(Continue|계속|继续|許可|允许|Allow|Next|下一步|下一頁)$/i
        }).first();
        if (await consentBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          console.log(`  [6.5/10] Clicking OAuth consent...`);
          await consentBtn.click();
          await randomDelay(2000, 3000);
        }
      } catch (e) { console.log(`[WARN] OAuth consent: ${e.message?.slice(0, 60)}`); }
    } // end Google path

    console.log(`  [7/10] Waiting for redirect...`);
    try {
      await page.waitForURL(/chat(gpt)?\.openai\.com|chatgpt\.com|auth\.openai\.com\/about/, { timeout: 8000 });
    } catch {}
    await randomDelay(2000, 3000);

    // Handle first-time account creation (name + age) only if on that page
    const pageUrl = page.url();
    if (pageUrl.includes('auth.openai.com/about') || pageUrl.includes('auth.openai.com/onboarding')) {
      await handleFirstTimeSetup(page);
      await randomDelay(2000, 3000);
    }

    // If still not on ChatGPT, wait a bit more
    if (!page.url().includes('chatgpt.com') && !page.url().includes('chat.openai.com')) {
      try { await page.waitForURL(/chat(gpt)?\.openai\.com|chatgpt\.com/, { timeout: 10000 }); } catch {}
    }

    console.log(`  [8/10] Verifying login...`);
    await randomDelay(1000, 2000);
    const currentUrl = page.url();
    await page.screenshot({ path: screenshotPath(account.email), fullPage: false });

    // If on chatgpt.com, consider logged in; otherwise check elements
    const isLoggedIn = currentUrl.includes('chatgpt.com') || currentUrl.includes('chat.openai.com') || await checkLoginSuccess(page, currentUrl);
    if (!isLoggedIn) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      return { email: account.email, status: 'error', duration, reason: 'Login verification failed - URL: ' + currentUrl.slice(0, 60) };
    }

    // Step 9: Get session / accessToken
    console.log(`  [9/10] Fetching session accessToken...`);
    const sessionData = await fetchSessionToken(page);
    if (!sessionData.accessToken) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      return { email: account.email, status: 'error', duration, reason: 'Failed to get accessToken', session: sessionData };
    }
    console.log(`  [9/10] accessToken obtained (${sessionData.accessToken.slice(0, 20)}...)`);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    return {
      email: account.email,
      status: 'success',
      duration,
      reason: '',
      accessToken: sessionData.accessToken,
      session: sessionData,
      lastOtp: lastOtp || '',
    };
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    try {
      await page.screenshot({ path: screenshotPath(account.email), fullPage: false });
    } catch {}
    return { email: account.email, status: 'error', duration, reason: error.message.slice(0, 200) };
  } finally {
    // Chrome process will be killed by index.js
  }
}

async function fetchSessionToken(page) {
  try {
    const response = await page.goto(SESSION_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const text = await page.locator('pre, body').first().textContent({ timeout: 5000 });
    const data = JSON.parse(text);
    return data;
  } catch (error) {
    console.log(`  [9/10] Session fetch error: ${error.message.slice(0, 100)}`);
    return {};
  }
}

async function typeHumanLike(page, text) {
  for (const char of text) {
    await page.keyboard.type(char, { delay: 50 + Math.random() * 100 });
  }
}

async function handleTOTP(page, totpSecret) {
  const totpInput = page.locator('input#totpPin, input[name="totpPin"], input[type="tel"][id*="otp"], input[type="tel"]').first();
  try {
    await totpInput.waitFor({ state: 'visible', timeout: 10000 });
    const code = generateTOTP(totpSecret);
    console.log(`  [6/10] Entering TOTP code: ${code}`);
    await totpInput.click();
    await typeHumanLike(page, code);
    await randomDelay(500, 1000);

    const totpNext = page.locator('#totpNext, button:has-text("Next"), button:has-text("下一步")').first();
    await totpNext.click();
    await randomDelay(2000, 3000);
  } catch {
    console.log(`  [6/10] No TOTP prompt detected, trying alternative 2FA methods...`);
    try {
      const tryAnother = page.locator('button, a').filter({ hasText: /try another|其他方式|其他验证/i }).first();
      const visible = await tryAnother.isVisible({ timeout: 3000 }).catch(() => false);
      if (visible) {
        await tryAnother.click();
        await randomDelay(1000, 2000);
        const authOption = page.locator('li, div[role="link"], button, a').filter({
          hasText: /authenticator|验证器|身份验证器|google auth/i
        }).first();
        const authVisible = await authOption.isVisible({ timeout: 3000 }).catch(() => false);
        if (authVisible) {
          await authOption.click();
          await randomDelay(1000, 2000);
          const retryInput = page.locator('input#totpPin, input[name="totpPin"], input[type="tel"]').first();
          await retryInput.waitFor({ state: 'visible', timeout: 10000 });
          const code = generateTOTP(totpSecret);
          console.log(`  [6/10] Entering TOTP code (retry): ${code}`);
          await retryInput.click();
          await typeHumanLike(page, code);
          await randomDelay(500, 1000);
          const nextBtn = page.locator('#totpNext, button:has-text("Next"), button:has-text("下一步")').first();
          await nextBtn.click();
          await randomDelay(2000, 3000);
        }
      }
    } catch {
      console.log(`  [6/10] 2FA handling failed, continuing anyway...`);
    }
  }
}

async function handleFirstTimeSetup(page) {
  // Handle account creation form (age field + "完成帐户创建")
  const ageInput = page.locator('input[name="age"], input[type="number"], input[placeholder*="age" i]')
    .or(page.locator('input').filter({ has: page.locator('xpath=ancestor::*[contains(text(),"年龄") or contains(text(),"age")]') }))
    .first();
  try {
    // Also try: any empty input on a page with "年龄" text
    const pageText = await page.textContent('body').catch(() => '');
    if (pageText.includes('年龄') || pageText.includes('How old') || pageText.includes('age')) {
      const firstNames = ['James','Robert','John','Michael','David','William','Richard','Joseph','Thomas','Christopher','Emma','Olivia','Sophia','Isabella','Mia','Charlotte','Amelia','Harper','Evelyn','Abigail'];
      const lastNames = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez','Wilson','Anderson','Taylor','Thomas','Moore','Jackson','Martin','Lee','Thompson','White'];
      const randName = firstNames[Math.floor(Math.random()*firstNames.length)] + ' ' + lastNames[Math.floor(Math.random()*lastNames.length)];
      const randAge = String(Math.floor(Math.random() * 8) + 18); // 18-25

      console.log(`  [7/10] Account creation: name="${randName}", age=${randAge}`);
      // Click name field → type → Tab → type age
      const nameField = page.locator('input:not([type="hidden"])').first();
      await nameField.click();
      await page.keyboard.type(randName, { delay: 40 });
      await randomDelay(300, 500);
      await page.keyboard.press('Tab');
      await randomDelay(300, 500);
      await page.keyboard.type(randAge, { delay: 40 });
      await randomDelay(800, 1000);

      // Click "完成帐户创建"
      const createBtn = page.locator('button').filter({ hasText: /完成帐户创建|完成帳戶創建|Create account|Complete|Continue|继续/i }).first();
      if (await createBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await page.waitForTimeout(500);
        console.log(`  [7/10] Clicking create account...`);
        await createBtn.click({ force: true });
        await randomDelay(5000, 6000);
      }
    }
  } catch (e) { console.log(`[WARN] First-time setup: ${e.message?.slice(0, 60)}`); }
}

async function checkLoginSuccess(page, url) {
  if (!url.includes('chatgpt.com') && !url.includes('chat.openai.com')) {
    return false;
  }

  const indicators = [
    page.locator('textarea, [contenteditable="true"]').first(),
    page.locator('[data-testid="profile-button"]').first(),
    page.locator('button[aria-label*="profile"], button[aria-label*="个人"]').first(),
    page.locator('nav a[href*="/gpts"]').first(),
    page.locator('button').filter({ hasText: /new chat|新聊天/i }).first(),
  ];

  for (const indicator of indicators) {
    try {
      const visible = await indicator.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) return true;
    } catch (e) { console.log(`[WARN] Login check: ${e.message?.slice(0, 60)}`); }
  }

  const loginBtnGone = await page.locator('[data-testid="login-button"]').isVisible({ timeout: 1000 }).catch(() => false);
  return !loginBtnGone;
}

module.exports = { loginAccount };
