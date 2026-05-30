// server/pipeline/steps/login.js
// P1 迁移：把 ProtocolEngine.start() 中的 Phase 1（登录）行为逐行搬运到独立 step。
//
// 行为来源（protocol）：protocol-engine.js 第 615–724 行（缓存快路径 + 协议登录 + DB 持久化）。
// 以及 protocol-engine.js 第 29–78 行（runProtocolRegister / _runProtocolRegisterOnce）。
//
// 行为来源（browser）：server/engine.js 第 221–333 行（缓存快路径 + Playwright 登录 + DB 持久化）。
// 浏览器策略差异详见 docs/superpowers/plans/inventory/browser-engine.md Section B1（D-L1..D-L7）。
//
// 禁止：不得改任何分支、重试次数、状态字符串、错误消息或顺序。
// 若某处看起来冗余，保持原样。

'use strict';

const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { defineStep } = require('../step');

const ROOT = path.join(__dirname, '..', '..', '..');
const PYTHON_SCRIPT = path.join(ROOT, 'protocol_register.py');

// --------------------------------------------------------------------------
// Python subprocess helpers（逐字搬自 protocol-engine.js:29-78）
// --------------------------------------------------------------------------

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

// --------------------------------------------------------------------------
// loginStep 工厂函数
// --------------------------------------------------------------------------

/**
 * loginStep(cfg) 返回 defineStep({ id:'login', ... })。
 *
 * cfg:
 *   { login: 'protocol' }   —— 目前只支持 'protocol'；'browser' 是 P2 的扩展点。
 *
 * ctx.deps 约定（由 engine-shell 在运行时注入）：
 *   emitStatus(data)                — 原始 engine.emitStatus，含 proxyNode/exitIp 注入
 *   summary                        — 共享可变计数器 { total, success, error, noLink, … }
 *   proxyMgr                       — require('./server/proxy') 的同一实例
 *   resources                      — engine-shell 拥有的可变袋，步骤把 pyProc 写进来供 stop() 清理
 *   runtimeCfg                     — 本轮解析的 config.json
 *   progress                       — 当前进度字符串，如 "3/10"
 *   statusDB                       — DB handle（用于 post-login 持久化）
 *   save                           — save()
 *
 * 测试接缝（test seam，仅供单元测试注入，生产不传）：
 *   ctx.deps.__runProtocolRegister — 替换真正的 runProtocolRegister，避免测试 spawn Python
 */
