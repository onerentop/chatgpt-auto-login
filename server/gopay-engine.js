// GoPay Plus 激活引擎 — 6 阶段纯协议编排
//
// Phase 1: Outlook login (复用 protocol-engine runProtocolRegister)
// Phase 2: Plan check (planType == 'plus' → skip)
// Phase 3: Stripe GoPay flow (stripe_gopay_flow.py → Midtrans snap URL)
// Phase 4+5: GoPay register + pay (gopay_activate.py)
// Phase 6: Verify Plus (planType check)
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

const STRIPE_SCRIPT = path.join(__dirname, '..', 'stripe_gopay_flow.py');
const GOPAY_SCRIPT = path.join(__dirname, '..', 'gopay_activate.py');
const MAIN_CONFIG = path.join(__dirname, '..', 'config.json');

const _OTP_RE = /\b\d{4,6}\b/g;
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
    this._childProc = null;
    this._aborted = false;
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

      // Phase 2: Plan check
      this._setPhase('plan_check');
      if (account.planType === 'plus') {
        this._addResult(account, 'already_plus');
        return;
      }

      // Phase 4 → Phase 3 → Phase 5（gopay_activate.py 内部按此顺序执行）
      // Phase 4 耗时长（注册钱包），先做；Phase 3 拿 snap token（15 分钟有效），紧接 Phase 5
      this._setPhase('gopay_activate');
      const mainCfg = JSON.parse(fs.readFileSync(MAIN_CONFIG, 'utf-8'));
      const gopayInput = {
        access_token: accessToken,
        pin: mainCfg.gopay?.defaultPin || '147258',
      };
      const gopayEnv = {};

      const gopayResult = await this._spawnPython(GOPAY_SCRIPT, gopayInput, gopayEnv, 600000);

      if (gopayResult.status === 'success') {
        this._setPhase('verify_plus');
        this._addResult(account, 'plus_gopay', null, {
          phone: gopayResult.phone,
          transactionStatus: gopayResult.transaction_status,
        });
      } else {
        this._addResult(account, gopayResult.status || 'gopay_pay_fail', gopayResult.detail, {
          phone: gopayResult.phone,
        });
      }
    } catch (err) {
      this._addResult(account, 'error', err.message);
    } finally {
      this._running = false;
      this._currentAccount = null;
      this._phase = 'idle';
      this._childProc = null;
    }
  }

  stop() {
    this._aborted = true;
    if (this._childProc) {
      try { this._childProc.kill(); } catch {}
    }
  }

  _setPhase(phase) {
    this._phase = phase;
    this._emitLog(`Phase: ${phase}`);
  }

  _emitLog(msg) {
    const safe = redactLine(msg);
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

  _spawnPython(script, input, envOverrides, timeoutMs) {
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
