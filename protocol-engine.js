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
// v2.51: enroll-passkey 自动 retry wrapper —— Python 返 passkey_retry 时 spawn 第 2 次
async function runProtocolRegister(account, engine) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await _runProtocolRegisterOnce(account, engine);
    if (result.status === 'passkey_retry') {
      if (attempt === 0) {
        console.log(`[1/1] enroll-passkey detected (page=${result.page}), retrying once in 2s (OpenAI 首次 create_account 概率触发)`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw new Error('enroll-passkey retry exhausted (2 attempts)');
    }
    return result;
  }
}

function _runProtocolRegisterOnce(account, engine) {
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
        else if (result.status === 'passkey_retry') resolve(result);  // v2.51: surface for outer retry
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
// v2.48: 加 cfg 参数透传 sms_poll_interval_ms / sms_max_attempts 给 Python 端
let runProtocolPhoneVerify = function (sessionState, phone, smsConfig, proxyUrl, engine, cfg = {}) {
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
      sms_poll_interval_ms: cfg.phonePool?.smsPollIntervalMs,
      sms_max_attempts: cfg.phonePool?.smsMaxAttempts,
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
  async _acquirePhoneForProtocol(provider, cfg, email, proxyUrl, excludePhones = [], attemptIdx = 0) {
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
      // v2.47.0: countryCode 支持 number | number[]（fraud retry 跨 country fallback）
      const codes = Array.isArray(s.countryCode)
        ? s.countryCode
        : (s.countryCode != null ? [s.countryCode] : []);
      if (!s.apiKey || !s.serviceCode || codes.length === 0) {
        console.log(`[protocol] smscloud config incomplete (apiKey/serviceCode/countryCode 任一为空)`);
        return {};
      }
      try {
        const smscloud = require('./server/smscloud-provider');
        const smscloudPool = require('./server/smscloud-pool');
        const max = cfg.phonePool.maxBindingsPerPhone || 3;
        const EXPIRY_MS = 18 * 60 * 1000;
        const baseUrl = s.baseUrl || 'https://smscloud.sbs/api/system';
        const countryCode = codes[attemptIdx % codes.length];
        console.log(`[protocol] smscloud attempt ${attemptIdx + 1} country=${countryCode} (list=[${codes.join(',')}])`);
        const takeOrderFn = async () => {
          const order = await smscloud.takeOrder(s.apiKey, baseUrl, s.serviceCode, countryCode);
          if (!order || !order.phone) throw new Error('takeOrder empty');
          return { orderNo: order.order_no, phone: order.phone, apiKey: s.apiKey, baseUrl, countryCode };
        };
        // v2.45.1: 复用号 cache hit 要 resend 通知 smscloud advance 上游 channel；
        // 失败则 markRejected + releaseBinding，循环重 acquire（拿新号或下一个 active cache 行）。
        // 内层循环而非返 {} 外层 retry：_finalizePhoneVerify:308-310 在 !phone && !lastReason 时
        // 短路成 phonePoolEmpty，attempt 1 acquire 失败不会进 attempt 2/3；改外层会影响 zhusms/local。
        const MAX_ACQUIRE_TRIES = 3;
        let acq = null;
        for (let i = 0; i < MAX_ACQUIRE_TRIES; i++) {
          acq = await smscloudPool.acquirePhone(getRawDb(), email, max, EXPIRY_MS, excludePhones, takeOrderFn, countryCode);
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
    if (provider === 'oapi') {
      const o = cfg.phonePool.oapi || {};
      const baseUrl = o.baseUrl || 'https://sms.oapi.vip/api.php';
      const apiKey = o.apiKey;
      if (!apiKey) {
        console.log(`[protocol] oapi config incomplete (apiKey 为空)`);
        return {};
      }
      try {
        const oapi = require('./server/oapi-provider');
        const oapiPool = require('./server/oapi-pool');
        const max = cfg.phonePool.maxBindingsPerPhone || 3;
        const takeOrderFn = async (cdk, baseUrlArg) => {
          return await oapi.takeOrder(cdk, baseUrlArg, apiKey);
        };
        const acq = await oapiPool.acquireCdk(getRawDb(), email, max, baseUrl, takeOrderFn);
        if (!acq) {
          // v2.54: diagnose 区分 fail 原因（pool 空 / 全 rejected / 全 bindings 满）
          const reason = oapiPool.diagnose(getRawDb());
          console.log(`[protocol] oapi acquire failed: ${reason}`);
          return {};
        }
        try { save(); } catch {}
        const cdkTail = acq.cdk.slice(-8);
        console.log(`[protocol] oapi ${acq.reused ? '复用' : '新取'}号 ${acq.phone} (cdk=...${cdkTail}, remaining=${acq.remaining})`);
        return {
          phone: acq.phone,
          smsConfig: { provider: 'oapi', cdk: acq.cdk, base_url: acq.baseUrl, api_key: apiKey },
          releaseFn: async () => {
            try {
              oapiPool.releaseBinding(getRawDb(), acq.cdk, email, acq.phone);
              save();
            } catch (e) {
              console.log(`[protocol] oapi releaseBinding failed: ${e?.message?.slice(0, 60)}`);
            }
          },
          meta: { provider: 'oapi', cdk: acq.cdk, baseUrl: acq.baseUrl },
        };
      } catch (e) {
        console.log(`[protocol] oapi acquire failed: ${e?.message?.slice(0, 80)}`);
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
      const acq = await this._acquirePhoneForProtocol(provider, cfg, account.email, proxyUrl, triedPhones, attempt - 1);
      const { phone, smsConfig, releaseFn, meta } = acq;
      if (!phone) {
        return lastReason ? { phoneVerifyFail: lastReason } : { phonePoolEmpty: true };
      }
      triedPhones.push(phone);
      // v2.39.4 hotfix 等价：拿号后立即落盘
      try { save(); } catch {}

      console.log(`[protocol] add-phone (attempt ${attempt}/${MAX_ATTEMPTS}): ${phone} (provider=${provider})`);
      const result = await runProtocolPhoneVerify(sessionState, phone, smsConfig, proxyUrl, this, cfg);

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
        } else if (meta?.provider === 'oapi') {
          // v2.50.0: oapi markRejected（不调 deferred-cancel — oapi 无 cancel API）
          try {
            const oapiPool = require('./server/oapi-pool');
            oapiPool.markRejected(getRawDb(), meta.cdk);
            save();
          } catch (e) { console.log(`[protocol] oapi markRejected err: ${e?.message}`); }
        } else {
          if (releaseFn) try { await releaseFn(); } catch {}
          try { save(); } catch {}
        }
        lastReason = result.status;
        continue;
      }
      if (result.status === 'sms-timeout') {
        // v2.49: sms-timeout 走换号 retry —— OpenAI 已发 SMS 但 smscloud 上游 channel
        // 未收到（号被 carrier 屏蔽 / smscloud 平台延迟），换号有概率成功（attempt 外层 + countryCode list）。
        console.log(`[protocol] add-phone sms-timeout for ${phone}, retry with new phone`);
        if (releaseFn) try { await releaseFn(); } catch {}
        try { save(); } catch {}
        lastReason = 'sms-timeout';
        continue;
      }
      if (result.status === 'validate-error' || result.status === 'submit-error') {
        // OpenAI 那边号没真用（spawn 失败 / OpenAI 拒验证码）→ release，不 retry
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

module.exports = {
  ProtocolEngine,
  // v2.40.0: 暴露给测试做 mock 注入
  __runProtocolPhoneVerify: runProtocolPhoneVerify,
  __setRunProtocolPhoneVerify: (fn) => { runProtocolPhoneVerify = fn; },
};