// --------------------------------------------------------------------------
// Browser login strategy（P2）
// 行为来源：server/engine.js line 221-333（逐字搬运，零逻辑丢失）
// D-L1: loginAccount(browser, account) 替换 runProtocolRegister（Python spawn）
// D-L2: launchChrome + waitForCDP 在 Phase 1 启动；句柄写入 ctx.deps.resources
// D-L3: emitStatus phase='login'（非 'protocol-login'）
// D-L4: statusDB.set phase='login'（非 'protocol-login'）
// D-L5: proxy 记账 tag='login_net_error'（非 'protocol_net_error'）
// D-L6: 在 ctx.outputs.login 注入 planType（与协议策略对称，供 plan-check step 使用）
// D-L7: ctx.outputs.login 携带 lastOtp（来自 loginAccount 返回；缓存路径设为 ''）
// --------------------------------------------------------------------------
function _buildBrowserLoginStep() {
  return defineStep({
    id: 'login',
    label: '登录 + 获取 access token（browser 策略）',

    // shouldSkip 永远返回 false：缓存快路径在 run() 内部处理。
    shouldSkip: () => false,

    async run(ctx) {
      const { account } = ctx;
      const {
        emitStatus,
        summary,
        proxyMgr,
        resources,
        progress,
        statusDB,
      } = ctx.deps;

      // 测试接缝：注入假实现，跳过真实 Chrome/Playwright 调用
      // ctx.deps.__loginAccount      → 替换 loginAccount（避免测试启动真实 Chrome）
      // ctx.deps.__launchChrome      → 替换 launchChrome
      // ctx.deps.__waitForCDP        → 替换 waitForCDP
      // ctx.deps.__findFreePort      → 替换 findFreePort
      const _loginAccountFn  = ctx.deps.__loginAccount  || require('../../../login').loginAccount;
      const _launchChromeFn  = ctx.deps.__launchChrome  || require('../../chrome').launchChrome;
      const _waitForCDPFn    = ctx.deps.__waitForCDP    || require('../../chrome').waitForCDP;
      const _findFreePortFn  = ctx.deps.__findFreePort  || require('../../chrome').findFreePort;

      // ====================================================================
      // engine.js:221-241
      // Cached-login fast path: if a previous login persisted a JWT and the
      // exp is still in the future (with 60s buffer), reconstitute loginResult
      // from the DB and skip browser login + Chrome launch entirely.
      // ====================================================================
      const JWT_BUFFER_SEC = 60;
      let loginResult = null;

      if (ctx.prevPersisted.last_access_token) {
        const { decodeJwtExp } = require('../../liveness/checker');
        const exp = decodeJwtExp(ctx.prevPersisted.last_access_token);
        if (exp > Date.now() / 1000 + JWT_BUFFER_SEC) {
          let session = null;
          try { session = JSON.parse(ctx.prevPersisted.last_session_json || '{}'); }
          catch { session = null; }
          if (session) {
            // D-L7: lastOtp='' on cache hit（engine.js:234）
            loginResult = {
              accessToken: ctx.prevPersisted.last_access_token,
              session,
              lastOtp: '',
            };
            const minLeft = Math.floor((exp - Date.now() / 1000) / 60);
            console.log(`[${progress}] Phase 1: reusing cached access token (exp in ${minLeft} min)`);
            // D-L3: phase='cached-login'（与协议引擎一致）
            emitStatus({ email: account.email, status: 'running', phase: 'cached-login', progress });
          }
        }
      }

      // ====================================================================
      // engine.js:267-316
      // Fresh login: launch Chrome, connect CDP, call loginAccount.
      // Skipped when loginResult was reconstituted from cache above.
      // ====================================================================
      if (!loginResult) {
        // D-L3: phase='login'（非 'protocol-login'）（engine.js:272-277）
        emitStatus({ email: account.email, status: 'running', phase: 'login', progress });
        console.log(`[${progress}] Phase 1: Login...`);

        // D-L2: findFreePort + tempDir + launchChrome + waitForCDP（engine.js:249-282）
        // 句柄写入 ctx.deps.resources，供 paypal-pay step 复用和 engine-shell cleanup 使用。
        const port = await _findFreePortFn();
        const tempDir = path.join(os.tmpdir(), `chatgpt-login-${Date.now()}`);

        // store handles in resources BEFORE launch so engine-shell stop() can always clean up
        resources.chromeProc = _launchChromeFn(port, tempDir, {});
        resources.tempDir = tempDir;
        resources.browser = await _waitForCDPFn(port);

        // D-L1: loginAccount(browser, account) —— engine.js:283
        const browser = resources.browser;
        loginResult = await _loginAccountFn(browser, account);

        // engine.js:285-316: failure / success branches
        if (loginResult.status !== 'success' || !loginResult.accessToken) {
          const isDeactivated = loginResult.status === 'deactivated';
          const statusOut = isDeactivated ? 'deactivated' : 'error';
          console.log(`[${progress}] Login ${isDeactivated ? 'account_deactivated' : 'failed'}: ${loginResult.reason || loginResult.status}`);

          // T9 proxy accounting（engine.js:290-298）
          // D-L5: tag 字符串 'login_net_error'（协议引擎用 'protocol_net_error'）
          if (!isDeactivated && proxyMgr.isProxyNetError(loginResult.reason)) {
            if (proxyMgr.getState().enabled) {
              try { proxyMgr.recordBadAttempt(proxyMgr.getState().currentNode, 'main', 'login_net_error'); } catch {}
            }
          } else if (isDeactivated) {
            // deactivated = 账号问题，节点工作正常（engine.js:294-298）
            if (proxyMgr.getState().enabled) {
              try { proxyMgr.recordGoodAttempt(proxyMgr.getState().currentNode, 'main'); } catch {}
            }
          }

          // engine.js:304-311
          const reason = isDeactivated ? 'account_deactivated' : `Login: ${loginResult.reason || loginResult.status}`;
          emitStatus({
            email: account.email,
            status: statusOut,
            // D-L3: phase='login'（非 'protocol-login'）；deactivated 用 'done'
            phase: isDeactivated ? 'done' : 'login',
            progress,
            reason,
          });
          summary.error++;
          return { ok: false, reason };
        }

        // G2: 登录成功，记录节点工作正常（engine.js:313-316）
        if (proxyMgr.getState().enabled) {
          try { proxyMgr.recordGoodAttempt(proxyMgr.getState().currentNode, 'main'); } catch {}
        }
        console.log(`[${progress}] Login OK, accessToken obtained.`);
      }

      // ====================================================================
      // engine.js:325-333（D-L4）
      // Post-login DB persistence: write token so the next retry can skip
      // the browser login entirely. phase='login'（非 'protocol-login'）。
      // ====================================================================
      if (loginResult && loginResult.accessToken) {
        statusDB.set(account.email, {
          status: 'running',
          // D-L4: phase='login'（协议引擎为 'protocol-login'）
          phase: 'login',
          progress,
          accessToken: loginResult.accessToken,
          sessionJson: JSON.stringify(loginResult.session || {}),
        });
      }

      // ====================================================================
      // 成功：将产物写入 ctx.outputs.login
      // D-L6: 注入 planType（与协议策略对称，plan-check step 读取）
      // D-L7: 携带 lastOtp（PKCE 阶段 fetchTokensViaPKCE 需要）
      // ====================================================================
      const session = loginResult.session;
      const planType = session?.account?.planType || session?.chatgpt_plan_type || 'free';
      ctx.outputs.login = {
        accessToken: loginResult.accessToken,
        session,
        planType,
        lastOtp: loginResult.lastOtp || '',  // D-L7
      };

      return { ok: true };
    },
  });
}

