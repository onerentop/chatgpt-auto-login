# Protocol Register Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add protocol register mode — Python curl_cffi 批量注册 GPT 账号，Discord 拿 $0 支付链接，Chrome 自动支付，生成无 rt 的 CPA JSON。协议登录并行 + 支付串行。

**Architecture:** 新建 `protocol_register.py`（Python 协议注册）和 `protocol-engine.js`（Node.js 执行引擎）。仅在 Config.vue 加开关、execute.js 加路由分支。不修改现有 engine.js/login.js/payment.js。

**Tech Stack:** Python 3 + curl_cffi, Node.js, Playwright (仅支付), Discord WebSocket, SQLite (sql.js)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `protocol_register.py` | Create | Python 协议注册：homepage → csrf → signin → authorize → register/OTP → about-you → accessToken |
| `protocol-engine.js` | Create | Node.js 引擎：并行 Python 子进程 + 串行 Discord/支付 + CPA JSON 生成 |
| `server/routes/execute.js` | Modify | 根据 protocolMode 选择引擎 |
| `web/src/views/Config.vue` | Modify | 新增 protocolMode 开关 |
| `config.json` | Modify | 新增 `protocolMode: false` |

---

### Task 1: Create protocol_register.py — Python 协议注册脚本

**Files:**
- Create: `protocol_register.py`

**注意**: 此脚本参考 `D:\workspace\projects\cliproxyaccountcleaner\chatgpt_register\chatgpt_register.py` 的注册流程，通过 stdin JSON 接收参数，stdout JSON 输出结果。

- [ ] **Step 1: Create protocol_register.py**

