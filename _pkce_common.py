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
