# v2.29 Liveness Protocol-Mode lightLogin 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 关闭 v2.26 Phase B 待办 —— 实现协议模式 liveness lightLogin（curl_cffi 走 Auth0 HTTP API），让没有 codex 缓存的账号在协议模式下能正常测活，不再标 `'liveness not yet supported in protocol mode'`。

**Architecture:** Python 端新建 `chatgpt_register/liveness_login.py`（纯登录脚本）+ `chatgpt_register/otp.py`（抽出共享 OTP helper）；Node 端 `server/liveness/light-login.js:protocolMode` 分支 spawn 此脚本；JSON-lines 子进程协议；错误 reason 字符串契约对齐 `runner.js:99-117` 的 9 类 keyword，runner 零改动。

**Tech Stack:** Python 3 + curl_cffi + pyotp（新）+ chatgpt_register/sentinel；Node `node:test` + child_process；Python `unittest`。

**Spec:** `docs/superpowers/specs/2026-05-25-liveness-protocol-lightlogin-design.md`

---

## 文件清单

**新建：**
- `chatgpt_register/otp.py` — IMAP OTP + TOTP helper（~85 行；抽自 protocol_register.py + 加 gen_totp）
- `chatgpt_register/liveness_login.py` — 协议模式纯登录脚本（~260 行）
- `tests/test_liveness_login.py` — Python unittest（3 cases）
- `server/liveness/__tests__/light-login.test.js` — JS node:test（5 cases）

**修改：**
- `protocol_register.py` — 删除 `_fetch_imap_otp` + `_get_imap_baseline` 函数体，改 import 别名（行 142-220 净减）
- `server/liveness/light-login.js` — 加 spawn 胶水 + `protocolLightLogin` 函数
- `server/liveness/runner.js:87-90` — 1 行加 `proxyUrl: getProxy().getProxyUrl()` 参数
- `CLAUDE.md` — `pip install` 命令加 pyotp
- `start.bat` — pyotp smoke 提示
- `docs/CHANGELOG.md` — 追加 v2.29.0 节

---

## Task 1：抽出 OTP helper（`chatgpt_register/otp.py`）

**Files:**
- Create: `chatgpt_register/otp.py`
- Modify: `protocol_register.py:142-220` (delete function bodies, add import alias)

### Step 1：创建 `chatgpt_register/otp.py`

- [ ] **Step 1:** Create with this content:

```python
"""OTP helpers — IMAP for Outlook, TOTP for Gmail.

Extracted from protocol_register.py for reuse across the register flow
and the new liveness_login flow. fetch_imap_otp / get_imap_baseline
bodies are byte-for-byte copies of the originals; only added `log=None`
callback parameter to decouple from protocol_register._log.
"""
import time
import re
import imaplib
import email as email_lib
from urllib.parse import urlencode


def fetch_imap_otp(email_addr, client_id, refresh_token, baseline_uid, timeout=90, log=None):
    """Poll Outlook IMAP for OTP code after baseline_uid.

    Returns 6-digit code as string, or None on timeout / parse fail.
    `log` is an optional callback `(str) -> None` for progress messages.
    """
    if log is None:
        log = lambda _m: None
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
        imap = None
        try:
            imap = imaplib.IMAP4_SSL("outlook.office365.com", 993, timeout=15)
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
                        return m.group(1)
        except Exception as e:
            if attempt == 0:
                log(f"IMAP poll error: {str(e)[:50]}")
        finally:
            if imap:
                try:
                    imap.logout()
                except Exception:
                    pass
        time.sleep(3)
    return None


def get_imap_baseline(email_addr, client_id, refresh_token):
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
        imap = imaplib.IMAP4_SSL("outlook.office365.com", 993, timeout=15)
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


def gen_totp(secret):
    """Generate current 6-digit TOTP from Gmail TOTP base32 secret.
    Lazy imports pyotp (new dependency). Returns string '123456'.
    """
    import pyotp
    return pyotp.TOTP(secret).now()
```

### Step 2：修改 `protocol_register.py` — 删函数体，加 import 别名

- [ ] **Step 2:** Open `protocol_register.py`. Find lines 142-220 — the two functions `_fetch_imap_otp` and `_get_imap_baseline` (full bodies, including final `return 0`).

Replace lines 142-220 (the entire block from `def _fetch_imap_otp` to closing `return 0` of `_get_imap_baseline`) with:

```python
# v2.29: OTP helpers moved to chatgpt_register/otp.py for reuse with liveness_login.
# Original bodies preserved verbatim; aliased here so all in-file callers work unchanged.
from chatgpt_register.otp import (
    fetch_imap_otp as _fetch_imap_otp_impl,
    get_imap_baseline as _get_imap_baseline,
)

def _fetch_imap_otp(email_addr, client_id, refresh_token, baseline_uid, timeout=90):
    """Back-compat wrapper that injects this module's _log callback."""
    return _fetch_imap_otp_impl(email_addr, client_id, refresh_token, baseline_uid, timeout, log=_log)
```

### Step 3：跑现有 Python 测试无回归

- [ ] **Step 3:** Run:

```bash
py -3 -m unittest tests.test_protocol_register_h1_fallback
```

