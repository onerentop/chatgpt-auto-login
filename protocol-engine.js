// protocol-engine.js — Protocol register mode execution engine
// Same EventEmitter interface as server/engine.js but uses Python curl_cffi for login/register

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { autoPayment } = require('./payment');
const { randomDelay, saveCPAAuthFile } = require('./utils');
const { connectGateway, getPaymentLink } = require('./server/discord-gateway');
const { fetchCheckoutLink } = require('./server/chatgpt-checkout');
const { verifyCheckoutIsFree } = require('./server/stripe-verify');
const { submitStripeBilling } = require('./server/stripe-billing');
const { runPayPalRpa } = require('./server/paypal-rpa');
const { confirmSubscriptionActivation } = require('./server/manual-approval');
const { fetchPkceTokensProtocol } = require('./server/pkce-oauth');
const { fetchAddress } = require('./payment');
const { launchChrome, waitForCDP } = require('./server/chrome');
const proxyMgr = require('./server/proxy');

const ROOT = __dirname;
const PYTHON_SCRIPT = path.join(ROOT, 'protocol_register.py');

// ========== Python subprocess ==========
function runProtocolRegister(account, engine) {
  return new Promise((resolve, reject) => {
    const py = spawn('py', ['-3', PYTHON_SCRIPT], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    if (engine) engine._pyProc = py;
    let settled = false;
    const timeout = setTimeout(() => { if (!settled) { settled = true; py.kill(); reject(new Error('Python timeout (120s)')); } }, 120000);
    const input = JSON.stringify({ email: account.email, password: account.password, client_id: account.client_id || '', refresh_token: account.refresh_token || '', proxy: proxyMgr.getProxyUrl() });
    let stdout = '', stderr = '';
    py.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n').filter(l => l.trim())) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.log) { console.log(parsed.log); } else { stdout = line; }
        } catch { stdout = line; }
      }
    });
    py.stderr.on('data', (data) => { stderr += data.toString(); });
    py.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      try {
        const result = JSON.parse(stdout);
        if (result.status === 'success') resolve(result);
        else if (result.status === 'deactivated') resolve(result);  // surface to caller
        else if (result.status === 'tls_failure') resolve(result);  // surface to caller — engine handles retry
        else reject(new Error(result.error || 'Protocol register failed'));
      } catch { reject(new Error(stderr.slice(-200) || `Python exit ${code}`)); }
    });
    py.stdin.write(input);
    py.stdin.end();
  });
}

function runProtocolPKCE(account, engine) {
  return new Promise((resolve, reject) => {
    const py = spawn('py', ['-3', PYTHON_SCRIPT], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    if (engine) engine._pyProc = py;
    let settled = false;
    const timeout = setTimeout(() => { if (!settled) { settled = true; py.kill(); reject(new Error('PKCE Python timeout (180s)')); } }, 180000);
    const input = JSON.stringify({ email: account.email, password: account.password, client_id: account.client_id || '', refresh_token: account.refresh_token || '', pkce: true, proxy: proxyMgr.getProxyUrl() });
    let stdout = '', stderr = '';
    py.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n').filter(l => l.trim())) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.log) { console.log(parsed.log); } else { stdout = line; }
        } catch { stdout = line; }
      }
    });
    py.stderr.on('data', (data) => { stderr += data.toString(); });
    py.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      try {
        const result = JSON.parse(stdout);
        if (result.status === 'success') resolve(result);
        else reject(new Error(result.error || 'PKCE failed'));
      } catch { reject(new Error(stderr.slice(-200) || `Python exit ${code}`)); }
    });
    py.stdin.write(input);
    py.stdin.end();
  });
}

// ========== Protocol Engine ==========
class ProtocolEngine extends EventEmitter {
  constructor() {
    super();
    this.status = 'idle';
    this.stopFlag = false;
    this._gw = null;
    this._chromeProc = null;
    this._browser = null;
    this._tempDir = null;
  }

  getStatus() { return this.status; }

  emitStatus(data) {
    this.emit('account-status', data);
    try {
      const { statusDB } = require('./server/db');
      statusDB.set(data.email, data);
    } catch (e) {
      console.log(`[DB] statusDB.set failed for ${data.email}: ${e.message?.slice(0, 60)}`);
    }
  }

