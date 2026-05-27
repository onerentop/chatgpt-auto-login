// protocol-engine.js — Protocol register mode execution engine
// Same EventEmitter interface as server/engine.js but uses Python curl_cffi for login/register

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { autoPayment } = require('./payment');
const { randomDelay, saveCPAAuthFile } = require('./utils');
const { statusDB } = require('./server/db');
const { connectGateway, getPaymentLink } = require('./server/discord-gateway');
const { fetchCheckoutLink } = require('./server/chatgpt-checkout');
const { verifyCheckoutIsFree } = require('./server/stripe-verify');
const { launchChrome, waitForCDP, findFreePort } = require('./server/chrome');
const proxyMgr = require('./server/proxy');
const { killTree } = require('./server/process-utils');
const phonePool = require('./server/phone-pool');
const zhusmsProvider = require('./server/zhusms-provider');
const { getRawDb, save } = require('./server/db');

const ROOT = __dirname;
const PYTHON_SCRIPT = path.join(ROOT, 'protocol_register.py');
const PYTHON_PHONE_VERIFY_SCRIPT = path.join(ROOT, 'protocol_phone_verify.py');

// ========== Python subprocess ==========
function runProtocolRegister(account, engine) {
  return new Promise((resolve, reject) => {
    const py = spawn('py', ['-3', PYTHON_SCRIPT], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    if (engine) engine._pyProc = py;
    let settled = false;
    const timeout = setTimeout(() => { if (!settled) { settled = true; py.kill(); reject(new Error('Python timeout (120s)')); } }, 120000);
    // v2.42: 不再显式传 proxy，Python 走 HTTPS_PROXY env（global.js 已设）
    const input = JSON.stringify({ email: account.email, password: account.password, client_id: account.client_id || '', refresh_token: account.refresh_token || '' });
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
    // v2.42: 不再显式传 proxy，Python 走 HTTPS_PROXY env
    const input = JSON.stringify({ email: account.email, password: account.password, client_id: account.client_id || '', refresh_token: account.refresh_token || '', pkce: true });
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

// v2.40.0: 协议模式 add_phone 单次 attempt（spawn protocol_phone_verify.py）
let runProtocolPhoneVerify = function (sessionState, phone, smsConfig, proxyUrl, engine) {
  return new Promise((resolve) => {
    const py = spawn('py', ['-3', PYTHON_PHONE_VERIFY_SCRIPT], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    if (engine) engine._pyProc = py;
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; try { py.kill('SIGKILL'); } catch {} resolve({ status: 'submit-error', detail: 'timeout 180s' }); }
    }, 180_000);
    const input = JSON.stringify({
      session_state: sessionState,
      phone, sms: smsConfig, proxy_url: proxyUrl,
    });
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
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ status: 'submit-error', detail: stderr.slice(-800) || `python exit ${code}` });
      }
    });
    py.on('error', (e) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      resolve({ status: 'submit-error', detail: `spawn failed: ${e.message}` });
    });
    py.stdin.write(input);
    py.stdin.end();
  });
};

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

  // v2.40.0: 协议模式 add_phone — 统一 local / zhusms provider 出参
  // v2.40.1: 加 excludePhones 参数避免 retry 反复取同号
  async _acquirePhoneForProtocol(provider, cfg, email, proxyUrl, excludePhones = []) {
    if (provider === 'zhusms') {
      const z = cfg.phonePool.zhusms || {};
      if (!z.cardKey) return {};
      try {
        const order = await zhusmsProvider.takeOrder(
          z.cardKey, z.baseUrl || 'https://zhusms.com',
          z.service || 'codex', proxyUrl,
        );
        if (!order) return {};
        // 拿 session cookie 给 Python 用（避免 Python 再 activate 一次）
        let cookie = '';
        try {
          cookie = await zhusmsProvider.ensureSession(z.cardKey, z.baseUrl || 'https://zhusms.com', proxyUrl);
        } catch {}
        return {
          phone: order.phone,
          smsConfig: {
            provider: 'zhusms',
            order_no: order.order_no,
            base_url: z.baseUrl || 'https://zhusms.com',
            card_key: z.cardKey,
            cookie,
          },
          releaseFn: async () => {
            try { await zhusmsProvider.cancelOrder(order.order_no, z.baseUrl || 'https://zhusms.com', z.cardKey, proxyUrl); } catch {}
          },
        };
      } catch (e) {
        console.log(`[protocol] zhusms takeOrder failed: ${e?.message?.slice(0, 60)}`);
        return {};
      }
    }
    if (provider === 'smscloud') {
      const s = cfg.phonePool.smscloud || {};
      if (!s.apiKey || !s.serviceCode || !s.countryCode) {
        console.log(`[protocol] smscloud config incomplete (apiKey/serviceCode/countryCode 任一为空)`);
        return {};
      }
      try {
        const smscloud = require('./server/smscloud-provider');
        const smscloudPool = require('./server/smscloud-pool');
        const max = cfg.phonePool.maxBindingsPerPhone || 3;
        const EXPIRY_MS = 18 * 60 * 1000;
        const baseUrl = s.baseUrl || 'https://smscloud.sbs/api/system';
        const takeOrderFn = async () => {
          const order = await smscloud.takeOrder(s.apiKey, baseUrl, s.serviceCode, s.countryCode);
          if (!order || !order.phone) throw new Error('takeOrder empty');
          return { orderNo: order.order_no, phone: order.phone, apiKey: s.apiKey, baseUrl };
        };
        // v2.45.1: 复用号 cache hit 要 resend 通知 smscloud advance 上游 channel；
        // 失败则 markRejected + releaseBinding，循环重 acquire（拿新号或下一个 active cache 行）
        const MAX_ACQUIRE_TRIES = 3;
        let acq = null;
        for (let i = 0; i < MAX_ACQUIRE_TRIES; i++) {
          acq = await smscloudPool.acquirePhone(getRawDb(), email, max, EXPIRY_MS, excludePhones, takeOrderFn);
          if (!acq.reused) break;
          try {
            await smscloud.resendSms(acq.orderNo, acq.apiKey, acq.baseUrl);
            console.log(`[protocol] smscloud resend SMS for orderNo=${acq.orderNo}`);
            break;
          } catch (e) {
            console.log(`[protocol] smscloud resend failed for ${acq.orderNo}: ${e?.message?.slice(0, 80)}, marking rejected`);
            smscloudPool.markRejected(getRawDb(), acq.orderNo);
            smscloudPool.releaseBinding(getRawDb(), acq.orderNo, email, acq.phone);
            try { save(); } catch {}
            acq = null;
            // continue: next iteration re-acquires (rejected entry 已被 WHERE status='active' 跳过)
          }
        }
        if (!acq) {
          console.log(`[protocol] smscloud acquire exhausted after ${MAX_ACQUIRE_TRIES} tries`);
          return {};
        }
        try { save(); } catch {}
        console.log(`[protocol] smscloud ${acq.reused ? '复用' : '新取'}号 ${acq.phone} (orderNo=${acq.orderNo}, bindings=${acq.bindings_used})`);
        return {
          phone: acq.phone,
          smsConfig: { provider: 'smscloud', order_no: acq.orderNo, api_key: acq.apiKey, base_url: acq.baseUrl },
          releaseFn: async () => {
            try {
              smscloudPool.releaseBinding(getRawDb(), acq.orderNo, email, acq.phone);
              save();
            } catch (e) {
              console.log(`[protocol] smscloud releaseBinding failed: ${e?.message?.slice(0, 60)}`);
            }
          },
          meta: {
            provider: 'smscloud',
            orderNo: acq.orderNo,
            apiKey: acq.apiKey,
            baseUrl: acq.baseUrl,
            takenAtMs: acq.taken_at_ms,
          },
        };
      } catch (e) {
        console.log(`[protocol] smscloud acquire failed: ${e?.message?.slice(0, 60)}`);
        return {};
      }
    }
    // local
    const max = cfg.phonePool.maxBindingsPerPhone || 3;
    const allotted = phonePool.acquirePhone(getRawDb(), email, max, excludePhones);
    if (!allotted) return {};
    return {
      phone: allotted.phone,
      smsConfig: { provider: 'local', url: allotted.smsApiUrl },
      releaseFn: async () => { phonePool.releaseBinding(getRawDb(), allotted.phone, email); },
    };
  }

  // v2.40.0: 协议模式 add_phone 主流程（retry 3 次，按 result.status 分流）
  async _finalizePhoneVerify(sessionState, account) {
    const CONFIG_PATH = path.join(ROOT, 'config.json');
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch {}
    if (!cfg?.phonePool?.enabled) {
      return { phoneVerifyFail: 'pool-disabled' };
    }

    let proxyUrl = null;
    try {
      const state = proxyMgr.getState?.();
      if (state?.enabled) proxyUrl = 'http://127.0.0.1:7890';
    } catch {}

    const provider = cfg.phonePool.provider || 'local';
    const MAX_ATTEMPTS = 3;
    let lastReason = null;
    const triedPhones = [];  // v2.40.1: retry 内防止反复取同号

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const acq = await this._acquirePhoneForProtocol(provider, cfg, account.email, proxyUrl, triedPhones);
      const { phone, smsConfig, releaseFn, meta } = acq;
      if (!phone) {
        return lastReason ? { phoneVerifyFail: lastReason } : { phonePoolEmpty: true };
      }
      triedPhones.push(phone);
      // v2.39.4 hotfix 等价：拿号后立即落盘
      try { save(); } catch {}

      console.log(`[protocol] add-phone (attempt ${attempt}/${MAX_ATTEMPTS}): ${phone} (provider=${provider})`);
      const result = await runProtocolPhoneVerify(sessionState, phone, smsConfig, proxyUrl, this);

      if (result.status === 'ok') {
        console.log(`[protocol] add-phone OK, tokens obtained`);
        return { tokens: result.tokens };
      }
      if (result.status === 'phone-rejected') {
        console.log(`[protocol] OpenAI rejected ${phone}: ${(result.detail || '').slice(0, 500)}, retry`);
        if (releaseFn) try { await releaseFn(); } catch {}
        try { save(); } catch {}
        lastReason = 'phone-rejected-by-openai';
        continue;
      }
      if (result.status === 'rate-limited' || result.status === 'fraud-blocked' || result.status === 'voip-blocked') {
        // v2.44.1: rate-limited / fraud-blocked / voip-blocked 现在走换号 retry。
        // local provider 保留 markPhoneSaturated（持久黑名单避免后续账号再选到）。
        // v2.45.0: smscloud 走 cache markRejected + deferred-cancel 入队（不动 releaseFn，
        //   binding 记录保留以避免本 session 同账号重选同号）。zhusms/其他走原 releaseFn。
        console.log(`[protocol] ${result.status} for ${phone}: ${(result.detail || '').slice(0, 500)}, retry with new phone`);
        if (provider === 'local') {
          try {
            const max = cfg.phonePool.maxBindingsPerPhone || 3;
            phonePool.markPhoneSaturated(getRawDb(), phone, max);
            save();
          } catch (e) { console.log(`[protocol] markPhoneSaturated err: ${e?.message}`); }
        } else if (meta?.provider === 'smscloud') {
          try {
            const smscloudPool = require('./server/smscloud-pool');
            const deferredCancel = require('./server/smscloud-deferred-cancel');
            smscloudPool.markRejected(getRawDb(), meta.orderNo);
            deferredCancel.enqueue({ apiKey: meta.apiKey, baseUrl: meta.baseUrl, orderNo: meta.orderNo, takenAtMs: meta.takenAtMs });
            save();
          } catch (e) { console.log(`[protocol] smscloud markRejected err: ${e?.message}`); }
        } else {
          if (releaseFn) try { await releaseFn(); } catch {}
          try { save(); } catch {}
        }
        lastReason = result.status;
        continue;
      }
      if (result.status === 'sms-timeout' || result.status === 'validate-error' || result.status === 'submit-error') {
        // OpenAI 那边号没真用（spawn 失败 / SMS 没到 / OpenAI 拒验证码）→ release
        // v2.40.2 fix：原 submit-error 也归 post-validate-error 错（spawn 失败时号根本没用上）
        console.log(`[protocol] add-phone ${result.status}: ${(result.detail || '').slice(0, 500)}`);
        if (releaseFn) try { await releaseFn(); } catch {}
        try { save(); } catch {}
        return { phoneVerifyFail: result.status };
      }
      // post-validate-error: OpenAI 已接受号 + 验证码，binding 保留
      console.log(`[protocol] add-phone post-validate failure: ${(result.detail || '').slice(0, 500)}, binding kept`);
      return { phoneVerifyFail: 'post-validate-error' };
    }

    return { phoneVerifyFail: lastReason || 'all-phones-rejected' };
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
      } else if (pkce.needsPhone) {
        // v2.40.0: 协议模式 add_phone 自动化
        console.log(`[${progress}] PKCE requires phone verification, running protocol add-phone flow...`);
        const r = await this._finalizePhoneVerify(pkce.session_state || {}, account);
        if (r.tokens) {
          console.log(`[${progress}] add-phone success, saving with refresh_token`);
          saveCPAAuthFile(account.email, r.tokens.access_token || loginResult.accessToken, {
            ...loginResult.session,
            refresh_token: r.tokens.refresh_token,
            id_token: r.tokens.id_token || '',
          });
          this.emitStatus({ email: account.email, status: 'plus', phase: 'done', progress });
        } else {
          // failure 映射：phonePoolEmpty → phone_pool_empty；phoneVerifyFail/pool-disabled → 既有 status
          let failStatus;
          if (r.phonePoolEmpty) failStatus = 'phone_pool_empty';
          else if (r.phoneVerifyFail === 'pool-disabled') failStatus = 'plus_no_rt';
          else failStatus = 'phone_verify_fail';
          console.log(`[${progress}] add-phone failed: ${r.phoneVerifyFail || 'pool-empty'}, status=${failStatus}`);
          saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
          this.emitStatus({ email: account.email, status: failStatus, phase: 'done', progress });
        }
      } else {
        console.log(`[${progress}] PKCE no RT: ${pkce.error || 'unknown'}`);
        saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
        this.emitStatus({ email: account.email, status: 'plus_no_rt', phase: 'done', progress });
      }
    } catch (e) {
      console.log(`[${progress}] PKCE error: ${e.message?.slice(0, 60)}`);
      saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
      this.emitStatus({ email: account.email, status: 'plus_no_rt', phase: 'done', progress });
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

  async start(startFrom = 0, filterEmails = null) {
    this.status = 'running';
    this.stopFlag = false;
    this._abortController = new AbortController();

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
    const summary = { total: accounts.length, success: 0, noLink: 0, error: 0, noJpProxy: 0, noPromo: 0, verifyError: 0 };

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

        // Snapshot the persisted row BEFORE any emitStatus call wipes it to
        // status='running'. The cache-check below reads this snapshot, not
        // the live DB row, so the user's previous failure (verify_error etc.)
        // is still visible after we transition into the new run.
        const prevPersisted = statusDB.get(account.email) || {};

        // Cached-login fast path: if a previous login persisted a JWT and the
        // exp is still in the future (with 60s buffer), reconstitute `result`
        // from the DB and skip Phase 1 entirely. Combined with the v2.25
        // payment-link cache below, a retry that hits both caches goes
        // directly to Phase 3 PayPal — saving 30-60s of OTP+auth0 churn.
        const JWT_BUFFER_SEC = 60;
        let result = null;
        if (prevPersisted.last_access_token) {
          const { decodeJwtExp } = require('./server/liveness/checker');
          const exp = decodeJwtExp(prevPersisted.last_access_token);
          if (exp > Date.now() / 1000 + JWT_BUFFER_SEC) {
            let session = null;
            try { session = JSON.parse(prevPersisted.last_session_json || '{}'); }
            catch { session = null; }
            if (session) {
              result = {
                accessToken: prevPersisted.last_access_token,
                session,
                planType: session?.account?.planType || session?.chatgpt_plan_type || 'free',
              };
              const minLeft = Math.floor((exp - Date.now() / 1000) / 60);
              console.log(`[${progress}] Phase 1: reusing cached access token (exp in ${minLeft} min)`);
              this.emitStatus({ email: account.email, status: 'running', phase: 'cached-login', progress });
            }
          }
        }

        console.log(`[${progress}] === ${account.email} (protocol) ===`);
        // Rotate proxy node before each account (if proxy enabled).
        // Hoisted OUT of `if (!result)` so cache-hit accounts also get a
        // fresh node for Phase 3 PayPal — matches server/engine.js parity.
        if (proxyMgr.getState().enabled) {
          try {
            const node = await proxyMgr.rotate();
            console.log(`[${progress}] Proxy rotated → ${node}`);
          } catch (e) {
            console.log(`[${progress}] Proxy rotate failed: ${e.message?.slice(0, 60)}`);
          }
        }

        // Step 1: Protocol login (skipped when result was reconstituted above)
        if (!result) {
          this.emitStatus({ email: account.email, status: 'running', phase: 'protocol-login', progress });

          try {
            result = await runProtocolRegister(account, this);
            if (result.status === 'tls_failure') {
              const badNode = proxyMgr.getState().currentNode;
              console.log(`[${progress}] TLS errors persisted on ${badNode}; counting + rotating + retrying once`);
              if (proxyMgr.getState().enabled) {
                try { proxyMgr.recordBadAttempt(badNode, 'main', 'tls_failure'); } catch {}
                try {
                  const newNode = await proxyMgr.rotate();
                  console.log(`[${progress}] Retrying on ${newNode}`);
                } catch (e) {
                  console.log(`[${progress}] Rotate failed: ${e.message?.slice(0, 60)}`);
                }
              }
              result = await runProtocolRegister(account, this);
              if (result.status === 'tls_failure') {
                console.log(`[${progress}] TLS still failing after rotation — giving up on this account`);
                if (proxyMgr.getState().enabled) {
                  try { proxyMgr.recordBadAttempt(proxyMgr.getState().currentNode, 'main', 'tls_failure'); } catch {}
                }
                this.emitStatus({ email: account.email, status: 'error', phase: 'protocol-login', progress, reason: result.error });
                summary.error++;
                continue;
              }
            }
            // G1: 任何"业务返回"（success / deactivated 等）都代表节点工作正常
            if (proxyMgr.getState().enabled) {
              try { proxyMgr.recordGoodAttempt(proxyMgr.getState().currentNode, 'main'); } catch {}
            }
            if (result.status === 'deactivated') {
              console.log(`[${progress}] Account deactivated/deleted by OpenAI`);
              this.emitStatus({ email: account.email, status: 'deactivated', phase: 'done', progress, reason: 'account_deactivated' });
              summary.error++;
              continue;
            }
            console.log(`[${progress}] Protocol login OK: ${result.accessToken}`);
          } catch (e) {
            console.log(`[${progress}] Protocol login failed: ${e.message?.slice(0, 500)}`);
            // T8: 网络类异常算节点失败；业务异常不算
            if (proxyMgr.isProxyNetError(e.message) && proxyMgr.getState().enabled) {
              try { proxyMgr.recordBadAttempt(proxyMgr.getState().currentNode, 'main', 'protocol_net_error'); } catch {}
            }
            this.emitStatus({ email: account.email, status: 'error', phase: 'protocol-login', progress, reason: e.message });
            summary.error++;
            continue;
          }
        }

        // After Phase 1 (cached or fresh), persist the token to DB so the
        // next retry can skip Phase 1 entirely. Without this, the
        // cached-login fast-path above would never have anything to read.
        if (result) {
          // status: 'running' explicitly passed; without it, statusDB.set's
          // destructuring default would revert status to 'idle' and the
          // running-account would flicker off the UI for one frame.
          statusDB.set(account.email, {
            status: 'running',
            phase: 'protocol-login',
            progress,
            accessToken: result.accessToken,
            sessionJson: JSON.stringify(result.session || {}),
          });
        }

        // Check if already Plus
        const isPlusOrAbove = ['plus', 'pro', 'team', 'enterprise'].includes((result.planType || 'free').toLowerCase());
        if (isPlusOrAbove) {
          statusDB.clearPaymentLink(account.email);
          statusDB.clearAccessToken(account.email);
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
        let fetchResult = null;

        // Reconnect Gateway only when using Discord path
        if (linkSource === 'discord' && this._gw?.ws?.readyState !== 1) {
          console.log(`[${progress}] Gateway disconnected, reconnecting...`);
          try { this._gw?.cleanup(); } catch {}
          this._gw = await connectGateway();
          console.log(`[${progress}] Gateway reconnected`);
        }

        // Cache check: if this account failed in Phase 3+ on a previous run,
        // it may have a usable Stripe link still in the DB. Reuse it to skip
        // Phase 2 (fetch) + Phase 2.5 (verify). Phase 3's NOT_FREE_TRIAL
        // detector handles stale links by throwing → status='no_link', which
        // won't be in REUSE_STATUSES on the next retry → forced full refetch.
        const REUSE_STATUSES = new Set(['error', 'aborted', 'paypal_captcha', 'verify_error']);
        let usedCachedLink = false;
        if (prevPersisted.payment_link && REUSE_STATUSES.has(prevPersisted.status)) {
          link = prevPersisted.payment_link;
          fetchResult = { link, pk: prevPersisted.payment_link_pk || '', title: 'cached', raw: '' };
          usedCachedLink = true;
          console.log(`[${progress}] Phase 2: reusing cached payment link (was ${prevPersisted.status} at ${prevPersisted.payment_link_at})`);
        }

        let linkFetchOk = usedCachedLink;
        if (!usedCachedLink) {
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
                console.log(`[${progress}] ${(fetchResult.raw || 'No link').slice(0, 500)}`);
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
        }
        if (!link) continue;

        // Persist link to DB immediately so verify_error / Phase 3 retries
        // can skip Phase 2 next time. This is intentionally BEFORE verify —
        // if verify fails, the link is still cached for the next retry to
        // try (verify_error is one of REUSE_STATUSES).
        if (link && !usedCachedLink) {
          statusDB.set(account.email, {
            status: 'running', phase: 'verify', progress,
            paymentLink: link, paymentLinkPk: fetchResult.pk || '',
          });
        }

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

        // Step 3: Payment (fresh Chrome for each account)
        // findFreePort: avoid colliding with any chrome already listening on
        // 9222 (e.g. superpowers-chrome MCP), which would otherwise silently
        // make Playwright connect to the wrong browser and run the entire
        // payment flow in the wrong incognito session.
        const port = await findFreePort();
        const tempDir = path.join(os.tmpdir(), `proto-pay-${Date.now()}-${i}`);
        let chromeProc = null, browser = null;
        try {
          this.emitStatus({ email: account.email, status: 'running', phase: 'payment', progress });
          console.log(`[${progress}] Opening payment: ${link}`);
          // v2.42: 不再显式传 proxyServer，launchChrome 默认读 process.env.HTTPS_PROXY
          chromeProc = launchChrome(port, tempDir, {});
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
            console.log(`[${progress}] Payment page unreachable via ${badNode} (${pageUrl.slice(0, 40)}); counting + rotating + retrying`);
            if (proxyMgr.getState().enabled) {
              try { proxyMgr.recordBadAttempt(badNode, 'main', 'payment_unreachable'); } catch {}
              try { const n = await proxyMgr.rotate(); console.log(`[${progress}] Retrying payment on ${n}`); } catch {}
            }
            await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            pageUrl = page.url();
            if (pageUrl.startsWith('chrome-error://') || pageUrl === 'about:blank') {
              if (proxyMgr.getState().enabled) {
                try { proxyMgr.recordBadAttempt(proxyMgr.getState().currentNode, 'main', 'payment_unreachable'); } catch {}
              }
              throw new Error(`Payment page unreachable after node rotation (${pageUrl.slice(0, 40)})`);
            }
            // 重试后真实页面打开 → 算 G3 成功
            if (proxyMgr.getState().enabled) {
              try { proxyMgr.recordGoodAttempt(proxyMgr.getState().currentNode, 'main'); } catch {}
            }
          } else {
            // G3: 一次到位也算成功
            if (proxyMgr.getState().enabled) {
              try { proxyMgr.recordGoodAttempt(proxyMgr.getState().currentNode, 'main'); } catch {}
            }
          }

          try { await page.locator('text=PayPal').first().waitFor({ state: 'visible', timeout: 15000 }); } catch {}
          await randomDelay(2000, 3000);

          console.log(`[${progress}] Auto-filling payment...`);
          let paymentResult = { success: false };
          try {
            // v2.43.3: 每账号重读 config.json (mirror PipelineEngine server/engine.js:548-550).
            //   让用户运行时改 config (e.g. 切手机号池) 不用重启 batch。
            //   path / fs / ROOT 已 import (line 6/7/23)。
            const freshCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
            const slot = freshCfg.phoneSlots?.[0] || { phone: freshCfg.phone, smsApiUrl: freshCfg.smsApiUrl };
            paymentResult = await autoPayment(page, { phone: slot.phone, smsApiUrl: slot.smsApiUrl, email: account.email }, { signal: this._abortController.signal }) || { success: false };
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
            statusDB.clearPaymentLink(account.email);
            statusDB.clearAccessToken(account.email);
            if (runtimeCfg.enableOAuth) {
              console.log(`[${progress}] Running PKCE via protocol...`);
              await this._finalizePkce(account, result, progress);
            } else {
              saveCPAAuthFile(account.email, result.accessToken, result.session);
              this.emitStatus({ email: account.email, status: 'plus_no_rt', phase: 'done', progress });
            }
            summary.success++;
          } else if (paymentResult.status === 'aborted') {
            console.log(`[${progress}] Payment aborted by user`);
            this.emitStatus({ email: account.email, status: 'aborted', phase: 'payment', progress, reason: 'Stopped by user' });
            summary.aborted = (summary.aborted || 0) + 1;
          } else if (paymentResult.notFreeTrial) {
            this.emitStatus({ email: account.email, status: 'no_link', phase: 'done', progress, reason: paymentResult.reason });
            summary.noLink++;
          } else if (paymentResult.status) {
            const reason = paymentResult.reason || 'Payment not completed';
            console.log(`[${progress}] Payment incomplete: ${reason}`);
            this.emitStatus({ email: account.email, status: paymentResult.status, phase: 'payment', progress, reason });
            summary.error++;
          } else {
            const reason = paymentResult.reason || 'Payment not completed';
            console.log(`[${progress}] Payment incomplete: ${reason}`);
            this.emitStatus({ email: account.email, status: 'error', phase: 'payment', progress, reason });
            summary.error++;
          }
        } catch (e) {
          console.log(`[${progress}] ${account.email} error: ${e.message?.slice(0, 500)}`);
          this.emitStatus({ email: account.email, status: 'error', phase: 'payment', progress, reason: e.message });
          summary.error++;
        } finally {
          if (browser) try { await browser.close(); } catch {}
          // Windows: chromeProc.kill() = SIGTERM, which Chrome's GUI/renderer
          // subprocesses ignore (see process-utils.js header). Without killTree,
          // the parent chrome.exe lingers and Chrome auto-opens an about:blank
          // tab to replace the CDP-closed page — visible as a phantom window.
          if (chromeProc) try { killTree(chromeProc.pid); } catch {}
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

module.exports = {
  ProtocolEngine,
  // v2.40.0: 暴露给测试做 mock 注入
  __runProtocolPhoneVerify: runProtocolPhoneVerify,
  __setRunProtocolPhoneVerify: (fn) => { runProtocolPhoneVerify = fn; },
};
