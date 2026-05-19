const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { parse } = require('csv-parse/sync');
const { authenticator } = require('otplib');

let _screenSize = null;
function getScreenQuarter() {
  if (!_screenSize) {
    try {
      const out = execSync('powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds | Select Width,Height | ConvertTo-Json"', { encoding: 'utf-8', timeout: 5000 });
      const { Width, Height } = JSON.parse(out);
      _screenSize = { w: Math.floor(Width / 2), h: Math.floor(Height / 2) };
    } catch {
      _screenSize = { w: 960, h: 540 };
    }
  }
  return _screenSize;
}

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

async function _fetchPkceOtp(page, account) {
  const { ImapFlow } = require('imapflow');
  const tokenBody = new URLSearchParams({ client_id: account.client_id, grant_type: 'refresh_token', refresh_token: account.refresh_token, scope: 'https://outlook.office.com/IMAP.AccessAsUser.All' });
  const tokenRes = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', { method: 'POST', body: tokenBody });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) { console.log('  [PKCE] IMAP token failed'); return null; }

  // Get baseline UID FIRST (before triggering new email)
  let baseline = 0;
  try {
    const pre = new ImapFlow({ host: 'outlook.office365.com', port: 993, secure: true, auth: { user: account.email, accessToken: tokenData.access_token }, logger: false });
    await pre.connect(); const lock = await pre.getMailboxLock('INBOX');
    console.log(`  [PKCE] INBOX total: ${pre.mailbox.exists}`);
    const s = Math.max(1, pre.mailbox.exists - 9);
    for await (const m of pre.fetch({ seq: `${s}:*` }, { uid: true })) { if (m.uid > baseline) baseline = m.uid; }
    lock.release(); await pre.logout();
  } catch (e) { console.log(`  [PKCE] Baseline error: ${e.message?.slice(0, 50)}`); }

  // THEN click resend to trigger fresh code
  try {
    const resend = page.locator('button, a').filter({ hasText: /重新发送|Resend/i }).first();
    if (await resend.isVisible({ timeout: 2000 }).catch(() => false)) { await resend.click(); console.log('  [PKCE] Clicked resend'); await new Promise(r => setTimeout(r, 2000)); }
  } catch {}

  console.log(`  [PKCE] Baseline UID: ${baseline}`);

  // Poll for OTP
  let lastResend = Date.now();
  for (let a = 0; a < 20; a++) {
    if (Date.now() - lastResend > 45000) {
      try { const rb = page.locator('button, a').filter({ hasText: /重新发送|Resend/i }).first(); if (await rb.isVisible({ timeout: 1000 }).catch(() => false)) { await rb.click(); lastResend = Date.now(); console.log('  [PKCE] Resend clicked'); } } catch {}
    }
    let client;
    try {
      client = new ImapFlow({ host: 'outlook.office365.com', port: 993, secure: true, auth: { user: account.email, accessToken: tokenData.access_token }, logger: false });
      await client.connect(); const lock = await client.getMailboxLock('INBOX');
      let newMsgCount = 0;
      for await (const msg of client.fetch({ uid: `${baseline + 1}:*` }, { envelope: true, source: true, uid: true })) {
        if (msg.uid <= baseline) continue;
        newMsgCount++;
        const subject = msg.envelope?.subject || '';
        const from = msg.envelope?.from?.[0]?.address || '';
        if (a === 0) console.log(`  [PKCE] New mail UID:${msg.uid} from:${from} subj:${subject.slice(0, 40)}`);
        if (subject.includes('ChatGPT') || subject.includes('验证') || subject.includes('OpenAI') || subject.includes('code') || subject.includes('verify') || subject.includes('代码') || from.includes('openai')) {
          // Try subject first (e.g. "你的 OpenAI 代码为 382661")
          const subjectMatch = subject.match(/\b(\d{6})\b/);
          if (subjectMatch) { lock.release(); await client.logout(); console.log(`  [PKCE] Got OTP from subject: ${subjectMatch[1]} (UID:${msg.uid})`); return subjectMatch[1]; }
          // Then try HTML body
          const src = msg.source?.toString() || '';
          const html = src.indexOf('<html') > -1 ? src.slice(src.indexOf('<html')).replace(/<[^>]+>/g, ' ') : src;
          const match = html.match(/\b(\d{6})\b/);
          if (match) { lock.release(); await client.logout(); console.log(`  [PKCE] Got OTP from body: ${match[1]} (UID:${msg.uid})`); return match[1]; }
        }
      }
      lock.release(); await client.logout();
      if (a === 0 && newMsgCount === 0) console.log('  [PKCE] No new emails after baseline');
    } catch (e) { if (a === 0) console.log(`  [PKCE] IMAP error: ${e.message?.slice(0, 50)}`); try { await client?.logout(); } catch {} }
    if (a % 5 === 4) console.log(`  [PKCE] OTP attempt ${a + 1}/20 - waiting...`);
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log('  [PKCE] OTP not received after 20 attempts'); return null;
}

async function fetchTokensViaPKCE(browser, account, lastOtp) {
  const crypto = require('crypto');
  const context = browser.contexts()[0];

  // Generate PKCE pair
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  const clientId = 'app_EMoamEEZ73f0CkXaXp7hrann';
  const redirectUri = 'http://localhost:1455/auth/callback';
  const state = crypto.randomBytes(16).toString('hex');

  const authUrl = `https://auth.openai.com/oauth/authorize?client_id=${clientId}&code_challenge=${codeChallenge}&code_challenge_method=S256&codex_cli_simplified_flow=true&id_token_add_organizations=true&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid+email+profile+offline_access&state=${state}`;

  // Navigate to chatgpt.com/api/auth/session to refresh session cookies on both domains
  const ctxPages = context.pages();
  const mainPage = ctxPages.length > 0 ? ctxPages[0] : await context.newPage();
  console.log('  [PKCE] Refreshing session cookies...');
  await mainPage.goto('https://chatgpt.com/api/auth/session', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 1000));
  await mainPage.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));

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

    // State machine for auth.openai.com pages
    const handled = {};
    for (let i = 0; i < 20; i++) {
      if (authCode) break;
      const url = page.url();
      if (i === 0) console.log('  [PKCE] Auth page:', url.slice(0, 80));

      // SUCCESS: redirected to localhost
      if (url.includes('localhost:1455')) {
        try { authCode = new URL(url).searchParams.get('code'); } catch {}
        break;
      }

      // STATE 1: choose-an-account
      if (url.includes('choose-an-account')) {
        console.log('  [PKCE] State: choose-an-account');
        const acct = page.locator('button, a, div[role="button"]').filter({ hasText: new RegExp(account.email.split('@')[0], 'i') }).first();
        if (await acct.isVisible({ timeout: 2000 }).catch(() => false)) { await acct.click(); console.log('  [PKCE] Selected account'); }
        else { const f = page.locator('button, div[role="button"]').first(); await f.click().catch(() => {}); console.log('  [PKCE] Clicked first account'); }
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // STATE 2: log-in (enter email → OTP)
      if (!handled.login && url.includes('auth.openai.com') && (url.includes('log-in') || url.includes('login')) && !url.includes('email-verification')) {
        handled.login = true;
        console.log('  [PKCE] State: log-in');
        await page.waitForLoadState('networkidle').catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
        const emailField = page.locator('input[type="email"], input[name="email"]').first();
        if (await emailField.isVisible({ timeout: 3000 }).catch(() => false)) {
          await emailField.click();
          await emailField.fill(account.email);
          await new Promise(r => setTimeout(r, 800));
          const btn = page.locator('button').filter({ hasText: /继续|Continue/i }).first();
          if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) await btn.click({ force: true });
          else await page.evaluate(() => { for (const b of document.querySelectorAll('button')) if (b.textContent.includes('继续') || b.textContent.includes('Continue')) { b.click(); return; } });
          console.log('  [PKCE] Email submitted');
        }
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // STATE 3: email-verification (OTP)
      if (url.includes('email-verification') || url.includes('check-your-email') || await page.locator('input[name="code"]').isVisible({ timeout: 1000 }).catch(() => false)) {
        if (handled.otp) { await new Promise(r => setTimeout(r, 2000)); continue; }
        handled.otp = true;
        console.log('  [PKCE] State: email-verification');

        // Try reusing login OTP first (OpenAI sends same code for same session)
        let otp = lastOtp || null;
        if (otp) {
          console.log(`  [PKCE] Reusing login OTP: ${otp}`);
        } else if (account.client_id && account.refresh_token) {
          otp = await _fetchPkceOtp(page, account);
        }
        if (otp) {
            await page.evaluate((code) => {
              const inp = document.querySelector('input[name="code"], input[type="text"]');
              if (inp) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inp, code); inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); }
            }, otp);
            await new Promise(r => setTimeout(r, 800));
            await page.evaluate(() => { for (const b of document.querySelectorAll('button')) if (['继续','Continue'].includes(b.textContent.trim())) { b.click(); return; } });
            console.log('  [PKCE] OTP submitted');
        } else {
          console.log('  [PKCE] No OTP available, giving up');
          break;
        }
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // STATE 4: about-you (first-time registration)
      if (url.includes('about-you') || url.includes('about')) {
        if (!handled.about) {
          handled.about = true;
          console.log('  [PKCE] State: about-you (skipping — already handled at login)');
        }
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // STATE 5: consent / any page with Continue button
      const clicked = await page.evaluate(() => {
        for (const b of document.querySelectorAll('button')) {
          const t = b.textContent.trim();
          if (['继续','Continue','Authorize','允许','同意','Accept'].includes(t)) { b.click(); return t; }
        }
        return null;
      });
      if (clicked) console.log(`  [PKCE] Clicked "${clicked}"`);
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

module.exports = { loadAccounts, generateTOTP, randomDelay, saveResult, saveSessionData, screenshotPath, saveCPAAuthFile, fetchTokensViaPKCE, getScreenQuarter };