```python
#!/usr/bin/env python3
"""Protocol register/login for ChatGPT via curl_cffi.
Input: JSON on stdin { email, password, client_id, refresh_token }
Output: JSON lines on stdout — log lines as {"log":"..."}, final result as {"status":...}
"""
import sys, os, json, uuid, time, random, re, string, hashlib, base64, secrets, imaplib
import email as email_lib
from urllib.parse import urlparse, parse_qs, urlencode

sys.path.insert(0, r"D:\workspace\projects\cliproxyaccountcleaner")

def _log(msg):
    print(json.dumps({"log": f"  [Proto] {msg}"}), flush=True)

def _generate_password(length=14):
    lower = string.ascii_lowercase
    upper = string.ascii_uppercase
    digits = string.digits
    special = "!@#$%&*"
    pwd = [random.choice(lower), random.choice(upper), random.choice(digits), random.choice(special)]
    all_chars = lower + upper + digits + special
    pwd += [random.choice(all_chars) for _ in range(length - 4)]
    random.shuffle(pwd)
    return "".join(pwd)

def _fetch_imap_otp(email_addr, client_id, refresh_token, baseline_uid, timeout=90):
    """Poll Outlook IMAP for OTP code after baseline_uid."""
    token_body = urlencode({"client_id": client_id, "grant_type": "refresh_token",
        "refresh_token": refresh_token, "scope": "https://outlook.office.com/IMAP.AccessAsUser.All"})
    from curl_cffi import requests as curl_requests
    r = curl_requests.post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
        headers={"Content-Type": "application/x-www-form-urlencoded"}, data=token_body, timeout=15)
    imap_token = r.json().get("access_token")
    if not imap_token:
        return None

    start = time.time()
    for attempt in range(30):
        if time.time() - start > timeout:
            break
        try:
            imap = imaplib.IMAP4_SSL("outlook.office365.com", 993)
            auth_str = f"user={email_addr}\x01auth=Bearer {imap_token}\x01\x01"
            imap.authenticate("XOAUTH2", lambda x: auth_str.encode())
            imap.select("INBOX")
            _, msgs = imap.search(None, f"UID {baseline_uid + 1}:*")
            new_uids = [u for u in msgs[0].split() if int(u) > baseline_uid]
            for uid in reversed(new_uids):
                _, data = imap.fetch(uid, "(BODY[])")
                raw = data[0][1]
                msg = email_lib.message_from_bytes(raw)
                subject = str(msg.get("Subject", ""))
                from_addr = str(msg.get("From", ""))
                if "openai" in from_addr.lower() or "chatgpt" in subject.lower() or "code" in subject.lower():
                    m = re.search(r"\b(\d{6})\b", subject)
                    if m:
                        imap.logout()
                        return m.group(1)
                    body = ""
                    if msg.is_multipart():
                        for part in msg.walk():
                            if part.get_content_type() == "text/html":
                                body = part.get_payload(decode=True).decode("utf-8", errors="ignore")
                                break
                    else:
                        body = msg.get_payload(decode=True).decode("utf-8", errors="ignore")
                    body_clean = re.sub(r"<[^>]+>", " ", body)
                    m = re.search(r"\b(\d{6})\b", body_clean)
                    if m:
                        imap.logout()
                        return m.group(1)
            imap.logout()
        except Exception as e:
            if attempt == 0:
                _log(f"IMAP poll error: {str(e)[:50]}")
        time.sleep(3)
    return None

def _get_imap_baseline(email_addr, client_id, refresh_token):
    """Get current max UID from Outlook IMAP."""
    try:
        token_body = urlencode({"client_id": client_id, "grant_type": "refresh_token",
            "refresh_token": refresh_token, "scope": "https://outlook.office.com/IMAP.AccessAsUser.All"})
        from curl_cffi import requests as curl_requests
        r = curl_requests.post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
            headers={"Content-Type": "application/x-www-form-urlencoded"}, data=token_body, timeout=15)
        imap_token = r.json().get("access_token")
        if not imap_token:
            return 0
        imap = imaplib.IMAP4_SSL("outlook.office365.com", 993)
        auth_str = f"user={email_addr}\x01auth=Bearer {imap_token}\x01\x01"
        imap.authenticate("XOAUTH2", lambda x: auth_str.encode())
        imap.select("INBOX")
        _, msgs = imap.search(None, "ALL")
        uids = msgs[0].split()
        baseline = int(uids[-1]) if uids else 0
        imap.logout()
        return baseline
    except Exception:
        return 0

def main():
    try:
        input_data = json.loads(sys.stdin.read())
    except Exception as e:
        print(json.dumps({"status": "error", "error": f"Invalid input: {e}"}))
        return

    email = input_data.get("email", "")
    password = input_data.get("password", "")
    client_id = input_data.get("client_id", "")
    refresh_token = input_data.get("refresh_token", "")

    try:
        from curl_cffi import requests as curl_requests
        from chatgpt_register.chatgpt_register import _random_chrome_version, build_sentinel_token

        impersonate, chrome_major, chrome_full, ua, sec_ch_ua = _random_chrome_version()
        device_id = str(uuid.uuid4())
        _log(f"Profile: {impersonate}, Device: {device_id[:8]}...")

        session = curl_requests.Session(impersonate=impersonate)
        session.headers.update({"User-Agent": ua, "Accept-Language": "en-US,en;q=0.9",
            "sec-ch-ua": sec_ch_ua, "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"'})
        session.cookies.set("oai-did", device_id, domain="chatgpt.com")
        session.cookies.set("oai-did", device_id, domain="auth.openai.com")
        session.cookies.set("oai-did", device_id, domain=".auth.openai.com")

        BASE = "https://chatgpt.com"
        AUTH = "https://auth.openai.com"

        # Get IMAP baseline BEFORE any auth flow
        imap_baseline = _get_imap_baseline(email, client_id, refresh_token) if client_id and refresh_token else 0
        _log(f"IMAP baseline: {imap_baseline}")

        # Step 0: Visit homepage
        _log("Step 0: Homepage...")
        for attempt in range(4):
            r = session.get(f"{BASE}/", headers={"Accept": "text/html", "Upgrade-Insecure-Requests": "1"}, allow_redirects=True, timeout=20)
            if r.status_code == 200:
                break
            if r.status_code == 403 and attempt < 3:
                _log(f"Homepage 403, retry ({attempt+1}/4)")
                impersonate, chrome_major, chrome_full, ua, sec_ch_ua = _random_chrome_version()
                device_id = str(uuid.uuid4())
                session = curl_requests.Session(impersonate=impersonate)
                session.headers.update({"User-Agent": ua, "sec-ch-ua": sec_ch_ua, "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"', "Accept-Language": "en-US,en;q=0.9"})
                session.cookies.set("oai-did", device_id, domain="chatgpt.com")
                session.cookies.set("oai-did", device_id, domain="auth.openai.com")
                session.cookies.set("oai-did", device_id, domain=".auth.openai.com")
                time.sleep(2 * (attempt + 1))
                continue
            raise Exception(f"Homepage failed: {r.status_code}")
        time.sleep(random.uniform(0.5, 1.5))

        # Step 1: CSRF
        _log("Step 1: CSRF...")
        r = session.get(f"{BASE}/api/auth/csrf", headers={"Accept": "application/json"}, timeout=15)
        csrf = r.json().get("csrfToken", "")
        if not csrf:
            raise Exception("CSRF failed")
        time.sleep(random.uniform(0.3, 0.8))

        # Step 2: Signin
        _log("Step 2: Signin...")
        signin_params = {"prompt": "login", "ext-oai-did": device_id,
            "auth_session_logging_id": str(uuid.uuid4()), "screen_hint": "login_or_signup", "login_hint": email}
        r = session.post(f"{BASE}/api/auth/signin/openai", params=signin_params,
            data={"callbackUrl": f"{BASE}/", "csrfToken": csrf, "json": "true"},
            headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}, timeout=15)
        auth_url = r.json().get("url", "")
        if not auth_url:
            raise Exception("Signin failed")
        time.sleep(random.uniform(0.5, 1.2))

        # Step 3: Authorize
        _log("Step 3: Authorize...")
        r = session.get(auth_url, headers={"Accept": "text/html", "Upgrade-Insecure-Requests": "1", "Referer": f"{BASE}/"}, allow_redirects=True, timeout=30)
        final_url = str(r.url)
        final_path = urlparse(final_url).path
        _log(f"Authorize -> {final_path}")

        need_otp = False
        need_register = False

        if "/create-account/password" in final_path:
            need_register = True
            _log("New account — registration flow")
        elif "/email-verification" in final_path:
            need_otp = True
            _log("Existing account — OTP flow")
        elif "/log-in" in final_path:
            # Submit email via authorize/continue
            _log("Step 3b: Submit email...")
            sentinel = ""
            try:
                sentinel = build_sentinel_token(session, device_id, flow="authorize_continue", user_agent=ua, sec_ch_ua=sec_ch_ua) or ""
            except: pass
            r = session.post(f"{AUTH}/api/accounts/authorize/continue",
                json={"username": {"kind": "email", "value": email}},
                headers={"Accept": "application/json", "Content-Type": "application/json",
                    "Origin": AUTH, "Referer": final_url, "oai-device-id": device_id,
                    "openai-sentinel-token": sentinel, "ext-passkey-client-capabilities": "conditional-create,conditional-get"}, timeout=30)
            page_data = r.json()
            page_type = (page_data.get("page") or {}).get("type", "")
            _log(f"Email response: page={page_type}")
            if "email_otp" in page_type or "email-verification" in (page_data.get("continue_url") or ""):
                need_otp = True
            elif "create-account" in page_type or "password" in page_type:
                need_register = True

        # Step 4: Register (new accounts only)
        if need_register:
            _log("Step 4: Registering new account...")
            if not password:
                password = _generate_password()
                _log(f"Generated password: {password[:3]}***")
            sentinel = ""
            try:
                sentinel = build_sentinel_token(session, device_id, flow="username_password_create", user_agent=ua, sec_ch_ua=sec_ch_ua) or ""
            except: pass
            r = session.post(f"{AUTH}/api/accounts/user/register",
                json={"username": email, "password": password},
                headers={"Accept": "application/json", "Content-Type": "application/json",
                    "Origin": AUTH, "Referer": f"{AUTH}/create-account/password",
                    "oai-device-id": device_id, "openai-sentinel-token": sentinel,
                    "ext-passkey-client-capabilities": "conditional-create,conditional-get"}, timeout=30)
            _log(f"Register: {r.status_code}")
            if r.status_code != 200:
                raise Exception(f"Register failed: {r.text[:100]}")
            need_otp = True
            # Trigger OTP send
            session.get(f"{AUTH}/api/accounts/email-otp/send",
                headers={"Accept": "text/html", "Referer": f"{AUTH}/create-account/password",
                    "oai-device-id": device_id, "Upgrade-Insecure-Requests": "1"}, timeout=10, allow_redirects=True)
            _log("OTP send triggered")

        # Step 5: OTP verification
        if need_otp:
            if not client_id or not refresh_token:
                raise Exception("OTP required but no IMAP credentials")
            _log("Step 5: Fetching OTP from IMAP...")
            time.sleep(5)
            otp = _fetch_imap_otp(email, client_id, refresh_token, imap_baseline, timeout=90)
            if not otp:
                raise Exception("OTP not received")
            _log(f"OTP: {otp}")

            sentinel = ""
            try:
                sentinel = build_sentinel_token(session, device_id, flow="email_otp_validate", user_agent=ua, sec_ch_ua=sec_ch_ua) or ""
            except: pass
            r = session.post(f"{AUTH}/api/accounts/email-otp/validate",
                json={"code": otp},
                headers={"Accept": "application/json", "Content-Type": "application/json",
                    "Origin": AUTH, "Referer": f"{AUTH}/email-verification",
                    "oai-device-id": device_id, "openai-sentinel-token": sentinel,
                    "ext-passkey-client-capabilities": "conditional-create,conditional-get"}, timeout=30)
            otp_data = r.json()
            otp_page = (otp_data.get("page") or {}).get("type", "")
            _log(f"OTP response: {r.status_code} page={otp_page}")
            if r.status_code != 200:
                raise Exception(f"OTP validation failed: {r.status_code}")

        # Step 6: About-you (if needed)
        if "about_you" in str(otp_page if need_otp else "") or need_register:
            _log("Step 6: About-you...")
            names_first = ["James", "Mary", "John", "Linda", "Robert", "Sarah"]
            names_last = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Davis"]
            name = f"{random.choice(names_first)} {random.choice(names_last)}"
            bdate = f"{random.randint(1990, 2002)}-{random.randint(1,12):02d}-{random.randint(1,28):02d}"
            sentinel = ""
            try:
                sentinel = build_sentinel_token(session, device_id, flow="oauth_create_account", user_agent=ua, sec_ch_ua=sec_ch_ua) or ""
            except: pass
            r = session.post(f"{AUTH}/api/accounts/create_account",
                json={"name": name, "birthdate": bdate},
                headers={"Accept": "application/json", "Content-Type": "application/json",
                    "Origin": AUTH, "Referer": f"{AUTH}/about-you",
                    "oai-device-id": device_id, "openai-sentinel-token": sentinel,
                    "ext-passkey-client-capabilities": "conditional-create,conditional-get"}, timeout=30)
            _log(f"About-you: {r.status_code}")

        # Step 7: Get session token
        _log("Step 7: Getting session...")
        time.sleep(1)
        # Re-visit chatgpt.com to trigger callback
        session.get(f"{BASE}/", headers={"Accept": "text/html", "Upgrade-Insecure-Requests": "1"}, allow_redirects=True, timeout=30)
        time.sleep(1)
        r = session.get(f"{BASE}/api/auth/session", headers={"Accept": "application/json"}, timeout=15)
        session_data = r.json()
        access_token = session_data.get("accessToken")

        if not access_token:
            raise Exception("Failed to get accessToken from session")
        _log(f"accessToken: {access_token[:20]}...")

        # Step 8: Generate checkout link
        _log("Step 8: Checkout link...")
        checkout_url = ""
        checkout_error = ""
        try:
            r = session.post(f"{BASE}/backend-api/payments/checkout",
                json={"plan_name": "chatgptplusplan", "billing_info": {"country": "JP", "is_new_card": True}, "currency": "USD"},
                headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"}, timeout=15)
            cd = r.json()
            checkout_url = cd.get("url", "")
            if cd.get("detail"):
                checkout_error = cd["detail"]
        except Exception as e:
            checkout_error = str(e)

        plan_type = session_data.get("account", {}).get("planType", session_data.get("chatgpt_plan_type", "free"))

        _log(f"Done! Plan: {plan_type}")

        print(json.dumps({
            "status": "success",
            "accessToken": access_token,
            "session": session_data,
            "checkoutUrl": checkout_url,
            "checkoutError": checkout_error,
            "planType": plan_type,
            "password": password,
        }))

    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"status": "error", "error": str(e)[:200]}))

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Verify Python script loads**

```bash
cd E:\workspace\projects\demo\chatgpt-auto-login
echo '{"email":"test@test.com","password":"test"}' | py -3 protocol_register.py 2>&1 | head -5
```

Expected: Either log output or error (not a syntax error).

- [ ] **Step 3: Commit**

```bash
git add protocol_register.py
git commit -m "feat: add protocol_register.py — Python curl_cffi GPT registration"
```

---

### Task 2: Create protocol-engine.js — Node.js Execution Engine

**Files:**
- Create: `protocol-engine.js`

This engine has the same EventEmitter interface as `server/engine.js` but uses Python subprocess for login/register and shares a single Discord + Chrome for payment.

- [ ] **Step 1: Create protocol-engine.js**

The file copies Discord Gateway code from engine.js (since we can't modify engine.js) and adds:
- Parallel Python subprocess spawning
- Serial Discord + payment queue
- CPA JSON generation (no refresh_token)

```javascript
// protocol-engine.js — Protocol register mode execution engine
// Same EventEmitter interface as server/engine.js but uses Python curl_cffi for login/register

