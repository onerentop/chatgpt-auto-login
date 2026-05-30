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
const { fetchCheckoutLink } = require('./chatgpt-checkout');
const { verifyCheckoutIsFree } = require('./stripe-verify');
const { launchChrome, waitForCDP, findChrome, findFreePort } = require('./chrome');
const proxyMgr = require('./proxy');
const { killTree } = require('./process-utils');

const {
  saveCPAAuthFile,
  fetchTokensViaPKCE,
  randomDelay,
} = require('../utils');
const { statusDB } = require('./db');
const { loginAccount } = require('../login');
const { autoPayment } = require('../payment');
const { registerToCPA } = require('../cpa');

// ========== Paths ==========
const ROOT = path.join(__dirname, '..');

// ========== Pipeline infrastructure ==========
const { PipelineRunner } = require('./pipeline/runner');
const { AccountContext } = require('./pipeline/context');
const { buildPipeline } = require('./pipeline');

// ========== PipelineEngine ==========
function getDB() { return require('./db'); }

class PipelineEngine extends EventEmitter {
  constructor() {
    super();
    this.status = 'idle';
    this.stopFlag = false;
    this.logCapture = new LogCapture();
    this._runId = '';
    this._chromeProc = null;
    this._browser = null;
    this._abortController = null;
  }

