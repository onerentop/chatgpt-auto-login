// server/liveness/light-login.js
// Browser-mode 轻登录：密码 + OTP → /api/auth/session 拿 access_token.
// 不走 PKCE / codex 客户端 deeplink；只产 web session 用的 access_token.
// 协议模式（config.protocolMode=true）的实现留作 Phase B：本期直接抛
// LivenessLoginNotImplementedError，runner 把它捕获为 alive_status='login_fail'.

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

  if (protocolMode) throw new LivenessLoginNotImplementedError();
  if (!account?.password) throw new Error('no password');

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

module.exports = { lightLogin, LivenessLoginNotImplementedError, toCstIso };
