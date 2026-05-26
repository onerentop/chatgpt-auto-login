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
        f"{_AUTH}/authorize?client_id={_CODEX_CLIENT_ID}"
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

    # v2.41.4: HTTP 5xx 或 body 空 / 过短 → connection 被服务端 close（OpenAI/Cloudflare 限速）
    #   不归到"no state"误报；HTTP 200 + body 完整但 state 缺失才算 page 结构变
    if r.status_code >= 500:
        raise Exception(f"proxy reset (login): HTTP {r.status_code}")
    body_len = len(r.text or "")
    if body_len < 500:
        raise Exception(f"proxy reset (login): HTTP {r.status_code} body_len={body_len}")
    # v2.41.11: HTTP 403/429 + Cloudflare challenge body 关键词 → proxy_error
    #   实测 /authorize 拿到 HTTP 403 + body ~6966 字节 (Cloudflare 'Just a moment')，
    #   v2.41.4 只检 >=500，403 漏了 → 走到 _parse_state 拿不到 state → 归 network_error 重试 3 次浪费。
    if r.status_code in (403, 429):
        _body_lower = (r.text or "").lower()
        if any(kw in _body_lower for kw in ('cloudflare', 'just a moment', 'challenge-platform', 'cf-mitigated', 'attention required')):
            raise Exception(f"proxy reset (login): Cloudflare HTTP {r.status_code}")
        # 非 Cloudflare 的 403/429 继续走 fallback，归 network_error 等
    # v2.41.9 / v2.41.10: 按 final_path 分类（state 缺失时）
    from urllib.parse import urlparse as _urlparse_lv
    _final_path = _urlparse_lv(str(r.url)).path

    # v2.41.9: OpenAI OAuth /error 页（账号问题，非 deactivated 但 OAuth flow 错）→ 直接 login_fail，不要 retry
    if _final_path == '/error' or _final_path.endswith('/error'):
        raise Exception(f"login_fail: OAuth /error redirect (url={str(r.url)[:80]})")

    state, _csrf = _parse_state_from_authorize_page(r)
    if not state:
        # v2.41.10: state 拿不到时按 path 细分。实测 liabhzo717818 出现：
        # OpenAI OAuth flow 跳到 /email-verification 或 /api/accounts/authorize，
        # 都拿不到 state — 语义是"账号已部分认证，需要 OTP reverify"，
        # 归 token_expired 而非 network_error（后者会触发 3 次无意义 retry）。
        if _final_path.startswith('/email-verification'):
            # OpenAI 当账号已部分认证，跳过 login form 让 OTP reverify
            raise Exception(f"token_expired: OAuth jumped to /email-verification (needs OTP reverify, url={str(r.url)[:80]})")
        if _final_path.startswith('/api/accounts/'):
            # 中间 redirect 失败（应该 302 到 /log-in 但停在 /api/accounts/*）
            raise Exception(f"token_expired: OAuth stuck at {_final_path} (needs reverify, url={str(r.url)[:80]})")
        # 真未知 path 或 page 结构变化 → fallback network_error retry
        raise Exception(f"unexpected: authorize page structure changed (HTTP {r.status_code}, body_len={body_len}, path={_final_path})")

    # Step 2: submit username
    _log("Step 2: submit username")
    sentinel = get_sentinel_token(session, device_id, flow="authorize_continue",
                                  user_agent=session.headers.get("User-Agent", "")) or ""
    try:
        r = session.post(f"{_AUTH}/u/login/identifier?state={state}",
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
    sentinel = get_sentinel_token(session, device_id, flow="authorize_continue",
                                  user_agent=session.headers.get("User-Agent", "")) or ""
    try:
        r = session.post(f"{_AUTH}/u/login/password?state={state}",
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
                                      user_agent=session.headers.get("User-Agent", "")) or ""
        try:
            r = session.post(f"{_AUTH}/u/email-otp/challenge?state={state}",
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
        r = session.get(f"{_BASE}/api/auth/session",
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