const { EventEmitter } = require('events');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const { chromium } = require('playwright');

const { autoPayment, CONFIG: PAY_CONFIG } = require('./payment');
const { randomDelay } = require('./utils');

const ROOT = __dirname;
const PYTHON_SCRIPT = path.join(ROOT, 'protocol_register.py');

// ========== Discord config (copied from engine.js — cannot modify original) ==========
const DISCORD_TOKEN = PAY_CONFIG.discordToken || '';
const CHANNEL_ID = PAY_CONFIG.discordChannelId || '';
const HUB_MESSAGE_ID = PAY_CONFIG.discordMessageId || '';
const GUILD_ID = PAY_CONFIG.discordGuildId || '';
const APP_ID = PAY_CONFIG.discordAppId || '';
const API_BASE = 'https://discord.com/api/v9';

const superProps = Buffer.from(JSON.stringify({
  os: 'Windows', browser: 'Chrome', device: '',
  browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  browser_version: '131.0.0.0', os_version: '10',
  release_channel: 'stable', client_build_number: 335978,
})).toString('base64');

const discordHeaders = {
  'Authorization': DISCORD_TOKEN, 'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'X-Super-Properties': superProps,
};

function nn() { return String(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))); }

// Discord Gateway (same as engine.js)
function connectGateway() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json');
    let hb = null, seq = null, sessionId = null;
    const eh = {};
    function on(e, f) { if (!eh[e]) eh[e] = []; eh[e].push(f); }
    function off(e, f) { const a = eh[e] || []; const i = a.indexOf(f); if (i !== -1) a.splice(i, 1); }
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.s) seq = m.s;
      if (m.op === 10) {
        hb = setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), m.d.heartbeat_interval);
        ws.send(JSON.stringify({ op: 2, d: { token: DISCORD_TOKEN, properties: { os: 'Windows', browser: 'Chrome', device: '' }, presence: { status: 'online', afk: false } } }));
      }
      if (m.op === 0 && m.t === 'READY') { sessionId = m.d.session_id; resolve({ ws, sessionId, on, off, cleanup: () => { clearInterval(hb); ws.close(); } }); }
      if (m.op === 0 && m.t) { for (const f of (eh[m.t] || [])) f(m.d); }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('Gateway timeout')), 30000);
  });
}