Expected: 4/4 PASS (test file does not exercise OTP path; protocol_register module load must still succeed).

### Step 4：Commit

- [ ] **Step 4:**

```bash
git add chatgpt_register/otp.py protocol_register.py
git commit -m "$(cat <<'EOF'
refactor(otp): 抽出 IMAP OTP helper 到 chatgpt_register/otp.py

protocol_register.py:_fetch_imap_otp + _get_imap_baseline 函数体
逐字复制到新模块 chatgpt_register/otp.py，原文件改为 import 别名。
_fetch_imap_otp 通过 log= callback 参数解耦 protocol_register._log，
back-compat wrapper 保持原签名调用方零改动。

新增 gen_totp(secret) 用 pyotp（lazy import，仅 Gmail liveness 需要）。

为 v2.29 liveness_login.py 共享 OTP 逻辑做准备。
现有 register 流程行为不变；test_protocol_register_h1_fallback 4/4 PASS。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2：协议模式登录脚本 + Python 单测（TDD Y1-Y3）

**Files:**
- Create: `chatgpt_register/liveness_login.py`
- Create: `tests/test_liveness_login.py`

### Step 1：写失败测试 `tests/test_liveness_login.py`

- [ ] **Step 1:** Create with this content:

```python
"""Tests for chatgpt_register/liveness_login.py — protocol-mode lightLogin.

Uses unittest.mock to stub curl_cffi + chatgpt_register.sentinel,
mirroring tests/test_protocol_register_h1_fallback.py pattern.
"""
import unittest
import sys, os, types
from unittest.mock import MagicMock, patch

# Stub curl_cffi BEFORE importing liveness_login so module-level imports succeed.
fake_curl_cffi = types.ModuleType('curl_cffi')
fake_curl_cffi.CurlHttpVersion = types.SimpleNamespace(V1_1='HTTP11_SENTINEL')
fake_curl_cffi.requests = types.SimpleNamespace(Session=MagicMock)
sys.modules.setdefault('curl_cffi', fake_curl_cffi)

# Stub chatgpt_register.sentinel — liveness_login imports get_sentinel_token at load.
fake_sentinel = types.ModuleType('chatgpt_register.sentinel')
fake_sentinel.get_sentinel_token = lambda *a, **k: ''
sys.modules.setdefault('chatgpt_register.sentinel', fake_sentinel)

# Stub chatgpt_register.otp so we don't actually hit Outlook IMAP.
fake_otp = types.ModuleType('chatgpt_register.otp')
fake_otp.fetch_imap_otp = lambda *a, **k: '123456'
fake_otp.get_imap_baseline = lambda *a, **k: 0
fake_otp.gen_totp = lambda secret: '654321'
sys.modules.setdefault('chatgpt_register.otp', fake_otp)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from chatgpt_register import liveness_login
# Silence _log so test output isn't polluted by JSON lines.
liveness_login._log = lambda msg: None


class LivenessLoginTest(unittest.TestCase):

    def test_Y1_no_password_raises(self):
        """Y1: login() called with password='' raises Exception('no password')."""
        with self.assertRaises(Exception) as cm:
            liveness_login.login(
                email='a@x.com', password='', login_type='outlook',
                client_id='c', refresh_token='r', totp_secret='', proxy_url='',
            )
        self.assertIn('no password', str(cm.exception))

    def test_Y2_bad_password_raises(self):
        """Y2: password POST returns URL with error=invalid → raises 'bad password'."""
        # Mock session that returns redirect with error=invalid on password POST
        fake_session = MagicMock()
        # Step 1 authorize GET — return state in URL query
        fake_session.get.return_value = MagicMock(url='https://auth.openai.com/u/login/identifier?state=test_state', text='', status_code=200)
        # Step 2 identifier POST — succeed
        # Step 3 password POST — return error=invalid in URL
        fake_session.post.side_effect = [
            MagicMock(url='https://auth.openai.com/u/login/password?state=test_state', text='', status_code=200),  # identifier
            MagicMock(url='https://auth.openai.com/u/login/password?state=test_state&error=invalid', text='', status_code=200),  # password
        ]
        with patch.object(liveness_login, '_build_session', return_value=(fake_session, 'chrome146')):
            with self.assertRaises(Exception) as cm:
                liveness_login.login(
                    email='a@x.com', password='wrong', login_type='outlook',
                    client_id='c', refresh_token='r', totp_secret='', proxy_url='',
                )
            self.assertIn('bad password', str(cm.exception))

    def test_Y3_happy_path_returns_three_fields(self):
        """Y3: full happy path with OTP returns {accessToken, accountId, expiresAtIso}."""
        fake_session = MagicMock()
        # Step 1 authorize: URL has state
        # Step 3 password POST: redirects to email-otp challenge
        # Step 5 OTP POST: redirects to chatgpt.com callback
        # Step 7 session GET: returns accessToken
        fake_session.get.side_effect = [
            MagicMock(url='https://auth.openai.com/u/login/identifier?state=s1', text='', status_code=200),
            MagicMock(url='https://chatgpt.com/', status_code=200, json=lambda: {
                'accessToken': 'eyJ.test_token',
                'user': {'id': 'acc_123'},
                'expires': '2026-08-22T12:00:00Z',
            }),
        ]
        fake_session.post.side_effect = [
            MagicMock(url='https://auth.openai.com/u/login/password?state=s1', text='', status_code=200),  # identifier
            MagicMock(url='https://auth.openai.com/u/email-otp/challenge?state=s1', text='', status_code=200),  # password → otp
            MagicMock(url='https://chatgpt.com/api/auth/callback/login-web?code=x', text='', status_code=200),  # otp submit
        ]
        fake_session.cookies = MagicMock()
        fake_session.headers = {'User-Agent': 'test'}
        with patch.object(liveness_login, '_build_session', return_value=(fake_session, 'chrome146')):
            result = liveness_login.login(
                email='a@outlook.com', password='pwd', login_type='outlook',
                client_id='c', refresh_token='r', totp_secret='', proxy_url='',
            )
        self.assertEqual(result['accessToken'], 'eyJ.test_token')
        self.assertEqual(result['accountId'], 'acc_123')
        self.assertIn('+08:00', result['expiresAtIso'])  # CST conversion happened


