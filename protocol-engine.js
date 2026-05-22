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
    } catch {}
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
      if (this._browser) try { this._browser.close(); } catch {}
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
    const summary = { total: accounts.length, success: 0, noLink: 0, error: 0 };

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

      // Connect Discord once (shared across all accounts)
      this._gw = await connectGateway();
      console.log('[Proto-Engine] Discord connected!');

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
          console.log(`[${progress}] Protocol login OK: ${result.accessToken?.slice(0, 20)}...`);
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

        // Step 2: Discord (retry up to 3 times on timeout)
        this.emitStatus({ email: account.email, status: 'running', phase: 'discord', progress });
        console.log(`[${progress}] Discord: ${account.email}...`);
        let link;
        // Reconnect Gateway if disconnected
        if (this._gw?.ws?.readyState !== 1) {
          console.log(`[${progress}] Gateway disconnected, reconnecting...`);
          try { this._gw?.cleanup(); } catch {}
          this._gw = await connectGateway();
          console.log(`[${progress}] Gateway reconnected`);
        }

        let discordOk = false;
        for (let dRetry = 0; dRetry < 3; dRetry++) {
          try {
            if (dRetry > 0) console.log(`[${progress}] Discord retry ${dRetry + 1}/3...`);
            const discord = await getPaymentLink(this._gw, result.accessToken);
            link = discord.link;
            if (link) console.log(`[${progress}] ${discord.title || 'Link obtained'}`);
            console.log(`[${progress}] Link: ${link?.slice(0, 80) || 'none'}`);
            if (!link) {
              console.log(`[${progress}] ${(discord.raw || 'No link').slice(0, 80)}`);
              this.emitStatus({ email: account.email, status: 'no_link', phase: 'done', progress, reason: discord.raw });
              summary.noLink++;
            }
            discordOk = true;
            break;
          } catch (e) {
            console.log(`[${progress}] Discord error: ${e.message?.slice(0, 60)}`);
            if (dRetry < 2 && e.message?.includes('Timeout')) {
              await new Promise(r => setTimeout(r, 2000));
              continue;
            }
            this.emitStatus({ email: account.email, status: 'error', phase: 'discord', progress, reason: e.message });
            summary.error++;
            discordOk = true;
            break;
          }
        }
        if (!discordOk) {
          this.emitStatus({ email: account.email, status: 'error', phase: 'discord', progress, reason: 'Discord timeout after 3 retries' });
          summary.error++;
        }
        if (!link) continue;

        // Step 3: Payment (fresh Chrome for each account)
        const port = 9222 + i;
        const tempDir = path.join(os.tmpdir(), `proto-pay-${Date.now()}-${i}`);
        let chromeProc = null, browser = null;
        try {
          this.emitStatus({ email: account.email, status: 'running', phase: 'payment', progress });
          console.log(`[${progress}] Opening payment: ${link.slice(0, 60)}...`);
          chromeProc = launchChrome(port, tempDir, { proxyServer: proxyMgr.getProxyUrl() || undefined });
          browser = await waitForCDP(port);
          this._chromeProc = chromeProc;
          this._browser = browser;
          this._tempDir = tempDir;

          const ctx = browser.contexts()[0];
          const page = ctx.pages()[0] || await ctx.newPage();
          await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

          // If the page landed on chrome-error (ERR_CONNECTION_CLOSED, etc.) the
          // current proxy node can't reach pay.openai.com. Blacklist it, rotate,
          // and retry once on a fresh route before giving up.
          let pageUrl = page.url();
          if (pageUrl.startsWith('chrome-error://') || pageUrl === 'about:blank') {
            const badNode = proxyMgr.getState().currentNode;
            console.log(`[${progress}] Payment page unreachable via ${badNode} (${pageUrl.slice(0, 40)}); rotating + retrying`);
            if (proxyMgr.getState().enabled) {
              try { proxyMgr.markBad(badNode); } catch {}
              try { const n = await proxyMgr.rotate(); console.log(`[${progress}] Retrying payment on ${n}`); } catch {}
            }
            await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            pageUrl = page.url();
            if (pageUrl.startsWith('chrome-error://') || pageUrl === 'about:blank') {
              throw new Error(`Payment page unreachable after node rotation (${pageUrl.slice(0, 40)})`);
            }
          }

          try { await page.locator('text=PayPal').first().waitFor({ state: 'visible', timeout: 15000 }); } catch {}
          await randomDelay(2000, 3000);

          console.log(`[${progress}] Auto-filling payment...`);
          let paymentResult = { success: false };
          try {
            const slot = runtimeCfg.phoneSlots?.[0] || { phone: runtimeCfg.phone, smsApiUrl: runtimeCfg.smsApiUrl };
            paymentResult = await autoPayment(page, { phone: slot.phone, smsApiUrl: slot.smsApiUrl }) || { success: false };
          } catch (e) {
            if (e.code === 'NOT_FREE_TRIAL') {
              // Link is not a $0 trial — treat as no_link (same outcome as Discord
              // failing to produce a link). Don't fill cards on a paid subscription page.
              console.log(`[${progress}] ${e.message}`);
              paymentResult = { success: false, notFreeTrial: true, reason: e.message };
            } else {
              console.log(`[${progress}] Payment error: ${e.message?.slice(0, 60)}`);
            }
          }

          if (paymentResult.success) {
            if (runtimeCfg.enableOAuth) {
              console.log(`[${progress}] Running PKCE via protocol...`);
              await this._finalizePkce(account, result, progress);
            } else {
              saveCPAAuthFile(account.email, result.accessToken, result.session);
              this.emitStatus({ email: account.email, status: 'plus_no_rt', phase: 'done', progress });
            }
            summary.success++;
          } else if (paymentResult.notFreeTrial) {
            this.emitStatus({ email: account.email, status: 'no_link', phase: 'done', progress, reason: paymentResult.reason });
            summary.noLink++;
          } else {
            const reason = paymentResult.reason || 'Payment not completed';
            console.log(`[${progress}] Payment incomplete: ${reason}`);
            this.emitStatus({ email: account.email, status: 'error', phase: 'payment', progress, reason });
            summary.error++;
          }
        } catch (e) {
          console.log(`[${progress}] ${account.email} error: ${e.message?.slice(0, 80)}`);
          this.emitStatus({ email: account.email, status: 'error', phase: 'payment', progress, reason: e.message });
          summary.error++;
        } finally {
          if (browser) try { await browser.close(); } catch {}
          if (chromeProc) try { chromeProc.kill(); } catch {}
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
          this._browser = null; this._chromeProc = null; this._tempDir = null;
        }

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
            await randomDelay(ACCOUNT_DELAY_MIN, ACCOUNT_DELAY_MAX);
          }
        }
      }

    } catch (e) {
      console.log(`[Proto-Engine] Fatal: ${e.message}`);
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