// --------------------------------------------------------------------------

function loginStep(cfg = {}) {
  const strategy = cfg.login || 'protocol';

  // P2 浏览器策略
  if (strategy === 'browser') {
    return _buildBrowserLoginStep();
  }

  if (strategy !== 'protocol') {
    throw new Error(`loginStep: strategy '${strategy}' not implemented yet`);
  }

  return defineStep({
    id: 'login',
    label: '登录 + 获取 access token',

    // shouldSkip 永远返回 false：缓存快路径在 run() 内部处理（原始行为）。
    shouldSkip: () => false,

    async run(ctx) {
      const { account, email } = ctx;
      const {
        emitStatus,
        summary,
        proxyMgr,
        resources,
        progress,
        statusDB,
      } = ctx.deps;

      // 测试接缝：允许注入替代实现，跳过 Python spawn
      const _runProtocolRegisterFn = ctx.deps.__runProtocolRegister || runProtocolRegister;

      // ====================================================================
      // protocol-engine.js:615-617
      // Use the top-of-loop snapshot captured in AccountContext constructor,
      // BEFORE any step writes to the DB. ctx.prevPersisted is equivalent to
      // the original `const prevPersisted = statusDB.get(account.email) || {}`
      // taken before login persists status='running'.
      // ====================================================================

      // ====================================================================
      // protocol-engine.js:624-643
      // Cached-login fast path: if a previous login persisted a JWT and the
      // exp is still in the future (with 60s buffer), reconstitute `result`
      // from the DB and skip Phase 1 entirely.
      // ====================================================================
      const JWT_BUFFER_SEC = 60;
      let result = null;
      if (ctx.prevPersisted.last_access_token) {
        const { decodeJwtExp } = require('../../liveness/checker');
        const exp = decodeJwtExp(ctx.prevPersisted.last_access_token);
        if (exp > Date.now() / 1000 + JWT_BUFFER_SEC) {
          let session = null;
          try { session = JSON.parse(ctx.prevPersisted.last_session_json || '{}'); }
          catch { session = null; }
          if (session) {
            result = {
              accessToken: ctx.prevPersisted.last_access_token,
              session,
              planType: session?.account?.planType || session?.chatgpt_plan_type || 'free',
            };
            const minLeft = Math.floor((exp - Date.now() / 1000) / 60);
            console.log(`[${progress}] Phase 1: reusing cached access token (exp in ${minLeft} min)`);
            emitStatus({ email: account.email, status: 'running', phase: 'cached-login', progress });
          }
        }
      }

      // ====================================================================
      // protocol-engine.js:659-707
      // Step 1: Protocol login (skipped when result was reconstituted above)
      // ====================================================================
      if (!result) {
        // protocol-engine.js:660
        emitStatus({ email: account.email, status: 'running', phase: 'protocol-login', progress });

        // engine-shell shim：_pyProc 写入 ctx.deps.resources 供 stop() 清理
        const engineShim = {
          get _pyProc() { return resources.pyProc; },
          set _pyProc(p) { resources.pyProc = p; },
        };

        try {
          // protocol-engine.js:663
          result = await _runProtocolRegisterFn(account, engineShim);

          // protocol-engine.js:664-685 — TLS retry-once
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
            result = await _runProtocolRegisterFn(account, engineShim);
            if (result.status === 'tls_failure') {
              console.log(`[${progress}] TLS still failing after rotation — giving up on this account`);
              if (proxyMgr.getState().enabled) {
                try { proxyMgr.recordBadAttempt(proxyMgr.getState().currentNode, 'main', 'tls_failure'); } catch {}
              }
              // protocol-engine.js:682-684
              emitStatus({ email: account.email, status: 'error', phase: 'protocol-login', progress, reason: result.error });
              summary.error++;
              return { ok: false, reason: 'tls_failure_after_rotation' };
            }
          }

          // protocol-engine.js:688-690 — G1: 任何"业务返回"（success / deactivated 等）都代表节点工作正常
          if (proxyMgr.getState().enabled) {
            try { proxyMgr.recordGoodAttempt(proxyMgr.getState().currentNode, 'main'); } catch {}
          }

          // protocol-engine.js:691-695
          if (result.status === 'deactivated') {
            console.log(`[${progress}] Account deactivated/deleted by OpenAI`);
            emitStatus({ email: account.email, status: 'deactivated', phase: 'done', progress, reason: 'account_deactivated' });
            summary.error++;
            return { ok: false, reason: 'deactivated' };
          }

          // protocol-engine.js:697
          console.log(`[${progress}] Protocol login OK: ${result.accessToken}`);
        } catch (e) {
          // protocol-engine.js:698-706
          console.log(`[${progress}] Protocol login failed: ${e.message?.slice(0, 500)}`);
          // T8: 网络类异常算节点失败；业务异常不算
          if (proxyMgr.isProxyNetError(e.message) && proxyMgr.getState().enabled) {
            try { proxyMgr.recordBadAttempt(proxyMgr.getState().currentNode, 'main', 'protocol_net_error'); } catch {}
          }
          emitStatus({ email: account.email, status: 'error', phase: 'protocol-login', progress, reason: e.message });
          summary.error++;
          return { ok: false, reason: e.message };
        }
      }

      // ====================================================================
      // protocol-engine.js:713-724
      // After Phase 1 (cached or fresh), persist the token to DB so the
      // next retry can skip Phase 1 entirely.
      // ====================================================================
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

      // ====================================================================
      // 成功：将产物写入 ctx.outputs.login
      // ====================================================================
      ctx.outputs.login = {
        accessToken: result.accessToken,
        session: result.session,
        planType: result.planType,
      };

      return { ok: true };
    },
  });
}

module.exports = { loginStep };
