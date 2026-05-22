#!/usr/bin/env python3
"""Protocol register/login for ChatGPT via curl_cffi.
Input: JSON on stdin { email, password, client_id, refresh_token }
Output: JSON lines on stdout — log lines as {"log":"..."}, final result as {"status":...}
"""
import sys, os, json, uuid, time, random, re, string, hashlib, base64, secrets, imaplib
import email as email_lib
from urllib.parse import urlparse, parse_qs, urlencode, quote

sys.path.insert(0, r"D:\workspace\projects\cliproxyaccountcleaner")

# Chrome fingerprint profiles (local, no external dependency)
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

def _log(msg):
    print(json.dumps({"log": f"  [Proto] {msg}"}), flush=True)

class _RetrySession:
    """Wraps curl_cffi session — auto-retries get/post on transient errors."""
    def __init__(self, session, retries=3):
        self._s = session
        self._retries = retries
    def __getattr__(self, name):
        return getattr(self._s, name)
    def get(self, url, **kw):
        return self._do('get', url, **kw)
    def post(self, url, **kw):
        return self._do('post', url, **kw)
    def _do(self, method, url, **kw):
        for attempt in range(self._retries):
            try:
                return getattr(self._s, method)(url, **kw)
            except Exception as e:
                err = str(e)
                if attempt < self._retries - 1 and any(k in err for k in [
                    'curl:', 'timed out', 'Timeout', 'Connection',
                    'reset by peer', 'SSL', 'TLS', 'OPENSSL', 'Recv failure',
                ]):
                    wait = 3 * (attempt + 1)
                    _log(f"Retry {attempt+1}/{self._retries}: {err[:60]}, wait {wait}s")
                    time.sleep(wait)
                    continue
                raise

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
                _log(f"IMAP poll error: {str(e)[:50]}")
        finally:
            if imap:
                try:
                    imap.logout()
                except Exception:
                    pass
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

