const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { authenticator } = require('otplib');

function loadAccounts(csvPath) {
  const content = fs.readFileSync(csvPath, 'utf-8');
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const valid = [];
  for (const record of records) {
    if (!record.email || !record.password) {
      console.log(`[SKIP] Incomplete row: ${record.email || 'no email'}`);
      continue;
    }
    // Auto-detect login type by email domain
    const domain = record.email.split('@')[1]?.toLowerCase() || '';
    const isOutlook = ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain);
    record.loginType = isOutlook ? 'outlook' : 'google';

    if (record.loginType === 'google') {
      if (!record.totp_secret) {
        console.log(`[SKIP] Missing TOTP for Google account: ${record.email}`);
        continue;
      }
      try {
        authenticator.generate(record.totp_secret);
      } catch {
        console.log(`[SKIP] Invalid TOTP secret for ${record.email}`);
        continue;
      }
    }
    valid.push(record);
    console.log(`[LOAD] ${record.email} (${record.loginType})`);
  }
  return valid;
}

function generateTOTP(secret) {
  return authenticator.generate(secret);
}

function randomDelay(minMs, maxMs) {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function saveResult(resultsPath, result) {
  try {
    const header = 'email,status,duration_s,failure_reason,checkout_url\n';
    const checkoutUrl = (result.checkoutUrl || '').replace(/,/g, '%2C');
    const reason = (result.reason || '').replace(/,/g, ';');
    const line = `${result.email},${result.status},${result.duration},${reason},${checkoutUrl}\n`;

    if (!fs.existsSync(resultsPath)) {
      fs.writeFileSync(resultsPath, header + line);
    } else {
      fs.appendFileSync(resultsPath, line);
    }
  } catch (e) {
    console.log(`[WARN] Failed to write results.csv: ${e.message.slice(0, 60)}`);
  }
}

function saveSessionData(sessionsDir, result) {
  if (!result.session || !result.accessToken) return;
  try {
  const sanitized = result.email.replace(/[@.]/g, '_');
  const filePath = path.join(sessionsDir, `${sanitized}.json`);
  const data = {
    email: result.email,
    accessToken: result.accessToken,
    session: result.session,
    checkoutUrl: result.checkoutUrl || '',
    checkoutError: result.checkoutError || '',
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (e) {
    console.log(`[WARN] Failed to write session: ${e.message.slice(0, 60)}`);
  }
}

function screenshotPath(email) {
  const sanitized = email.replace(/[@.]/g, '_');
  return path.join(__dirname, 'screenshots', `${sanitized}.png`);
}

async function fetchTokensViaPKCE(browser, account) {
  const crypto = require('crypto');
  const context = browser.contexts()[0];

  // Generate PKCE pair
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  const clientId = 'app_EMoamEEZ73f0CkXaXp7hrann';
  const redirectUri = 'http://localhost:1455/auth/callback';
  const state = crypto.randomBytes(16).toString('hex');

  const authUrl = `https://auth.openai.com/oauth/authorize?client_id=${clientId}&code_challenge=${codeChallenge}&code_challenge_method=S256&codex_cli_simplified_flow=true&id_token_add_organizations=true&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid+email+profile+offline_access&state=${state}`;

  // Ensure we're on chatgpt.com first (session cookies needed for auto-auth)
  const ctxPages = context.pages();
  const mainPage = ctxPages.length > 0 ? ctxPages[0] : await context.newPage();
  const currentUrl = mainPage.url();
  if (!currentUrl.includes('chatgpt.com') && !currentUrl.includes('auth.openai.com')) {
    console.log('  [PKCE] Navigating back to chatgpt.com first...');
    await mainPage.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
  }

  // Intercept localhost redirect to capture the authorization code
  let authCode = null;
  await context.route('http://localhost:1455/**', (route) => {
    const url = new URL(route.request().url());
    authCode = url.searchParams.get('code');
    route.abort();
  });

  // Use current page (same tab, user already logged in)
  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();
  try {
    await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

    // Handle auth pages: choose-an-account, login, consent
    let loginDone = false;
    for (let i = 0; i < 15; i++) {
      if (authCode) break;
      const url = page.url();
      if (i === 0) console.log('  [PKCE] Auth page URL:', url.slice(0, 80));
      if (url.includes('localhost:1455')) { try { const u = new URL(url); authCode = u.searchParams.get('code'); } catch {} break; }

      // log-in page → enter email, then handle OTP (only once)
      if (!loginDone && url.includes('auth.openai.com') && (url.includes('log-in') || url.includes('login'))) {
        loginDone = true;
        console.log('  [PKCE] Login page detected, entering email...');
        try {
          // Enter email
          const emailField = page.locator('input[type="email"], input[name="email"]').first();
          if (await emailField.isVisible({ timeout: 3000 }).catch(() => false)) {
            await emailField.click();
            await emailField.fill(account.email);
            await new Promise(r => setTimeout(r, 500));
            const contBtn = page.locator('button').filter({ hasText: /继续|Continue/i }).first();
            await contBtn.click();
            console.log('  [PKCE] Email submitted');
            await new Promise(r => setTimeout(r, 3000));
            await page.waitForLoadState('domcontentloaded').catch(() => {});
            await new Promise(r => setTimeout(r, 2000));

            // Check page content for OTP input (URL might still be the same)
            const hasOtpInput = await page.locator('input[name="code"], input[type="text"]').first().isVisible({ timeout: 3000 }).catch(() => false);
            const pageUrl = page.url();
            if (hasOtpInput || pageUrl.includes('email-verification') || pageUrl.includes('check-your-email')) {
              // OTP needed — use IMAP to get code
              if (account.client_id && account.refresh_token) {
                console.log('  [PKCE] Fetching OTP for PKCE auth...');
                const { ImapFlow } = require('imapflow');
                const tokenBody = new URLSearchParams({ client_id: account.client_id, grant_type: 'refresh_token', refresh_token: account.refresh_token, scope: 'https://outlook.office.com/IMAP.AccessAsUser.All' });
                const tokenRes = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', { method: 'POST', body: tokenBody });
                const tokenData = await tokenRes.json();
                if (tokenData.access_token) {
                  // Click resend first
                  try {
                    const resend = page.locator('button, a').filter({ hasText: /重新发送|Resend/i }).first();
                    if (await resend.isVisible({ timeout: 1500 }).catch(() => false)) await resend.click();
                  } catch {}

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
                          if (match) { otp = match[1]; console.log(`  [PKCE] Got OTP: ${otp}`); }
                        }
                      }
                      lock.release(); await client.logout();
                    } catch { try { await client?.logout(); } catch {} }
                    if (otp) break;
                    if (a % 5 === 4) console.log(`  [PKCE] OTP attempt ${a + 1}/20...`);
                    await new Promise(r => setTimeout(r, 3000));
                  }

                  if (otp) {
                    await page.evaluate((code) => {
                      const inp = document.querySelector('input[name="code"], input[type="text"]');
                      if (inp) { const ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; ns.call(inp, code); inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); }
                    }, otp);
                    await new Promise(r => setTimeout(r, 800));
                    await page.evaluate(() => { const b = document.querySelectorAll('button'); for (const btn of b) { if (btn.textContent.trim() === '继续' || btn.textContent.trim() === 'Continue') { btn.click(); return; } } });
                    console.log('  [PKCE] OTP submitted');
                    await new Promise(r => setTimeout(r, 3000));
                  }
                }
              }
            }
            continue;
          }
        } catch (e) { console.log('  [PKCE] Login error:', e.message?.slice(0, 60)); }
      }

      // choose-an-account → click matching account
      if (url.includes('choose-an-account')) {
        try {
          const acct = page.locator('button, a, div[role="button"]').filter({ hasText: new RegExp(account.email.split('@')[0], 'i') }).first();
          if (await acct.isVisible({ timeout: 1500 }).catch(() => false)) {
            await acct.click();
            console.log('  [PKCE] Selected account');
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          // Fallback: first clickable account
          const first = page.locator('button, div[role="button"]').first();
          if (await first.isVisible({ timeout: 1000 }).catch(() => false)) { await first.click(); await new Promise(r => setTimeout(r, 2000)); continue; }
        } catch {}
      }

      // Continue/Authorize buttons
      const btnTexts = ['继续', 'Continue', 'Authorize', '允许', '同意', '계속'];
      for (const txt of btnTexts) {
        try {
          const btn = page.getByRole('button', { name: txt });
          if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
            await btn.click();
            console.log(`  [PKCE] Clicked "${txt}"`);
            break;
          }
        } catch {}
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  } finally {
    await context.unroute('http://localhost:1455/**').catch(() => {});
  }

  if (!authCode) {
    console.log('  [PKCE] Failed to get authorization code');
    return null;
  }
  console.log('  [PKCE] Got authorization code');

  // Exchange code for tokens
  try {
    const res = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: clientId,
        code: authCode,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }),
    });
    const tokens = await res.json();
    if (tokens.access_token) {
      console.log('  [PKCE] Token exchange successful');
      return {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || '',
        id_token: tokens.id_token || '',
        expires_in: tokens.expires_in || 3600,
      };
    }
    console.log('  [PKCE] Token exchange failed:', tokens.error || JSON.stringify(tokens).slice(0, 100));
    return null;
  } catch (e) {
    console.log('  [PKCE] Token exchange error:', e.message);
    return null;
  }
}

