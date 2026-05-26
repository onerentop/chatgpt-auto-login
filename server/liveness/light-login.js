// server/liveness/light-login.js
// 轻登录：密码 + OTP → /api/auth/session 拿 access_token.
// 不走 PKCE / codex 客户端 deeplink；只产 web session 用的 access_token.
//
// 双模式实现：
//   - 浏览器模式 (default)：Playwright 操作 auth.openai.com 表单
//   - 协议模式 (config.protocolMode=true, v2.29 Phase B)：spawn
//     chatgpt_register/liveness_login.py 用 curl_cffi 走 Auth0 HTTP API
//
// 共同返回 shape { accessToken, accountId, expiresAtIso }，runner.js 不
// 关心走的哪条路径。错误字符串契约对齐 runner.js:99-117 的 9 种 keyword。

const path = require('path');
const { redact } = require('../logger');

const PROTOCOL_SCRIPT = path.join(__dirname, '..', '..', 'chatgpt_register', 'liveness_login.py');
// IMAP OTP 轮询最多 90s + sentinel + 4 次 POST 开销 ≈ 110s；120s 留余量。
const PROTOCOL_TIMEOUT_MS = 120_000;

// 保留导出 — runner.js 用 e.name 检测；新协议路径不再主动抛此错，但
// pyotp 缺失 / py 二进制找不到等场景仍走这条兜底（runner 把它统一映射到
// alive_status='login_fail', reason='liveness not yet supported in protocol mode'）。
class LivenessLoginNotImplementedError extends Error {
  constructor(msg) {
    super(msg || 'liveness login not implemented in protocol mode');
    this.name = 'LivenessLoginNotImplementedError';
  }
}

function toCstIso(input) {
  const d = input ? new Date(input) : new Date();
  if (isNaN(d.getTime())) return '';
  const cst = new Date(d.getTime() + 8 * 3600_000);
  return cst.toISOString().replace('Z', '+08:00');
}