def _do_pkce_flow(session, email, password, ms_client_id, ms_refresh_token):
    """PKCE OAuth flow using existing session cookies. Returns {access_token, refresh_token, id_token}."""
    code_verifier = secrets.token_urlsafe(32)
    code_challenge = base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode()).digest()).rstrip(b'=').decode()
    state = secrets.token_hex(16)
    pkce_client_id = "app_EMoamEEZ73f0CkXaXp7hrann"
    redirect_uri = "http://localhost:1455/auth/callback"
    AUTH = "https://auth.openai.com"
    device_id = session.cookies.get("oai-did") or str(uuid.uuid4())

    auth_url = (
        f"{AUTH}/oauth/authorize?"
        f"client_id={pkce_client_id}&code_challenge={code_challenge}&code_challenge_method=S256"
        f"&codex_cli_simplified_flow=true&id_token_add_organizations=true"
        f"&redirect_uri={quote(redirect_uri, safe='')}&response_type=code"
        f"&scope=openid+email+profile+offline_access&state={state}"
    )

    # Step 1: Navigate to authorize (follow redirects, stop at localhost)
    # Get IMAP baseline BEFORE any PKCE auth requests (so we don't miss OTP emails)
    pkce_imap_baseline = 0
    if ms_client_id and ms_refresh_token:
        try:
            token_body = urlencode({"client_id": ms_client_id, "grant_type": "refresh_token",
                "refresh_token": ms_refresh_token, "scope": "https://outlook.office.com/IMAP.AccessAsUser.All"})
            try:
                from curl_cffi import requests as curl_req
                tr = curl_req.post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
                    headers={"Content-Type": "application/x-www-form-urlencoded"}, data=token_body, timeout=15)
                imap_tok = tr.json().get("access_token")
            except ImportError:
                from urllib.request import Request, urlopen
                with urlopen(Request("https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
                    data=token_body.encode(), method="POST"), timeout=15) as resp:
                    imap_tok = json.loads(resp.read()).get("access_token")
            if imap_tok:
                auth_s = f"user={email}\x01auth=Bearer {imap_tok}\x01\x01"
                im = imaplib.IMAP4_SSL("outlook.office365.com", 993, timeout=15)
                im.authenticate("XOAUTH2", lambda x: auth_s.encode())
                im.select("INBOX")
                _, msgs = im.search(None, "ALL")
                uids = msgs[0].split()
                pkce_imap_baseline = int(uids[-1]) if uids else 0
                im.logout()
            _log(f"PKCE: Pre-auth IMAP baseline: {pkce_imap_baseline}")
        except Exception as e:
            _log(f"PKCE: Pre-auth baseline error: {str(e)[:60]}")

    _log("PKCE: Navigating to authorize...")
    auth_code = None
    r = None
    try:
        r = session.get(auth_url, headers={"Accept": "text/html", "Upgrade-Insecure-Requests": "1"}, allow_redirects=True, timeout=30)
    except Exception as e:
        err_str = str(e)
        if "localhost" in err_str or "1455" in err_str:
            _log("PKCE: Redirect to localhost (connection refused, expected)")
            code_match = re.search(r'code=([^&\s\'"]+)', err_str)
            if code_match:
                auth_code = code_match.group(1)
                _log(f"PKCE: Got auth code from connection error")
        else:
            _log(f"PKCE: Auth request failed: {str(e)[:60]}")
            return {"error": str(e)[:200]}

    if not auth_code:
        final_url = str(r.url) if r else ""
        final_path = urlparse(final_url).path
        _log(f"PKCE: Landed on {final_path}")

        # Check if we got the code directly (auto-consent)
        if "localhost:1455" in final_url and "code=" in final_url:
            auth_code = parse_qs(urlparse(final_url).query).get("code", [None])[0]

        # Choose account page — select our account
        elif "/choose-an-account" in final_path:
            _log("PKCE: Choose account page, selecting account...")
            try:
                from chatgpt_register.chatgpt_register import build_sentinel_token
                sentinel = build_sentinel_token(session, device_id, flow="authorize_continue", user_agent=session.headers.get("User-Agent", ""), sec_ch_ua=session.headers.get("sec-ch-ua", "")) or ""
            except Exception:
                sentinel = ""
            r = session.post(f"{AUTH}/api/accounts/authorize/continue",
                json={"username": {"kind": "email", "value": email}},
                headers={"Accept": "application/json", "Content-Type": "application/json",
                    "Origin": AUTH, "Referer": final_url, "oai-device-id": device_id,
                    "openai-sentinel-token": sentinel,
                    "ext-passkey-client-capabilities": "conditional-create,conditional-get"}, timeout=30)
            _log(f"PKCE: authorize/continue response: {r.status_code}")
            # Check response for next step
            if r.status_code == 200:
                try:
                    resp_data = r.json()
                    page_type = (resp_data.get("page") or {}).get("type", "")
                    continue_url = resp_data.get("continue_url", "")
                    _log(f"PKCE: Choose-account response: page={page_type} continue={continue_url[:60]}")

                    # May need OTP verification
                    if "email_otp" in page_type or "email-verification" in continue_url:
                        _log("PKCE: OTP verification needed after account selection...")
                        # Do NOT call email-otp/send — it resends old code and breaks session
                        time.sleep(8)
                        otp = _fetch_otp_for_pkce(ms_client_id, ms_refresh_token, email, pkce_imap_baseline)
                        if not otp:
                            _log("PKCE: OTP not received")
                        else:
                            _log(f"PKCE: Validating OTP: {otp}")
                            try:
                                sentinel2 = build_sentinel_token(session, device_id, flow="email_otp_validate", user_agent=session.headers.get("User-Agent", ""), sec_ch_ua=session.headers.get("sec-ch-ua", "")) or ""
                                _log(f"PKCE: Sentinel token: {'yes' if sentinel2 else 'no'}")
                            except Exception as se:
                                sentinel2 = ""
                                _log(f"PKCE: Sentinel build failed: {str(se)[:50]}")
                            r = session.post(f"{AUTH}/api/accounts/email-otp/validate",
                                json={"code": otp},
                                headers={"Accept": "application/json", "Content-Type": "application/json",
                                    "Origin": AUTH, "Referer": f"{AUTH}/email-verification",
                                    "oai-device-id": device_id, "openai-sentinel-token": sentinel2,
                                    "ext-passkey-client-capabilities": "conditional-create,conditional-get"}, timeout=30)
                            _log(f"PKCE: OTP validate: {r.status_code} body={r.text[:100]}")
                            otp_resp = r.json() if r.status_code == 200 else {}
                            otp_continue = otp_resp.get("continue_url", "")
                            otp_page_type = (otp_resp.get("page") or {}).get("type", "")
                            _log(f"PKCE: OTP validate response: {r.status_code} continue={otp_continue[:60]}")
                            if "add_phone" in otp_page_type or "add-phone" in otp_continue or "phone-required" in otp_continue:
                                _log("PKCE: Phone verification required")
                                return {"needsPhone": True}
                            elif otp_continue:
                                try:
                                    r = session.get(otp_continue, headers={"Accept": "text/html", "Upgrade-Insecure-Requests": "1"}, allow_redirects=True, timeout=30)
                                    redir_url = str(r.url)
                                    if "localhost:1455" in redir_url and "code=" in redir_url:
                                        auth_code = parse_qs(urlparse(redir_url).query).get("code", [None])[0]
                                except Exception as e:
                                    code_match = re.search(r'code=([^&\s]+)', str(e))
                                    if code_match:
                                        auth_code = code_match.group(1)
                                        _log("PKCE: Got code from connection error")

                    elif continue_url:
                        _log(f"PKCE: Following continue URL: {continue_url[:60]}")
                        try:
                            r = session.get(continue_url, headers={"Accept": "text/html", "Upgrade-Insecure-Requests": "1"}, allow_redirects=True, timeout=30)
                            redir_url = str(r.url)
                            if "localhost:1455" in redir_url and "code=" in redir_url:
                                auth_code = parse_qs(urlparse(redir_url).query).get("code", [None])[0]
                        except Exception as e:
                            code_match = re.search(r'code=([^&\s]+)', str(e))
                            if code_match:
                                auth_code = code_match.group(1)
                                _log("PKCE: Got code from connection error")
                except Exception:
                    _log(f"PKCE: Choose-account response: {r.status_code} {str(r.url)[:60]}")

        # Need to log in
        elif "/log-in" in final_path:
            _log("PKCE: Need to log in, submitting email...")
            try:
                from chatgpt_register.chatgpt_register import build_sentinel_token
                sentinel = build_sentinel_token(session, device_id, flow="authorize_continue", user_agent=session.headers.get("User-Agent", ""), sec_ch_ua=session.headers.get("sec-ch-ua", "")) or ""
            except Exception:
                sentinel = ""
            r = session.post(f"{AUTH}/api/accounts/authorize/continue",
                json={"username": {"kind": "email", "value": email}},
                headers={"Accept": "application/json", "Content-Type": "application/json",
                    "Origin": AUTH, "Referer": final_url, "oai-device-id": device_id,
                    "openai-sentinel-token": sentinel}, timeout=30)
            page_data = r.json() if r.status_code == 200 else {}
            page_type = (page_data.get("page") or {}).get("type", "")
            _log(f"PKCE: Email response: page={page_type}")

            # OTP verification needed
            if "email_otp" in page_type or "email-verification" in str(page_data.get("continue_url", "")):
                _log("PKCE: OTP verification needed...")
                # Do NOT call email-otp/send — authorize/continue triggers it automatically
                time.sleep(8)
                otp = _fetch_otp_for_pkce(ms_client_id, ms_refresh_token, email, pkce_imap_baseline)
                if not otp:
                    return {"error": "OTP not received for PKCE"}
                try:
                    sentinel = build_sentinel_token(session, device_id, flow="email_otp_validate", user_agent=session.headers.get("User-Agent", ""), sec_ch_ua=session.headers.get("sec-ch-ua", "")) or ""
                except Exception:
                    sentinel = ""
                r = session.post(f"{AUTH}/api/accounts/email-otp/validate",
                    json={"code": otp},
                    headers={"Accept": "application/json", "Content-Type": "application/json",
                        "Origin": AUTH, "Referer": f"{AUTH}/email-verification",
                        "oai-device-id": device_id, "openai-sentinel-token": sentinel}, timeout=30)
                otp_data = r.json() if r.status_code == 200 else {}
                otp_page = (otp_data.get("page") or {}).get("type", "")
                continue_url = otp_data.get("continue_url", "")
                _log(f"PKCE: OTP response: page={otp_page} continue={continue_url[:60]}")

                if "add_phone" in otp_page or "add-phone" in str(continue_url):
                    return {"needsPhone": True}

                # Follow continue URL to get the auth code
                if continue_url:
                    try:
                        r = session.get(continue_url, headers={"Accept": "text/html", "Upgrade-Insecure-Requests": "1"}, allow_redirects=True, timeout=30)
                        final_redir = str(r.url)
                        if "localhost:1455" in final_redir and "code=" in final_redir:
                            auth_code = parse_qs(urlparse(final_redir).query).get("code", [None])[0]
                    except Exception as e:
                        err_str = str(e)
                        if "localhost" in err_str or "1455" in err_str:
                            # Extract code from the error/redirect URL
                            import traceback
                            tb = traceback.format_exc()
                            code_match = re.search(r'code=([^&\s]+)', tb + err_str)
                            if code_match:
                                auth_code = code_match.group(1)
                                _log(f"PKCE: Got code from connection error")

        elif "add-phone" in final_path or "phone-required" in final_path:
            return {"needsPhone": True}

    if not auth_code:
        # Last resort: check response history for localhost redirect
        if hasattr(r, 'history'):
            for hr in (r.history if r.history else []):
                loc = hr.headers.get("location", "")
                if "localhost:1455" in loc and "code=" in loc:
                    auth_code = parse_qs(urlparse(loc).query).get("code", [None])[0]
                    _log("PKCE: Found code in redirect history")
                    break

    if not auth_code:
        _log("PKCE: Failed to get auth code")
        return {"error": "No auth code obtained"}

    # Token exchange
    _log("PKCE: Exchanging code for tokens...")
    try:
        r = session.post("https://auth.openai.com/oauth/token",
            json={
                "grant_type": "authorization_code",
                "client_id": pkce_client_id,
                "code": auth_code,
                "code_verifier": code_verifier,
                "redirect_uri": redirect_uri,
            },
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            timeout=15)
        tokens = r.json()
        if tokens.get("access_token"):
            _log(f"PKCE: Token exchange OK! RT: {'yes' if tokens.get('refresh_token') else 'no'}")
            return {
                "access_token": tokens["access_token"],
                "refresh_token": tokens.get("refresh_token", ""),
                "id_token": tokens.get("id_token", ""),
                "expires_in": tokens.get("expires_in", 3600),
            }
        _log(f"PKCE: Token exchange failed: {tokens.get('error', str(tokens)[:80])}")
        return {"error": tokens.get("error_description", tokens.get("error", "Token exchange failed"))}
    except Exception as e:
        _log(f"PKCE: Token exchange error: {str(e)[:60]}")
        return {"error": str(e)[:200]}