if __name__ == '__main__':
    unittest.main()
```

### Step 2：跑测试确认失败

- [ ] **Step 2:** Run:

```bash
py -3 -m unittest tests.test_liveness_login
```

Expected: All 3 tests FAIL with `ModuleNotFoundError: No module named 'chatgpt_register.liveness_login'`.

### Step 3：创建 `chatgpt_register/liveness_login.py`

- [ ] **Step 3:** Create with this content:

```python
#!/usr/bin/env python3
"""Liveness re-login (protocol mode).

Pure password + OTP login — no register, no PKCE, no codex deeplink.
Only purpose: refresh access_token for /backend-api/accounts/check.

Input: JSON on stdin {email, password, login_type, client_id?,
                      refresh_token?, totp_secret?, proxy?}
Output: JSON-lines on stdout — streaming {"log":"..."} and final terminal:
   {"status":"ok",    "accessToken":"...", "accountId":"...", "expiresAtIso":"..."}
   {"status":"error", "reason":"<keyword matched by runner.js:99-117>"}

Reason strings MUST contain one of (matched case-insensitively by runner.js):
   bad password / no password / outlook oauth missing / otp timeout /
   otp fail / captcha / no session / proxy reset / unexpected:<...>
"""
import sys, json, time, uuid, random
from datetime import datetime, timedelta, timezone

# Redirect side-effect prints from chatgpt_register/* imports to stderr —
# JSON-lines stdout protocol cannot tolerate any stray text.
_orig_stdout = sys.stdout
sys.stdout = sys.stderr
try:
    from chatgpt_register.sentinel import get_sentinel_token
    from chatgpt_register.otp import fetch_imap_otp, get_imap_baseline, gen_totp
except Exception:
    def get_sentinel_token(*a, **k): return ""
    fetch_imap_otp = get_imap_baseline = gen_totp = None
finally:
    sys.stdout = _orig_stdout


_CHROME = [
    ("chrome146", 146), ("chrome142", 142), ("chrome136", 136),
    ("chrome133a", 133), ("chrome131", 131), ("chrome124", 124),
]


def _log(msg):
    print(json.dumps({"log": f"  [LivenessLogin] {msg}"}), flush=True)


def _emit(payload):
    print(json.dumps(payload), flush=True)


def _err(reason):
    _emit({"status": "error", "reason": str(reason)[:120]})


def _to_cst_iso(dt_str_or_obj):
    if not dt_str_or_obj:
        return ""
    if isinstance(dt_str_or_obj, str):
        try:
            d = datetime.fromisoformat(dt_str_or_obj.replace("Z", "+00:00"))
        except Exception:
            return ""
    else:
        d = dt_str_or_obj
    cst = d.astimezone(timezone(timedelta(hours=8)))
    return cst.isoformat()


def _build_session(proxy_url):
    """Mirror protocol_register.py session setup — Chrome JA3 + rotating impersonate."""
    from curl_cffi import requests as curl_requests
    if proxy_url and proxy_url.startswith('http://'):
        proxy_url = 'socks5h://' + proxy_url[len('http://'):]
    proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else None
    session = None
    impersonate_name = None
    for _ in range(5):
        impersonate_name, _major = random.choice(_CHROME)
        try:
            session = curl_requests.Session(impersonate=impersonate_name)
            if proxies:
                session.proxies = proxies
            break
        except Exception:
            session = None
    if not session:
        session = curl_requests.Session()
        if proxies:
            session.proxies = proxies
    _log(f"Profile: {impersonate_name}, proxy: {'on' if proxy_url else 'direct'}")
    return session, impersonate_name


def _parse_state_from_authorize_page(response):
    """Extract state CSRF from Auth0 authorize redirect URL or HTML form."""
    import re
    from urllib.parse import urlparse, parse_qs

    url = str(response.url)
    parsed = urlparse(url)
    qs = parse_qs(parsed.query)
    if 'state' in qs:
        return qs['state'][0], None
    body = response.text or ""
    m = re.search(r'name="state"\s+value="([^"]+)"', body)
    if m:
        return m.group(1), None
    return None, None


