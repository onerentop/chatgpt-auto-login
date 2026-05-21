/**
 * PipelineEngine - Core execution engine for the web dashboard.
 *
 * Wraps the same pipeline logic as the CLI index.js, but as an EventEmitter
 * so the Express/Socket.IO layer can stream progress to the frontend.
 *
 * Events emitted:
 *   'log'            → { email, phase, message, timestamp }
 *   'account-status' → { email, status, phase, progress, paymentLink?, reason? }
 *   'complete'       → { summary: { total, success, noLink, error } }
 */
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { LogCapture } = require('./logger');
const { connectGateway, getPaymentLink } = require('./discord-gateway');
const { launchChrome, waitForCDP, findChrome } = require('./chrome');

const {
  saveCPAAuthFile,
  fetchTokensViaPKCE,
  randomDelay,
} = require('../utils');
const { loginAccount } = require('../login');
const { autoPayment } = require('../payment');
const { registerToCPA } = require('../cpa');

// ========== Paths ==========
const ROOT = path.join(__dirname, '..');

// ========== PipelineEngine ==========
function getDB() { return require('./db'); }

class PipelineEngine extends EventEmitter {
  constructor() {
    super();
    this.status = 'idle';
    this.stopFlag = false;
    this.logCapture = new LogCapture();
    this._runId = '';
  }

  emitStatus(data) {
    this.emit('account-status', data);
    try { getDB().statusDB.set(data.email, data); } catch (e) { console.log(`[WARN] statusDB.set: ${e.message?.slice(0, 60)}`); }
  }

  /**
   * @returns {'idle' | 'running' | 'stopping'}
   */
  getStatus() {
    return this.status;
  }

  /**
   * Force stop — kill Chrome, close connections, reset immediately.
   */
  stop() {
    if (this.status !== 'idle') {
      this.stopFlag = true;
      this.status = 'stopping';
      console.log('Force stopping pipeline...');

      // Kill Chrome processes launched by this engine
      if (this._chromeProc) {
        try { this._chromeProc.kill(); } catch {}
        this._chromeProc = null;
      }
      // Close browser CDP connection
      if (this._browser) {
        try { this._browser.close(); } catch {}
        this._browser = null;
      }
      // Close Discord Gateway
      if (this._gw) {
        try { this._gw.cleanup(); } catch {}
        this._gw = null;
      }
      // Clean temp dir
      if (this._tempDir) {
        try { fs.rmSync(this._tempDir, { recursive: true, force: true }); } catch {}
        this._tempDir = null;
      }

      // Reset any "running" accounts in DB to idle
      try {
        const { statusDB } = require('./db');
        if (statusDB.resetRunning) statusDB.resetRunning();
      } catch {}

      this.logCapture.stop();
      this.status = 'idle';
      this.emit('log', { email: '', phase: '', message: 'Pipeline force stopped.', timestamp: new Date().toISOString() });
    }
  }