async function lightLogin(account, opts = {}) {
  const { protocolMode, playwrightConnect, getOtp, signal } = opts;

  if (protocolMode) {
    return await protocolLightLogin(account, { signal });
  }

  if (!account?.password) throw new Error('no password');
  if (account.login_type === 'outlook' && (!account.client_id || !account.refresh_token)) {
    throw new Error('outlook oauth missing');
  }

  const browser = await playwrightConnect();
  let ctx;
  try {
    ctx = await browser.newContext();
    const page = await ctx.newPage();

    // 1. Navigate to login page
    try {
      await page.goto('https://auth.openai.com/authorize?client_id=pdlLIX2Y72MIl2rhLhTE9VV9bN9MD869&scope=openid%20email%20profile%20offline_access%20model.request%20model.read%20organization.read%20organization.write&response_type=code&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fapi%2Fauth%2Fcallback%2Flogin-web', { timeout: 30_000 });
    } catch (e) {
      if (/ERR_CONNECTION_RESET|net::ERR_CONNECTION|ECONNRESET/i.test(e.message)) {
        throw new Error('proxy reset (login)');
      }
      throw new Error(`navigation: ${String(e.message).slice(0, 40)}`);
    }

    // 2. Fill username and submit
    await page.fill('input[name="username"]', account.email);
    await page.click('button[type="submit"]');

    // 3. Fill password and submit
    await page.fill('input[name="password"]', account.password);
    await page.click('button[type="submit"]');

    // 4. Check for bad password
    if (/error=invalid/.test(page.url())) {
      throw new Error('bad password');
    }

    // 5. Get OTP code
    let code;
    try {
      code = await getOtp(account, { signal });
    } catch (e) {
      if (/timeout/i.test(e.message)) throw new Error('otp timeout');
      throw new Error(`otp fail: ${String(e.message).slice(0, 40)}`);
    }

    // 6. Wait for OTP input field
    try {
      await page.waitForSelector('input[name="code"]', { timeout: 30_000 });
    } catch {
      throw new Error('otp timeout');
    }

    // 7. Fill OTP and submit
    await page.fill('input[name="code"]', code);
    await page.click('button[type="submit"]');

    // 8. Wait for redirect to chatgpt.com (captcha/bot check may block this)
    try {
      await page.waitForURL(/chatgpt\.com\//, { timeout: 30_000 });
    } catch (e) {
      throw new Error('captcha');
    }

    // 9. Fetch session token
    const sessionRes = await page.request.get('https://chatgpt.com/api/auth/session');
    const session = await sessionRes.json();
    if (!session || !session.accessToken) throw new Error('no session after login');

    return {
      accessToken: session.accessToken,
      accountId: session.user?.id || '',
      expiresAtIso: toCstIso(session.expires),
    };
  } finally {
    try { await ctx?.close(); } catch {}
    try { await browser?.close(); } catch {}
  }
}

async function protocolLightLogin(account, { signal } = {}) {
  // Pre-flight contract checks — match the browser path's early validation
  // so callers see the same error keywords regardless of mode.
  if (!account?.password) throw new Error('no password');
  if (account.login_type === 'outlook' && (!account.client_id || !account.refresh_token)) {
    throw new Error('outlook oauth missing');
  }

  // v2.42: 不再传 proxy，Python 走 HTTPS_PROXY env
  const input = JSON.stringify({
    email: account.email,
    password: account.password,
    login_type: account.login_type || '',
    client_id: account.client_id || '',
    refresh_token: account.refresh_token || '',
    totp_secret: account.totp_secret || '',
  });

  return new Promise((resolve, reject) => {
    // 使用延迟 require，让测试通过 Module.prototype.require 拦截 spawn。
    // 不要在模块顶层解构 spawn，否则 mock 注入时引用已固化。
    let py;
    try {
      py = require('child_process').spawn('py', ['-3', PROTOCOL_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(new LivenessLoginNotImplementedError(`spawn failed: ${e.message?.slice(0, 80)}`));
    }

    let settled = false;
    let stdout = '';
    let stderr = '';
    let timeoutHandle = null;
    let abortHandler = null;

    const cleanup = () => {
      if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
      if (abortHandler && signal) { signal.removeEventListener('abort', abortHandler); abortHandler = null; }
    };

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { py.kill(); } catch {}
      if (err) reject(err); else resolve(result);
    };

    // 1. Timeout
    timeoutHandle = setTimeout(() => {
      finish(new Error('unexpected: liveness_login timeout (120s)'));
    }, PROTOCOL_TIMEOUT_MS);

    // 2. Abort signal (runner stop)
    if (signal) {
      if (signal.aborted) {
        return finish(new Error('unexpected: aborted before spawn'));
      }
      abortHandler = () => finish(new Error('unexpected: aborted'));
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    // 3. spawn error (binary missing, permission, ENOMEM) — distinct from script error
    py.on('error', (e) => {
      finish(new LivenessLoginNotImplementedError(`spawn failed: ${e.message?.slice(0, 80)}`));
    });

    py.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.log) {
            // Stream log line — discard for now. Could pipe to runner's onLog in future.
            continue;
          }
          // Final terminal object
          stdout = trimmed;
        } catch {
          // Non-JSON line — keep as fallback ONLY if no valid terminal yet.
          // Otherwise (e.g., Python prints a deprecation warning after terminal),
          // do NOT clobber a valid terminal object.
          if (!stdout) stdout = trimmed;
        }
      }
    });

    py.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    py.on('close', (code) => {
      if (settled) return;
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch {}

      if (!parsed) {
        return finish(new Error(`unexpected: no terminal (exit ${code}) ${redact(stderr.slice(-80))}`));
      }
      if (parsed.status === 'ok') {
        return finish(null, {
          accessToken: parsed.accessToken || '',
          accountId: parsed.accountId || '',
          expiresAtIso: parsed.expiresAtIso || '',
        });
      }
      if (parsed.status === 'error') {
        return finish(new Error(parsed.reason || `unexpected: empty reason`));
      }
      finish(new Error(`unexpected: bad status ${parsed.status}`));
    });

    py.stdin.write(input);
    py.stdin.end();
  });
}

module.exports = { lightLogin, LivenessLoginNotImplementedError, toCstIso, protocolLightLogin };