function saveCPAAuthFile(email, accessToken, session) {
  const authDir = path.join(__dirname, 'cpa-auth');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
  const sanitized = email.replace(/@/g, '-at-').replace(/\./g, '-');
  const filePath = path.join(authDir, `codex-${sanitized}.json`);

  // Extract account_id from JWT payload
  let accountId = '';
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64').toString());
    accountId = payload['https://api.openai.com/auth']?.chatgpt_account_id || '';
  } catch {}

  // Get refresh_token and id_token from PKCE tokens or session
  const refreshToken = session?.refresh_token || session?.refreshToken || '';
  const idToken = session?.id_token || session?.idToken || '';

  const now = new Date();
  const expired = new Date(now.getTime() + 10 * 24 * 3600000); // 10 days

  const data = {
    access_token: accessToken,
    account_id: accountId,
    email: email,
    expired: expired.toISOString().replace('Z', '+08:00'),
    id_token: idToken,
    last_refresh: now.toISOString().replace('Z', '+08:00'),
    refresh_token: refreshToken,
    type: 'codex',
  };

  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`  [CPA-Auth] Saved: ${filePath}`);
    return filePath;
  } catch (e) {
    console.log(`  [CPA-Auth] Failed: ${e.message.slice(0, 60)}`);
    return null;
  }
}

module.exports = { loadAccounts, generateTOTP, randomDelay, saveResult, saveSessionData, screenshotPath, saveCPAAuthFile, fetchTokensViaPKCE };
