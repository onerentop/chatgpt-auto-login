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

function screenshotPath(email) {
  const sanitized = email.replace(/[@.]/g, '_');
  return path.join(__dirname, 'screenshots', `${sanitized}.png`);
}

async function _fetchPkceOtp(page, account) {
  const { ImapFlow } = require('imapflow');
  const tokenBody = new URLSearchParams({ client_id: account.client_id, grant_type: 'refresh_token', refresh_token: account.refresh_token, scope: 'https://outlook.office.com/IMAP.AccessAsUser.All' });
  const tokenRes = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', { method: 'POST', body: tokenBody, signal: AbortSignal.timeout(15000) });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) { console.log(`  [PKCE] IMAP token failed: ${tokenData.error || 'no access_token'}`); return null; }

  // Get baseline UID FIRST (before triggering new email)
  let baseline = 0;
  try {
    const pre = new ImapFlow({ host: 'outlook.office365.com', port: 993, secure: true, auth: { user: account.email, accessToken: tokenData.access_token }, logger: false, connectionTimeout: 30000, greetingTimeout: 15000, socketTimeout: 60000 });
    pre.on('error', () => {});
    await pre.connect(); const lock = await pre.getMailboxLock('INBOX');
    console.log(`  [PKCE] INBOX total: ${pre.mailbox.exists}`);
    const s = Math.max(1, pre.mailbox.exists - 9);
    for await (const m of pre.fetch({ seq: `${s}:*` }, { uid: true })) { if (m.uid > baseline) baseline = m.uid; }
    lock.release(); pre.close();
  } catch (e) { console.log(`  [PKCE] Baseline error: ${e.message?.slice(0, 50)}`); }

  // THEN click resend to trigger fresh code
  try {
    const resend = page.locator('button, a').filter({ hasText: /重新发送|Resend/i }).first();
    if (await resend.isVisible({ timeout: 2000 }).catch(() => false)) { await resend.click(); console.log('  [PKCE] Clicked resend'); await new Promise(r => setTimeout(r, 2000)); }
  } catch (e) { console.log(`  [WARN] PKCE resend click: ${e.message?.slice(0, 60)}`); }

  console.log(`  [PKCE] Baseline UID: ${baseline}`);

  // Poll for OTP
  let lastResend = Date.now();
  for (let a = 0; a < 20; a++) {
    if (Date.now() - lastResend > 45000) {
      try { const rb = page.locator('button, a').filter({ hasText: /重新发送|Resend/i }).first(); if (await rb.isVisible({ timeout: 1000 }).catch(() => false)) { await rb.click(); lastResend = Date.now(); console.log('  [PKCE] Resend clicked'); } } catch (e) { console.log(`  [WARN] PKCE auto-resend: ${e.message?.slice(0, 60)}`); }
    }
    let client;
    try {
      client = new ImapFlow({ host: 'outlook.office365.com', port: 993, secure: true, auth: { user: account.email, accessToken: tokenData.access_token }, logger: false, connectionTimeout: 30000, greetingTimeout: 15000, socketTimeout: 60000 });
      client.on('error', () => {});
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
          if (subjectMatch) { lock.release(); client.close(); console.log(`  [PKCE] Got OTP from subject: ${subjectMatch[1]} (UID:${msg.uid})`); return subjectMatch[1]; }
          // Then try HTML body
          const src = msg.source?.toString() || '';
          const html = src.indexOf('<html') > -1 ? src.slice(src.indexOf('<html')).replace(/<[^>]+>/g, ' ') : src;
          const match = html.match(/\b(\d{6})\b/);
          if (match) { lock.release(); client.close(); console.log(`  [PKCE] Got OTP from body: ${match[1]} (UID:${msg.uid})`); return match[1]; }
        }
      }
      lock.release(); client.close();
      if (a === 0 && newMsgCount === 0) console.log('  [PKCE] No new emails after baseline');
    } catch (e) { if (a === 0) console.log(`  [PKCE] IMAP error: ${e.message?.slice(0, 50)}`); try { client?.close(); } catch {} }
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

  // Use current page — go directly to auth URL (don't load chatgpt.com SPA, it blocks navigation)
  const page = context.pages()[0] || await context.newPage();
  try { await page.evaluate(() => { window.onbeforeunload = null; }); } catch {}
  console.log(`  [PKCE] Current page: ${page.url().slice(0, 50)}`);

  // Capture authorization code via page event (context.route doesn't work on CDP Chrome)
  let authCode = null;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      const u = frame.url();
      if (u.includes('localhost:1455') && u.includes('code=')) {
        try { authCode = new URL(u).searchParams.get('code'); } catch {}
      }
    }
  });
  // Also listen for request to localhost (catches even failed navigations)
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('localhost:1455') && u.includes('code=')) {
      try { authCode = new URL(u).searchParams.get('code'); } catch {}
    }
  });

  try {
    console.log(`  [PKCE] Navigating to auth page...`);
    await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e) => { console.log(`  [PKCE] goto error: ${e.message?.slice(0, 60)}`); });
    console.log(`  [PKCE] Auth page: ${page.url().slice(0, 60)}`);

    // State machine for auth.openai.com pages
    const handled = {};
    for (let i = 0; i < 20; i++) {
      if (authCode) break;
      const url = page.url();
      if (i === 0) console.log('  [PKCE] Auth page:', url.slice(0, 80));

      // SUCCESS: redirected to localhost
      if (url.includes('localhost:1455')) {
        try { authCode = new URL(url).searchParams.get('code'); } catch (e) { console.log(`  [WARN] PKCE URL parse: ${e.message?.slice(0, 60)}`); }
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
          otp = await _fetchPkceOtp(page, account).catch(e => { console.log(`  [PKCE] OTP fetch error: ${e.message?.slice(0, 60)}`); return null; });
        }
        if (otp) {
            // Debug: dump page state before filling
            const pageState = await page.evaluate(() => {
              const inputs = Array.from(document.querySelectorAll('input')).map(i => ({ tag: 'input', type: i.type, name: i.name, placeholder: i.placeholder, id: i.id, visible: i.offsetHeight > 0 }));
              const iframes = document.querySelectorAll('iframe').length;
              const shadows = Array.from(document.querySelectorAll('*')).filter(e => e.shadowRoot).length;
              return { url: location.href, inputs, iframes, shadows, bodyLen: document.body?.innerHTML?.length };
            }).catch(e => ({ error: e.message }));
            console.log(`  [PKCE] Page state before fill: ${JSON.stringify(pageState)}`);

            // Also check all frames
            const allFrames = page.frames();
            for (let fi = 0; fi < allFrames.length; fi++) {
              const fInputs = await allFrames[fi].evaluate(() => Array.from(document.querySelectorAll('input')).map(i => ({ type: i.type, name: i.name, placeholder: i.placeholder, visible: i.offsetHeight > 0 }))).catch(() => []);
              if (fInputs.length > 0) console.log(`  [PKCE] Frame ${fi} (${allFrames[fi].url().slice(0, 50)}): ${JSON.stringify(fInputs)}`);
            }

            // Fill OTP via React setter (same approach as login.js)
            const filled = await page.evaluate((code) => {
              var inputs = document.querySelectorAll('input');
              for (var i = 0; i < inputs.length; i++) {
                var inp = inputs[i];
                if (inp.offsetHeight > 0 && inp.type !== 'hidden') {
                  var ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                  ns.call(inp, code);
                  inp.dispatchEvent(new Event('input', { bubbles: true }));
                  inp.dispatchEvent(new Event('change', { bubbles: true }));
                  return 'filled:' + (inp.name || inp.type || inp.id || 'unknown');
                }
              }
              return null;
            }, otp);
            console.log(`  [PKCE] OTP fill result: ${filled}`);
            if (!filled) {
              await page.keyboard.type(otp, { delay: 80 });
              console.log('  [PKCE] OTP typed via keyboard fallback');
            }
            await new Promise(r => setTimeout(r, 800));
            await page.evaluate(() => { for (const b of document.querySelectorAll('button')) if (['继续','Continue'].includes(b.textContent.trim())) { b.click(); return; } });
            console.log('  [PKCE] OTP submitted');

            // Check if OTP was accepted — if still on email-verification, code was wrong
            await new Promise(r => setTimeout(r, 3000));
            const stillOnVerify = page.url().includes('email-verification');
            if (stillOnVerify && account.client_id && account.refresh_token) {
              console.log('  [PKCE] OTP rejected, resending and fetching fresh code...');
              // _fetchPkceOtp handles: get baseline → click resend → poll IMAP → return code
              const freshOtp = await _fetchPkceOtp(page, account).catch(e => { console.log(`  [PKCE] Fresh OTP fetch error: ${e.message?.slice(0, 60)}`); return null; });
              if (freshOtp) {
                console.log(`  [PKCE] Fresh OTP: ${freshOtp}`);
                const retryFilled = await page.evaluate((code) => {
                  var inputs = document.querySelectorAll('input');
                  for (var i = 0; i < inputs.length; i++) {
                    var inp = inputs[i];
                    if (inp.offsetHeight > 0 && inp.type !== 'hidden') {
                      var ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                      ns.call(inp, '');
                      inp.dispatchEvent(new Event('input', { bubbles: true }));
                      ns.call(inp, code);
                      inp.dispatchEvent(new Event('input', { bubbles: true }));
                      inp.dispatchEvent(new Event('change', { bubbles: true }));
                      return true;
                    }
                  }
                  return false;
                }, freshOtp);
                console.log(`  [PKCE] Fresh OTP filled: ${retryFilled}`);
                await new Promise(r => setTimeout(r, 800));
                await page.evaluate(() => { for (const b of document.querySelectorAll('button')) if (['继续','Continue'].includes(b.textContent.trim())) { b.click(); return; } });
                console.log('  [PKCE] Fresh OTP submitted');
              } else {
                console.log('  [PKCE] Fresh OTP not received');
              }
              handled.otp = false;
            }
        } else {
          console.log('  [PKCE] No OTP available, giving up');
          break;
        }
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // STATE: add-phone (OpenAI requires phone verification for Codex)
      if (url.includes('add-phone') || url.includes('phone-required')) {
        console.log('  [PKCE] State: add-phone — phone verification required, skipping PKCE');
        return { needsPhone: true };
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
  } catch (e) {
    console.log(`  [PKCE] Loop error: ${e.message?.slice(0, 60)}`);
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

  // Parse JWT
  let payload = {};
  try { payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64').toString()); } catch {}
  const authClaim = payload['https://api.openai.com/auth'] || {};
  const accountId = authClaim.chatgpt_account_id || '';
  const userId = authClaim.chatgpt_user_id || authClaim.user_id || '';
  const planType = authClaim.chatgpt_plan_type || session?.account?.planType || 'free';
  const refreshToken = session?.refresh_token || session?.refreshToken || '';
  const idToken = session?.id_token || session?.idToken || '';
  const now = new Date();
  const toCST = (d) => { const t = new Date(d.getTime() + 8 * 3600000); return t.toISOString().replace('Z', '+08:00'); };
  const expiresAt = payload.exp ? toCST(new Date(payload.exp * 1000)) : toCST(new Date(now.getTime() + 10 * 24 * 3600000));
  const exportedAt = toCST(now);

  // CPA format
  const cpa = {
    access_token: accessToken, account_id: accountId, email,
    expired: expiresAt, id_token: idToken, last_refresh: exportedAt,
    refresh_token: refreshToken, type: 'codex',
  };
  const cpaPath = path.join(authDir, `codex-${sanitized}.json`);
  try { fs.writeFileSync(cpaPath, JSON.stringify(cpa, null, 2)); console.log(`  [CPA] Saved: ${cpaPath}`); } catch (e) { console.log(`  [CPA] Failed: ${e.message?.slice(0, 60)}`); }

  // Sub2API format
  const sub2apiDoc = {
    exported_at: now.toISOString(), proxies: [],
    accounts: [{
      name: email, platform: 'openai', type: 'oauth',
      credentials: {
        _token_version: now.getTime(), access_token: accessToken,
        chatgpt_account_id: accountId, chatgpt_user_id: userId, email,
        expires_at: expiresAt, expires_in: payload.exp ? payload.exp - Math.floor(now.getTime() / 1000) : 864000,
        id_token: idToken, organization_id: '', refresh_token: refreshToken,
      },
      extra: { email }, concurrency: 10, priority: 1, rate_multiplier: 1, auto_pause_on_expired: true,
    }],
  };
  const sub2apiPath = path.join(authDir, `sub2api-${sanitized}.json`);
  try { fs.writeFileSync(sub2apiPath, JSON.stringify(sub2apiDoc, null, 2)); console.log(`  [Sub2API] Saved: ${sub2apiPath}`); } catch (e) { console.log(`  [Sub2API] Failed: ${e.message?.slice(0, 60)}`); }

  return cpaPath;
}

module.exports = { loadAccounts, generateTOTP, randomDelay, screenshotPath, saveCPAAuthFile, fetchTokensViaPKCE };