def login(email, password, login_type, client_id, refresh_token, totp_secret, proxy_url):
    """Returns {accessToken, accountId, expiresAtIso} or raises Exception
    whose str() contains a runner.js-matchable keyword."""
    AUTH = "https://auth.openai.com"
    BASE = "https://chatgpt.com"
    CODEX_CLIENT_ID = "pdlLIX2Y72MIl2rhLhTE9VV9bN9MD869"

    if not password:
        raise Exception("no password")
    if login_type == "outlook" and (not client_id or not refresh_token):
        raise Exception("outlook oauth missing")

    session, impersonate_name = _build_session(proxy_url)
    device_id = str(uuid.uuid4())
    session.cookies.set("oai-did", device_id, domain="chatgpt.com")
    session.cookies.set("oai-did", device_id, domain="auth.openai.com")
    session.cookies.set("oai-did", device_id, domain=".auth.openai.com")

    # IMAP baseline BEFORE submitting password (avoid race with old OTP email)
    imap_baseline = 0
    if login_type == "outlook" and fetch_imap_otp:
        try:
            imap_baseline = get_imap_baseline(email, client_id, refresh_token)
            _log(f"IMAP baseline: {imap_baseline}")
        except Exception as e:
            _log(f"IMAP baseline failed (will use 0): {str(e)[:50]}")

    # Step 1: GET authorize page → parse state
    auth_url = (
        f"{AUTH}/authorize?client_id={CODEX_CLIENT_ID}"
        "&scope=openid%20email%20profile%20offline_access%20model.request"
        "%20model.read%20organization.read%20organization.write"
        "&response_type=code"
        "&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fapi%2Fauth%2Fcallback%2Flogin-web"
    )
    _log("Step 1: GET authorize page")
    try:
        r = session.get(auth_url, headers={"Accept": "text/html"},
                       allow_redirects=True, timeout=30)
    except Exception as e:
        msg = str(e)
        if 'ECONNRESET' in msg or 'CONNECTION_RESET' in msg or 'reset' in msg.lower():
            raise Exception("proxy reset (login)")
        raise Exception(f"unexpected: navigation {msg[:40]}")

    state, _csrf = _parse_state_from_authorize_page(r)
    if not state:
        raise Exception("unexpected: no state in authorize page")

    # Step 2: submit username
    _log("Step 2: submit username")
    sentinel = get_sentinel_token(session, device_id, flow="login_identifier",
                                  user_agent=session.headers.get("User-Agent", ""))
    try:
        r = session.post(f"{AUTH}/u/login/identifier?state={state}",
                        data={"state": state, "username": email,
                              "js-available": "true", "webauthn-available": "true",
                              "is-brave": "false", "webauthn-platform-available": "false",
                              "action": "default"},
                        headers={"openai-sentinel-token": sentinel,
                                 "Content-Type": "application/x-www-form-urlencoded"},
                        allow_redirects=True, timeout=30)
    except Exception as e:
        if 'reset' in str(e).lower(): raise Exception("proxy reset (login)")
        raise Exception(f"unexpected: identifier {str(e)[:40]}")

    # Step 3: submit password
    _log("Step 3: submit password")
    sentinel = get_sentinel_token(session, device_id, flow="login_password",
                                  user_agent=session.headers.get("User-Agent", ""))
    try:
        r = session.post(f"{AUTH}/u/login/password?state={state}",
                        data={"state": state, "username": email, "password": password,
                              "action": "default"},
                        headers={"openai-sentinel-token": sentinel,
                                 "Content-Type": "application/x-www-form-urlencoded"},
                        allow_redirects=True, timeout=30)
    except Exception as e:
        if 'reset' in str(e).lower(): raise Exception("proxy reset (login)")
        raise Exception(f"unexpected: password {str(e)[:40]}")

    if 'error=invalid' in str(r.url) or 'invalid_user_password' in (r.text or ''):
        raise Exception("bad password")

    # Step 4: detect OTP requirement
    final_url = str(r.url)
    need_otp = ('/u/email-otp' in final_url or '/u/mfa-otp' in final_url
                or '/email-otp/challenge' in final_url)

    if need_otp:
        _log("Step 4: OTP required")
        try:
            if login_type == "outlook" and fetch_imap_otp:
                code = fetch_imap_otp(email, client_id, refresh_token, imap_baseline,
                                     timeout=90, log=_log)
                if not code:
                    raise Exception("otp timeout")
            elif login_type == "google" and totp_secret and gen_totp:
                code = gen_totp(totp_secret)
            else:
                raise Exception("otp fail: no method")
        except TimeoutError:
            raise Exception("otp timeout")
        except Exception as e:
            msg = str(e).lower()
            if 'otp' in msg:
                raise  # already-formatted otp error
            if 'timeout' in msg:
                raise Exception("otp timeout")
            raise Exception(f"otp fail: {str(e)[:40]}")

        # Step 5: submit OTP
        _log(f"Step 5: submit OTP (code={code[:2]}***)")
        sentinel = get_sentinel_token(session, device_id, flow="email_otp_validate",
                                      user_agent=session.headers.get("User-Agent", ""))
        try:
            r = session.post(f"{AUTH}/u/email-otp/challenge?state={state}",
                            data={"state": state, "code": code, "action": "default"},
                            headers={"openai-sentinel-token": sentinel,
                                     "Content-Type": "application/x-www-form-urlencoded"},
                            allow_redirects=True, timeout=30)
        except Exception as e:
            if 'reset' in str(e).lower(): raise Exception("proxy reset (login)")
            raise Exception(f"unexpected: otp submit {str(e)[:40]}")
        final_url = str(r.url)

        # OTP rejected by server (URL still on /u/email-otp/*)
        if '/u/email-otp' in final_url:
            raise Exception("otp fail: rejected by server")

    # Step 6: ensure landed on chatgpt.com callback
    if 'chatgpt.com' not in final_url:
        if '/u/login' in final_url or '/authorize' in final_url:
            raise Exception("captcha")
        raise Exception(f"unexpected: stuck at {final_url[:40]}")

    # Step 7: fetch /api/auth/session for accessToken
    _log("Step 7: fetch /api/auth/session")
    try:
        r = session.get(f"{BASE}/api/auth/session",
                       headers={"Accept": "application/json"}, timeout=15)
        session_data = r.json() if r.status_code == 200 else {}
    except Exception:
        session_data = {}

    access_token = session_data.get("accessToken") or ""
    if not access_token:
        raise Exception("no session after login")

    return {
        "accessToken": access_token,
        "accountId": (session_data.get("user") or {}).get("id", ""),
        "expiresAtIso": _to_cst_iso(session_data.get("expires", "")),
    }


