// protocol-engine.js — Protocol register mode execution engine
// Same EventEmitter interface as server/engine.js but uses Python curl_cffi for login/register
// v2.55: PKCE/add-phone/register 死代码已迁移至 server/pipeline/steps/{paypal-pkce,login}.js，
// 本文件现为纯 thin shell：仅含 start()/stop()/emitStatus() + EventEmitter 封装。

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

const { statusDB, save } = require('./server/db');
const { connectGateway } = require('./server/discord-gateway');
const proxyMgr = require('./server/proxy');
const { killTree } = require('./server/process-utils');

const ROOT = __dirname;

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
    this._abortController = null;
  }

  getStatus() { return this.status; }

  emitStatus(data) {
    // 从 proxyMgr 注入代理上下文。merge-aware statusDB.set 在缺失时保留旧值；
    // 这里始终注入（除非完全取不到状态），覆盖刚发生的代理切换。
    try {
      const proxyMgr = require('./server/proxy');
      const st = proxyMgr.getState();
      data = { ...data, proxyNode: st.currentNode || '', exitIp: st.exitIp || '' };
    } catch {}
    this.emit('account-status', data);
    try {
      const { statusDB } = require('./server/db');
      statusDB.set(data.email, data);
    } catch (e) {
      console.log(`[DB] statusDB.set failed for ${data.email}: ${e.message?.slice(0, 60)}`);
    }
  }

  async stop() {
    if (this.status === 'idle') return;
    this.stopFlag = true;
    if (this._abortController) try { this._abortController.abort(); } catch {}
    this.status = 'stopping';

    // Kill Python subprocess (login / PKCE). curl_cffi may have child
    // threads/processes; use killTree() so taskkill /T can clean them all
    // on Windows (HX-13). On POSIX it falls back to single-process kill if
    // we didn't spawn with detached:true.
    const py = this._pyProc; this._pyProc = null;
    if (py) {
      try { killTree(py.pid); } catch {}
      try { py.kill(); } catch {}  // belt-and-suspenders: signals the Node child wrapper too
    }
    // Browser graceful close then Chrome kill — see PipelineEngine.stop() for
    // rationale.
    const browser = this._browser; this._browser = null;
    if (browser) {
      try { await browser.close(); } catch {}
    }
    const chromeProc = this._chromeProc; this._chromeProc = null;
    if (chromeProc) {
      try { killTree(chromeProc.pid); } catch {}
      try { chromeProc.kill(); } catch {}
    }
    const gw = this._gw; this._gw = null;
    if (gw) {
      try { gw.cleanup(); } catch {}
    }
    const tempDir = this._tempDir; this._tempDir = null;
    if (tempDir) {
      try { await fs.promises.rm(tempDir, { recursive: true, force: true }); } catch {}
    }
    this._abortController = null;

    // Reset any "running" accounts in DB to idle
    try {
      const { statusDB } = require('./server/db');
      if (statusDB.resetRunning) statusDB.resetRunning();
    } catch {}

    this.status = 'idle';
    this.emit('log', { email: '', phase: '', message: 'Protocol engine force stopped.', timestamp: new Date().toISOString() });
  }

  async start(startFrom = 0, filterEmails = null, opts = {}) {
    this.status = 'running';
    this.stopFlag = false;
    this._abortController = new AbortController();

    // =========================================================================
    // resources bag: thin proxy through to this._* fields.
    // stop() reads this._pyProc / this._chromeProc / this._browser / this._tempDir / this._gw
    // directly, so we proxy reads/writes here to keep stop() unchanged.
    // Steps write into the bag; stop() cleans up the canonical this._ fields.
    // =========================================================================
    const engine = this;  // capture for use in getter/setter proxy below
    const resources = {
      get pyProc()      { return engine._pyProc; },
      set pyProc(v)     { engine._pyProc = v; },
      get chromeProc()  { return engine._chromeProc; },
      set chromeProc(v) { engine._chromeProc = v; },
      get browser()     { return engine._browser; },
      set browser(v)    { engine._browser = v; },
      get tempDir()     { return engine._tempDir; },
      set tempDir(v)    { engine._tempDir = v; },
      get gw()          { return engine._gw; },
      set gw(v)         { engine._gw = v; },
    };

    // =========================================================================
    // runner-loop: LogCapture (inventory 554–566)
    // Phase tagging now reads the runner's active step id for richer log metadata.
    // =========================================================================
    const { LogCapture } = require('./server/logger');
    this._logCapture = new LogCapture();
    let currentEmail = '';
    const logHandler = (message) => {
      const ts = new Date().toISOString();
      const phase = this._runner?._activeCtx?.currentStepId || '';
      this.emit('log', { email: currentEmail, phase, message, timestamp: ts });
      if (currentEmail) {
        try { const { logsDB } = require('./server/db'); logsDB.add(currentEmail, phase, message, ts); } catch {}
      }
    };
    this._logCapture.onLog(logHandler);
    this._logCapture.start();

    // =========================================================================
    // runner-loop: load accounts + filter (inventory 569–577)
    // =========================================================================
    const { accountsDB, stepStateDB } = require('./server/db');
    let accounts = accountsDB.list().map(a => ({
      email: a.email, password: a.password, login_type: a.login_type,
      client_id: a.client_id || '', refresh_token: a.refresh_token || '',
    }));

    if (filterEmails?.length > 0) {
      const set = new Set(filterEmails.map(e => e.toLowerCase()));
      accounts = accounts.filter(a => set.has(a.email.toLowerCase()));
    }
    // runner-loop: No accounts fatal (inventory 578)
    if (accounts.length === 0) throw new Error('No accounts');

    // runner-loop: runtimeCfg (inventory 580)
    const runtimeCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
    // runner-loop: summary (inventory 581)
    const summary = { total: accounts.length, success: 0, noLink: 0, error: 0, noJpProxy: 0, noPromo: 0, verifyError: 0 };

    // runner-loop: cooldown constants (inventory 584–589)
    const COOLDOWN_THRESHOLD = 3;          // N consecutive failures triggers cooldown
    const COOLDOWN_MS_MIN = 300000;        // 5 min
    const COOLDOWN_MS_MAX = 600000;        // 10 min
    const ACCOUNT_DELAY_MIN = 15000;       // 15s between accounts
    const ACCOUNT_DELAY_MAX = 45000;       // 45s between accounts
    let consecutiveErrors = 0;

    // =========================================================================
    // Instantiate PipelineRunner (single instance, reused per account).
    // Deps template is shared for all accounts; per-account fields (emitStatus,
    // summary, progress, resources, runtimeCfg, linkSource, abortController)
    // are passed into each AccountContext's deps at construction time.
    // =========================================================================
    const { PipelineRunner } = require('./server/pipeline/runner');
    const { AccountContext } = require('./server/pipeline/context');
    const { buildPipeline } = require('./server/pipeline');

    const runnerDeps = {
      statusDB,
      stepStateDB,
      save,
      log: (email, stepId, msg) => console.log(msg),
    };
    this._runner = new PipelineRunner(runnerDeps);
    // Forward step-status events (ADDITIVE new event — does not replace existing events)
    this._runner.on('step-status', d => this.emit('step-status', d));

    try {
      // === Sequential: each account runs login → Discord → payment → done before next ===
      console.log(`[Proto-Engine] Starting ${accounts.length} accounts sequentially...`);

      // runner-loop: linkSource + Discord connect (inventory 596–603)
      const linkSource = runtimeCfg.paymentLinkSource || 'api';
      console.log(`[Proto-Engine] Payment link source: ${linkSource}`);

      if (linkSource === 'discord') {
        console.log('[Proto-Engine] Connecting to Discord Gateway...');
        this._gw = await connectGateway();
        // Mirror into resources bag so paypal-fetch step can read/write resources.gw
        // (resources.gw proxies through to this._gw via the getter/setter above)
        console.log('[Proto-Engine] Discord connected!');
      }

      for (let i = 0; i < accounts.length; i++) {
        // runner-loop: stopFlag check (inventory 606)
        if (this.stopFlag) break;
        const account = accounts[i];
        const progress = `${i + 1}/${accounts.length}`;
        currentEmail = account.email;
        // runner-loop: errorsBefore (inventory 610)
        const errorsBefore = summary.error;

        // runner-loop: proxy rotate per account (inventory 649–656)
        // NOTE: placed BEFORE AccountContext construction and BEFORE _runAccount,
        // to preserve the original ordering (rotate → then steps start).
        console.log(`[${progress}] === ${account.email} (protocol) ===`);
        if (proxyMgr.getState().enabled) {
          try {
            const node = await proxyMgr.rotate();
            console.log(`[${progress}] Proxy rotated → ${node}`);
          } catch (e) {
            console.log(`[${progress}] Proxy rotate failed: ${e.message?.slice(0, 60)}`);
          }
        }

        // AccountContext MUST be constructed BEFORE any step writes to statusDB
        // (prevPersisted snapshot is load-bearing for cached-login and cached-link).
        // Per-account deps assembled here and passed into ctx.
        const deps = {
          emitStatus: this.emitStatus.bind(this),
          summary,
          progress,
          proxyMgr,
          resources,
          runtimeCfg,
          linkSource,
          statusDB,
          stepStateDB,
          save,
          abortController: this._abortController,
          log: (email, stepId, msg) => console.log(msg),
        };
        const ctx = new AccountContext({
          email: account.email,
          password: account.password,
          client_id: account.client_id,
          refresh_token: account.refresh_token,
          login_type: account.login_type,
        }, deps);

        // Sync stopFlag into runner before each account
        this._runner.stopFlag = this.stopFlag;

        const steps = buildPipeline({ login: 'protocol', payment: 'paypal' });
        await this._runner._runAccount(ctx, steps, { forceStepId: opts.forceStepId });

        // runner-loop: consecutiveErrors tracking (inventory 962–968)
        if (summary.error > errorsBefore) {
          consecutiveErrors++;
          console.log(`[${progress}] consecutive errors: ${consecutiveErrors}/${COOLDOWN_THRESHOLD}`);
        } else {
          consecutiveErrors = 0;
        }

        // runner-loop: cooldown / delay (inventory 970–989)
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
            const delayMs = ACCOUNT_DELAY_MIN + Math.floor(Math.random() * (ACCOUNT_DELAY_MAX - ACCOUNT_DELAY_MIN));
            for (let elapsed = 0; elapsed < delayMs; elapsed += 1000) {
              if (this.stopFlag) break;
              await new Promise(r => setTimeout(r, 1000));
            }
          }
        }
      }

    } catch (e) {
      // runner-loop: fatal catch (inventory 992–994)
      console.log(`[Proto-Engine] Fatal: ${e.message}`);
      summary.error = summary.total;  // All accounts failed due to gateway
    } finally {
      // runner-loop + engine-shell: finally cleanup (inventory 995–1006)
      // stop() cleans this._browser/_chromeProc/_gw/_tempDir/_pyProc via this._ fields.
      // resources bag proxies through to these, so any step that set resources.chromeProc
      // etc. is already reflected in this._chromeProc etc. here.
      if (this._browser) try { await this._browser.close(); } catch {}
      if (this._chromeProc) try { killTree(this._chromeProc.pid); } catch {}
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
