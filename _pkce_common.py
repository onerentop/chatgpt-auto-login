# _pkce_common.py — PKCE / add-phone 公共函数
# 从 protocol_register.py 抽出，共享给 protocol_phone_verify.py
import json
import re
import sys
from urllib.parse import parse_qs, urlparse

# HTTP/1.1 fallback constant for curl_cffi (>= 0.5.9). None on older versions —
# _post_with_h1_fallback then no-ops (original HTTP/2-only behavior).
try:
    from curl_cffi import CurlHttpVersion
    HTTP11 = CurlHttpVersion.V1_1
except Exception:
    HTTP11 = None

AUTH = "https://auth.openai.com"
BASE = "https://chatgpt.com"


def _log(msg):
    print(json.dumps({"log": msg}))
    sys.stdout.flush()


def get_sentinel_token(session, device_id, flow="authorize_continue", user_agent=""):
    return ""


def _post_with_h1_fallback(session, url, *, json=None, headers=None, timeout=30):
    """POST that retries once with HTTP/1.1 on transient HTTP/2 errors or 400
    risk-control responses. Returns the final Response.

    Triggers HTTP/1.1 retry on:
      (1) HTTP/2 raises a TLS/curl exception
      (2) HTTP/2 returns 400 with 'invalid_r' in body (sentinel-token / frame
          corruption marker observed with sing-box mixed inbound, ref:
          SagerNet/sing-box#3945)

    No retry on success or other non-400 status. If HTTP11 sentinel is None
    (older curl_cffi without CurlHttpVersion), no fallback happens — original
    behavior preserved.
    """
    try:
        r = session.post(url, json=json, headers=headers, timeout=timeout)
    except Exception as e:
        if HTTP11 is not None:
            _log(f"POST {url.rsplit('/', 1)[-1]} HTTP/2 raise: {str(e)[:60]} — retry HTTP/1.1")
            return session.post(url, json=json, headers=headers, timeout=timeout, http_version=HTTP11)
        raise

    if r.status_code == 400 and 'invalid_r' in (r.text or '') and HTTP11 is not None:
        _log(f"POST {url.rsplit('/', 1)[-1]} got 400 invalid_r on HTTP/2 — retry HTTP/1.1")
        return session.post(url, json=json, headers=headers, timeout=timeout, http_version=HTTP11)

    return r