function waitFor(gw, event, filter, ms = 30000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { gw.off(event, h); reject(new Error(`Timeout: ${event}`)); }, ms);
    function h(d) { if (filter(d)) { clearTimeout(t); gw.off(event, h); resolve(d); } }
    gw.on(event, h);
  });
}

function waitForAny(gw, events, filter, ms = 30000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error('Timeout')); }, ms);
    const hs = {};
    function cleanup() { clearTimeout(t); for (const e of events) gw.off(e, hs[e]); }
    for (const e of events) { hs[e] = (d) => { if (filter(d)) { cleanup(); resolve(d); } }; gw.on(e, hs[e]); }
  });
}

async function interact(body) {
  const r = await fetch(`${API_BASE}/interactions`, { method: 'POST', headers: discordHeaders, body: JSON.stringify(body) });
  if (r.status !== 204 && r.status !== 200) throw new Error(`Interaction ${r.status}: ${await r.text()}`);
}

async function getPaymentLink(gw, accessToken) {
  const menuP = waitFor(gw, 'MESSAGE_CREATE', (d) => d.author?.bot && d.components?.length > 0, 15000);
  await interact({ type: 3, nonce: nn(), guild_id: GUILD_ID, channel_id: CHANNEL_ID, message_flags: 0, message_id: HUB_MESSAGE_ID, application_id: APP_ID, session_id: gw.sessionId, data: { component_type: 2, custom_id: 'hub:chatgpt' } });
  const menu = await menuP;
  let btnId = null;
  for (const r of (menu.components || [])) { for (const c of (r.components || [])) { if (c.label?.includes('美区') && c.label?.includes('PLUS') && c.label?.includes('免费试用')) btnId = c.custom_id; } }
  if (!btnId) throw new Error('US Plus button not found');
  const modalP = waitFor(gw, 'INTERACTION_MODAL_CREATE', () => true, 15000);
  await new Promise(r => setTimeout(r, 1500));
  await interact({ type: 3, nonce: nn(), guild_id: GUILD_ID, channel_id: CHANNEL_ID, message_flags: 64, message_id: menu.id, application_id: APP_ID, session_id: gw.sessionId, data: { component_type: 2, custom_id: btnId } });
  const modal = await modalP;
  const fieldId = modal.data?.components?.[0]?.components?.[0]?.custom_id;
  if (!fieldId) throw new Error('Modal field not found');
  await new Promise(r => setTimeout(r, 1000));
  await interact({ type: 5, nonce: nn(), application_id: APP_ID, channel_id: CHANNEL_ID, guild_id: GUILD_ID, session_id: gw.sessionId, data: { id: modal.data.id, custom_id: modal.data.custom_id, components: [{ type: 1, components: [{ type: 4, custom_id: fieldId, value: accessToken }] }] } });
  const result = await waitForAny(gw, ['MESSAGE_UPDATE', 'MESSAGE_CREATE'], (d) => { const txt = JSON.stringify(d); return txt.includes('pay.openai.com') || txt.includes('已经是') || txt.includes('already'); }, 30000);
  const raw = JSON.stringify(result);
  const linkMatch = raw.match(/https:\/\/pay\.openai\.com[^\s"')]+/);
  const titleMatch = raw.match(/✅[^"'\n]+/);
  return { link: linkMatch?.[0] || '', title: titleMatch?.[0] || '', raw: raw.slice(0, 300) };
}

// ========== Chrome helpers ==========
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
];
function findChrome() { for (const p of CHROME_PATHS) if (fs.existsSync(p)) return p; return null; }

let _screenSize = null;
function getScreenQuarter() {
  if (!_screenSize) {
    try {
      const out = execSync('powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds | Select Width,Height | ConvertTo-Json"', { encoding: 'utf-8', timeout: 5000 });
      const { Width, Height } = JSON.parse(out);
      _screenSize = { w: Math.floor(Width / 2), h: Math.floor(Height / 2) };
    } catch { _screenSize = { w: 960, h: 540 }; }
  }
  return _screenSize;
}

function launchChrome(port, tempDir) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('Chrome not found');
  const q = getScreenQuarter();
  return spawn(chromePath, [`--remote-debugging-port=${port}`, '--incognito', `--user-data-dir=${tempDir}`, '--no-first-run', '--no-default-browser-check', '--disable-default-apps', '--disable-popup-blocking', `--window-size=${q.w},${q.h}`, '--window-position=0,0', 'about:blank'], { stdio: 'ignore', detached: false });
}

async function waitForCDP(port) {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  throw new Error('CDP timeout');
}

// ========== CPA JSON (no refresh_token) ==========
function saveCPAJson(email, accessToken, session) {
  const authDir = path.join(ROOT, 'cpa-auth');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
  const sanitized = email.replace(/@/g, '-at-').replace(/\./g, '-');
  const filePath = path.join(authDir, `codex-${sanitized}.json`);
  let accountId = '';
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64').toString());
    accountId = payload['https://api.openai.com/auth']?.chatgpt_account_id || '';
  } catch {}
  const now = new Date();
  const expired = new Date(now.getTime() + 10 * 24 * 3600000);
  const data = {
    access_token: accessToken, account_id: accountId, email,
    expired: expired.toISOString().replace('Z', '+08:00'),
    id_token: '', last_refresh: now.toISOString().replace('Z', '+08:00'),
    refresh_token: '', type: 'codex',
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`  [CPA-Auth] Saved: ${filePath}`);
  return filePath;
}

// ========== Python subprocess ==========
function runProtocolRegister(account) {
  return new Promise((resolve, reject) => {
    const py = spawn('py', ['-3', PYTHON_SCRIPT], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
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
      try {
        const result = JSON.parse(stdout);
        if (result.status === 'success') resolve(result);
        else reject(new Error(result.error || 'Protocol register failed'));
      } catch { reject(new Error(stderr.slice(-200) || `Python exit ${code}`)); }
    });
    py.stdin.write(input);
    py.stdin.end();
  });
}

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
  }

  getStatus() { return this.status; }

  emitStatus(data) {
    this.emit('account-status', data);
    try {
      const { statusDB } = require('./server/db');
      statusDB.set(data.email, data);
    } catch {}
  }

  stop() {
    if (this.status !== 'idle') {
      this.stopFlag = true;
      if (this._chromeProc) try { this._chromeProc.kill(); } catch {}
      if (this._browser) try { this._browser.close(); } catch {}
      if (this._gw) try { this._gw.cleanup(); } catch {}
      if (this._tempDir) try { fs.rmSync(this._tempDir, { recursive: true, force: true }); } catch {}
      this._chromeProc = null; this._browser = null; this._gw = null; this._tempDir = null;
      this.status = 'idle';
      this.emit('log', { email: '', phase: '', message: 'Protocol engine force stopped.', timestamp: new Date().toISOString() });
    }
  }

  async start(startFrom = 0, filterEmails = null) {
    this.status = 'running';
    this.stopFlag = false;

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

    const summary = { total: accounts.length, success: 0, alreadyPlus: 0, noLink: 0, error: 0 };

    try {
      // === Phase 1: Parallel protocol login/register ===
      console.log(`[Proto-Engine] Starting ${accounts.length} accounts in parallel...`);
      const loginResults = await Promise.allSettled(accounts.map(async (account, i) => {
        if (this.stopFlag) throw new Error('Stopped');
        const progress = `${i + 1}/${accounts.length}`;
        this.emitStatus({ email: account.email, status: 'running', phase: 'protocol-login', progress });
        console.log(`[${progress}] === ${account.email} (protocol) ===`);
        const result = await runProtocolRegister(account);
        console.log(`[${progress}] Protocol login OK: ${result.accessToken?.slice(0, 20)}...`);
        return { account, result };
      }));

      // Collect successful logins
      const successfulLogins = [];
      for (const r of loginResults) {
        if (r.status === 'fulfilled') {
          const { account, result } = r.value;
          const isPlusOrAbove = ['plus', 'pro', 'team', 'enterprise'].includes((result.planType || 'free').toLowerCase());
          if (isPlusOrAbove) {
            console.log(`[Proto-Engine] ${account.email} already Plus, generating CPA JSON...`);
            saveCPAJson(account.email, result.accessToken, result.session);
            this.emitStatus({ email: account.email, status: 'already_plus', phase: 'done', progress: '' });
            summary.alreadyPlus++;
          } else {
            successfulLogins.push({ account, result });
          }
        } else {
          const email = accounts[loginResults.indexOf(r)]?.email || 'unknown';
          console.log(`[Proto-Engine] ${email} failed: ${r.reason?.message?.slice(0, 80)}`);
          this.emitStatus({ email, status: 'error', phase: 'protocol-login', reason: r.reason?.message });
          summary.error++;
        }
      }

      if (successfulLogins.length === 0 || this.stopFlag) {
        this.emit('complete', { summary });
        this.status = 'idle';
        return;
      }

      // === Phase 2: Serial Discord + Payment ===
      console.log(`[Proto-Engine] ${successfulLogins.length} accounts need payment. Connecting Discord...`);
      this._gw = await connectGateway();
      console.log('[Proto-Engine] Discord connected!');

      const port = 9222;
      this._tempDir = path.join(os.tmpdir(), `proto-pay-${Date.now()}`);
      this._chromeProc = launchChrome(port, this._tempDir);
      this._browser = await waitForCDP(port);

      for (let i = 0; i < successfulLogins.length; i++) {
        if (this.stopFlag) break;
        const { account, result } = successfulLogins[i];
        const progress = `${i + 1}/${successfulLogins.length}`;

        try {
          // Discord
          this.emitStatus({ email: account.email, status: 'running', phase: 'discord', progress });
          console.log(`[${progress}] Discord: ${account.email}...`);
          let link = result.checkoutUrl;
          if (!link) {
            const discord = await getPaymentLink(this._gw, result.accessToken);
            link = discord.link;
            console.log(`[${progress}] ${discord.title || 'Link obtained'}`);
          }

          if (!link) {
            console.log(`[${progress}] No payment link`);
            this.emitStatus({ email: account.email, status: 'no_link', phase: 'done', progress });
            summary.noLink++;
            continue;
          }

          // Payment
          this.emitStatus({ email: account.email, status: 'running', phase: 'payment', progress });
          console.log(`[${progress}] Opening payment: ${link.slice(0, 60)}...`);
          const ctx = this._browser.contexts()[0];
          const page = ctx.pages()[0] || await ctx.newPage();
          await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await randomDelay(2000, 3000);

          let paymentOk = true;
          try { await autoPayment(page); } catch (e) { console.log(`[${progress}] Payment error: ${e.message?.slice(0, 60)}`); paymentOk = false; }

          // Generate CPA JSON (no refresh_token)
          saveCPAJson(account.email, result.accessToken, result.session);

          if (paymentOk) {
            this.emitStatus({ email: account.email, status: 'success', phase: 'done', progress });
            summary.success++;
          } else {
            this.emitStatus({ email: account.email, status: 'error', phase: 'payment', progress, reason: 'Payment failed' });
            summary.error++;
          }
        } catch (e) {
          console.log(`[${progress}] ${account.email} error: ${e.message?.slice(0, 80)}`);
          this.emitStatus({ email: account.email, status: 'error', phase: 'payment', progress, reason: e.message });
          summary.error++;
        }

        if (i < successfulLogins.length - 1) await randomDelay(3000, 5000);
      }

    } catch (e) {
      console.log(`[Proto-Engine] Fatal: ${e.message}`);
    } finally {
      if (this._browser) try { await this._browser.close(); } catch {}
      if (this._chromeProc) try { this._chromeProc.kill(); } catch {}
      if (this._gw) try { this._gw.cleanup(); } catch {}
      if (this._tempDir) try { fs.rmSync(this._tempDir, { recursive: true, force: true }); } catch {}
      this._browser = null; this._chromeProc = null; this._gw = null; this._tempDir = null;
    }

    console.log(`[Proto-Engine] Complete: ${JSON.stringify(summary)}`);
    this.emit('complete', { summary });
    this.status = 'idle';
  }
}

