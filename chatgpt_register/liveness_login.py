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

# v2.42 Task 2: 系统级透明代理。必须在 curl_cffi import 之前设 env。
# Node 父进程（server/liveness/runner.js spawn）已通过 ...process.env 继承注入
# HTTPS_PROXY=http://127.0.0.1:7890；此处兜底默认值。
_DEFAULT_PROXY = os.environ.get('HTTPS_PROXY') or 'http://127.0.0.1:7890'
os.environ['HTTPS_PROXY'] = _DEFAULT_PROXY
os.environ['HTTP_PROXY'] = _DEFAULT_PROXY
os.environ.setdefault('NO_PROXY', '127.0.0.1,localhost')

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
    try:
        from chatgpt_register.proxy_helpers import report_bad_node
    except Exception:
        def report_bad_node(*a, **k):  # type: ignore[no-redef]
            pass  # v2.42 Task 11: helper 缺失时静默
except Exception as _import_err:
    # 不再静默 swallow —— 把错误信息记下来便于诊断（但 stdout 仍走 stderr 避免污染
    # JSON-lines protocol）。如果 fetch_imap_otp/get_imap_baseline 仍可能为 None
    # （比如 pyotp 没装），保留 None 兜底；但顶层 sys.path 修复后正常 import 不该走到这里。
    print(f"[liveness_login.py import fallback] {_import_err}", file=sys.stderr)
    def get_sentinel_token(*a, **k): return ""
    fetch_imap_otp = get_imap_baseline = gen_totp = None
    def report_bad_node(*a, **k):  # type: ignore[no-redef]
        pass  # v2.42 Task 11: import 失败时兜底
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


def _build_session():
    """Mirror protocol_register.py session setup — Chrome JA3 + rotating impersonate.

    v2.42 Task 2: 删 proxy_url 参数。curl_cffi 自动读 HTTPS_PROXY env（模块顶部
    已设）。Node 父进程通过 ...process.env 继承同样的 env 值。

    Note: protocol_register.py explicitly sets User-Agent, Accept-Language and
    sec-ch-ua headers after Session() because it builds a full sec-ch-ua string
    per profile.  _build_session doesn't carry that per-profile metadata, so we
    rely on curl_cffi impersonate= injecting the UA implicitly.  If a caller
    needs the exact UA string it can read session.headers.get("User-Agent", "").
    """
    from curl_cffi import requests as curl_requests
    session = None
    impersonate_name = None
    for _ in range(5):
        impersonate_name, _major = random.choice(_CHROME)
        try:
            session = curl_requests.Session(impersonate=impersonate_name)
            break
        except Exception:
            session = None
    if not session:
        session = curl_requests.Session()
    _log(f"Profile: {impersonate_name}, proxy: env-based")
    return session, impersonate_name


