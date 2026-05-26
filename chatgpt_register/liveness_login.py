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
import sys, json, uuid, random
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

# OpenAI Codex client_id — also referenced in protocol_register.py and
# server/liveness/light-login.js (browser path). If OpenAI rotates this, all
# three must update together.
_CODEX_CLIENT_ID = "pdlLIX2Y72MIl2rhLhTE9VV9bN9MD869"
_AUTH = "https://auth.openai.com"
_BASE = "https://chatgpt.com"


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
    """Mirror protocol_register.py session setup — Chrome JA3 + rotating impersonate.

    Note: protocol_register.py explicitly sets User-Agent, Accept-Language and
    sec-ch-ua headers after Session() because it builds a full sec-ch-ua string
    per profile.  _build_session doesn't carry that per-profile metadata, so we
    rely on curl_cffi impersonate= injecting the UA implicitly.  If a caller
    needs the exact UA string it can read session.headers.get("User-Agent", "").
    """
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


def login(email, password, login_type, client_id, refresh_token, totp_secret, proxy_url):
    """新 SPA OAuth flow:
    1. GET /authorize → 拿 cookies (oai-did, __cf_bm 等)
    2. POST /api/accounts/authorize/continue → 触发 OTP 邮件
    3. IMAP 拉 OTP
    4. POST /api/accounts/email-otp/validate → 拿 chatgpt.com session cookies
    5. GET chatgpt.com/api/auth/session → 拿 access_token + user.id
    """
    if not password and login_type != "outlook":
        raise Exception("no password")  # gmail 走旧 flow（暂不支持），出错
    if login_type == "outlook" and (not client_id or not refresh_token):
        raise Exception("outlook oauth missing")

    session, impersonate_name = _build_session(proxy_url)
    device_id = str(uuid.uuid4())
    session.cookies.set("oai-did", device_id, domain="chatgpt.com")
    session.cookies.set("oai-did", device_id, domain="auth.openai.com")
    session.cookies.set("oai-did", device_id, domain=".auth.openai.com")

    # Step 1: GET /authorize → SPA shell（无需 parse HTML，只为拿 Cloudflare cookies）
    auth_url = (
        f"{_AUTH}/authorize?client_id={_CODEX_CLIENT_ID}"
        "&scope=openid%20email%20profile%20offline_access%20model.request"
        "%20model.read%20organization.read%20organization.write"
        "&response_type=code"
        "&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fapi%2Fauth%2Fcallback%2Flogin-web"
    )
    _log("Step 1: GET /authorize (拿 cookies)")
    try:
        r = session.get(auth_url, headers={"Accept": "text/html"},
                       allow_redirects=True, timeout=30)
    except Exception as e:
        msg = str(e)
        if 'ECONNRESET' in msg or 'CONNECTION_RESET' in msg or 'reset' in msg.lower():
            raise Exception("proxy reset (login)")
        raise Exception(f"unexpected: GET /authorize {msg[:40]}")

    if r.status_code >= 500:
        raise Exception(f"proxy reset (login): HTTP {r.status_code}")
    if r.status_code in (403, 429):
        _body_lower = (r.text or "").lower()
        if any(kw in _body_lower for kw in ('cloudflare', 'just a moment', 'challenge-platform', 'cf-mitigated', 'attention required')):
            raise Exception(f"proxy reset (login): Cloudflare HTTP {r.status_code}")
    _log(f"Step 1 OK: status={r.status_code} cookies={len(session.cookies)}")

    raise Exception("not_implemented: step 2-5 待 Task 2-5")


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