module.exports = { ProtocolEngine };
```

- [ ] **Step 2: Verify engine loads**

```bash
node -e "const { ProtocolEngine } = require('./protocol-engine'); console.log('OK:', typeof ProtocolEngine)"
```

Expected: `OK: function`

- [ ] **Step 3: Commit**

```bash
git add protocol-engine.js
git commit -m "feat: add protocol-engine.js — parallel protocol register + serial payment"
```

---

### Task 3: Modify execute.js — Route to Protocol Engine

**Files:**
- Modify: `server/routes/execute.js`

- [ ] **Step 1: Add protocol engine selection**

At the top of `server/routes/execute.js`, add the ProtocolEngine import. Then in the POST handler, read config to decide which engine to use.

Find the line `engine = new PipelineEngine();` (line 21) and wrap it:

```javascript
// Add at top:
const { ProtocolEngine } = require('../../protocol-engine');
const { readConfig } = require('./config');

// Replace line 21:
const config = readConfig();
engine = config.protocolMode ? new ProtocolEngine() : new PipelineEngine();
```

**Note:** `readConfig` needs to be exported from config.js. Check if it already is.

- [ ] **Step 2: Export readConfig from config.js**

In `server/routes/config.js`, add `readConfig` to module.exports if not already exported.

- [ ] **Step 3: Commit**

```bash
git add server/routes/execute.js server/routes/config.js
git commit -m "feat: route execute to ProtocolEngine when protocolMode enabled"
```

---

### Task 4: Modify Config.vue + config.json — Add protocolMode Switch

**Files:**
- Modify: `web/src/views/Config.vue`
- Modify: `config.json`

- [ ] **Step 1: Add protocolMode to Config.vue form state**

In the `reactive` form object, add: `protocolMode: false,`

- [ ] **Step 2: Add switch to Config.vue template**

After the SMS API URL section, before Discord config, add:

```html
<el-divider content-position="left">执行模式</el-divider>
<el-form-item label="协议注册模式">
  <el-switch v-model="form.protocolMode" />
  <span style="color:#909399;margin-left:8px;font-size:12px">开启后使用协议注册（仅支付时开浏览器），支持多并发</span>
