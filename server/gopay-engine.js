// GoPay Plus 激活引擎 — 批量 start()，runner 驱动 login(protocol)→gopay 管线
//
// 外部契约：
//   start(startFrom=0, filterEmails=null) — 批量激活（从 accountsDB 加载 emails 选中账号）
//   state getter — { running, phase, currentAccount, results, logCount }
//   events — 'account-status' / 'step-status' / 'complete' / 'log'
//   stop() — 中止
//
//   login 步（protocol）做协议注册登录 → ctx.outputs.login.accessToken → gopay 三步沿用。
'use strict';

const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

const { PipelineRunner } = require('./pipeline/runner');
const { AccountContext } = require('./pipeline/context');
const { buildPipeline }  = require('./pipeline/index');
const proxyMgr = require('./proxy');
const { killTree } = require('./process-utils');

const MAIN_CONFIG = path.join(__dirname, '..', 'config.json');

const _OTP_RE   = /\b\d{4,6}\b/g;
const _TOKEN_RE = /Bearer\s+\S+|eyJ[A-Za-z0-9_-]{20,}/g;
function redactLine(line) {
  return String(line)
    .replace(_TOKEN_RE, '[REDACTED_TOKEN]')
    .replace(_OTP_RE, (m, offset, str) => {
      const before = str.slice(Math.max(0, offset - 15), offset).toLowerCase();
      if (/otp|code|pin|sms|verif/.test(before)) return '[REDACTED_OTP]';
      return m;
    });
}

class GoPayEngine extends EventEmitter {
  constructor() {
    super();
    this._running = false;
    this._currentAccount = null;
    this._phase = 'idle';
    this._aborted = false;
    this._abortController = null;
    this._pyProc = null;
    this._runner = null;
    this._logCapture = null;
    this._results = [];
    this._logs = [];
    this._injectDeps = null;
  }

  get state() {
    return {
      running: this._running,
      phase: this._phase,
      currentAccount: this._currentAccount,
      results: this._results.slice(-50),
      logCount: this._logs.length,
    };
  }

  emitStatus(data) {
    try {
      const st = proxyMgr.getState();
      data = { ...data, proxyNode: st.currentNode || '', exitIp: st.exitIp || '' };
    } catch {}
    if (data.email) this._currentAccount = data.email;
    if (data.phase) this._phase = data.phase;
    this.emit('account-status', data);
    try {
      const { statusDB } = require('./db');
      statusDB.set(data.email, data);
    } catch (e) {
      console.log(`[GoPay] statusDB.set failed for ${data.email}: ${e.message?.slice(0, 60)}`);
    }
  }

  stop() {
    this._aborted = true;
    if (this._runner) this._runner.stopFlag = true;
    if (this._abortController) { try { this._abortController.abort(); } catch {} }
    const py = this._pyProc; this._pyProc = null;
    if (py) { try { killTree(py.pid); } catch {} try { py.kill(); } catch {} }
    try { const { statusDB } = require('./db'); statusDB.resetRunning?.(); } catch {}
  }

