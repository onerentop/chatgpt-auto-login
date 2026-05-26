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
import sys, json, uuid, random, os
from datetime import datetime, timedelta, timezone

# 让 chatgpt_register 包能被找到 —— 直接 spawn `py -3 chatgpt_register/liveness_login.py`
# 时 sys.path[0] 是脚本所在目录 chatgpt_register/，导致下面 `from chatgpt_register.*`
# 抛 ModuleNotFoundError 被静默吞，fetch_imap_otp 落成 None，step 3 误报 deps missing。
_PROJ_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJ_ROOT not in sys.path:
    sys.path.insert(0, _PROJ_ROOT)

# Redirect side-effect prints from chatgpt_register/* imports to stderr —
# JSON-lines stdout protocol cannot tolerate any stray text.
_orig_stdout = sys.stdout
sys.stdout = sys.stderr
try:
    from chatgpt_register.sentinel import get_sentinel_token
    from chatgpt_register.otp import fetch_imap_otp, get_imap_baseline, gen_totp
except Exception as _import_err:
    # 不再静默 swallow —— 把错误信息记下来便于诊断（但 stdout 仍走 stderr 避免污染
    # JSON-lines protocol）。如果 fetch_imap_otp/get_imap_baseline 仍可能为 None
    # （比如 pyotp 没装），保留 None 兜底；但顶层 sys.path 修复后正常 import 不该走到这里。
    print(f"[liveness_login.py import fallback] {_import_err}", file=sys.stderr)
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

    # Step 1: 走 chatgpt.com next-auth signin 流程拿 oai-client-auth-session cookie。
    #   实测发现 chatgpt.com /auth/login_with 是纯 SPA shell（不会服务端 302），
    #   reconnaissance 描述的"chatgpt.com → auth.openai.com 跳转"实际由 React app
    #   client-side 触发 next-auth signIn() —— 即 POST /api/auth/signin/openai。
    #   protocol 模式直访 auth.openai.com/authorize 会跳过 chatgpt.com 这段，
    #   拿不到 server set 的 oai-client-auth-session cookie → POST authorize/continue
    #   返回 409 invalid_state。
    #
    #   正确链路（实测）:
    #   A. GET  chatgpt.com/api/auth/csrf            → __Host-next-auth.csrf-token
    #   B. POST chatgpt.com/api/auth/signin/openai   → {url: auth.openai.com/api/accounts/authorize?...}
    #                                                 （server 生成 client_id + state，
    #                                                  set __Secure-next-auth.state）
    #   C. GET  auth.openai.com/api/accounts/authorize?... → 302 → auth.openai.com/log-in
    #                                                 （set oai-client-auth-session 等）
    _log("Step 1A: GET chatgpt.com/api/auth/csrf")
    try:
        r_csrf = session.get(f"{_BASE}/api/auth/csrf",
                            headers={"Accept": "application/json"}, timeout=30)
    except Exception as e:
        msg = str(e)
        if 'ECONNRESET' in msg or 'CONNECTION_RESET' in msg or 'reset' in msg.lower():
            raise Exception("proxy reset (login)")
        raise Exception(f"unexpected: GET csrf {msg[:40]}")
    if r_csrf.status_code >= 500:
        raise Exception(f"proxy reset (login): HTTP {r_csrf.status_code}")
    if r_csrf.status_code in (403, 429):
        _body_lower = (r_csrf.text or "").lower()
        if any(kw in _body_lower for kw in ('cloudflare', 'just a moment', 'challenge-platform', 'cf-mitigated', 'attention required')):
            raise Exception(f"proxy reset (login): Cloudflare HTTP {r_csrf.status_code}")
        raise Exception(f"unexpected: csrf HTTP {r_csrf.status_code}")
    try:
        csrf_token = r_csrf.json().get("csrfToken")
    except Exception:
        raise Exception(f"unexpected: csrf body not json (HTTP {r_csrf.status_code})")
    if not csrf_token:
        raise Exception("unexpected: csrf missing csrfToken")

    _log("Step 1B: POST chatgpt.com/api/auth/signin/openai")
    import urllib.parse as _urlparse
    signin_form = _urlparse.urlencode({
        "callbackUrl": f"{_BASE}/",
        "csrfToken": csrf_token,
        "json": "true",
        "prompt": "login",
        "screen_hint": "login",
    })
    try:
        r_signin = session.post(
            f"{_BASE}/api/auth/signin/openai",
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "*/*",
                "Origin": _BASE,
                "Referer": f"{_BASE}/auth/login_with?callback_path=/",
            },
            data=signin_form, allow_redirects=False, timeout=30,
        )
    except Exception as e:
        msg = str(e)
        if 'ECONNRESET' in msg or 'reset' in msg.lower():
            raise Exception("proxy reset (login)")
        raise Exception(f"unexpected: signin/openai {msg[:40]}")
    if r_signin.status_code >= 500:
        raise Exception(f"proxy reset (login): HTTP {r_signin.status_code}")
    if r_signin.status_code in (403, 429):
        raise Exception(f"proxy reset (login): HTTP {r_signin.status_code}")
    try:
        authorize_url = r_signin.json().get("url")
    except Exception:
        raise Exception(f"unexpected: signin body not json (HTTP {r_signin.status_code})")
    if not authorize_url or "auth.openai.com" not in authorize_url:
        raise Exception(f"unexpected: signin url invalid={str(authorize_url)[:80]}")

    _log("Step 1C: GET auth.openai.com/api/accounts/authorize → 302 log-in")
    try:
        r_auth = session.get(authorize_url, headers={"Accept": "text/html"},
                            allow_redirects=True, timeout=30)
    except Exception as e:
        msg = str(e)
        if 'ECONNRESET' in msg or 'CONNECTION_RESET' in msg or 'reset' in msg.lower():
            raise Exception("proxy reset (login)")
        raise Exception(f"unexpected: GET authorize {msg[:40]}")
    if r_auth.status_code >= 500:
        raise Exception(f"proxy reset (login): HTTP {r_auth.status_code}")
    if r_auth.status_code in (403, 429):
        _body_lower = (r_auth.text or "").lower()
        if any(kw in _body_lower for kw in ('cloudflare', 'just a moment', 'challenge-platform', 'cf-mitigated', 'attention required')):
            raise Exception(f"proxy reset (login): Cloudflare HTTP {r_auth.status_code}")

    # 校验拿到了关键 session cookie
    # curl_cffi 的 session.cookies 直接迭代返回 cookie name 字符串
    cookie_names = list(session.cookies)
    if 'oai-client-auth-session' not in cookie_names:
        raise Exception(f"unexpected: oai-client-auth-session cookie missing (HTTP {r_auth.status_code}, cookies={cookie_names[:10]})")
    _log(f"Step 1 OK: status={r_auth.status_code} cookies={len(session.cookies)} final_url={str(r_auth.url)[:80]}")

    # Step 2: POST /api/accounts/authorize/continue → 触发 OTP 邮件
    _log("Step 2: POST authorize/continue")
    try:
        r2 = session.post(
            f"{_AUTH}/api/accounts/authorize/continue",
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Origin": _AUTH,
                "Referer": f"{_AUTH}/log-in",
            },
            json={"username": {"kind": "email", "value": email}},
            timeout=30,
        )
    except Exception as e:
        msg = str(e)
        if 'ECONNRESET' in msg or 'reset' in msg.lower():
            raise Exception("proxy reset (login)")
        raise Exception(f"unexpected: authorize/continue {msg[:40]}")

    if r2.status_code in (403, 429):
        raise Exception(f"proxy reset (login): HTTP {r2.status_code}")
    if r2.status_code >= 500:
        raise Exception(f"proxy reset (login): HTTP {r2.status_code}")
    try:
        j2 = r2.json()
    except Exception:
        raise Exception(f"unexpected: authorize/continue body not json (HTTP {r2.status_code})")

    if r2.status_code >= 400:
        err = (j2.get("error") or {}).get("code") or "unknown"
        if err == "unknown_user" or err == "invalid_email":
            raise Exception(f"login_fail: authorize/continue {err}")
        raise Exception(f"login_fail: authorize/continue HTTP {r2.status_code} code={err}")

    page_type = (j2.get("page") or {}).get("type")
    if page_type != "email_otp_verification":
        raise Exception(f"login_fail: unexpected page.type={page_type}")
    _log(f"Step 2 OK: page.type={page_type}")

    # Step 3: IMAP 取 OTP（Outlook 路径；Gmail TOTP 不在本 flow 范围）
    if login_type != "outlook":
        raise Exception(f"login_fail: SPA OAuth 仅支持 outlook，login_type={login_type}")
    if not fetch_imap_otp:
        raise Exception("login_fail: pyotp/imap deps missing")
    _log("Step 3: IMAP poll OTP")
    try:
        baseline = get_imap_baseline(email, client_id, refresh_token)
    except Exception as e:
        baseline = 0
        _log(f"IMAP baseline failed (use 0): {str(e)[:50]}")
    # 给 OpenAI 邮件队列 5 秒缓冲再开始 poll，避免拿到过期 baseline 邮件
    import time as _t; _t.sleep(5)
    otp = fetch_imap_otp(email, client_id, refresh_token, baseline_uid=baseline, timeout=90,
                        log=lambda m: _log(f"IMAP: {m}"))
    if not otp:
        raise Exception("otp timeout")
    _log(f"Step 3 OK: OTP={otp[:2]}****")

    # Step 4: POST /api/accounts/email-otp/validate → 拿 chatgpt.com session cookies
    _log("Step 4: POST email-otp/validate")
    try:
        r4 = session.post(
            f"{_AUTH}/api/accounts/email-otp/validate",
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Origin": _AUTH,
                "Referer": f"{_AUTH}/email-verification",
            },
            json={"code": otp},
            allow_redirects=True,
            timeout=30,
        )
    except Exception as e:
        msg = str(e)
        if 'reset' in msg.lower():
            raise Exception("proxy reset (login)")
        raise Exception(f"unexpected: email-otp/validate {msg[:40]}")

    if r4.status_code in (403, 429) and r4.status_code != 403:
        raise Exception(f"proxy reset (login): HTTP {r4.status_code}")
    if r4.status_code >= 500:
        raise Exception(f"proxy reset (login): HTTP {r4.status_code}")

    if r4.status_code >= 400:
        try:
            j4 = r4.json()
            err = (j4.get("error") or {}).get("code") or "unknown"
        except Exception:
            err = "parse_error"
        if err == "account_deactivated":
            raise Exception("deactivated: account_deactivated")
        if err == "invalid_code":
            raise Exception("login_fail: invalid_code")
        if err == "rate_limited":
            raise Exception(f"proxy reset (login): rate_limited")
        raise Exception(f"login_fail: email-otp/validate code={err}")
    _log(f"Step 4 OK: HTTP {r4.status_code} cookies={len(session.cookies)}")

    # Step 5: GET chatgpt.com/api/auth/session → 拿 access_token
    _log("Step 5: GET chatgpt.com/api/auth/session")
    try:
        r5 = session.get(f"{_BASE}/api/auth/session",
                        headers={"Accept": "application/json"}, timeout=30)
    except Exception as e:
        raise Exception(f"unexpected: /api/auth/session {str(e)[:40]}")
    if r5.status_code != 200:
        raise Exception(f"no session after login: HTTP {r5.status_code}")
    try:
        sj = r5.json()
    except Exception:
        raise Exception("no session after login: body not json")
    access_token = sj.get("accessToken")
    if not access_token:
        raise Exception("no session after login: missing accessToken")
    account_id = (sj.get("user") or {}).get("id", "")
    expires = sj.get("expires") or ""
    _log(f"Step 5 OK: account_id={account_id}, expires={expires}")

    return {
        "accessToken": access_token,
        "accountId": account_id,
        "expiresAtIso": _to_cst_iso(expires),
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
