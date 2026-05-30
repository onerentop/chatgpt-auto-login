// GoPay Plus 激活引擎 — runner 驱动 gopay 管线
//
// 外部契约（保持不变）：
//   runOne(account)  — 执行一个账号的 GoPay 激活流程
//   state getter     — { running, phase, currentAccount, results, logCount }
//   events           — 'log', 'result'
//   stop()           — 中止当前运行
//
// 内部实现（P3 迁移）：
//   用 PipelineRunner._runAccount 驱动 buildPipeline({payment:'gopay'}) 的 4 步管线
//   （plan-check → gopay-register → gopay-pay → gopay-verify），
//   取代原来直接 _spawnPython(GOPAY_SCRIPT, ...) 的单次 Python 调用。
//   PipelineRunner._recordStep 会写 account_step_state，步骤抽屉可读取。
'use strict';

const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

const { PipelineRunner }  = require('./pipeline/runner');
const { AccountContext }  = require('./pipeline/context');
const { buildPipeline }   = require('./pipeline/index');

// DB 依赖懒加载：gopay-engine 可在 initDB() 完成前被 require（测试/单机场景）。
// 用 getter 推迟访问；若 DB 尚未初始化则透明降级为 no-op shim，避免 db.prepare() 在
// db===null 时 crash（AccountContext 构造器在 prevPersisted 读取时会触发 statusDB.get()）。
function _safeDb() {
  try {
    const db = require('./db');
    // 探活：如果 db 真的可用，statusDB.get 不会抛；否则降级
    db.statusDB.get('__probe__');
    return db;
  } catch {
    return null;
  }
}

const _noopStatusDB = {
  get:              () => null,
  set:              () => {},
  reset:            () => {},
  clearAccessToken: () => {},
  clearPaymentLink: () => {},
  setAlive:         () => {},
  clearAlive:       () => {},
};
const _noopStepStateDB = {
  get:   () => null,
  list:  () => [],
  set:   () => {},
  reset: () => {},
};
const _noopSave = async () => {};

function _getDbDeps() {
  const db = _safeDb();
  if (db) return { statusDB: db.statusDB, stepStateDB: db.stepStateDB, save: db.save };
  return { statusDB: _noopStatusDB, stepStateDB: _noopStepStateDB, save: _noopSave };
}

const STRIPE_SCRIPT = path.join(__dirname, '..', 'stripe_gopay_flow.py');
const GOPAY_SCRIPT  = path.join(__dirname, '..', 'gopay_activate.py');
const MAIN_CONFIG   = path.join(__dirname, '..', 'config.json');

const _OTP_RE   = /\b\d{4,6}\b/g;
const _TOKEN_RE = /Bearer\s+\S+|eyJ[A-Za-z0-9_-]{20,}/g;

function redactLine(line) {
  return line
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
    this._childProc = null;   // kept for stop() compat (harmless; spawn now inside steps)
    this._aborted = false;
    this._abortController = null;
    this._results = [];
    this._logs = [];
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

  async runOne(account) {
    if (this._running) throw new Error('Engine already running');
    this._running = true;
    this._aborted = false;
    this._currentAccount = account.email || account.id;
    this._logs = [];

    try {
      const accessToken = account.accessToken || account.access_token;
      if (!accessToken) throw new Error('No access token');

      // AbortController：stop() 通过 abort() 通知 runner/steps 中止
      this._abortController = new AbortController();

      // deps 构造：把 step 发出的 emitStatus 映射到引擎 phase 状态 + log
      const self = this;
      const { statusDB, stepStateDB, save } = _getDbDeps();

      const deps = {
        emitStatus(d) {
          // step 在 running/done 事件中携带 phase，映射到引擎 _phase 状态
          if (d.phase && d.phase !== 'done') {
            self._setPhase(d.phase);
          }
        },
        summary: {},          // gopay 路径不用计数器
        progress: '1/1',
        runtimeCfg: JSON.parse(fs.readFileSync(MAIN_CONFIG, 'utf-8')),
        abortController: this._abortController,
        statusDB,
        stepStateDB,
        save,
        log: (_email, _stepId, msg) => this._emitLog(msg),
      };

      const ctx = new AccountContext(
        { email: account.email || account.id },
        deps,
      );

      // 注入外部已获取的 login 输出（GoPay 无 login step）
      ctx.outputs.login = {
        accessToken,
        session:  account.session  || {},
        planType: account.planType || 'free',
      };

      const runner = new PipelineRunner(deps);
      // 透传 step-status 事件（供未来 socket 接线；目前无前端消费，harmless）
      runner.on('step-status', (d) => this.emit('step-status', d));

      const steps = buildPipeline({ payment: 'gopay' });
      const result = await runner._runAccount(ctx, steps);

      // 确定终止状态
      const finalStatus = ctx.flags.finalStatus ||
        (result.completed ? 'plus_gopay' : 'error');

      this._addResult(account, finalStatus, ctx.flags.finalReason || null, {
        phone:             ctx.outputs['gopay-pay']?.phone,
        transactionStatus: ctx.outputs['gopay-pay']?.transaction_status,
      });

    } catch (err) {
      this._addResult(account, 'error', err.message);
    } finally {
      this._running = false;
      this._currentAccount = null;
      this._phase = 'idle';
      this._childProc = null;
      this._abortController = null;
    }
  }

  stop() {
    this._aborted = true;
    // 优先通过 AbortController 通知 runner/steps（spawnGopay 监听 signal）
    if (this._abortController) {
      try { this._abortController.abort(); } catch {}
    }
    // _childProc kill 保留（backward compat；_childProc 目前由 steps 内部管理，通常为 null）
    if (this._childProc) {
      try { this._childProc.kill(); } catch {}
    }
  }

  _setPhase(phase) {
    this._phase = phase;
    this._emitLog(`Phase: ${phase}`);
  }

  _emitLog(msg) {
    const safe = redactLine(String(msg));
    this._logs.push(safe);
    this.emit('log', safe);
  }

  _addResult(account, status, detail, extra) {
    const r = {
      email: account.email || account.id,
      status,
      detail: detail || null,
      timestamp: new Date().toISOString(),
      ...extra,
    };
    this._results.push(r);
    this.emit('result', r);
  }

  // _spawnPython kept for reference; no longer called by runOne (P5 cleanup)
  _spawnPython(script, input, envOverrides, timeoutMs) {
    const { spawn } = require('child_process');
    return new Promise((resolve) => {
      if (this._aborted) {
        resolve({ status: 'aborted' });
        return;
      }

      const child = spawn('py', ['-3', script], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, ...envOverrides },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this._childProc = child;

      let finalResult = null;
      let stderr = '';

      child.stdin.write(JSON.stringify(input));
      child.stdin.end();

      child.stdout.on('data', (data) => {
        for (const line of data.toString().split('\n').filter(l => l.trim())) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.log) {
              this._emitLog(parsed.log);
            } else {
              finalResult = parsed;
            }
          } catch {
            this._emitLog(line);
          }
        }
      });

      child.stderr.on('data', (d) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        resolve({ status: 'timeout', detail: `${timeoutMs}ms exceeded` });
      }, timeoutMs);

      child.on('exit', () => {
        clearTimeout(timer);
        this._childProc = null;
        if (finalResult) {
          resolve(finalResult);
        } else {
          resolve({ status: 'error', detail: stderr.slice(-300) || 'no output' });
        }
      });

      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ status: 'error', detail: e.message });
      });
    });
  }
}

const engine = new GoPayEngine();
module.exports = engine;