def _fetch_otp_for_pkce(ms_client_id, ms_refresh_token, email, pre_baseline=0):
    """Fetch OTP via IMAP for PKCE re-authentication. Same approach as _fetch_imap_otp."""
    if not ms_client_id or not ms_refresh_token:
        _log("PKCE OTP: No Microsoft credentials")
        return None
    try:
        # Get IMAP token (use curl_cffi if available, fallback to urllib)
        try:
            from curl_cffi import requests as curl_requests
            r = curl_requests.post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                data=urlencode({"client_id": ms_client_id, "grant_type": "refresh_token",
                    "refresh_token": ms_refresh_token, "scope": "https://outlook.office.com/IMAP.AccessAsUser.All"}),
                timeout=15)
            imap_token = r.json().get("access_token")
        except ImportError:
            from urllib.request import Request, urlopen
            body = urlencode({"client_id": ms_client_id, "grant_type": "refresh_token",
                "refresh_token": ms_refresh_token, "scope": "https://outlook.office.com/IMAP.AccessAsUser.All"}).encode()
            with urlopen(Request("https://login.microsoftonline.com/consumers/oauth2/v2.0/token", data=body, method="POST"), timeout=15) as resp:
                imap_token = json.loads(resp.read()).get("access_token")
        if not imap_token:
            _log("PKCE OTP: IMAP token failed")
            return None

        auth_str = f"user={email}\x01auth=Bearer {imap_token}\x01\x01"

        # Use pre-auth baseline if provided (captured before OTP was triggered)
        if pre_baseline > 0:
            baseline = pre_baseline
            _log(f"PKCE OTP: Using pre-auth baseline UID: {baseline}")
        else:
            imap = imaplib.IMAP4_SSL("outlook.office365.com", 993, timeout=15)
            try:
                imap.authenticate("XOAUTH2", lambda x: auth_str.encode())
                imap.select("INBOX")
                _, msgs = imap.search(None, "ALL")
                uids = msgs[0].split()
                baseline = int(uids[-1]) if uids else 0
            finally:
                try:
                    imap.logout()
                except Exception:
                    pass
            _log(f"PKCE OTP: Baseline UID: {baseline}")

        time.sleep(5)

        # Poll — same pattern as _fetch_imap_otp
        for attempt in range(20):
            imap = None
            try:
                imap = imaplib.IMAP4_SSL("outlook.office365.com", 993, timeout=15)
                imap.authenticate("XOAUTH2", lambda x: auth_str.encode())
                imap.select("INBOX")
                _, msgs = imap.search(None, f"UID {baseline + 1}:*")
                new_uids = [u for u in msgs[0].split() if int(u) > baseline]
                if attempt == 0:
                    _log(f"PKCE OTP: Found {len(new_uids)} new emails")
                for uid in reversed(new_uids):
                    _, data = imap.fetch(uid, "(BODY[])")
                    msg = email_lib.message_from_bytes(data[0][1])
                    subject = str(msg.get("Subject", ""))
                    from_addr = str(msg.get("From", ""))
                    if "openai" in from_addr.lower() or "chatgpt" in subject.lower() or "code" in subject.lower() or "代码" in subject:
                        m = re.search(r"\b(\d{6})\b", subject)
                        if m:
                            _log(f"PKCE OTP: Got code: {m.group(1)} (subj)")
                            return m.group(1)
                        body = ""
                        if msg.is_multipart():
                            for part in msg.walk():
                                if part.get_content_type() == "text/html":
                                    body = part.get_payload(decode=True).decode("utf-8", errors="ignore")
                                    break
                        else:
                            body = msg.get_payload(decode=True).decode("utf-8", errors="ignore")
                        m = re.search(r"\b(\d{6})\b", re.sub(r"<[^>]+>", " ", body))
                        if m:
                            _log(f"PKCE OTP: Got code: {m.group(1)} (body)")
                            return m.group(1)
            except Exception as e:
                if attempt == 0:
                    _log(f"PKCE OTP: IMAP error: {str(e)[:50]}")
            finally:
                if imap:
                    try:
                        imap.logout()
                    except Exception:
                        pass
            time.sleep(3)

        _log("PKCE OTP: Not received after 20 attempts")
        return None
    except Exception as e:
        _log(f"PKCE OTP: Error: {str(e)[:60]}")
        return None


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
    do_pkce = input_data.get("pkce", False)
    proxy_url = input_data.get("proxy", "")  # e.g. http://127.0.0.1:7890

    try:
        from curl_cffi import requests as curl_requests
        from chatgpt_register.chatgpt_register import build_sentinel_token

        # HTTP/1.1 constant for TLS-retry fallback (curl_cffi >= 0.5.9).
        # Some unstable proxy paths break HTTP/2 framing mid-handshake — falling back
        # to HTTP/1.1 on retry often unblocks the request when the same node would
        # otherwise produce repeated "TLS connect error: invalid library" failures.
        try:
            from curl_cffi import CurlHttpVersion
            HTTP11 = CurlHttpVersion.V1_1
        except Exception:
            HTTP11 = None

        proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else None
        if proxy_url:
            _log(f"Using proxy: {proxy_url}")

        # Pick a supported profile (retry if impersonate fails)
        session = None
        for _try in range(5):
            impersonate, chrome_major, chrome_full, ua, sec_ch_ua = _random_chrome_version()
            try:
                session = curl_requests.Session(impersonate=impersonate)
                if proxies:
                    session.proxies = proxies
                break
            except Exception as e:
                _log(f"{impersonate} not supported, retrying... ({e})")
                session = None
        if not session:
            session = curl_requests.Session()  # fallback: no impersonate
            if proxies:
                session.proxies = proxies
            _log("Using default session (no impersonate)")
        device_id = str(uuid.uuid4())
        _log(f"Profile: {impersonate}, Device: {device_id[:8]}...")

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

        # Step 0: Visit homepage (retry on TLS errors and 403)
        _log("Step 0: Homepage...")
        r = None
        for attempt in range(5):
            try:
                # On retry (attempt >= 2), force HTTP/1.1 if available. Curl_cffi's default
                # HTTP/2 framing can break on unstable proxy paths, producing repeated
                # "invalid library" TLS errors that don't go away by just rotating the
                # Chrome fingerprint. HTTP/1.1 sidesteps the framing problem at the cost
                # of slightly weaker JA3 fidelity, which is the right trade on retry.
                req_kwargs = {"headers": {"Accept": "text/html", "Upgrade-Insecure-Requests": "1"},
                              "allow_redirects": True, "timeout": 20}
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
                # TLS/curl errors are transient — switch impersonate and retry
                is_tls_err = "curl:" in err or "TLS" in err or "OPENSSL" in err or "SSL" in err or "invalid library" in err
                if attempt < 4 and (is_tls_err or "403" in err):
                    _log(f"Homepage error ({attempt+1}/5): {err} — switching fingerprint")
                else:
                    raise
            # Rebuild session with a different profile
            impersonate, chrome_major, chrome_full, ua, sec_ch_ua = _random_chrome_version()
            device_id = str(uuid.uuid4())
            try: session = curl_requests.Session(impersonate=impersonate)
            except Exception: session = curl_requests.Session()
            if proxies: session.proxies = proxies
            session.headers.update({"User-Agent": ua, "sec-ch-ua": sec_ch_ua, "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"', "Accept-Language": "en-US,en;q=0.9"})
            session.cookies.set("oai-did", device_id, domain="chatgpt.com")
            session.cookies.set("oai-did", device_id, domain="auth.openai.com")
            session.cookies.set("oai-did", device_id, domain=".auth.openai.com")
            time.sleep(2 * (attempt + 1))
        if not r or r.status_code != 200:
            # Treat exhausted homepage retries as a network-layer failure (node-level)
            # rather than an account-level error. The engine can blacklist the current
            # proxy node, rotate, and retry the same account with a fresh route.
            print(json.dumps({"status": "tls_failure", "error": "Homepage failed after 5 attempts (likely node-level TLS issue)"}))
            sys.exit(0)
        time.sleep(random.uniform(0.5, 1.5))

        session = _RetrySession(session)

        # Step 1: Signin (chatgpt.com flow — no add_phone requirement)
        _log("Step 1: CSRF + Signin...")
        r = session.get(f"{BASE}/api/auth/csrf", headers={"Accept": "application/json"}, timeout=15)
        csrf = r.json().get("csrfToken", "")
        if not csrf: raise Exception("CSRF failed")
        time.sleep(random.uniform(0.3, 0.8))

        signin_params = {"prompt": "login", "ext-oai-did": device_id,
            "auth_session_logging_id": str(uuid.uuid4()), "screen_hint": "login_or_signup", "login_hint": email}
        r = session.post(f"{BASE}/api/auth/signin/openai", params=signin_params,
            data={"callbackUrl": f"{BASE}/", "csrfToken": csrf, "json": "true"},
            headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}, timeout=15)
        auth_url = r.json().get("url", "")
        if not auth_url: raise Exception("Signin failed")
        time.sleep(random.uniform(0.5, 1.2))

        _log("Step 2: Authorize...")
        r = session.get(auth_url, headers={"Accept": "text/html", "Upgrade-Insecure-Requests": "1", "Referer": f"{BASE}/"}, allow_redirects=True, timeout=30)
        final_url = str(r.url)
        final_path = urlparse(final_url).path
        _log(f"Authorize -> {final_path}")

        # Check if landing page is an error page (account deleted/deactivated)
        page_html = r.text or ""
        if "account_deactivated" in page_html or "account_disabled" in page_html:
            _log("Account deactivated/deleted detected on authorize page")
            print(json.dumps({"status": "deactivated", "error": "account_deactivated"}))
            return

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
            except Exception: pass
            r = session.post(f"{AUTH}/api/accounts/authorize/continue",
                json={"username": {"kind": "email", "value": email}},
                headers={"Accept": "application/json", "Content-Type": "application/json",
                    "Origin": AUTH, "Referer": final_url, "oai-device-id": device_id,
                    "openai-sentinel-token": sentinel, "ext-passkey-client-capabilities": "conditional-create,conditional-get"}, timeout=30)
            try:
                page_data = r.json()
            except Exception:
                page_data = {}
            page_type = (page_data.get("page") or {}).get("type", "")
            _log(f"Email response: page={page_type}")
            # Check for deactivated/deleted account
            body_text = r.text or ""
            if "account_deactivated" in body_text or "account_disabled" in body_text:
                _log("Account deactivated detected in authorize/continue response")
                print(json.dumps({"status": "deactivated", "error": "account_deactivated"}))
                return
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
            except Exception: pass
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
            # authorize/continue triggers OTP email automatically
            # Do NOT call /email-otp/send — it can break the session (401 on validate)
            time.sleep(5)
            otp = _fetch_imap_otp(email, client_id, refresh_token, imap_baseline, timeout=90)
            if not otp:
                raise Exception("OTP not received")
            _log(f"OTP: {otp}")

            sentinel = ""
            try:
                sentinel = build_sentinel_token(session, device_id, flow="email_otp_validate", user_agent=ua, sec_ch_ua=sec_ch_ua) or ""
            except Exception: pass
            r = session.post(f"{AUTH}/api/accounts/email-otp/validate",
                json={"code": otp},
                headers={"Accept": "application/json", "Content-Type": "application/json",
                    "Origin": AUTH, "Referer": f"{AUTH}/email-verification",
                    "oai-device-id": device_id, "openai-sentinel-token": sentinel,
                    "ext-passkey-client-capabilities": "conditional-create,conditional-get"}, timeout=30)
            try:
                otp_data = r.json()
            except Exception:
                otp_data = {}
            otp_page = (otp_data.get("page") or {}).get("type", "")
            otp_continue = otp_data.get("continue_url", "")
            _log(f"OTP response: {r.status_code} page={otp_page} continue={otp_continue[:60]}")
            if r.status_code != 200:
                body_preview = (r.text or "")[:200]
                _log(f"OTP error body: {body_preview}")
                # Detect account deletion/deactivation
                if "account_deactivated" in body_preview or "account_disabled" in body_preview or "deleted" in body_preview.lower():
                    _log("Account deactivated/deleted by OpenAI")
                    print(json.dumps({"status": "deactivated", "error": "account_deactivated"}))
                    return
                raise Exception(f"OTP validation failed: {r.status_code} {body_preview[:80]}")

        # Step 6: About-you (handle both new and existing accounts)
        continue_url = otp_continue if need_otp else ""
        page_type = otp_page if need_otp else ""

        if "about_you" in str(page_type) or "about-you" in str(continue_url):
            _log("Step 6: About-you...")
            # GET about-you page first (may redirect to consent for existing accounts)
            try:
                r = session.get(f"{AUTH}/about-you", headers={"Accept": "text/html", "Upgrade-Insecure-Requests": "1",
                    "Referer": f"{AUTH}/email-verification"}, allow_redirects=True, timeout=30)
                about_final = str(r.url)
                _log(f"GET about-you -> {about_final[:60]}")
                if "consent" in about_final or "organization" in about_final:
                    continue_url = about_final
                    page_type = "consent"
                    _log("Redirected to consent!")
            except Exception:
                pass

            if "consent" not in str(page_type):
                # POST create_account
                names_first = ["James", "Mary", "John", "Linda", "Robert", "Sarah"]
                names_last = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Davis"]
                name = f"{random.choice(names_first)} {random.choice(names_last)}"
                bdate = f"{random.randint(1990, 2002)}-{random.randint(1,12):02d}-{random.randint(1,28):02d}"
                _log(f"create_account: name={name}, bdate={bdate}")

                # Try 1: with browser-based Turnstile sentinel (headless, no visible window)
                sentinel = ""
                try:
                    from chatgpt_register.sentinel_browser import get_sentinel_token_browser
                    sentinel = get_sentinel_token_browser(device_id) or ""
                    if sentinel:
                        _log("Sentinel token (Turnstile) obtained")
                except Exception as e:
                    _log(f"Turnstile failed: {str(e)[:40]}")

                # Try 2: protocol PoW fallback
                if not sentinel:
                    try: sentinel = build_sentinel_token(session, device_id, flow="create_account", user_agent=ua, sec_ch_ua=sec_ch_ua) or ""
                    except Exception: pass
                    if sentinel:
                        _log("Sentinel token (PoW) obtained")

                headers_ca = {"Accept": "application/json", "Content-Type": "application/json",
                    "Origin": AUTH, "Referer": f"{AUTH}/about-you", "oai-device-id": device_id,
                    "ext-passkey-client-capabilities": "conditional-create,conditional-get"}
                if sentinel:
                    headers_ca["openai-sentinel-token"] = sentinel
                r = session.post(f"{AUTH}/api/accounts/create_account",
                    json={"name": name, "birthdate": bdate}, headers=headers_ca, timeout=30)
                _log(f"create_account: {r.status_code} {r.text[:120]}")
                if r.status_code == 200:
                    try:
                        ca_data = r.json()
                        continue_url = ca_data.get("continue_url", "") or continue_url
                        page_type = (ca_data.get("page") or {}).get("type", "") or page_type
                    except Exception: pass
                elif r.status_code == 400 and "already_exists" in (r.text or "already"):
                    _log("Account already exists, jumping to consent")
                    continue_url = f"{AUTH}/sign-in-with-chatgpt/codex/consent"
                    page_type = "consent"

        # Step 7: Follow continue_url (callback) to get accessToken
        _log("Step 7: Getting accessToken...")
        access_token = None
        session_data = {}

        # Follow continue_url — prefer updated continue_url (from create_account) over otp_continue
        final_continue = continue_url or (otp_continue if need_otp else "")
        if final_continue and "chatgpt.com" in final_continue:
            _log(f"Following callback: {final_continue[:60]}...")
            try:
                r = session.get(final_continue, headers={"Accept": "text/html", "Upgrade-Insecure-Requests": "1"}, allow_redirects=True, timeout=30)
                _log(f"Callback -> {str(r.url)[:60]}")
            except Exception as e:
                _log(f"Callback error: {str(e)[:50]}")

        # Get session
        time.sleep(1)
        try:
            r = session.get(f"{BASE}/api/auth/session", headers={"Accept": "application/json"}, timeout=15)
            session_data = r.json()
            access_token = session_data.get("accessToken")
        except Exception: pass

        if not access_token and final_continue and "auth.openai.com" in str(final_continue):
            # continue_url is on auth.openai.com (about_you/add_phone) — follow then retry
            _log(f"Following auth continue: {final_continue[:60]}...")
            try:
                r = session.get(final_continue, headers={"Accept": "text/html", "Upgrade-Insecure-Requests": "1"}, allow_redirects=True, timeout=30)
            except Exception: pass
            time.sleep(1)
            try:
                r = session.get(f"{BASE}/api/auth/session", headers={"Accept": "application/json"}, timeout=15)
                session_data = r.json()
                access_token = session_data.get("accessToken")
            except Exception: pass

        if not access_token:
            page_info = page_type or (otp_page if need_otp else "unknown")
            _log(f"No accessToken (page: {page_info})")
            print(json.dumps({"status": "error", "error": f"Auth OK but no accessToken (page: {page_info})"}))
            return

        _log(f"accessToken: {access_token[:20]}...")

        # accessToken obtained — checkout link will be fetched via Discord by Node.js engine
        checkout_url = ""
        checkout_error = ""

        plan_type = session_data.get("account", {}).get("planType", session_data.get("chatgpt_plan_type", "free"))

        _log(f"Done! Plan: {plan_type}")

        # PKCE OAuth flow (if requested)
        pkce_result = {}
        if do_pkce:
            _log("Step 8: PKCE OAuth flow...")
            try:
                pkce_result = _do_pkce_flow(session, email, password, client_id, refresh_token)
            except Exception as e:
                _log(f"PKCE error: {str(e)[:80]}")
                pkce_result = {"error": str(e)[:200]}

        print(json.dumps({
            "status": "success",
            "accessToken": access_token,
            "session": session_data,
            "checkoutUrl": checkout_url,
            "checkoutError": checkout_error,
            "planType": plan_type,
            "password": password,
            "pkce": pkce_result,
        }))

    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"status": "error", "error": str(e)[:200]}))

if __name__ == "__main__":
    main()