def main():
    try:
        input_data = json.loads(sys.stdin.read())
    except Exception as e:
        _err(f"unexpected: bad stdin {str(e)[:40]}")
        return

    email = input_data.get("email", "")
    password = input_data.get("password", "")
    login_type = input_data.get("login_type", "")
    client_id = input_data.get("client_id", "")
    refresh_token = input_data.get("refresh_token", "")
    totp_secret = input_data.get("totp_secret", "")
    proxy_url = input_data.get("proxy", "")

    try:
        result = login(email, password, login_type, client_id, refresh_token,
                      totp_secret, proxy_url)
        _emit({"status": "ok", **result})
    except Exception as e:
        _err(str(e))


if __name__ == "__main__":
    main()
```

### Step 4：跑测试确认通过

- [ ] **Step 4:** Run:

```bash
py -3 -m unittest tests.test_liveness_login
```

Expected: 3/3 PASS.

### Step 5：跑既有 Python 测试无回归

- [ ] **Step 5:**

```bash
py -3 -m unittest tests.test_protocol_register_h1_fallback tests.test_liveness_login
```

Expected: 7/7 PASS (4 existing + 3 new).

### Step 6：Commit

- [ ] **Step 6:**

```bash
git add chatgpt_register/liveness_login.py tests/test_liveness_login.py
git commit -m "$(cat <<'EOF'
feat(liveness): 协议模式登录脚本 chatgpt_register/liveness_login.py

新建脚本 ~260 行：纯密码 + OTP 登录流程（无 register / PKCE）
- Step 1 GET /authorize → 解析 state CSRF
- Step 2-3 POST identifier + password（含 sentinel token + bad password 检测）
- Step 4-5 OTP（IMAP for Outlook / TOTP for Gmail）→ POST email-otp/challenge
- Step 6 检测 chatgpt.com callback（captcha / otp rejected 区分）
- Step 7 GET /api/auth/session 拿 accessToken

错误契约对齐 runner.js:99-117 9 类 keyword（bad password / otp timeout /
captcha / proxy reset / no session / unexpected:...）。