def follow_continue_for_auth_code(session, continue_url, device_id=None):
    """跟 continue_url 的 redirect chain，从 localhost:1455 重定向中提取 code= 参数。
    OpenAI 内部 redirect 到 localhost:1455 会触发 ConnectionError（本机没监听），
    需要从 exception 字符串里 regex 提 code。

    v2.40.0 新增 consent fallback: 协议侧 OAuth 在新账号第一次 OAuth 或新增 scope 时，
    continue_url 会指向 /sign-in-with-chatgpt/codex/consent 页（HTML UI，需要用户点
    "继续"按钮）。浏览器侧靠主循环 click 触发 POST /api/accounts/workspace/select。
    协议侧在 follow GET 拿不到 code 后主动 POST workspace/select 模拟同意 → 拿 callback。
    """
    auth_code = None
    try:
        r = session.get(
            continue_url,
            headers={"Accept": "text/html", "Upgrade-Insecure-Requests": "1"},
            allow_redirects=True,
            timeout=30,
        )
        redir_url = str(r.url)
        if "localhost:1455" in redir_url and "code=" in redir_url:
            auth_code = parse_qs(urlparse(redir_url).query).get("code", [None])[0]
        # 也检查 response history（有时 final url 不带 code 但中间 redirect 带）
        if not auth_code and hasattr(r, 'history') and r.history:
            for hr in r.history:
                loc = hr.headers.get("location", "") if hasattr(hr, 'headers') else ""
                if "localhost:1455" in loc and "code=" in loc:
                    auth_code = parse_qs(urlparse(loc).query).get("code", [None])[0]
                    break
    except Exception as e:
        # ConnectionError 文本里抓 code
        err_str = str(e)
        import traceback
        tb = traceback.format_exc()
        code_match = re.search(r'code=([^&\s\'"]+)', tb + err_str)
        if code_match:
            auth_code = code_match.group(1)

    # v2.40.0 consent fallback
    if not auth_code and ("/consent" in continue_url or "/sign-in-with-chatgpt" in continue_url):
        try:
            headers = {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Origin": AUTH,
                "Referer": continue_url,
            }
            if device_id:
                headers["oai-device-id"] = device_id
            # OpenAI 要求 workspace_id required。先 GET consent HTML 试着 parse workspace_id；
            # 失败的话退而 GET /sign-in-with-chatgpt/codex/consent.data + 各种 _routes 探查
            workspace_id = None
            try:
                rh = session.get(continue_url, headers={"Accept": "text/html"}, allow_redirects=True, timeout=30)
                # OpenAI consent 页是 Remix Turbo Stream 渲染，workspace_id 在 escape 串里：
                # 形如：workspaces\",[32],...,\"86892992-c7f0-4896-a636-1053e697e1f1\",\"profile_picture_alt_text\"
                # 不能直接 regex `"workspaces":[{"id":"<uuid>"`（backslash-escape 不匹配），
                # 改为：在 'workspaces' 关键字附近 1200 字符内找首个 UUID。
                if rh.ok:
                    ws_idx = rh.text.find('workspaces')
                    if ws_idx >= 0:
                        nearby = rh.text[ws_idx:ws_idx + 1200]
                        m = re.search(r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', nearby)
                        if m:
                            workspace_id = m.group(1)
                            _log(f"consent: parsed workspace_id={workspace_id}")
            except Exception as e:
                _log(f"consent GET HTML err: {str(e)[:80]}")

            if workspace_id:
                r = session.post(
                    f"{AUTH}/api/accounts/workspace/select",
                    json={"workspace_id": workspace_id},
                    headers=headers,
                    timeout=30,
                )
                _log(f"consent fallback workspace/select: status={r.status_code} body={(r.text or '')[:300]}")
                if r.ok:
                    d = r.json()
                    cu = d.get("continue_url", "")
                    if "localhost:1455" in cu and "code=" in cu:
                        auth_code = parse_qs(urlparse(cu).query).get("code", [None])[0]
                    if not auth_code:
                        payload_url = ((d.get("page") or {}).get("payload") or {}).get("url", "")
                        if "localhost:1455" in payload_url and "code=" in payload_url:
                            auth_code = parse_qs(urlparse(payload_url).query).get("code", [None])[0]
            else:
                _log("consent fallback: no workspace_id parsed from HTML")
        except Exception as e:
            _log(f"consent fallback workspace/select err: {str(e)[:80]}")
    return auth_code


def exchange_code(session, auth_code, code_verifier, client_id, redirect_uri):
    """POST /oauth/token 用 authorization_code 换 tokens。返回 dict（含 access_token / refresh_token / id_token），失败时返回 {}。"""
    try:
        r = session.post(
            f"{AUTH}/oauth/token",
            json={
                "grant_type": "authorization_code",
                "code": auth_code,
                "code_verifier": code_verifier,
                "client_id": client_id,
                "redirect_uri": redirect_uri,
            },
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            timeout=30,
        )
        if r.ok:
            return r.json()
        _log(f"exchange_code failed: HTTP {r.status_code} {r.text[:120]}")
        return {}
    except Exception as e:
        _log(f"exchange_code exception: {str(e)[:80]}")
        return {}


def rebuild_session(session_state, proxy_url=None):
    """根据 session_state（cookies + UA + device_id）重建 curl_cffi.Session。"""
    from curl_cffi import requests as curl_requests
    ua = session_state.get("user_agent", "")
    m = re.search(r"Chrome/(\d+)", ua)
    chrome_major = int(m.group(1)) if m else 120
    impersonate = f"chrome{chrome_major}"
    proxies = None
    if proxy_url:
        if proxy_url.startswith("http://"):
            proxy_url = "socks5h://" + proxy_url[len("http://"):]
        proxies = {"http": proxy_url, "https": proxy_url}
    try:
        s = curl_requests.Session(impersonate=impersonate)
    except Exception:
        s = curl_requests.Session(impersonate="chrome120")
    if proxies:
        s.proxies.update(proxies)
    if ua:
        s.headers.update({"User-Agent": ua})
    for c in session_state.get("cookies", []):
        s.cookies.set(c["name"], c["value"], domain=c.get("domain"), path=c.get("path", "/"))
    return s


def _serialize_cookies(session):
    """把 curl_cffi Session 的 cookies jar 序列化为 [{name,value,domain,path}, ...] 列表，
    供 Node 端 stdin JSON 传给下一个 spawn 的 Python 脚本恢复 session。"""
    out = []
    try:
        for c in session.cookies.jar:
            out.append({
                "name": c.name,
                "value": c.value,
                "domain": getattr(c, "domain", ".openai.com") or ".openai.com",
                "path": getattr(c, "path", "/") or "/",
            })
    except Exception:
        try:
            for k, v in session.cookies.items():
                out.append({"name": k, "value": v, "domain": ".openai.com", "path": "/"})
        except Exception:
            pass
    return out