  // Run PKCE and emit final status. Used by both already-Plus and post-payment branches.
  async _finalizePkce(account, loginResult, progress) {
    this.emitStatus({ email: account.email, status: 'running', phase: 'pkce', progress });
    try {
      const pkceResult = await runProtocolPKCE(account, this);
      const pkce = pkceResult.pkce || {};
      if (pkce.refresh_token) {
        console.log(`[${progress}] PKCE success, saving with refresh_token`);
        saveCPAAuthFile(account.email, pkce.access_token || loginResult.accessToken, { ...loginResult.session, refresh_token: pkce.refresh_token, id_token: pkce.id_token || '' });
        this.emitStatus({ email: account.email, status: 'plus', phase: 'done', progress });
      } else {
        if (pkce.needsPhone) console.log(`[${progress}] PKCE requires phone verification`);
        else console.log(`[${progress}] PKCE no RT: ${pkce.error || 'unknown'}`);
        saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
        this.emitStatus({ email: account.email, status: 'plus_no_rt', phase: 'done', progress });
      }
    } catch (e) {
      console.log(`[${progress}] PKCE error: ${e.message?.slice(0, 60)}`);
      saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
      this.emitStatus({ email: account.email, status: 'plus_no_rt', phase: 'done', progress });
    }
  }

  stop() {
    if (this.status !== 'idle') {
      this.stopFlag = true;
      if (this._pyProc) try { this._pyProc.kill(); } catch {}
      if (this._chromeProc) try { this._chromeProc.kill(); } catch {}
      if (this._browser) try { this._browser.close().catch(() => {}); } catch {}
      if (this._gw) try { this._gw.cleanup(); } catch {}
      if (this._tempDir) try { fs.rmSync(this._tempDir, { recursive: true, force: true }); } catch {}
      this._pyProc = null; this._chromeProc = null; this._browser = null; this._gw = null; this._tempDir = null;

      // Reset any "running" accounts in DB to idle
      try {
        const { statusDB } = require('./server/db');
        if (statusDB.resetRunning) statusDB.resetRunning();
      } catch {}

      this.status = 'idle';
      this.emit('log', { email: '', phase: '', message: 'Protocol engine force stopped.', timestamp: new Date().toISOString() });
    }
  }