</el-form-item>
```

- [ ] **Step 3: Add protocolMode to config.json**

Add `"protocolMode": false` to config.json.

- [ ] **Step 4: Build frontend**

```bash
cd web && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add web/src/views/Config.vue
git commit -m "feat: add protocolMode switch to Config page"
```

---

### Task 5: Integration Test

- [ ] **Step 1: Start server and verify protocol mode toggle**

1. `node server/index.js`
2. Open http://localhost:3000
3. Go to Config, toggle "协议注册模式" on, save
4. Execute an Outlook account
5. Verify logs show `[Proto]` prefix (Python subprocess)

- [ ] **Step 2: Verify browser mode still works**

1. Toggle "协议注册模式" off, save
2. Execute same account
3. Verify Chrome opens normally (browser login flow)

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: protocol register mode complete — parallel login + serial payment"
```

---

## Spec Coverage

| Spec Section | Task |
|---|---|
| protocol_register.py | Task 1 |
| protocol-engine.js | Task 2 |
| execute.js routing | Task 3 |
| Config.vue switch | Task 4 |
| CPA JSON (no rt) | Task 2 (saveCPAJson function) |
| Multi-concurrent | Task 2 (Promise.allSettled) |
| Discord Gateway | Task 2 (copied from engine.js) |
| Chrome payment | Task 2 (shared single Chrome) |
