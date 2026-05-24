#!/usr/bin/env python3
"""Lightweight Step 0-2 deactivated-account detector (no OTP).

Runs chatgpt.com homepage → CSRF → signin → authorize and checks whether the
resulting redirect or page HTML contains account_deactivated / account_disabled
markers.  Stops immediately after Step 2 — no OTP, no password submission.

Input: JSON on stdin
  { "email": "...", "client_id": "...", "refresh_token": "...", "proxy_url": "..." }

Output: JSON-lines on stdout
  {"log": "  [Deactivated] ..."}   — streaming progress lines
  {"status": "deactivated", "reason": "account_deactivated"}
  {"status": "active",      "reason": null}
  {"status": "error",       "reason": "<short description>"}

NB: Module-level imports must NOT print to stdout (corrupts JSON-lines
protocol). curl_cffi is safe — it does not print on import.
"""
import sys, json, random, uuid, time
from urllib.parse import urlparse

# HTTP/1.1 constant for fallback retries (curl_cffi >= 0.5.9).
try:
    from curl_cffi import CurlHttpVersion
    HTTP11 = CurlHttpVersion.V1_1
except Exception:
    HTTP11 = None

# Force stdout/stderr UTF-8 on Windows terminals.
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

# Chrome fingerprint profiles — same pool as protocol_register.py.
_CHROME_PROFILES = [
    {"major": 146, "impersonate": "chrome146", "build": 7876, "patch_range": (10, 100),
     "sec_ch_ua": '"Chromium";v="146", "Google Chrome";v="146", "Not/A)Brand";v="24"'},
    {"major": 142, "impersonate": "chrome142", "build": 7600, "patch_range": (10, 100),
     "sec_ch_ua": '"Chromium";v="142", "Google Chrome";v="142", "Not:A-Brand";v="99"'},
    {"major": 136, "impersonate": "chrome136", "build": 7103, "patch_range": (48, 175),
     "sec_ch_ua": '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"'},
    {"major": 133, "impersonate": "chrome133a", "build": 6943, "patch_range": (33, 153),
     "sec_ch_ua": '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"'},
    {"major": 131, "impersonate": "chrome131", "build": 6778, "patch_range": (69, 205),
     "sec_ch_ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"'},
    {"major": 124, "impersonate": "chrome124", "build": 6367, "patch_range": (60, 207),
     "sec_ch_ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"'},
]


def _random_chrome_version():
    p = random.choice(_CHROME_PROFILES)
    patch = random.randint(*p["patch_range"])
    full = f"{p['major']}.0.{p['build']}.{patch}"
    ua = f"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{full} Safari/537.36"
    return p["impersonate"], p["major"], full, ua, p["sec_ch_ua"]


def _log(m):
    print(json.dumps({"log": f"  [Deactivated] {m}"}), flush=True)


def _emit(payload):
    print(json.dumps(payload), flush=True)


def main():
    try:
        inp = json.loads(sys.stdin.read())
    except Exception as e:
        _emit({"status": "error", "reason": f"stdin parse: {str(e)[:60]}"})
        return

    email = inp.get("email", "")
    proxy_url = inp.get("proxy_url") or None

    if not email:
        _emit({"status": "error", "reason": "no email"})
        return

    try:
        from curl_cffi import requests as curl_requests
    except ImportError as e:
        _emit({"status": "error", "reason": f"import curl_cffi: {str(e)[:60]}"})
        return

    # Convert http:// proxy URL to socks5h:// — same rationale as protocol_register.py:
    # sing-box mixed inbound serves both; socks5h offloads DNS to proxy, avoiding
    # IP/DNS mismatch risk signals.
    if proxy_url and proxy_url.startswith('http://'):
        proxy_url = 'socks5h://' + proxy_url[len('http://'):]
    proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else None
    if proxy_url:
        _log(f"Using proxy: {proxy_url}")

    # Build session with a random Chrome fingerprint.
    session = None
    impersonate, chrome_major, chrome_full, ua, sec_ch_ua = _random_chrome_version()
    for _try in range(5):
        try:
            session = curl_requests.Session(impersonate=impersonate)
            if proxies:
                session.proxies = proxies
            break
        except Exception as e:
            _log(f"{impersonate} not supported, retrying... ({e})")
            impersonate, chrome_major, chrome_full, ua, sec_ch_ua = _random_chrome_version()
            session = None
    if not session:
        session = curl_requests.Session()
        if proxies:
            session.proxies = proxies
        _log("Using default session (no impersonate)")

    device_id = str(uuid.uuid4())
    _log(f"Profile: {impersonate}, Device: {device_id[:8]}...")

    session.headers.update({
        "User-Agent": ua,
        "Accept-Language": "en-US,en;q=0.9",
        "sec-ch-ua": sec_ch_ua,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
    })
    session.cookies.set("oai-did", device_id, domain="chatgpt.com")
    session.cookies.set("oai-did", device_id, domain="auth.openai.com")
    session.cookies.set("oai-did", device_id, domain=".auth.openai.com")

    BASE = "https://chatgpt.com"

    try:
        # Step 0: Visit homepage (retry on TLS / 403 errors)
        _log("Step 0: Homepage...")
        r = None
        for attempt in range(5):
            try:
                req_kwargs = {
                    "headers": {"Accept": "text/html", "Upgrade-Insecure-Requests": "1"},
                    "allow_redirects": True,
                    "timeout": 20,
                }
                if attempt >= 2 and HTTP11 is not None:
                    req_kwargs["http_version"] = HTTP11
                    if attempt == 2:
                        _log("Forcing HTTP/1.1 for remaining retries")
                r = session.get(f"{BASE}/", **req_kwargs)
                if r.status_code == 200:
                    break
                if r.status_code == 403 and attempt < 4:
                    _log(f"Homepage 403, retry ({attempt+1}/5) with new fingerprint")
                else:
                    raise Exception(f"Homepage failed: {r.status_code}")
            except Exception as e:
                err = str(e)[:80]
                is_tls_err = ("curl:" in err or "TLS" in err or "OPENSSL" in err
                              or "SSL" in err or "invalid library" in err)
                if attempt < 4 and (is_tls_err or "403" in err):
                    _log(f"Homepage error ({attempt+1}/5): {err} — switching fingerprint")
                else:
                    _emit({"status": "error", "reason": f"homepage failed: {err}"})
                    return
            # Rebuild session with a fresh fingerprint before retry
            impersonate, chrome_major, chrome_full, ua, sec_ch_ua = _random_chrome_version()
            device_id = str(uuid.uuid4())
            try:
                session = curl_requests.Session(impersonate=impersonate)
            except Exception:
                session = curl_requests.Session()
            if proxies:
                session.proxies = proxies
            session.headers.update({
                "User-Agent": ua,
                "sec-ch-ua": sec_ch_ua,
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"Windows"',
                "Accept-Language": "en-US,en;q=0.9",
            })
            session.cookies.set("oai-did", device_id, domain="chatgpt.com")
            session.cookies.set("oai-did", device_id, domain="auth.openai.com")
            session.cookies.set("oai-did", device_id, domain=".auth.openai.com")
            time.sleep(2 * (attempt + 1))

        if not r or r.status_code != 200:
            _emit({"status": "error", "reason": "homepage failed after 5 attempts"})
            return

        time.sleep(random.uniform(0.3, 0.8))

        # Step 1: CSRF + Signin
        _log("Step 1: CSRF + Signin...")
        try:
            r = session.get(f"{BASE}/api/auth/csrf",
                            headers={"Accept": "application/json"}, timeout=15)
            csrf = r.json().get("csrfToken", "")
        except Exception as e:
            _emit({"status": "error", "reason": f"CSRF fetch failed: {str(e)[:60]}"})
            return
        if not csrf:
            _emit({"status": "error", "reason": "CSRF token empty"})
            return

        time.sleep(random.uniform(0.2, 0.6))

        signin_params = {
            "prompt": "login",
            "ext-oai-did": device_id,
            "auth_session_logging_id": str(uuid.uuid4()),
            "screen_hint": "login_or_signup",
            "login_hint": email,
        }
        try:
            r = session.post(
                f"{BASE}/api/auth/signin/openai",
                params=signin_params,
                data={"callbackUrl": f"{BASE}/", "csrfToken": csrf, "json": "true"},
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "application/json",
                },
                timeout=15,
            )
            auth_url = r.json().get("url", "")
        except Exception as e:
            _emit({"status": "error", "reason": f"signin failed: {str(e)[:60]}"})
            return
        if not auth_url:
            _emit({"status": "error", "reason": "signin: no auth URL returned"})
            return

        time.sleep(random.uniform(0.3, 0.8))

        # Step 2: Follow the authorize URL and inspect the landing page
        _log("Step 2: Authorize...")
        try:
            r = session.get(
                auth_url,
                headers={
                    "Accept": "text/html",
                    "Upgrade-Insecure-Requests": "1",
                    "Referer": f"{BASE}/",
                },
                allow_redirects=True,
                timeout=30,
            )
        except Exception as e:
            _emit({"status": "error", "reason": f"authorize request failed: {str(e)[:60]}"})
            return

        final_url = str(r.url)
        final_path = urlparse(final_url).path
        _log(f"Authorize -> {final_path}")

        page_html = r.text or ""
        if "account_deactivated" in page_html or "account_disabled" in page_html:
            _log("account_deactivated marker found in authorize page HTML")
            _emit({"status": "deactivated", "reason": "account_deactivated"})
            return

        # If the path is one of the normal post-signin destinations, account is active.
        # /email-verification  → existing account with OTP  (active)
        # /create-account/...  → brand new account           (active, no such account)
        # /log-in              → auth.openai.com login page  (active, email not found or needs password)
        _log(f"Step 2: Authorize -> {final_path} (not deactivated)")
        _emit({"status": "active", "reason": None})

    except Exception as e:
        _emit({"status": "error", "reason": f"unexpected: {str(e)[:80]}"})


if __name__ == '__main__':
    main()