  async start(startFrom = 0, filterEmails = null) {
    this.status = 'running';
    this.stopFlag = false;

    // LogCapture: hijack console.log to emit 'log' events (same as PipelineEngine)
    const { LogCapture } = require('./server/logger');
    this._logCapture = new LogCapture();
    let currentEmail = '';
    const logHandler = (message) => {
      const ts = new Date().toISOString();
      this.emit('log', { email: currentEmail, phase: '', message, timestamp: ts });
      if (currentEmail) {
        try { const { logsDB } = require('./server/db'); logsDB.add(currentEmail, '', message, ts); } catch {}
      }
    };
    this._logCapture.onLog(logHandler);
    this._logCapture.start();

    const { accountsDB } = require('./server/db');
    let accounts = accountsDB.list().map(a => ({
      email: a.email, password: a.password, loginType: a.login_type,
      client_id: a.client_id || '', refresh_token: a.refresh_token || '',
    }));

    if (filterEmails?.length > 0) {
      const set = new Set(filterEmails.map(e => e.toLowerCase()));
      accounts = accounts.filter(a => set.has(a.email.toLowerCase()));
    }
    if (accounts.length === 0) throw new Error('No accounts');

    const runtimeCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
    const summary = { total: accounts.length, success: 0, noLink: 0, error: 0, noJpProxy: 0, noPromo: 0, verifyError: 0, stripeBillingError: 0, activationError: 0 };

    // Rate-limit / anti-bot cooldown configuration
    const COOLDOWN_THRESHOLD = 3;          // N consecutive failures triggers cooldown
    const COOLDOWN_MS_MIN = 300000;        // 5 min
    const COOLDOWN_MS_MAX = 600000;        // 10 min
    const ACCOUNT_DELAY_MIN = 15000;       // 15s between accounts
    const ACCOUNT_DELAY_MAX = 45000;       // 45s between accounts
    let consecutiveErrors = 0;

    try {
      // === Sequential: each account runs login → Discord → payment → done before next ===
      console.log(`[Proto-Engine] Starting ${accounts.length} accounts sequentially...`);

      // Determine payment-link source from runtime config. Default 'api'.
      const linkSource = runtimeCfg.paymentLinkSource || 'api';
      console.log(`[Proto-Engine] Payment link source: ${linkSource}`);

      if (linkSource === 'discord') {
        console.log('[Proto-Engine] Connecting to Discord Gateway...');
        this._gw = await connectGateway();
        console.log('[Proto-Engine] Discord connected!');
      }

      for (let i = 0; i < accounts.length; i++) {
        if (this.stopFlag) break;
        const account = accounts[i];
        const progress = `${i + 1}/${accounts.length}`;
        currentEmail = account.email;
        const errorsBefore = summary.error;

        // Step 1: Protocol login
        this.emitStatus({ email: account.email, status: 'running', phase: 'protocol-login', progress });
        console.log(`[${progress}] === ${account.email} (protocol) ===`);
        // Rotate proxy node before each account (if proxy enabled)
        if (proxyMgr.getState().enabled) {
          try {
            const node = await proxyMgr.rotate();
            console.log(`[${progress}] Proxy rotated → ${node}`);
          } catch (e) {
            console.log(`[${progress}] Proxy rotate failed: ${e.message?.slice(0, 60)}`);
          }
        }

        let result;
        try {
          result = await runProtocolRegister(account, this);
          // tls_failure means the homepage step exhausted its 5 retries with TLS errors —
          // a network-layer (node) problem, not an account problem. Blacklist the current
          // node, rotate to a fresh one, and retry the same account once.
          if (result.status === 'tls_failure') {
            const badNode = proxyMgr.getState().currentNode;
            console.log(`[${progress}] TLS errors persisted on ${badNode}; blacklisting + rotating + retrying once`);
            if (proxyMgr.getState().enabled) {
              try { proxyMgr.markBad(badNode); } catch {}
              try {
                const newNode = await proxyMgr.rotate();
                console.log(`[${progress}] Retrying on ${newNode}`);
              } catch (e) {
                console.log(`[${progress}] Rotate failed: ${e.message?.slice(0, 60)}`);
              }
            }
            // Single retry on a fresh route. If this also fails, surface the original
            // tls_failure as a normal error so cooldown/summary handling stays consistent.
            result = await runProtocolRegister(account, this);
            if (result.status === 'tls_failure') {
              console.log(`[${progress}] TLS still failing after rotation — giving up on this account`);
              this.emitStatus({ email: account.email, status: 'error', phase: 'protocol-login', progress, reason: result.error });
              summary.error++;
              continue;
            }
          }
          if (result.status === 'deactivated') {
            console.log(`[${progress}] Account deactivated/deleted by OpenAI`);
            this.emitStatus({ email: account.email, status: 'deactivated', phase: 'done', progress, reason: 'account_deactivated' });
            summary.error++;
            continue;
          }
          console.log(`[${progress}] Protocol login OK: ${result.accessToken}`);
        } catch (e) {
          console.log(`[${progress}] Protocol login failed: ${e.message?.slice(0, 80)}`);
          this.emitStatus({ email: account.email, status: 'error', phase: 'protocol-login', progress, reason: e.message });
          summary.error++;
          continue;
        }

        // Check if already Plus
        const isPlusOrAbove = ['plus', 'pro', 'team', 'enterprise'].includes((result.planType || 'free').toLowerCase());
        if (isPlusOrAbove) {
          console.log(`[${progress}] Already Plus`);
          if (runtimeCfg.enableOAuth) {
            console.log(`[${progress}] Running PKCE via protocol...`);
            await this._finalizePkce(account, result, progress);
          } else {
            saveCPAAuthFile(account.email, result.accessToken, result.session);
            this.emitStatus({ email: account.email, status: 'plus_no_rt', phase: 'done', progress });
          }
          summary.success++;
          continue;
        }

        // Step 2: Payment link (retry up to 3 times on transient errors)
        const phaseTag = linkSource === 'discord' ? 'discord' : 'checkout';
        this.emitStatus({ email: account.email, status: 'running', phase: phaseTag, progress });
        console.log(`[${progress}] ${phaseTag === 'discord' ? 'Discord' : 'Checkout'}: ${account.email}...`);
        let link;

        // Reconnect Gateway only when using Discord path
        if (linkSource === 'discord' && this._gw?.ws?.readyState !== 1) {
          console.log(`[${progress}] Gateway disconnected, reconnecting...`);
          try { this._gw?.cleanup(); } catch {}
          this._gw = await connectGateway();
          console.log(`[${progress}] Gateway reconnected`);
        }

        let linkFetchOk = false;
        let fetchResult = null;
        for (let dRetry = 0; dRetry < 3; dRetry++) {
          try {
            if (dRetry > 0) console.log(`[${progress}] Link fetch retry ${dRetry + 1}/3...`);
            if (linkSource === 'discord') {
              fetchResult = await getPaymentLink(this._gw, result.accessToken);
            } else {
              fetchResult = await fetchCheckoutLink(result.accessToken);
            }
            link = fetchResult.link;
            if (link) console.log(`[${progress}] ${fetchResult.title || 'Link obtained'}`);
            console.log(`[${progress}] Link: ${link || 'none'}`);
            if (fetchResult.noJpProxy) {
              console.log(`[${progress}] No JP proxy — skipping account`);
              this.emitStatus({ email: account.email, status: 'no_jp_proxy', phase: 'done', progress, reason: 'JP checkout channel unavailable' });
              summary.noJpProxy++;
            } else if (!link) {
              console.log(`[${progress}] ${(fetchResult.raw || 'No link').slice(0, 80)}`);
              this.emitStatus({ email: account.email, status: 'no_link', phase: 'done', progress, reason: fetchResult.raw });
              summary.noLink++;
            }
            linkFetchOk = true;
            break;
          } catch (e) {
            console.log(`[${progress}] Link fetch error: ${e.message?.slice(0, 60)}`);
            if (dRetry < 2 && (e.message?.includes('Timeout') || e.message?.includes('fetch'))) {
              await new Promise(r2 => setTimeout(r2, 2000));
              continue;
            }
            this.emitStatus({ email: account.email, status: 'error', phase: phaseTag, progress, reason: e.message });
            summary.error++;
            linkFetchOk = true;
            break;
          }
        }
        if (!link) continue;

        // Phase 2.5: Stripe init 验证 (API path only; Discord skips — bot is authority)
        if (linkSource !== 'discord') {
          this.emitStatus({ email: account.email, status: 'running', phase: 'verify', progress });
          console.log(`[${progress}] Phase 2.5: Verifying $0 via Stripe init...`);
          const v = await verifyCheckoutIsFree(link, fetchResult.pk);
          if (!v.ok) {
            console.log(`[${progress}] Verify failed: ${v.reason}`);
            this.emitStatus({ email: account.email, status: 'verify_error', phase: 'done', progress, paymentLink: link, reason: `Stripe init: ${v.reason}` });
            summary.verifyError++;
            continue;
          }
          if (!v.is_free) {
            console.log(`[${progress}] Not free: amount_due=${v.amount_due} ${v.currency}`);
            this.emitStatus({ email: account.email, status: 'no_promo', phase: 'done', progress, paymentLink: link, reason: `amount_due=${v.amount_due} ${v.currency}` });
            summary.noPromo++;
            continue;
          }
          console.log(`[${progress}] ✓ Verified $0 + coupons=[${v.coupons.join(',')}]`);
        }

        // === Phase 3a: Stripe billing (HTTP) ===
        this.emitStatus({ email: account.email, status: 'running', phase: 'stripe-billing', progress });
        console.log(`[${progress}] Phase 3a: Stripe billing (HTTP)...`);
        const billing = fetchAddress();  // reuse payment.js random US address
        const b = await submitStripeBilling(link, fetchResult.pk, billing);
        if (!b.ok) {
          console.log(`[${progress}] Stripe billing failed: ${b.reason}`);
          this.emitStatus({ email: account.email, status: 'stripe_billing_error', phase: 'done', progress, reason: b.reason });
          summary.stripeBillingError++;
          continue;
        }
        console.log(`[${progress}] PayPal URL obtained: ${b.paypal_redirect_url.slice(0, 60)}...`);

        // === Phase 3b: PayPal RPA (isolated Node subprocess) ===
        this.emitStatus({ email: account.email, status: 'running', phase: 'paypal-rpa', progress });
        console.log(`[${progress}] Phase 3b: PayPal RPA...`);
        const phoneSlot = runtimeCfg.phoneSlots?.[0] || { phone: runtimeCfg.phone, smsApiUrl: runtimeCfg.smsApiUrl };
        const payResult = await runPayPalRpa({
          paypal_url: b.paypal_redirect_url,
          phone: phoneSlot.phone,
          sms_api_url: phoneSlot.smsApiUrl,
          proxy: proxyMgr.getProxyUrl(),
          worker_id: `wk-${Date.now()}-${i}`,
          approval_url_pattern: 'chatgpt\\.com/agreements/approve',
        });
        if (!payResult.ok) {
          console.log(`[${progress}] PayPal RPA failed: ${payResult.reason}`);
          this.emitStatus({ email: account.email, status: 'error', phase: 'paypal-rpa', progress, reason: payResult.reason });
          summary.error++;
          continue;
        }
        console.log(`[${progress}] PayPal approved, got approval URL`);

        // === Phase 3c: HTTP manual approval ===
        this.emitStatus({ email: account.email, status: 'running', phase: 'activation', progress });
        console.log(`[${progress}] Phase 3c: Confirming subscription activation (HTTP)...`);
        const c = await confirmSubscriptionActivation(result.accessToken, payResult.chatgpt_approval_url);
        if (!c.ok || (c.plan_type || '').toLowerCase() !== 'plus') {
          console.log(`[${progress}] Activation failed: ${c.reason || ('plan_type=' + c.plan_type)}`);
          this.emitStatus({ email: account.email, status: 'activation_error', phase: 'done', progress, reason: c.reason });
          summary.activationError++;
          continue;
        }
        console.log(`[${progress}] ✓ Subscription activated: plan_type=${c.plan_type}`);

        // === Phase 4: HTTP PKCE OAuth ===
        let finalStatus = 'plus_no_rt';
        if (runtimeCfg.enableOAuth) {
          this.emitStatus({ email: account.email, status: 'running', phase: 'pkce', progress });
          console.log(`[${progress}] Phase 4: PKCE OAuth (HTTP)...`);
          const pkceTokens = await fetchPkceTokensProtocol(result.accessToken, account);
          if (pkceTokens.ok && pkceTokens.refresh_token) {
            saveCPAAuthFile(account.email, pkceTokens.access_token, pkceTokens);
            finalStatus = 'plus';
            console.log(`[${progress}] PKCE success with refresh_token`);
          } else {
            saveCPAAuthFile(account.email, result.accessToken, result.session);
            console.log(`[${progress}] PKCE no refresh_token (${pkceTokens.reason || 'unknown'}), saved without`);
          }
        } else {
          saveCPAAuthFile(account.email, result.accessToken, result.session);
        }

        this.emitStatus({ email: account.email, status: finalStatus, phase: 'done', progress });
        summary.success++;

        // Track consecutive failures for rate-limit cooldown
        if (summary.error > errorsBefore) {
          consecutiveErrors++;
          console.log(`[${progress}] consecutive errors: ${consecutiveErrors}/${COOLDOWN_THRESHOLD}`);
        } else {
          consecutiveErrors = 0;
        }

        if (i < accounts.length - 1) {
          if (consecutiveErrors >= COOLDOWN_THRESHOLD) {
            const cd = COOLDOWN_MS_MIN + Math.floor(Math.random() * (COOLDOWN_MS_MAX - COOLDOWN_MS_MIN));
            console.log(`[Proto-Engine] ${consecutiveErrors} consecutive failures — cooldown ${Math.round(cd/1000)}s before next account`);
            // Sleep in 1s chunks so stop() can interrupt
            for (let elapsed = 0; elapsed < cd; elapsed += 1000) {
              if (this.stopFlag) break;
              await new Promise(r => setTimeout(r, 1000));
            }
            consecutiveErrors = 0;
          } else {
            {
              const delayMs = ACCOUNT_DELAY_MIN + Math.floor(Math.random() * (ACCOUNT_DELAY_MAX - ACCOUNT_DELAY_MIN));
              for (let elapsed = 0; elapsed < delayMs; elapsed += 1000) {
                if (this.stopFlag) break;
                await new Promise(r => setTimeout(r, 1000));
              }
            }
          }
        }
      }

    } catch (e) {
      console.log(`[Proto-Engine] Fatal: ${e.message}`);
      summary.error = summary.total;  // All accounts failed due to gateway
    } finally {
      if (this._browser) try { await this._browser.close(); } catch {}
      if (this._chromeProc) try { this._chromeProc.kill(); } catch {}
      if (this._gw) try { this._gw.cleanup(); } catch {}
      if (this._tempDir) try { fs.rmSync(this._tempDir, { recursive: true, force: true }); } catch {}
      this._browser = null; this._chromeProc = null; this._gw = null; this._tempDir = null;
      if (this._logCapture) { this._logCapture.offLog(logHandler); this._logCapture.stop(); }
      console.log(`[Proto-Engine] Complete: ${JSON.stringify(summary)}`);
      this.emit('complete', { summary });
      this.status = 'idle';
    }
  }
}

module.exports = { ProtocolEngine };
