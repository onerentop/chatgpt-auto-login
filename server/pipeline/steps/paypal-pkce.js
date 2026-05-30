// server/pipeline/steps/paypal-pkce.js
// P1 迁移：把 ProtocolEngine 中 PKCE+add-phone 终止逻辑（_finalizePkce, _finalizePhoneVerify,
// _acquirePhoneForProtocol, runProtocolPKCE, runProtocolPhoneVerify）逐行搬运到独立 step。
//
// 行为来源：
//   protocol-engine.js 第 80–111 行   — runProtocolPKCE
//   protocol-engine.js 第 115–158 行  — runProtocolPhoneVerify（含模块级 let + seam 模式）
//   protocol-engine.js 第 194–354 行  — _acquirePhoneForProtocol（4 provider）
//   protocol-engine.js 第 356–457 行  — _finalizePhoneVerify（3 次 attempt 循环，9 种 status）
//   protocol-engine.js 第 459–501 行  — _finalizePkce（refresh_token / needsPhone / no-RT 分支）
//   protocol-engine.js 第 726–741 行  — already-Plus 路径（clearPaymentLink + clear + finalizer）
//   protocol-engine.js 第 917–927 行  — post-payment 路径（同上，由 paypal-pay outputs 路由）
//
// 设计：terminal SUCCESS finalizer，对以下两种到达路径执行相同终止逻辑：
//   (A) ctx.flags.alreadyPlus === true  → plan-check 检测到已 Plus，paypal-fetch/verify/pay 已跳过
//   (B) ctx.outputs['paypal-pay'].paymentSuccess === true → paypal-pay 支付成功
//
// 禁止：不得改任何分支、重试次数、状态字符串、错误消息或顺序。若某处看起来冗余，保持原样。

'use strict';

const path   = require('path');
const fs     = require('fs');
const { spawn } = require('child_process');

const { defineStep }    = require('../step');
// saveCPAAuthFile 在 repo 根 utils.js（server/pipeline/steps/ 上三级）
const { saveCPAAuthFile } = require('../../../utils');
const { statusDB: _statusDB, getRawDb, save } = require('../../db');
const proxyMgr = require('../../proxy');
const phonePool = require('../../phone-pool');
const zhusmsProvider = require('../../zhusms-provider');

// ROOT 相对于 server/pipeline/steps/ → 上三级到 repo 根
const ROOT = path.join(__dirname, '..', '..', '..');
const PYTHON_SCRIPT = path.join(ROOT, 'protocol_register.py');
const PYTHON_PHONE_VERIFY_SCRIPT = path.join(ROOT, 'protocol_phone_verify.py');

// ==========================================================================
// runProtocolPKCE（逐字搬自 protocol-engine.js:80-111）
// ==========================================================================
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

// ==========================================================================
// runProtocolPhoneVerify（逐字搬自 protocol-engine.js:115-158）
// v2.40.0: 协议模式 add_phone 单次 attempt（spawn protocol_phone_verify.py）
// v2.48: 加 cfg 参数透传 sms_poll_interval_ms / sms_max_attempts 给 Python 端
//
// 注意：使用模块级 let，允许测试通过 __setRunProtocolPhoneVerify 注入替代实现
// （镜像 protocol-engine.js 的 seam 模式）。
// ==========================================================================
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

