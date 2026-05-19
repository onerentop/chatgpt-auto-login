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
    for (let i = 0; i < 10; i++) {
      if (authCode) break;
      const url = page.url();
      if (i === 0) console.log('  [PKCE] Auth page URL:', url.slice(0, 80));
      if (url.includes('localhost:1455')) { try { const u = new URL(url); authCode = u.searchParams.get('code'); } catch {} break; }

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