  /**
   * Run the full pipeline starting from the given account index.
   * @param {number} startFrom - Zero-based account index to start from.
   */
  async start(startFrom = 0, filterEmails = null) {
    if (this.status !== 'idle') {
      throw new Error(`Engine is already ${this.status}`);
    }

    this.status = 'running';
    this.stopFlag = false;
    this._runId = `run_${Date.now()}`;

    let currentEmail = '';
    let currentPhase = '';

    // Cleanup old logs
    try { getDB().logsDB.cleanup(); } catch (e) { console.log(`[WARN] logsDB.cleanup: ${e.message?.slice(0, 60)}`); }

    // Hook console.log → emit 'log' events + write to per-account log files
    const logHandler = (message) => {
      const entry = {
        email: currentEmail,
        phase: currentPhase,
        message,
        timestamp: new Date().toISOString(),
      };
      this.emit('log', entry);

      // Save to DB
      if (currentEmail) {
        try { getDB().logsDB.add(currentEmail, currentPhase, message, entry.timestamp, this._runId); } catch (e) { console.log(`[WARN] logsDB.add: ${e.message?.slice(0, 60)}`); }
      }
    };
    this.logCapture.onLog(logHandler);
    this.logCapture.start();

    const allResults = [];
    const basePort = 19222;
    let gw = null;

    try {
      // Load accounts
      const { accountsDB } = require('./db');
      const accounts = accountsDB.list().map(a => ({
        email: a.email,
        password: a.password,
        loginType: a.login_type === 'google' ? 'google' : 'outlook',
        totp_secret: a.totp_secret || '',
        client_id: a.client_id || '',
        refresh_token: a.refresh_token || '',
      }));
      if (accounts.length === 0) throw new Error('No accounts in database');
      if (!findChrome()) throw new Error('Chrome not found!');

      // Filter by selected emails if provided
      let filtered = accounts;
      if (filterEmails && filterEmails.length > 0) {
        const emailSet = new Set(filterEmails.map(e => e.toLowerCase()));
        filtered = accounts.filter(a => emailSet.has(a.email.toLowerCase()));
      }
      if (filtered.length === 0) throw new Error('No matching accounts to execute');

      console.log(`Loaded ${filtered.length} accounts to process.`);

      // Connect Discord Gateway
      currentPhase = 'discord-connect';
      console.log('Connecting to Discord Gateway...');
      gw = await connectGateway();
      this._gw = gw;
      console.log('Discord connected!');

      // Process each account
      for (let i = 0; i < filtered.length; i++) {
        if (this.stopFlag) {
          console.log('Stop requested, breaking out of loop.');
          break;
        }

        const account = filtered[i];
        currentEmail = account.email;
        const progress = `${i + 1}/${filtered.length}`;
        const p = `[${progress}]`;

        this.emitStatus( {
          email: account.email,
          status: 'running',
          phase: 'login',
          progress,
        });

        console.log(`${p} === ${account.email} ===`);

        const port = basePort + i;
        const tempDir = path.join(os.tmpdir(), `chatgpt-login-${Date.now()}`);
        this._chromeProc = null;
        this._browser = null;
        this._tempDir = tempDir;
        let finalResult = { email: account.email, status: 'error', paymentLink: '', reason: '' };

        try {
          if (this.stopFlag) break;
          // Phase 1: Login & get accessToken
          currentPhase = 'login';
          console.log(`${p} Phase 1: Login...`);
          this._chromeProc = launchChrome(port, tempDir);
          this._browser = await waitForCDP(port);
          const browser = this._browser;
          const loginResult = await loginAccount(browser, account);

          if (loginResult.status !== 'success' || !loginResult.accessToken) {
            const isDeactivated = loginResult.status === 'deactivated';
            const statusOut = isDeactivated ? 'deactivated' : 'error';
            console.log(`${p} Login ${isDeactivated ? 'account_deactivated' : 'failed'}: ${loginResult.reason || loginResult.status}`);
            finalResult.status = statusOut;
            finalResult.reason = isDeactivated ? 'account_deactivated' : `Login: ${loginResult.reason || loginResult.status}`;
            allResults.push(finalResult);

            this.emitStatus({
              email: account.email,
              status: statusOut,
              phase: isDeactivated ? 'done' : 'login',
              progress,
              reason: finalResult.reason,
            });
            continue;
          }
          console.log(`${p} Login OK, accessToken obtained.`);

          // Check plan type from session
          const planType =
            loginResult.session?.account?.planType ||
            loginResult.session?.chatgpt_plan_type ||
            'free';
          const isPlusOrAbove = ['plus', 'pro', 'team', 'enterprise'].includes(planType.toLowerCase());
          console.log(`${p} Plan: ${planType} (${isPlusOrAbove ? 'Plus member' : 'Not Plus'})`);

          if (isPlusOrAbove) {
            console.log(`${p} Already Plus!`);
            finalResult = { email: account.email, status: 'plus_no_rt', paymentLink: '', reason: '' };

            const latestCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
            if (latestCfg.enableOAuth) {
              console.log(`${p} Running PKCE for already-Plus account...`);
              this.emitStatus({ email: account.email, status: 'running', phase: 'pkce', progress });
              const pkceTokens = await fetchTokensViaPKCE(browser, account, loginResult.lastOtp).catch((e) => { console.log(`  [PKCE] Failed: ${e.message}`); return null; });
              if (pkceTokens && !pkceTokens.needsPhone && pkceTokens.refresh_token) {
                saveCPAAuthFile(account.email, pkceTokens.access_token, pkceTokens);
                finalResult.status = 'plus';
              } else {
                if (pkceTokens?.needsPhone) console.log(`${p} PKCE requires phone verification`);
                else if (pkceTokens && !pkceTokens.refresh_token) console.log(`${p} PKCE returned no refresh_token`);
                saveCPAAuthFile(account.email, pkceTokens?.access_token || loginResult.accessToken, pkceTokens || loginResult.session);
              }
            } else {
              saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
            }

            if (latestCfg.enableCPA) {
              console.log(`${p} CPA registration...`);
              this.emitStatus({ email: account.email, status: 'running', phase: 'cpa', progress });
              try {
                const cpaOk = await registerToCPA(browser, account.email, account);
                if (cpaOk) console.log(`${p} CPA OAuth done.`);
                else console.log(`${p} CPA OAuth may have issues, check manually.`);
              } catch (e) {
                console.log(`${p} CPA error: ${e.message}`);
              }
            }
          } else {
            // Not Plus → full payment flow
            // Phase 2: Discord bot → payment link (retry up to 3 times on timeout)
            currentPhase = 'discord';
            console.log(`${p} Phase 2: Discord bot...`);
            this.emitStatus({ email: account.email, status: 'running', phase: 'discord', progress });
            let discord;
            for (let dRetry = 0; dRetry < 3; dRetry++) {
              try {
                if (dRetry > 0) console.log(`${p} Discord retry ${dRetry + 1}/3...`);
                discord = await getPaymentLink(gw, loginResult.accessToken);
                break;
              } catch (de) {
                console.log(`${p} Discord error: ${de.message?.slice(0, 60)}`);
                if (dRetry < 2 && de.message?.includes('Timeout')) {
                  await new Promise(r => setTimeout(r, 2000));
                  continue;
                }
                throw de;
              }
            }

            if (discord.link) {
              console.log(`${p} ${discord.title}`);
              console.log(`${p} Link: ${discord.link.slice(0, 80)}...`);
              finalResult = { email: account.email, status: 'error', paymentLink: discord.link, reason: '' };

              // Phase 3: Open payment link & auto-fill
              currentPhase = 'payment';
              console.log(`${p} Phase 3: Opening payment page...`);
              this.emitStatus({ email: account.email, status: 'running', phase: 'payment', progress });
              const ctx = browser.contexts()[0];
              const pages = ctx.pages();
              const page = pages.length > 0 ? pages[0] : await ctx.newPage();
              await page.goto(discord.link, { waitUntil: 'domcontentloaded', timeout: 30000 });
              await randomDelay(2000, 3000);

              console.log(`${p} Phase 3: Auto-filling payment...`);
              let paymentOk = false;
              let paymentReason = '';
              try {
                const freshCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
                const phoneSlot = freshCfg.phoneSlots?.[0] || { phone: freshCfg.phone, smsApiUrl: freshCfg.smsApiUrl };
                const payResult = await autoPayment(page, { phone: phoneSlot.phone, smsApiUrl: phoneSlot.smsApiUrl }) || {};
                paymentOk = !!payResult.success;
                paymentReason = payResult.reason || '';
              } catch (e) {
                console.log(`${p} Auto-fill error: ${e.message}`);
                paymentReason = e.message?.slice(0, 100) || 'exception';
              }

              if (paymentOk) {
                finalResult.status = 'plus_no_rt';
                console.log(`${p} Payment succeeded (redirect_status=succeeded)`);
              } else {
                finalResult.status = 'error';
                finalResult.reason = paymentReason || 'Payment not completed';
                console.log(`${p} Payment failed: ${finalResult.reason}, skipping auth file generation`);
              }

              console.log(`${p} Payment flow completed. Waiting 10s...`);
              await randomDelay(10000, 12000);

              // Phase 4: OAuth (PKCE) + CPA (only on payment success)
              if (paymentOk) {
                currentPhase = 'oauth';
                const latestCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));

                if (latestCfg.enableOAuth) {
                  console.log(`${p} Phase 4: PKCE OAuth...`);
                  this.emitStatus({ email: account.email, status: 'running', phase: 'pkce', progress });
                  const pkceTokens = await fetchTokensViaPKCE(browser, account, loginResult.lastOtp).catch((e) => { console.log(`  [PKCE] Failed: ${e.message}`); return null; });
                  if (pkceTokens && !pkceTokens.needsPhone && pkceTokens.refresh_token) {
                    console.log(`${p} PKCE success, saving with refresh_token`);
                    saveCPAAuthFile(account.email, pkceTokens.access_token, pkceTokens);
                    finalResult.status = 'plus';
                  } else {
                    if (pkceTokens?.needsPhone) console.log(`${p} PKCE requires phone verification`);
                    else if (pkceTokens && !pkceTokens.refresh_token) console.log(`${p} PKCE returned no refresh_token`);
                    else console.log(`${p} PKCE failed, saving without refresh_token`);
                    saveCPAAuthFile(account.email, pkceTokens?.access_token || loginResult.accessToken, pkceTokens || loginResult.session);
                  }
                } else {
                  saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
                }

                if (latestCfg.enableCPA) {
                  console.log(`${p} Phase 4: CPA registration...`);
                  try {
                    const cpaOk = await registerToCPA(browser, account.email, account);
                    if (cpaOk) console.log(`${p} CPA OAuth done.`);
                    else console.log(`${p} CPA OAuth may have issues, check manually.`);
                  } catch (e) {
                    console.log(`${p} CPA error: ${e.message}`);
                  }
                }
              }
            } else {
              console.log(`${p} No link: ${discord.raw.slice(0, 150)}`);
              finalResult = { email: account.email, status: 'no_link', paymentLink: '', reason: discord.raw.slice(0, 200) };
            }
          }
        } catch (error) {
          console.log(`${p} ERROR: ${error.message}`);
          if (!finalResult.status) finalResult.status = 'error';
          finalResult.reason = error.message.slice(0, 200);
        } finally {
          if (this._browser) try { await this._browser.close(); } catch {}
          if (this._chromeProc) try { this._chromeProc.kill(); } catch {}
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
          this._browser = null;
          this._chromeProc = null;
          this._tempDir = null;
        }

        allResults.push(finalResult);
        console.log(`${p} ${account.email} → ${finalResult.status}`);

        // Emit final account status
        this.emitStatus( {
          email: account.email,
          status: finalResult.status,
          phase: 'done',
          progress,
          paymentLink: finalResult.paymentLink || undefined,
          reason: finalResult.reason || undefined,
        });

        // Random delay between accounts
        if (i < filtered.length - 1 && !this.stopFlag) {
          const wait = 5 + Math.floor(Math.random() * 3);
          console.log(`  Waiting ${wait}s...`);
          await randomDelay(wait * 1000, wait * 1000 + 500);
        }
      }
    } catch (err) {
      // Emit directly to avoid console.log loops if logger is misbehaving
      const msg = `[Engine] FATAL: ${err.message}`;
      this.emit('log', { email: '', phase: 'error', message: msg, timestamp: new Date().toISOString() });
      this.emit('log', { email: '', phase: 'error', message: `[Engine] Stack: ${err.stack?.split('\n').slice(0, 3).join(' | ')}`, timestamp: new Date().toISOString() });
    } finally {
      if (gw) gw.cleanup();

      // Stop log capture
      this.logCapture.stop();
      this.logCapture.offLog(logHandler);

      // Build summary
      const summary = {
        total: allResults.length,
        success: allResults.filter((r) => r.status === 'plus' || r.status === 'plus_no_rt').length,
        noLink: allResults.filter((r) => r.status === 'no_link').length,
        error: allResults.filter((r) => r.status === 'error' || r.status === 'deactivated').length,
      };

      console.log('========================================');
      console.log(`  Success: ${summary.success}  |  No Link: ${summary.noLink}  |  Error: ${summary.error}`);
      console.log('========================================');

      this.emit('complete', { summary });

      // Flush logs to DB
      try { getDB().logsDB.flush(); } catch (e) { console.log(`[WARN] logsDB.flush: ${e.message?.slice(0, 60)}`); }

      // Reset state
      this.status = 'idle';
      this.stopFlag = false;
    }
  }
}

module.exports = { PipelineEngine };