def login(email, password, login_type, client_id, refresh_token, totp_secret, proxy_url=None):
    """新 SPA OAuth flow:
    1. GET /authorize → 拿 cookies (oai-did, __cf_bm 等)
    2. POST /api/accounts/authorize/continue → 触发 OTP 邮件
    3. IMAP 拉 OTP
    4. POST /api/accounts/email-otp/validate → 拿 chatgpt.com session cookies
    5. GET chatgpt.com/api/auth/session → 拿 access_token + user.id

    v2.42 Task 2: proxy_url 参数保留向后兼容（旧测试 + Node spawn 入口仍传），
    但已 NO-OP — curl_cffi 自动用 HTTPS_PROXY env（模块顶部 + Node 父进程注入）。
    """
    if not password and login_type != "outlook":
        raise Exception("no password")  # gmail 走旧 flow（暂不支持），出错
    if login_type == "outlook" and (not client_id or not refresh_token):
        raise Exception("outlook oauth missing")

    session, impersonate_name = _build_session()
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
            report_bad_node('connection_reset', 'main')  # v2.42 Task 11
            raise Exception("proxy reset (login)")
        raise Exception(f"unexpected: GET csrf {msg[:40]}")
    if r_csrf.status_code >= 500:
        report_bad_node('connection_reset', 'main')  # v2.42 Task 11: 5xx 视作上游不稳
        raise Exception(f"proxy reset (login): HTTP {r_csrf.status_code}")
    if r_csrf.status_code in (403, 429):
        _body_lower = (r_csrf.text or "").lower()
        if any(kw in _body_lower for kw in ('cloudflare', 'just a moment', 'challenge-platform', 'cf-mitigated', 'attention required')):
            report_bad_node('cloudflare_403', 'main')  # v2.42 Task 11
            raise Exception(f"proxy reset (login): Cloudflare HTTP {r_csrf.status_code}")
        if r_csrf.status_code == 429:
            report_bad_node('rate_limited', 'main')  # v2.42 Task 11
        raise Exception(f"unexpected: csrf HTTP {r_csrf.status_code}")
    try:
        csrf_token = r_csrf.json().get("csrfToken")
    except Exception:
        raise Exception(f"unexpected: csrf body not json (HTTP {r_csrf.status_code})")
    if not csrf_token:
        raise Exception("unexpected: csrf missing csrfToken")

    _log("Step 1B: POST chatgpt.com/api/auth/signin/openai")
    import urllib.parse as _urlparse
    # v2.43.4: 关键参数 screen_hint=login_or_signup + login_hint=email 让 OpenAI
    # 直接 redirect 到 /email-verification (OTP path)，避免默认走 /log-in/password
    # (login_password page → DB 密码不匹配 → login_fail 死局)。
    # 参考 protocol_register.py:590 signin_params 实测有效 (Authorize -> /email-verification)。
    signin_params = _urlparse.urlencode({
        "prompt": "login",
        "screen_hint": "login_or_signup",
        "login_hint": email,
        "ext-oai-did": device_id,
        "auth_session_logging_id": str(uuid.uuid4()),
    })
    signin_form = _urlparse.urlencode({
        "callbackUrl": f"{_BASE}/",
        "csrfToken": csrf_token,
        "json": "true",
    })
    try:
        r_signin = session.post(
            f"{_BASE}/api/auth/signin/openai?{signin_params}",
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
            report_bad_node('connection_reset', 'main')  # v2.42 Task 11
            raise Exception("proxy reset (login)")
        raise Exception(f"unexpected: signin/openai {msg[:40]}")
    if r_signin.status_code >= 500:
        report_bad_node('connection_reset', 'main')  # v2.42 Task 11: 5xx 视作上游不稳
        raise Exception(f"proxy reset (login): HTTP {r_signin.status_code}")
    if r_signin.status_code in (403, 429):
        if r_signin.status_code == 429:
            report_bad_node('rate_limited', 'main')  # v2.42 Task 11
        else:
            report_bad_node('cloudflare_403', 'main')  # v2.42 Task 11: 403 走 main 路径，最可能是 CF
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
            report_bad_node('connection_reset', 'main')  # v2.42 Task 11
            raise Exception("proxy reset (login)")
        raise Exception(f"unexpected: GET authorize {msg[:40]}")
    if r_auth.status_code >= 500:
        report_bad_node('connection_reset', 'main')  # v2.42 Task 11: 5xx 视作上游不稳
        raise Exception(f"proxy reset (login): HTTP {r_auth.status_code}")
    if r_auth.status_code in (403, 429):
        _body_lower = (r_auth.text or "").lower()
        if any(kw in _body_lower for kw in ('cloudflare', 'just a moment', 'challenge-platform', 'cf-mitigated', 'attention required')):
            report_bad_node('cloudflare_403', 'main')  # v2.42 Task 11
            raise Exception(f"proxy reset (login): Cloudflare HTTP {r_auth.status_code}")
        if r_auth.status_code == 429:
            report_bad_node('rate_limited', 'main')  # v2.42 Task 11

    # 校验拿到了关键 session cookie
    # curl_cffi 的 session.cookies 直接迭代返回 cookie name 字符串
    cookie_names = list(session.cookies)
    if 'oai-client-auth-session' not in cookie_names:
        raise Exception(f"unexpected: oai-client-auth-session cookie missing (HTTP {r_auth.status_code}, cookies={cookie_names[:10]})")
    _log(f"Step 1 OK: status={r_auth.status_code} cookies={len(session.cookies)} final_url={str(r_auth.url)[:80]}")

    # v2.43.4: 检测 step 1 final_url — screen_hint=login_or_signup 让 OpenAI 直接 redirect 到
    # /email-verification (OTP path)。这种情况下 OpenAI session-state 已就绪等 OTP 验证，
    # 不需要 POST authorize/continue（再调反而把 state 切回 login_password 触发 user/register 死局）。
    # 参考 protocol_register.py:618-620: elif "/email-verification" in final_path: need_otp = True
    from urllib.parse import urlparse as _urlparse_step1
    _final_path_step1 = _urlparse_step1(str(r_auth.url)).path
    sentinel = ""

    if "/email-verification" in _final_path_step1:
        _log("Step 1 final_path /email-verification — 跳过 step 2 (OpenAI session 已就绪 OTP path)")
        page_type = "email_otp_verification"
    else:
        # Step 2: POST /api/accounts/authorize/continue → 触发 OTP 邮件
        #   关键 headers：
        #     openai-sentinel-token = QuickJS 跑 OpenAI sdk.js 生成的 token，没这个 OpenAI 会
        #       silent-drop OTP 邮件下发（200 OK 假成功但邮件根本不发）
        #     oai-device-id = 第一行 session.cookies.set 的同一个 uuid
        #     ext-passkey-client-capabilities = passkey 能力声明
        _log("Step 2: POST authorize/continue")
        try:
            sentinel = get_sentinel_token(session, device_id, flow="authorize_continue",
                                         user_agent=session.headers.get("User-Agent", "")) or ""
        except Exception as _e:
            _log(f"sentinel token fail (continue 用空): {str(_e)[:50]}")
            sentinel = ""
        try:
            r2 = session.post(
                f"{_AUTH}/api/accounts/authorize/continue",
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    "Origin": _AUTH,
                    "Referer": str(r_auth.url),
                    "oai-device-id": device_id,
                    "openai-sentinel-token": sentinel,
                    "ext-passkey-client-capabilities": "conditional-create,conditional-get",
                },
                json={"username": {"kind": "email", "value": email}},
                timeout=30,
            )
        except Exception as e:
            msg = str(e)
            if 'ECONNRESET' in msg or 'reset' in msg.lower():
                report_bad_node('connection_reset', 'main')
                raise Exception("proxy reset (login)")
            raise Exception(f"unexpected: authorize/continue {msg[:40]}")

        if r2.status_code in (429,) or r2.status_code >= 500:
            if r2.status_code == 429:
                report_bad_node('rate_limited', 'main')
            else:
                report_bad_node('connection_reset', 'main')
            raise Exception(f"proxy reset (login): HTTP {r2.status_code}")

        body_text = r2.text or ""
        if "account_deactivated" in body_text or "account_disabled" in body_text:
            _log("Step 2: account_deactivated detected (short-circuit, no OTP needed)")
            raise Exception("deactivated: account_deactivated")

        if r2.status_code in (403,):
            _body_lower = body_text.lower()
            if any(kw in _body_lower for kw in ('cloudflare', 'just a moment', 'challenge-platform')):
                report_bad_node('cloudflare_403', 'main')
                raise Exception(f"proxy reset (login): Cloudflare HTTP {r2.status_code}")
            raise Exception(f"login_fail: authorize/continue HTTP 403 body={body_text[:80]}")

        try:
            j2 = r2.json()
        except Exception:
            raise Exception(f"unexpected: authorize/continue body not json (HTTP {r2.status_code})")

        if r2.status_code >= 400:
            err = (j2.get("error") or {}).get("code") or "unknown"
            if err == "unknown_user" or err == "invalid_email":
                raise Exception(f"login_fail: authorize/continue {err}")
            if err == "invalid_state":
                raise Exception(f"login_fail: invalid_state (sentinel/header missing?)")
            raise Exception(f"login_fail: authorize/continue HTTP {r2.status_code} code={err}")

        page_type = (j2.get("page") or {}).get("type")
        _log(f"Step 2 OK: page.type={page_type} sentinel={'yes' if sentinel else 'NO'}")

    # v2.43: 强制 passwordless 路径 — 即使 OpenAI 返回 login_password 也切回 OTP。
    # v2.43.3: page.type=login_password 路径 — 参考 protocol_register.py:647 的处理。
    # OpenAI 对已注册账号的 login_password page 接受 user/register 调用重设密码，
    # 然后强制跳 email_otp_verification (2FA) → step 3 IMAP 拿 OTP → step 4 validate。
    # 这等同于"重新注册"路径，实测协议流程注册新账号也走这条。
    # 替换密码 — 因为账号本来就是验证码注册的，DB password 不是真密码；用 user/register 重设。
    if page_type == "login_password":
        _log("Step 2.5: page.type=login_password, re-register via user/register")
        # OpenAI user/register 对已注册账号接受新密码（等同 password reset）。
        # 实测 DB 密码 (随机 10 字符) 被 OpenAI 拒为 string_below_min_length —
        # 改用 _default_password_from_email 规则 (参考 Gpt-Agreement-Payment line 1591)：
        # email去@ (一般 20+ 字符)，不够 8 字符补 2026OpenAI。
        register_pw = (email or "").replace("@", "")
        if len(register_pw) < 8:
            register_pw = f"{register_pw}2026OpenAI"
        _log(f"Reset password to default rule ({len(register_pw)} chars)")
        try:
            sentinel25 = get_sentinel_token(session, device_id, flow="username_password_create",
                                           user_agent=session.headers.get("User-Agent", "")) or sentinel
        except Exception as _e:
            _log(f"sentinel25 fail (复用 step 2 sentinel): {str(_e)[:40]}")
            sentinel25 = sentinel
        try:
            r25 = session.post(
                f"{_AUTH}/api/accounts/user/register",
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    "Origin": _AUTH,
                    "Referer": f"{_AUTH}/create-account/password",
                    "oai-device-id": device_id,
                    "openai-sentinel-token": sentinel25,
                    "ext-passkey-client-capabilities": "conditional-create,conditional-get",
                },
                json={"username": email, "password": register_pw},
                timeout=30,
            )
        except Exception as e:
            msg = str(e)
            if 'reset' in msg.lower() or 'ECONNRESET' in msg:
                raise Exception("proxy reset (login)")
            raise Exception(f"unexpected: user/register {msg[:40]}")

        if r25.status_code in (429,) or r25.status_code >= 500:
            raise Exception(f"proxy reset (login): HTTP {r25.status_code}")

        body_text = r25.text or ""
        if "account_deactivated" in body_text or "account_disabled" in body_text:
            raise Exception("deactivated: account_deactivated")

        if r25.status_code != 200:
            try:
                err = (r25.json().get('error') or {}).get('code') or 'unknown'
            except Exception:
                err = 'parse_error'
            raise Exception(f"login_fail: user/register HTTP {r25.status_code} code={err}")

        _log(f"Step 2.5 OK: re-registered, OTP email will be triggered")

        # 触发 OTP 邮件 (参考 protocol_register.py:676-680)
        try:
            session.get(
                f"{_AUTH}/api/accounts/email-otp/send",
                headers={
                    "Accept": "text/html",
                    "Referer": f"{_AUTH}/create-account/password",
                    "oai-device-id": device_id,
                    "Upgrade-Insecure-Requests": "1",
                },
                timeout=10,
                allow_redirects=True,
            )
        except Exception as _e:
            _log(f"OTP send trigger fail (继续，authorize/continue 也会自动触发): {str(_e)[:40]}")

    elif page_type != "email_otp_verification":
        # 其他未知页面类型 —— 归 login_fail
        raise Exception(f"login_fail: unexpected page.type={page_type}")

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
        sentinel4 = get_sentinel_token(session, device_id, flow="email_otp_validate",
                                      user_agent=session.headers.get("User-Agent", "")) or ""
    except Exception as _e:
        _log(f"sentinel token fail (validate 用空): {str(_e)[:50]}")
        sentinel4 = ""
    try:
        r4 = session.post(
            f"{_AUTH}/api/accounts/email-otp/validate",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Origin": _AUTH,
                "Referer": f"{_AUTH}/email-verification",
                "oai-device-id": device_id,
                "openai-sentinel-token": sentinel4,
            },
            json={"code": otp},
            allow_redirects=True,
            timeout=30,
        )
    except Exception as e:
        msg = str(e)
        if 'reset' in msg.lower():
            report_bad_node('connection_reset', 'main')  # v2.42 Task 11
            raise Exception("proxy reset (login)")
        raise Exception(f"unexpected: email-otp/validate {msg[:40]}")

    if r4.status_code in (403, 429) and r4.status_code != 403:
        # 等价于 r4.status_code == 429
        report_bad_node('rate_limited', 'main')  # v2.42 Task 11
        raise Exception(f"proxy reset (login): HTTP {r4.status_code}")
    if r4.status_code >= 500:
        report_bad_node('connection_reset', 'main')  # v2.42 Task 11: 5xx 视作上游不稳
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
            report_bad_node('rate_limited', 'main')  # v2.42 Task 11
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
    # v2.42 Task 2: 不再读 stdin proxy 字段 —— curl_cffi 自动用 HTTPS_PROXY env

    try:
        result = login(email, password, login_type, client_id, refresh_token,
                      totp_secret)
        _emit({"status": "ok", **result})
    except Exception as e:
        _err(str(e))


if __name__ == "__main__":
    main()