  emitStatus(data) {
    // 从 proxyMgr 注入代理上下文。merge-aware statusDB.set 在缺失时保留旧值；
    // 这里始终注入（除非完全取不到状态），覆盖刚发生的代理切换。
    try {
      const proxyMgr = require('./proxy');
      const st = proxyMgr.getState();
      data = { ...data, proxyNode: st.currentNode || '', exitIp: st.exitIp || '' };
    } catch {}
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
  async stop() {
    if (this.status === 'idle') return;
    this.stopFlag = true;
    if (this._abortController) try { this._abortController.abort(); } catch {}
    this.status = 'stopping';
    console.log('Force stopping pipeline...');

    // Close browser CDP first (graceful) so Chrome gets a chance to detach
    // cleanly before we SIGKILL the process — avoids zombie chrome.exe.
    const browser = this._browser; this._browser = null;
    if (browser) {
      try { await browser.close(); } catch {}
    }
    // Now kill the Chrome process tree (HX-13). taskkill /T cleans renderer
    // / GPU / utility subprocesses on Windows that .kill() leaves behind.
    const chromeProc = this._chromeProc; this._chromeProc = null;
    if (chromeProc) {
      try { killTree(chromeProc.pid); } catch {}
      try { chromeProc.kill(); } catch {}
    }
    // Close Discord Gateway
    const gw = this._gw; this._gw = null;
    if (gw) {
      try { gw.cleanup(); } catch {}
    }
    this._abortController = null;
    // Clean temp dir — async so we don't block the event loop on a multi-GB
    // user-data-dir, and so the rm waits for the chrome process file handles
    // to drop (kill() was sync above, but the OS may need a tick to release).
    const tempDir = this._tempDir; this._tempDir = null;
    if (tempDir) {
      try { await fs.promises.rm(tempDir, { recursive: true, force: true }); } catch {}
    }

    // Reset any "running" accounts in DB to idle
    try {
      const { statusDB } = require('./db');
      if (statusDB.resetRunning) statusDB.resetRunning();
    } catch {}

    try { this.logCapture.stop(); } catch {}
    this.status = 'idle';
    this.emit('log', { email: '', phase: '', message: 'Pipeline force stopped.', timestamp: new Date().toISOString() });
  }

  /**
   * Run the full pipeline starting from the given account index.
   *
   * Rewritten as a thin runner-driven shell (P2): all business logic lives in
   * server/pipeline/steps/. This method mirrors protocol-engine.js start()
   * but preserves all browser-specific behaviors (findChrome fail-fast,
   * browser field mapping, 5-7s delay, no consecutiveErrors cooldown,
   * per-account Chrome cleanup, loop-end emit conditional, allResults summary).
   *
   * @param {number} startFrom - Zero-based account index to start from.
   */
  async start(startFrom = 0, filterEmails = null, opts = {}) {
    if (this.status !== 'idle') {
      throw new Error(`Engine is already ${this.status}`);
    }

    this.status = 'running';
    this.stopFlag = false;
    this._abortController = new AbortController();
    this._runId = `run_${Date.now()}`;

    // =========================================================================
    // runner-loop: LogCapture (engine.js:138-155)
    // Phase tagging reads the runner's active step id, same as protocol-engine.
    // =========================================================================
    let currentEmail = '';
    try { getDB().logsDB.cleanup(); } catch (e) { console.log(`[WARN] logsDB.cleanup: ${e.message?.slice(0, 60)}`); }

    const logHandler = (message) => {
      const ts = new Date().toISOString();
      const phase = this._runner?._activeCtx?.currentStepId || '';
      const entry = { email: currentEmail, phase, message, timestamp: ts };
      this.emit('log', entry);
      if (currentEmail) {
        try { getDB().logsDB.add(currentEmail, phase, message, ts, this._runId); } catch (e) { console.log(`[WARN] logsDB.add: ${e.message?.slice(0, 60)}`); }
      }
    };
    this.logCapture.onLog(logHandler);
    this.logCapture.start();

    // =========================================================================
    // resources bag: thin proxy through to this._* fields.
    // stop() reads this._chromeProc / this._browser / this._tempDir / this._gw
    // directly, so we proxy reads/writes here to keep stop() unchanged.
    // Steps write into the bag; stop() cleans up the canonical this._ fields.
    // =========================================================================
    const engine = this;
    const resources = {
      get chromeProc()  { return engine._chromeProc; },
      set chromeProc(v) { engine._chromeProc = v; },
      get browser()     { return engine._browser; },
      set browser(v)    { engine._browser = v; },
      get tempDir()     { return engine._tempDir; },
      set tempDir(v)    { engine._tempDir = v; },
      get gw()          { return engine._gw; },
      set gw(v)         { engine._gw = v; },
    };

    const allResults = [];

    try {
      // =========================================================================
      // runner-loop: load accounts (engine.js:163-171)
      // Fields include loginType, totp_secret, client_id, refresh_token.
      // =========================================================================
      const { accountsDB, stepStateDB } = require('./db');
      const accounts = accountsDB.list().map(a => ({
        email: a.email,
        password: a.password,
        loginType: a.login_type === 'google' ? 'google' : 'outlook',
        totp_secret: a.totp_secret || '',
        client_id: a.client_id || '',
        refresh_token: a.refresh_token || '',
        // Preserve login_type field name that AccountContext + login step expect
        login_type: a.login_type,
      }));
      if (accounts.length === 0) throw new Error('No accounts in database');

      // runner-loop: findChrome fail-fast (engine.js:173)
      // Browser engine always needs Chrome; fail-fast here rather than silently
      // crashing per-account inside the payment step.
      if (!findChrome()) throw new Error('Chrome not found!');

      // runner-loop: filterEmails (engine.js:177-181)
      let filtered = accounts;
      if (filterEmails && filterEmails.length > 0) {
        const emailSet = new Set(filterEmails.map(e => e.toLowerCase()));
        filtered = accounts.filter(a => emailSet.has(a.email.toLowerCase()));
      }
      if (filtered.length === 0) throw new Error('No matching accounts to execute');

      console.log(`Loaded ${filtered.length} accounts to process.`);

      // runner-loop: runtimeCfg + linkSource (engine.js:187-189)
      const runtimeCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
      const linkSource = runtimeCfg.paymentLinkSource || 'api';
      console.log(`Payment link source: ${linkSource}`);

      // runner-loop: Discord connect-before-loop (engine.js:192-198)
      if (linkSource === 'discord') {
        console.log('Connecting to Discord Gateway...');
        this._gw = await connectGateway();
        // resources.gw proxies through to this._gw via getter/setter above
        console.log('Discord connected!');
      }

      // =========================================================================
      // Instantiate PipelineRunner (single instance, reused per account).
      // =========================================================================
      this._runner = new PipelineRunner({
        statusDB: getDB().statusDB,
        stepStateDB,
        save: getDB().save,
        log: (email, stepId, msg) => console.log(msg),
      });
      // Forward step-status events (additive — does not replace existing events)
      this._runner.on('step-status', d => this.emit('step-status', d));

      // === Sequential: each account runs login → plan-check → … → cpa before next ===
      console.log(`[Browser-Engine] Starting ${filtered.length} accounts sequentially...`);

      for (let i = 0; i < filtered.length; i++) {
        // runner-loop: stopFlag check (engine.js:201-205)
        if (this.stopFlag) {
          console.log('Stop requested, breaking out of loop.');
          break;
        }

        const account = filtered[i];
        currentEmail = account.email;
        const progress = `${i + 1}/${filtered.length}`;
        const p = `[${progress}]`;

        console.log(`${p} === ${account.email} (browser) ===`);

        // runner-loop: proxy rotate per account (engine.js:249-265)
        // NOTE: placed BEFORE AccountContext construction and BEFORE _runAccount,
        // to preserve the original ordering (rotate → then steps start).
        if (proxyMgr.getState().enabled) {
          try {
            const node = await proxyMgr.rotate();
            console.log(`${p} Proxy rotated → ${node}`);
          } catch (e) {
            console.log(`${p} Proxy rotate failed: ${e.message?.slice(0, 60)}`);
          }
        }

        // AccountContext MUST be constructed BEFORE any step writes to statusDB
        // (prevPersisted snapshot is load-bearing for cached-login and cached-link).
        // Per-account deps assembled here and passed into ctx.
        //
        // summary: a throwaway counter object that shared steps harmlessly increment.
        // The real summary is built from allResults at the end (engine.js:692-701
        // semantics). Browser engine does NOT use summary counters from steps for
        // the emitted complete-summary.
        const summaryCounters = {};
        const deps = {
          emitStatus: this.emitStatus.bind(this),
          summary: summaryCounters,
          progress,
          proxyMgr,
          resources,
          runtimeCfg,
          linkSource,
          statusDB: getDB().statusDB,
          stepStateDB,
          save: getDB().save,
          abortController: this._abortController,
          log: (email, stepId, msg) => console.log(msg),
          // browserMode=true: tells paypal-pay step's finally to skip chrome cleanup
          // (engine-shell owns Chrome lifecycle per account in browser mode).
          browserMode: true,
        };

        // prevPersisted snapshot captured in AccountContext constructor BEFORE
        // any step writes to statusDB (engine.js:209-216 semantics).
        const ctx = new AccountContext({
          email: account.email,
          password: account.password,
          totp_secret: account.totp_secret,
          client_id: account.client_id,
          refresh_token: account.refresh_token,
          login_type: account.login_type,
        }, deps);

        // Sync stopFlag into runner before each account
        this._runner.stopFlag = this.stopFlag;

        const steps = buildPipeline({ login: 'browser', payment: 'paypal' });

        // Per-account Chrome cleanup: always run, even if steps throw.
        // paypal-pay step's finally is a no-op in browserMode, so the
        // engine-shell owns Chrome cleanup here (engine.js:647-657).
        try {
          const result = await this._runner._runAccount(ctx, steps, { forceStepId: opts.forceStepId });

          // ===================================================================
          // Loop-end emit (engine.js:659-670 semantics) — CONDITIONAL:
          //
          // OLD browser engine emit pattern (target):
          //   - Login-failure → emits in-block (login step), then `continue`s
          //     past loop-end → NO loop-end emit.
          //   - Every other account → gets the loop-end {status}/done emit.
          //     This includes: success (plus/plus_no_rt), no_jp_proxy, no_link,
          //     no_promo, verify_error, aborted, NOT_FREE_TRIAL (no_link),
          //     pay-error, phone_pool_empty, phone_verify_fail.
          //   - aborted also emits in-block (aborted/payment) AND gets loop-end.
          //   - phone_pool_empty/phone_verify_fail emit in-block (pkce) AND
          //     get loop-end (browser-pkce returns ok:true → result.completed).
          //
          // NEW: emit for every account EXCEPT login-failure
          //   (result.stoppedAt === 'login' means login step emitted in-block
          //    and the OLD engine continued past loop-end — skip loop-end emit).
          //
          // Steps that previously emitted their own terminal in-step are now
          // suppressed via browserMode gate (Part A), so the loop-end emit is
          // the SINGLE terminal emit for those paths.
          // ===================================================================
          if (result.stoppedAt !== 'login') {
            const finalStatus = ctx.flags.finalStatus || 'error';
            const finalReason = ctx.flags.finalReason || '';
            const finalPaymentLink = ctx.flags.finalPaymentLink || '';

            this.emitStatus({
              email: account.email,
              status: finalStatus,
              phase: 'done',
              progress,
              paymentLink: finalPaymentLink || undefined,
              reason: finalReason || undefined,
            });
          }

          // Record for summary (engine.js:659-660 + 692-701 semantics)
          const finalStatus = ctx.flags.finalStatus || 'error';
          allResults.push({ email: account.email, status: finalStatus });
          console.log(`${p} ${account.email} → ${finalStatus}`);

        } finally {
          // Per-account Chrome cleanup (engine.js:647-657)
          // Mirror stop() rationale: killTree first to clean renderer/GPU
          // subprocesses on Windows, then kill() as belt-and-suspenders,
          // then rmSync the temp profile dir.
          if (this._browser) try { await this._browser.close(); } catch {}
          if (this._chromeProc) try { killTree(this._chromeProc.pid); } catch {}
          if (this._chromeProc) try { this._chromeProc.kill(); } catch {}
          if (this._tempDir) try { fs.rmSync(this._tempDir, { recursive: true, force: true }); } catch {}
          this._browser = null;
          this._chromeProc = null;
          this._tempDir = null;
        }

        // runner-loop: delay (engine.js:673-677)
        // Browser engine: 5-7s. NO consecutiveErrors cooldown (browser has none).
        if (i < filtered.length - 1 && !this.stopFlag) {
          const wait = 5 + Math.floor(Math.random() * 3);
          console.log(`  Waiting ${wait}s...`);
          await randomDelay(wait * 1000, wait * 1000 + 500);
        }
      }

    } catch (err) {
      // Emit directly to avoid console.log loops if logger is misbehaving
      const msg = `[Browser-Engine] FATAL: ${err.message}`;
      this.emit('log', { email: '', phase: 'error', message: msg, timestamp: new Date().toISOString() });
      this.emit('log', { email: '', phase: 'error', message: `[Browser-Engine] Stack: ${err.stack?.split('\n').slice(0, 3).join(' | ')}`, timestamp: new Date().toISOString() });
    } finally {
      // runner-loop + engine-shell: finally cleanup (engine.js:684-716)
      // stop() cleans this._browser/_chromeProc/_gw/_tempDir via this._ fields.
      // resources bag proxies through to these, so any step that set
      // resources.chromeProc etc. is already reflected in this._chromeProc here.
      if (this._browser) try { await this._browser.close(); } catch {}
      if (this._chromeProc) try { killTree(this._chromeProc.pid); } catch {}
      if (this._chromeProc) try { this._chromeProc.kill(); } catch {}
      if (this._gw) try { this._gw.cleanup(); } catch {}
      if (this._tempDir) try { fs.rmSync(this._tempDir, { recursive: true, force: true }); } catch {}
      this._browser = null; this._chromeProc = null; this._gw = null; this._tempDir = null;

      // Stop log capture (engine.js:689-690)
      this.logCapture.stop();
      this.logCapture.offLog(logHandler);

      // Build summary from allResults (engine.js:692-701)
      // aborted is always present (even 0), matching browser engine behavior.
      const summary = {
        total: allResults.length,
        success: allResults.filter(r => r.status === 'plus' || r.status === 'plus_no_rt').length,
        noLink: allResults.filter(r => r.status === 'no_link').length,
        error: allResults.filter(r => r.status === 'error' || r.status === 'deactivated').length,
        noJpProxy: allResults.filter(r => r.status === 'no_jp_proxy').length,
        noPromo: allResults.filter(r => r.status === 'no_promo').length,
        verifyError: allResults.filter(r => r.status === 'verify_error').length,
        aborted: allResults.filter(r => r.status === 'aborted').length,
      };

      console.log('========================================');
      console.log(`  Success: ${summary.success}  |  No Link: ${summary.noLink}  |  Error: ${summary.error}  |  Aborted: ${summary.aborted}`);
      console.log(`  No-JP: ${summary.noJpProxy}  |  No-Promo: ${summary.noPromo}  |  Verify-Err: ${summary.verifyError}`);
      console.log('========================================');

      this.emit('complete', { summary });

      // Flush logs to DB (engine.js:711)
      try { getDB().logsDB.flush(); } catch (e) { console.log(`[WARN] logsDB.flush: ${e.message?.slice(0, 60)}`); }

      // Reset state (engine.js:714-715)
      this.status = 'idle';
      this.stopFlag = false;
    }
  }
}

module.exports = { PipelineEngine };