  async start(startFrom = 0, filterEmails = null) {
    if (this._running) throw new Error('GoPay engine already running');
    this._running = true;
    this._aborted = false;
    this._currentAccount = null;
    this._logs = [];
    this._abortController = new AbortController();

    const engine = this;
    const resources = {
      get pyProc() { return engine._pyProc; },
      set pyProc(v) { engine._pyProc = v; },
      get chromeProc() { return null; }, set chromeProc(_v) {},
      get browser() { return null; }, set browser(_v) {},
      get tempDir() { return null; }, set tempDir(_v) {},
    };

    const { LogCapture } = require('./logger');
    this._logCapture = new LogCapture();
    let currentEmail = '';
    const logHandler = (message) => {
      const ts = new Date().toISOString();
      const phase = this._runner?._activeCtx?.currentStepId || '';
      const safe = redactLine(message);
      this._logs.push(safe);
      this.emit('log', { email: currentEmail, phase, message: safe, timestamp: ts });
      if (currentEmail) {
        try { const { logsDB } = require('./db'); logsDB.add(currentEmail, phase, safe, ts); } catch {}
      }
    };
    this._logCapture.onLog(logHandler);
    this._logCapture.start();

    const { accountsDB, statusDB, stepStateDB, save } = require('./db');
    let accounts = accountsDB.list().map(a => ({
      email: a.email, password: a.password, login_type: a.login_type,
      client_id: a.client_id || '', refresh_token: a.refresh_token || '',
    }));
    if (filterEmails?.length > 0) {
      const set = new Set(filterEmails.map(e => e.toLowerCase()));
      accounts = accounts.filter(a => set.has(a.email.toLowerCase()));
    }
    if (accounts.length === 0) {
      this._running = false;
      if (this._logCapture) { this._logCapture.offLog(logHandler); this._logCapture.stop(); }
      throw new Error('No accounts');
    }

    let runtimeCfg = {};
    try { runtimeCfg = JSON.parse(fs.readFileSync(MAIN_CONFIG, 'utf-8')); } catch {}
    const summary = { total: accounts.length, success: 0, error: 0, noLink: 0, noJpProxy: 0, noPromo: 0, verifyError: 0 };

    const ACCOUNT_DELAY_MIN = 15000, ACCOUNT_DELAY_MAX = 45000;
    const COOLDOWN_THRESHOLD = 3, COOLDOWN_MS_MIN = 300000, COOLDOWN_MS_MAX = 600000;
    let consecutiveErrors = 0;

    this._runner = new PipelineRunner({ statusDB, stepStateDB, save, log: () => {} });
    this._runner.on('step-status', d => this.emit('step-status', d));

    try {
      for (let i = 0; i < accounts.length; i++) {
        if (this._aborted) break;
        const account = accounts[i];
        const progress = `${i + 1}/${accounts.length}`;
        currentEmail = account.email;
        const errorsBefore = summary.error;

        console.log(`[${progress}] === ${account.email} (gopay) ===`);
        if (proxyMgr.getState().enabled) {
          try { const node = await proxyMgr.rotate(); console.log(`[${progress}] Proxy rotated → ${node}`); }
          catch (e) { console.log(`[${progress}] Proxy rotate failed: ${e.message?.slice(0, 60)}`); }
        }

        const deps = {
          emitStatus: this.emitStatus.bind(this),
          summary,
          progress,
          proxyMgr,
          resources,
          runtimeCfg,
          statusDB,
          stepStateDB,
          save,
          abortController: this._abortController,
          log: (_e, _s, msg) => console.log(msg),
          ...(this._injectDeps || {}),
        };
        const ctx = new AccountContext({
          email: account.email, password: account.password,
          client_id: account.client_id, refresh_token: account.refresh_token,
          login_type: account.login_type,
        }, deps);

        this._runner.stopFlag = this._aborted;
        const steps = buildPipeline({ login: 'protocol', payment: 'gopay' });
        const result = await this._runner._runAccount(ctx, steps);

        const finalStatus = ctx.flags.finalStatus || (result.completed ? 'plus_gopay' : 'error');
        this._addResult(account, finalStatus, ctx.flags.finalReason || null, {
          phone: ctx.outputs['gopay-pay']?.phone,
          transactionStatus: ctx.outputs['gopay-pay']?.transaction_status,
        });

        if (summary.error > errorsBefore) consecutiveErrors++; else consecutiveErrors = 0;

        if (i < accounts.length - 1) {
          const cd = consecutiveErrors >= COOLDOWN_THRESHOLD
            ? COOLDOWN_MS_MIN + Math.floor(Math.random() * (COOLDOWN_MS_MAX - COOLDOWN_MS_MIN))
            : ACCOUNT_DELAY_MIN + Math.floor(Math.random() * (ACCOUNT_DELAY_MAX - ACCOUNT_DELAY_MIN));
          if (consecutiveErrors >= COOLDOWN_THRESHOLD) consecutiveErrors = 0;
          for (let elapsed = 0; elapsed < cd; elapsed += 1000) {
            if (this._aborted) break;
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      }
    } catch (e) {
      console.log(`[GoPay-Engine] Fatal: ${e.message}`);
    } finally {
      const py = this._pyProc; this._pyProc = null;
      if (py) { try { killTree(py.pid); } catch {} try { py.kill(); } catch {} }
      if (this._logCapture) { this._logCapture.offLog(logHandler); this._logCapture.stop(); }
      console.log(`[GoPay-Engine] Complete: ${JSON.stringify(summary)}`);
      this.emit('complete', { summary });
      this._running = false;
      this._currentAccount = null;
      this._phase = 'idle';
      this._abortController = null;
      this._runner = null;
    }
  }

  _emitLog(msg) {
    const safe = redactLine(msg);
    this._logs.push(safe);
    this.emit('log', safe);
  }

  _addResult(account, status, detail, extra) {
    const r = {
      email: account.email || account.id,
      status, detail: detail || null,
      timestamp: new Date().toISOString(),
      ...extra,
    };
    this._results.push(r);
    this.emit('result', r);
  }
}

const engine = new GoPayEngine();
module.exports = engine;