// ==========================================================================
// _acquirePhoneForProtocol（逐字搬自 protocol-engine.js:194-354）
// v2.40.0: 协议模式 add_phone — 统一 local / zhusms provider 出参
// v2.40.1: 加 excludePhones 参数避免 retry 反复取同号
// ==========================================================================
async function _acquirePhoneForProtocol(provider, cfg, email, proxyUrl, excludePhones = [], attemptIdx = 0) {
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
      const smscloud = require('../../smscloud-provider');
      const smscloudPool = require('../../smscloud-pool');
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
      const oapi = require('../../oapi-provider');
      const oapiPool = require('../../oapi-pool');
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

// 测试接缝：允许通过 __setAcquirePhoneForProtocol 注入替代实现，镜像 runProtocolPhoneVerify 的 seam 模式。
// _finalizePhoneVerify 内部通过此变量调用，测试可替换它避免真实 phone-pool/db 操作。
let _acquirePhoneFn = _acquirePhoneForProtocol;

// ==========================================================================
// _finalizePhoneVerify（逐字搬自 protocol-engine.js:356-457）
// v2.40.0: 协议模式 add_phone 主流程（retry 3 次，按 result.status 分流）
//
// 注意：engine 参数（原始 this）替换为 ctx：内部调用 runProtocolPhoneVerify 时
// 传 engineShim（{_pyProc → ctx.deps.resources.pyProc}），镜像 login.js 的 shim 模式。
// ==========================================================================
async function _finalizePhoneVerify(sessionState, account, ctx) {
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

  // engineShim：把 _pyProc 写入 ctx.deps.resources 供 stop() 清理
  const engineShim = {
    get _pyProc() { return ctx.deps.resources.pyProc; },
    set _pyProc(p) { ctx.deps.resources.pyProc = p; },
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const acq = await _acquirePhoneFn(provider, cfg, account.email, proxyUrl, triedPhones, attempt - 1);
    const { phone, smsConfig, releaseFn, meta } = acq;
    if (!phone) {
      return lastReason ? { phoneVerifyFail: lastReason } : { phonePoolEmpty: true };
    }
    triedPhones.push(phone);
    // v2.39.4 hotfix 等价：拿号后立即落盘
    try { save(); } catch {}

    console.log(`[protocol] add-phone (attempt ${attempt}/${MAX_ATTEMPTS}): ${phone} (provider=${provider})`);
    const result = await runProtocolPhoneVerify(sessionState, phone, smsConfig, proxyUrl, engineShim, cfg);

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
          const smscloudPool = require('../../smscloud-pool');
          const deferredCancel = require('../../smscloud-deferred-cancel');
          smscloudPool.markRejected(getRawDb(), meta.orderNo);
          deferredCancel.enqueue({ apiKey: meta.apiKey, baseUrl: meta.baseUrl, orderNo: meta.orderNo, takenAtMs: meta.takenAtMs });
          save();
        } catch (e) { console.log(`[protocol] smscloud markRejected err: ${e?.message}`); }
      } else if (meta?.provider === 'oapi') {
        // v2.50.0: oapi markRejected（不调 deferred-cancel — oapi 无 cancel API）
        try {
          const oapiPool = require('../../oapi-pool');
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

// ==========================================================================
// _finalizePkce（逐字搬自 protocol-engine.js:459-501）
// Run PKCE and emit final status. Used by both already-Plus and post-payment branches.
//
// 注意：
//   - this.emitStatus(...)  → ctx.deps.emitStatus(...)
//   - runProtocolPKCE(account, this) → runProtocolPKCE(account, engineShim)
//   - this._finalizePhoneVerify(...)  → _finalizePhoneVerify(..., ctx)
// ==========================================================================
async function _finalizePkce(ctx, account, loginResult, progress) {
  const { emitStatus } = ctx.deps;

  // engineShim：把 _pyProc 写入 ctx.deps.resources 供 stop() 清理
  const engineShim = {
    get _pyProc() { return ctx.deps.resources.pyProc; },
    set _pyProc(p) { ctx.deps.resources.pyProc = p; },
  };

  // 测试接缝：允许注入替代实现，跳过 Python spawn（镜像 __setRunProtocolPhoneVerify 的模式）
  const _runPKCEFn = ctx.deps.__runProtocolPKCE || runProtocolPKCE;

  emitStatus({ email: account.email, status: 'running', phase: 'pkce', progress });
  try {
    const pkceResult = await _runPKCEFn(account, engineShim);
    const pkce = pkceResult.pkce || {};
    if (pkce.refresh_token) {
      console.log(`[${progress}] PKCE success, saving with refresh_token`);
      saveCPAAuthFile(account.email, pkce.access_token || loginResult.accessToken, { ...loginResult.session, refresh_token: pkce.refresh_token, id_token: pkce.id_token || '' });
      emitStatus({ email: account.email, status: 'plus', phase: 'done', progress });
    } else if (pkce.needsPhone) {
      // v2.40.0: 协议模式 add_phone 自动化
      console.log(`[${progress}] PKCE requires phone verification, running protocol add-phone flow...`);
      const r = await _finalizePhoneVerify(pkce.session_state || {}, account, ctx);
      if (r.tokens) {
        console.log(`[${progress}] add-phone success, saving with refresh_token`);
        saveCPAAuthFile(account.email, r.tokens.access_token || loginResult.accessToken, {
          ...loginResult.session,
          refresh_token: r.tokens.refresh_token,
          id_token: r.tokens.id_token || '',
        });
        emitStatus({ email: account.email, status: 'plus', phase: 'done', progress });
      } else {
        // failure 映射：phonePoolEmpty → phone_pool_empty；phoneVerifyFail/pool-disabled → 既有 status
        let failStatus;
        if (r.phonePoolEmpty) failStatus = 'phone_pool_empty';
        else if (r.phoneVerifyFail === 'pool-disabled') failStatus = 'plus_no_rt';
        else failStatus = 'phone_verify_fail';
        console.log(`[${progress}] add-phone failed: ${r.phoneVerifyFail || 'pool-empty'}, status=${failStatus}`);
        saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
        emitStatus({ email: account.email, status: failStatus, phase: 'done', progress });
      }
    } else {
      console.log(`[${progress}] PKCE no RT: ${pkce.error || 'unknown'}`);
      saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
      emitStatus({ email: account.email, status: 'plus_no_rt', phase: 'done', progress });
    }
  } catch (e) {
    console.log(`[${progress}] PKCE error: ${e.message?.slice(0, 60)}`);
    saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
    emitStatus({ email: account.email, status: 'plus_no_rt', phase: 'done', progress });
  }
}

// ==========================================================================
// paypalPkceStep 工厂函数
// ==========================================================================

/**
 * paypalPkceStep() 返回 defineStep({ id:'paypal-pkce', label:'PKCE / add-phone / 写凭证', shouldSkip, run })。
 *
 * ctx.deps 约定（由 engine-shell 在运行时注入）：
 *   emitStatus(data)   — 原始 engine.emitStatus（含 proxyNode/exitIp 注入）
 *   summary            — 共享可变计数器；本 step 只做 summary.success++
 *   progress           — 当前进度字符串，如 "3/10"
 *   runtimeCfg         — 本轮解析的 config.json（enableOAuth 读取点）
 *   resources          — 可变袋；本 step 把 pyProc 写入供 stop() 清理
 *
 * ctx.outputs.login 约定（由 login step 写入）：
 *   { accessToken, session, planType }
 *
 * ctx.flags 读取：
 *   alreadyPlus: true  — plan-check 设旗，表示账号已 Plus（跳过了 fetch/verify/pay）
 *
 * ctx.outputs['paypal-pay'] 读取（paypal-pay 写入）：
 *   { paymentSuccess: true }  — 支付成功信号（仅 alreadyPlus=false 且到达本 step 时）
 *
 * 测试接缝（仅供单元测试注入，生产不传）：
 *   ctx.deps.__runProtocolPKCE         — 替换 runProtocolPKCE，避免测试 spawn Python
 *   ctx.deps.__setRunProtocolPhoneVerify（见 module.exports）— 替换 runProtocolPhoneVerify
 */
function paypalPkceStep() {
  return defineStep({
    id: 'paypal-pkce',
    label: 'PKCE / add-phone / 写凭证',

    // shouldSkip: 永远返回 false（本 step 只有在 pipeline 到达它时才运行，
    // 即 already-Plus 或 post-payment-success；pipeline 在失败时不会到达本 step）。
    shouldSkip: () => false,

    async run(ctx) {
      const { account } = ctx;
      const { emitStatus, summary, progress, runtimeCfg } = ctx.deps;
      const loginResult = ctx.outputs.login;

      // ====================================================================
      // 原始两条路径（already-Plus line 729-730 & post-payment line 918-919）均有：
      //   statusDB.clearPaymentLink(email); statusDB.clearAccessToken(email);
      // ====================================================================
      _statusDB.clearPaymentLink(account.email);
      _statusDB.clearAccessToken(account.email);

      // ====================================================================
      // 原始两条路径（already-Plus line 732-739 & post-payment line 920-927）：
      //   if (runtimeCfg.enableOAuth) { _finalizePkce(...) } else { saveCPAAuthFile + emitStatus plus_no_rt/done }
      // ====================================================================
      if (runtimeCfg.enableOAuth) {
        // protocol-engine.js:733 / :921 — 原文逐字日志（经 LogCapture 进 logsDB/UI）
        console.log(`[${progress}] Running PKCE via protocol...`);
        await _finalizePkce(ctx, account, loginResult, progress);
      } else {
        saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
        emitStatus({ email: account.email, status: 'plus_no_rt', phase: 'done', progress });
      }

      // ====================================================================
      // 原始两条路径（already-Plus line 739 & post-payment line 927）均有：
      //   summary.success++;
      // ====================================================================
      summary.success++;

      return { ok: true };
    },
  });
}

module.exports = {
  paypalPkceStep,
  // 测试接缝（镜像 protocol-engine.js 的 __setRunProtocolPhoneVerify / __runProtocolPhoneVerify）
  __runProtocolPhoneVerify: runProtocolPhoneVerify,
  __setRunProtocolPhoneVerify: (fn) => { runProtocolPhoneVerify = fn; },
  // PKCE seam（供测试注入；phone-verify seam 与 protocol-engine.js 同模式）
  __setRunProtocolPKCE: null, // 通过 ctx.deps.__runProtocolPKCE 注入，见 _finalizePkce 内注释
  // 迁移测试接缝：暴露给从 protocol-engine.js 迁过来的测试文件使用
  _acquirePhoneForProtocol,
  _finalizePhoneVerify,
  // _acquirePhoneForProtocol 接缝（供迁移测试注入替代实现，避免真实 phone-pool/db 操作）
  __setAcquirePhoneForProtocol: (fn) => { _acquirePhoneFn = fn != null ? fn : _acquirePhoneForProtocol; },
};
