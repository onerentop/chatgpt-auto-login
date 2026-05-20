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
            otp_continue = otp_data.get("continue_url", "")
            _log(f"OTP response: {r.status_code} page={otp_page} continue={otp_continue[:60]}")
            if r.status_code != 200:
                raise Exception(f"OTP validation failed: {r.status_code}")

        # Step 6: About-you (if needed) — skip for existing accounts (400 = already exists)
        if need_register or ("about_you" in str(otp_page if need_otp else "") and need_register):
            _log("Step 6: About-you (new account)...")
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

        # Follow continue_url from OTP or about_you if available
        final_continue = otp_continue if need_otp else ""
        if final_continue:
            try:
                full = final_continue if final_continue.startswith("http") else f"{AUTH}{final_continue}"
                _log(f"Following continue_url: {full[:60]}...")
                r = session.get(full, headers={"Accept": "text/html", "Upgrade-Insecure-Requests": "1"}, allow_redirects=True, timeout=30)
                _log(f"Continue -> {str(r.url)[:60]}")
            except Exception as e:
                _log(f"Continue URL error: {str(e)[:50]}")

        # Visit chatgpt.com to pick up session cookies
        time.sleep(1)
        session.get(f"{BASE}/", headers={"Accept": "text/html", "Upgrade-Insecure-Requests": "1"}, allow_redirects=True, timeout=30)
        time.sleep(1)
        r = session.get(f"{BASE}/api/auth/session", headers={"Accept": "application/json"}, timeout=15)
        session_data = r.json()
        access_token = session_data.get("accessToken")

        if not access_token:
            # Fallback: use reference project's full OAuth method (handles about_you + consent + PKCE)
            _log("Session token failed, trying full OAuth login via reference project...")
            try:
                from chatgpt_register.chatgpt_register import ChatGPTRegister
                reg = ChatGPTRegister(proxy=None)
                tokens = reg.perform_codex_oauth_login_http(email=email, password=password, email_addr=email)
                if tokens and tokens.get("access_token"):
                    access_token = tokens["access_token"]
                    session_data = {"accessToken": access_token}
                    _log(f"OAuth login OK: {access_token[:20]}...")
            except Exception as e:
                _log(f"OAuth login failed: {str(e)[:60]}")

        if not access_token:
            raise Exception("Failed to get accessToken")
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