JSON-lines stdio 协议同 protocol_register.py。chatgpt_register/* 顶部 print
重定向到 stderr 防污染 stdout。

3 Y unittest（Y1 no password / Y2 bad password / Y3 happy path 三字段）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3：Node 端 spawn 胶水 + JS 单测（TDD P1-P5）

**Files:**
- Modify: `server/liveness/light-login.js`
- Create: `server/liveness/__tests__/light-login.test.js`

### Step 1：写失败测试 `server/liveness/__tests__/light-login.test.js`

- [ ] **Step 1:** Create with this content:

```js
// Tests for protocolLightLogin spawn glue in light-login.js.
// Mocks child_process.spawn to verify Node-side behavior without launching Python.

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const Module = require('module');

// Per-test mock for child_process.spawn injected via Module._cache override
let mockSpawn = null;
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'child_process') {
    return { spawn: mockSpawn || origRequire.call(this, 'child_process').spawn };
  }
  return origRequire.apply(this, arguments);
};

// Load light-login fresh so it picks up our mocked require
delete require.cache[require.resolve('../light-login')];
const { lightLogin, protocolLightLogin, LivenessLoginNotImplementedError } = require('../light-login');

// Restore real require for other tests after this file runs
process.on('exit', () => { Module.prototype.require = origRequire; });

function fakeChild({ stdoutTerminal = null, stderr = '', spawnError = null }) {
  const cp = new EventEmitter();
  cp.stdout = new EventEmitter();
  cp.stderr = new EventEmitter();
  cp.kill = () => {};
  cp.stdin = {
    write: () => {},
    end: () => {
      if (spawnError) {
        setImmediate(() => cp.emit('error', spawnError));
        return;
      }
      setImmediate(() => {
        if (stdoutTerminal) cp.stdout.emit('data', Buffer.from(stdoutTerminal + '\n'));
        if (stderr) cp.stderr.emit('data', Buffer.from(stderr));
        cp.emit('close', 0);
      });
    },
  };
  return cp;
}

test('P1 protocolMode=true + no password → throws "no password" without spawn', async () => {
  let spawned = false;
  mockSpawn = () => { spawned = true; return fakeChild({}); };
  await assert.rejects(
    () => lightLogin({ email: 'a@x.com', login_type: 'outlook' }, { protocolMode: true }),
    /no password/,
  );
  assert.strictEqual(spawned, false, 'spawn must NOT be called when pre-flight fails');
});

test('P2 outlook account missing client_id → throws "outlook oauth missing"', async () => {
  let spawned = false;
  mockSpawn = () => { spawned = true; return fakeChild({}); };
  await assert.rejects(
    () => lightLogin(
      { email: 'a@outlook.com', password: 'pwd', login_type: 'outlook' },
      { protocolMode: true },
    ),
    /outlook oauth missing/,
  );
  assert.strictEqual(spawned, false);
});

test('P3 spawn returns status:ok → resolves with {accessToken,accountId,expiresAtIso}', async () => {
  mockSpawn = () => fakeChild({
    stdoutTerminal: JSON.stringify({
      status: 'ok',
      accessToken: 'eyJ.test',
      accountId: 'acc_123',
      expiresAtIso: '2026-08-22T12:00:00+08:00',
    }),
  });
  const result = await lightLogin(
    { email: 'a@x.com', password: 'pwd', login_type: 'google', totp_secret: 'JBSW' },
    { protocolMode: true },
  );
  assert.strictEqual(result.accessToken, 'eyJ.test');
  assert.strictEqual(result.accountId, 'acc_123');
  assert.strictEqual(result.expiresAtIso, '2026-08-22T12:00:00+08:00');
});

test('P4 spawn returns status:error reason:"bad password" → rejects with Error.message containing "bad password"', async () => {
  mockSpawn = () => fakeChild({
    stdoutTerminal: JSON.stringify({ status: 'error', reason: 'bad password' }),
  });
  await assert.rejects(
    () => lightLogin(
      { email: 'a@x.com', password: 'wrong', login_type: 'google', totp_secret: 'JBSW' },
      { protocolMode: true },
    ),
    /bad password/,
  );
});

test('P5 spawn error event (ENOENT) → rejects with LivenessLoginNotImplementedError', async () => {
  const enoent = new Error('spawn py ENOENT');
  enoent.code = 'ENOENT';
  mockSpawn = () => fakeChild({ spawnError: enoent });
  try {
    await lightLogin(
      { email: 'a@x.com', password: 'pwd', login_type: 'google', totp_secret: 'JBSW' },
      { protocolMode: true },
    );
    assert.fail('expected rejection');
  } catch (e) {
    assert.strictEqual(e.name, 'LivenessLoginNotImplementedError');
  }
});
```

### Step 2：跑测试确认失败

- [ ] **Step 2:** Run:

```bash
node --test server/liveness/__tests__/light-login.test.js
```

Expected: 5 FAIL (P3/P4/P5 fail because `protocolLightLogin` not exported; P1/P2 fail because protocolMode still throws stub).

### Step 3：修改 `server/liveness/light-login.js`

- [ ] **Step 3:** Open `server/liveness/light-login.js`. Replace the entire file content with:

```js
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

const { spawn } = require('child_process');
const path = require('path');

const PROTOCOL_SCRIPT = path.join(__dirname, '..', '..', 'chatgpt_register', 'liveness_login.py');
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
  const { protocolMode, playwrightConnect, getOtp, signal, proxyUrl } = opts;

  if (protocolMode) {
    return await protocolLightLogin(account, { signal, proxyUrl });
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

async function protocolLightLogin(account, { signal, proxyUrl } = {}) {
  // Pre-flight contract checks — match the browser path's early validation
  // so callers see the same error keywords regardless of mode.
  if (!account?.password) throw new Error('no password');
  if (account.login_type === 'outlook' && (!account.client_id || !account.refresh_token)) {
    throw new Error('outlook oauth missing');
  }

  const input = JSON.stringify({
    email: account.email,
    password: account.password,
    login_type: account.login_type || '',
    client_id: account.client_id || '',
    refresh_token: account.refresh_token || '',
    totp_secret: account.totp_secret || '',
    proxy: proxyUrl || '',
  });

  return new Promise((resolve, reject) => {
    let py;
    try {
      py = spawn('py', ['-3', PROTOCOL_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
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
          // Non-JSON line — keep last one as fallback for error reporting
          stdout = trimmed;
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
        return finish(new Error(`unexpected: no terminal (exit ${code}) ${stderr.slice(-80)}`));
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
```

### Step 4：跑测试确认通过

- [ ] **Step 4:**

```bash
node --test server/liveness/__tests__/light-login.test.js
```

Expected: 5/5 PASS.

### Step 5：跑全量 JS 测试无回归

- [ ] **Step 5:**

```bash
node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
```

Expected: ALL PASS（既有 197 + 5 新 = 202 个）。

### Step 6：Commit

- [ ] **Step 6:**

```bash
git add server/liveness/light-login.js server/liveness/__tests__/light-login.test.js
git commit -m "$(cat <<'EOF'
feat(liveness): light-login.js 加 protocolLightLogin spawn 胶水

light-login.js 入口 protocolMode 分支不再抛 LivenessLoginNotImplementedError，
改 await protocolLightLogin(account, { signal, proxyUrl }) — spawn
chatgpt_register/liveness_login.py 子进程，stdin JSON 输入，stdout JSON-lines
输出，120s timeout + abortSignal 双兜底。

- spawn ENOENT / 二进制缺失 → reject LivenessLoginNotImplementedError
  （runner.js:99 兜底链路保留兼容）
- 正常 status:error reason → reject new Error(reason)，runner.js 9 类
  keyword 自动映射 alive_status
- 浏览器路径完全不变；module.exports 加 protocolLightLogin 供单测

5 P 单测：P1 no password / P2 outlook oauth missing / P3 happy path /
P4 bad password 映射 / P5 spawn ENOENT 映射 LivenessLoginNotImplementedError。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4：runner.js 加 proxyUrl 参数（1 行）

**Files:**
- Modify: `server/liveness/runner.js:87-90`

### Step 1：修改 runner.js lightLogin 调用

- [ ] **Step 1:** Open `server/liveness/runner.js`. Find lines 87-90:

```js
          const fresh = await lightLogin(account, {
            protocolMode: config.protocolMode,
            signal: abortSignal,
          });
```

Replace with (add `proxyUrl` line):

```js
          const fresh = await lightLogin(account, {
            protocolMode: config.protocolMode,
            proxyUrl: getProxy().getProxyUrl(),
            signal: abortSignal,
          });
```

NOTE: `getProxy()` is the existing helper in runner.js (line 26: `if (proxyMgr) return proxyMgr;` with lazy fallback). It returns the proxyMgr instance; `.getProxyUrl()` returns the main proxy URL like `http://127.0.0.1:7890` or `''` when proxy disabled.

### Step 2：跑全量 JS 测试无回归

- [ ] **Step 2:**

```bash
node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
```

Expected: ALL PASS (202 tests, no regression — runner tests don't exercise the new proxyUrl arg).

### Step 3：Commit

- [ ] **Step 3:**

```bash
git add server/liveness/runner.js
git commit -m "$(cat <<'EOF'
feat(liveness/runner): 给 lightLogin 调用传入 proxyUrl

为协议模式 lightLogin 提供主代理 URL，让 spawn 出的 liveness_login.py
子进程能走代理（而不是直连 OpenAI auth endpoint，会被风控）。

仅 1 行改动；getProxy() 是已有 lazy fallback helper（line 22-27）。
浏览器路径的 lightLogin 忽略 proxyUrl 字段（已有 Playwright 上下文）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5：依赖说明文档（CLAUDE.md + start.bat）

**Files:**
- Modify: `CLAUDE.md`
- Modify: `start.bat`

### Step 1：CLAUDE.md 加 pyotp 依赖说明

- [ ] **Step 1:** Open `CLAUDE.md`. Find the line:

```bash
pip install curl_cffi
```

Replace with:

```bash
pip install curl_cffi pyotp
```

Then find the section block that contains this pip command (look for surrounding `# Python 依赖（仅协议模式需要）` heading). After the `pip install` line, INSERT this clarification block:

```

# pyotp 仅 v2.29+ 协议模式 liveness lightLogin 用（Gmail TOTP 账号）。
# Outlook-only 部署可不装；缺失时 Gmail 账号测活会标 alive_reason='otp fail'。
```

### Step 2：start.bat 加 pyotp smoke 提示

- [ ] **Step 2:** Open `start.bat`. Find the existing `py -3 -c "import curl_cffi"` smoke check block (检查 curl_cffi 是否已装). After it, insert a parallel block for pyotp:

```batch
py -3 -c "import pyotp" >nul 2>&1
if errorlevel 1 (
    echo [WARN] pyotp not installed — Gmail accounts cannot do protocol-mode liveness re-login
    echo        Run: pip install pyotp
    echo        Outlook-only deployments can skip this.
)
```

This is a non-blocking warning — start.bat continues even if pyotp missing (Outlook users don't need it).

### Step 3：Commit

- [ ] **Step 3:**

```bash
git add CLAUDE.md start.bat
git commit -m "$(cat <<'EOF'
docs: v2.29 加 pyotp 依赖说明 + start.bat smoke 提示

CLAUDE.md 常用命令段：pip install curl_cffi → curl_cffi pyotp。
新增注释说明 pyotp 仅 v2.29 协议模式 Gmail liveness 用；
Outlook-only 部署可不装。

start.bat 加 pyotp 检测，缺失时打 [WARN] 不阻塞启动。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6：CHANGELOG v2.29 + 全量测试 + 人工验证

**Files:**
- Modify: `docs/CHANGELOG.md`

### Step 1：插入 v2.29 节

- [ ] **Step 1:** Open `docs/CHANGELOG.md`. Insert immediately after `# Changelog` heading (line 1), before the existing first version section:

```markdown

## v2.29.0 — 2026-05-25

### Liveness Protocol-Mode lightLogin（v2.26 Phase B 收尾）

关闭 v2.26 Phase B 待办：协议模式下，无 `cpa-auth/codex-{email}.json`
缓存的账号测活时 `!tok` 触发 `lightLogin` → 当时抛 stub →
runner 标 `alive_status='login_fail', reason='liveness not yet
supported in protocol mode'`，看起来像账号死了实际是机制缺失。

**核心改动：**

- **`chatgpt_register/liveness_login.py`** —— 新建协议模式纯登录脚本
  （~260 行）：username → password → OTP → session 7 步走 curl_cffi +
  sentinel，与 `protocol_register.py` 解耦但共享底层。
- **`chatgpt_register/otp.py`** —— 从 `protocol_register.py` 抽出
  `fetch_imap_otp` / `get_imap_baseline`（函数体逐字复制，加 `log=`
  callback 解耦）+ 新增 `gen_totp(secret)`（pyotp lazy import）。
- **`server/liveness/light-login.js`** —— `protocolMode=true` 分支
  spawn `chatgpt_register/liveness_login.py`，120s timeout + abortSignal
  双兜底；spawn ENOENT 仍 reject `LivenessLoginNotImplementedError`
  保留 runner.js:99 兜底兼容。
- **`server/liveness/runner.js`** —— 1 行改动：`lightLogin(...)` 调用
  加 `proxyUrl: getProxy().getProxyUrl()`，让子进程走代理。
- **错误契约**：Python `reason` 字符串包含 runner.js:99-117 的 9 类
  keyword 之一（bad password / outlook oauth missing / otp timeout /
  captcha / proxy reset / no session / unexpected / ...）；runner 错误
  映射零改动。

**对外契约不变**：`lightLogin(account, opts)` 返回 shape
`{accessToken, accountId, expiresAtIso}` 双模式一致；`LivenessLoginNotImplementedError`
类保留为 spawn 失败兜底。

**单测**：`tests/test_liveness_login.py` 新建 3 Y unittest（Y1 no
password / Y2 bad password / Y3 happy path 三字段）+
`server/liveness/__tests__/light-login.test.js` 新建 5 P 单测（P1-P5
Node 端 spawn 胶水）。共新增 8 用例。

**新依赖**：`pyotp`（仅 Gmail 协议模式 liveness 需要；Outlook 不影响）。
CLAUDE.md / start.bat 已更新说明，缺失时 start.bat WARN 不阻塞。

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-liveness-protocol-lightlogin-design.md`
+ `docs/superpowers/plans/2026-05-25-liveness-protocol-lightlogin.md`。

```

### Step 2：跑全量测试（JS + Python）

- [ ] **Step 2:**

```bash
node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
py -3 -m unittest tests.test_protocol_register_h1_fallback tests.test_liveness_login
```

Expected:
- JS: 202/202 PASS (197 baseline + 5 new P tests)
- Python: 7/7 PASS (4 existing + 3 new Y tests)
- Total: 209/209

### Step 3：人工验证清单（12 项）

- [ ] **Step 3:** 启动服务，按 spec §测试策略人工验证清单逐条跑：
  - [ ] `pip install pyotp` 后服务能起；缺 pyotp 时 Outlook 账号正常
  - [ ] 基础 Outlook 测活：无 codex 文件的账号（如 fzrbq8112）→ 真实 alive_status
  - [ ] 基础 Gmail 测活：TOTP 账号无 codex 文件 → 测活成功
  - [ ] bad password：临时改密码 → `alive_reason='bad password'`
  - [ ] outlook oauth missing：清掉 client_id → `alive_reason='outlook oauth missing'`
  - [ ] OTP timeout：断 IMAP → 90s 后 `alive_reason='otp timeout'`
  - [ ] proxy reset：关 sing-box → `alive_reason='proxy reset (login)'`
  - [ ] 120s 超时：iptables drop auth.openai.com → 130s 后 `network_error` + runner 重试
  - [ ] runner abort：测活中点停止 → 子进程被 kill
  - [ ] pyotp 缺失：临时 uninstall → Outlook 正常，Gmail `otp fail: no method`
  - [ ] Python 脚本路径缺失：改 `PROTOCOL_SCRIPT` 路径错 → reject `LivenessLoginNotImplementedError`
  - [ ] codex 文件写入：成功后看 `cpa-auth/codex-{email}.json` 含 access_token 三字段

### Step 4：Commit

- [ ] **Step 4:**

```bash
git add docs/CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs: v2.29.0 liveness protocol-mode lightLogin

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 全套测试一遍（实施完成后最终冒烟）

- [ ] 6 任务完成后：

```bash
node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
py -3 -m unittest tests.test_protocol_register_h1_fallback tests.test_liveness_login
```

Expected: 202/202 JS + 7/7 Python = **209/209 PASS**

- [ ] 人工 12 项验证清单跑完
