"""
GoPay Pure-Protocol Worker — registration + payment parallel pipeline.

Self-contained deployment version — all imports are local (no C:\\tools dependency).

Each worker thread loops independently:
  1. Register GoPay account (rent phone → signup → refresh → PIN)
  2. Push account to inbox, wait for balance > 0
  3. Claim inbox job → pure-protocol Midtrans payment
  4. Done or failed → loop back to step 1
"""
from __future__ import annotations

import base64
import json
import logging
import os
import random
import string
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from . import config as cfg
from .sms_helpers import (
    api_call_with_retry, get_error_code,
    is_waf_block, is_rate_limited,
)
from .sms_provider import SmsProvider, create_sms_provider
from .gojek_client import GojekClient, CLIENT_ID as _GOJEK_CLIENT_ID, CLIENT_SECRET as _GOJEK_CLIENT_SECRET

from .envelope_manager import EnvelopeManager
from .gopay_payment_protocol import GoPayPayment, GoPayFraudDenyError

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

INBOX_URL = cfg.get("inbox", "base_url")
INBOX_USER = cfg.get("inbox", "basic_user")
INBOX_PASS = cfg.get("inbox", "basic_pass")
POLL_INTERVAL = float(cfg.get("gopay", "poll_interval", 10))
MIN_REMAINING_SEC = int(cfg.get("gopay", "min_remaining_sec", 300))
DEFAULT_PIN = cfg.get("gopay", "default_pin", "147258")
MIN_BALANCE_RP = int(cfg.get("gopay", "min_balance_rp", 1))

GOPAY_ACCOUNT_TTL = int(cfg.get("gopay", "account_ttl_sec", 1200))

_NOVPROXY_TPL = cfg.get("gopay", "proxy_template")


def _make_proxy() -> str:
    override = cfg.get("gopay", "register_proxy")
    if override:
        return override
    if not _NOVPROXY_TPL:
        return ""
    sid = "gp" + "".join(random.choices(string.ascii_letters + string.digits, k=6))
    return _NOVPROXY_TPL.format(sid=sid)


# ---------------------------------------------------------------------------
# Inbox account sync
# ---------------------------------------------------------------------------

_INBOX_AUTH = None


def _inbox_auth_header() -> str:
    global _INBOX_AUTH
    if _INBOX_AUTH is None:
        _INBOX_AUTH = "Basic " + base64.b64encode(f"{INBOX_USER}:{INBOX_PASS}".encode()).decode()
    return _INBOX_AUTH


def _inbox_push_account(phone: str, data: dict):
    try:
        url = f"{INBOX_URL}/api/gopay-accounts"
        req = urllib.request.Request(url, data=json.dumps(data).encode(), method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("Authorization", _inbox_auth_header())
        urllib.request.urlopen(req, timeout=10)
        log.info("[inbox] %s pushed", phone)
    except Exception as e:
        log.warning("[inbox] %s push failed: %s", phone, e)


def _inbox_delete_account(phone: str):
    try:
        url = f"{INBOX_URL}/api/gopay-accounts/{urllib.parse.quote(phone, safe='')}"
        req = urllib.request.Request(url, method="DELETE")
        req.add_header("Authorization", _inbox_auth_header())
        urllib.request.urlopen(req, timeout=10)
        log.info("[inbox] %s deleted", phone)
    except Exception as e:
        log.debug("[inbox] %s delete failed: %s", phone, e)


def _inbox_ttl_cleanup():
    def _loop():
        while True:
            time.sleep(60)
            try:
                url = f"{INBOX_URL}/api/gopay-accounts"
                req = urllib.request.Request(url)
                req.add_header("Authorization", _inbox_auth_header())
                resp = urllib.request.urlopen(req, timeout=10)
                data = json.loads(resp.read().decode())
                now = time.time()
                for a in data.get("accounts", []):
                    added = a.get("added_at", "")
                    if not added:
                        continue
                    try:
                        ts = datetime.fromisoformat(added.replace("Z", "+00:00")).timestamp()
                    except Exception:
                        continue
                    if now - ts > GOPAY_ACCOUNT_TTL:
                        phone = a.get("phone", "")
                        if phone:
                            log.info("[inbox-ttl] %s expired (%.0fs old), removing", phone, now - ts)
                            _inbox_delete_account(phone)
            except Exception as e:
                log.debug("[inbox-ttl] cleanup error: %s", e)

    t = threading.Thread(target=_loop, daemon=True, name="inbox-ttl")
    t.start()


# ---------------------------------------------------------------------------
# Deferred phone cancel
# ---------------------------------------------------------------------------

_CANCEL_MIN_AGE = 130


def _deferred_cancel_phone(provider: SmsProvider, activation_id: str, phone: str, rented_at: float):
    def _loop():
        _inbox_delete_account(phone)
        wait = max(0, _CANCEL_MIN_AGE - (time.time() - rented_at))
        if wait > 0:
            time.sleep(wait + 5)
        deadline = rented_at + 1200
        while time.time() < deadline:
            try:
                provider.cancel(activation_id)
                log.info("[cancel] %s done", phone)
                return
            except Exception as e:
                log.debug("[cancel] %s error: %s", phone, e)
            time.sleep(180)
        log.info("[cancel] %s gave up (20min auto-reclaim)", phone)

    t = threading.Thread(target=_loop, daemon=True, name=f"cancel-{phone}")
    t.start()


# ---------------------------------------------------------------------------
# Account persistence
# ---------------------------------------------------------------------------

ACCOUNTS_FILE = os.environ.get(
    "OPAI_GOPAY_ACCOUNTS_FILE",
    str(Path(__file__).resolve().parent.parent.parent.parent.parent / "config" / "gopay_worker_accounts.json"),
)
_accounts_lock = threading.Lock()


def _save_account(phone: str, local: str, pin: str, aid: str, client: GojekClient):
    entry = {
        "phone": phone,
        "local": local,
        "pin": pin,
        "activation_id": aid,
        "customer_id": client.user_uuid,
        "access_token": client.auth.access_token,
        "refresh_token": client.auth.refresh_token,
        "registered_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "balance": 0,
    }
    with _accounts_lock:
        accounts = []
        if os.path.exists(ACCOUNTS_FILE):
            try:
                accounts = json.loads(open(ACCOUNTS_FILE, encoding="utf-8").read())
            except Exception:
                pass
        accounts.append(entry)
        open(ACCOUNTS_FILE, "w", encoding="utf-8").write(json.dumps(accounts, indent=2, ensure_ascii=False))
    log.info("[save] %s saved locally", phone)
    _inbox_push_account(phone, {**entry, "added_at": entry["registered_at"]})


def _update_account_balance(phone: str, balance: int, client: GojekClient):
    with _accounts_lock:
        accounts = []
        if os.path.exists(ACCOUNTS_FILE):
            try:
                accounts = json.loads(open(ACCOUNTS_FILE, encoding="utf-8").read())
            except Exception:
                return
        for a in accounts:
            if a["phone"] == phone:
                a["balance"] = balance
                a["access_token"] = client.auth.access_token
                a["refresh_token"] = client.auth.refresh_token
                break
        open(ACCOUNTS_FILE, "w", encoding="utf-8").write(json.dumps(accounts, indent=2, ensure_ascii=False))
    log.info("[save] %s balance=%d updated locally", phone, balance)


def _check_balance(client: GojekClient) -> int:
    try:
        r = client.get_balance()
        if r["status"] == 200:
            data = r["body"].get("data", [])
            if isinstance(data, list) and data:
                return data[0].get("balance", {}).get("value", 0)
        return -1
    except Exception:
        return -1


# ---------------------------------------------------------------------------
# Register one GoPay account
# ---------------------------------------------------------------------------

def _register_one(provider: SmsProvider, pin: str, proxy: str, envelope_did: str) -> Optional[dict]:
    """Full registration flow: rent phone -> signup -> refresh -> PIN."""
    phone, aid = provider.get_number()
    if not phone:
        log.error("No phone number available")
        return "NO_STOCK"

    rented_at = time.time()
    local = phone.lstrip("+")
    if local.startswith("62"):
        local = local[2:]

    log.info("[%s] Proxy: %s", phone, proxy.split("@")[-1] if "@" in proxy else "direct")
    client = GojekClient.from_phone(phone, proxy=proxy)
    success = False
    account_created = False

    try:
        # === Phase 1: Login check ===
        time.sleep(2)
        methods = api_call_with_retry(client.get_login_methods, "+62", local)

        if is_rate_limited(methods):
            log.warning("[%s] Rate limited on login check, need new IP", phone)
            return "RATE_LIMITED"

        if methods["status"] in (200, 201):
            log.info("[%s] Already registered, skipping", phone)
            return None

        err_code = get_error_code(methods)
        if methods["status"] == 403 or is_waf_block(methods):
            log.warning("[%s] WAF 403, need new proxy IP", phone)
            return "RATE_LIMITED"

        # === Signup ===
        log.info("[%s] New number -> signup", phone)
        otp_result = client.signup_request_otp(phone)
        if is_rate_limited(otp_result):
            log.warning("[%s] Rate limited on signup OTP, need new IP", phone)
            return "RATE_LIMITED"
        if otp_result["status"] not in (200, 201):
            log.error("[%s] Signup OTP failed: %d", phone, otp_result["status"])
            return None

        otp = provider.wait_code(aid, timeout=60)
        if not otp:
            log.error("[%s] Signup OTP timeout", phone)
            return None
        log.info("[%s] Signup OTP: %s", phone, otp)

        time.sleep(2)
        verify = api_call_with_retry(client.signup_verify_otp, otp, phone)
        if verify["status"] not in (200, 201):
            log.error("[%s] Signup verify failed: %d", phone, verify["status"])
            return None

        time.sleep(2)
        names = [
            "Budi Santoso", "Adi Pratama", "Siti Rahayu", "Dewi Lestari",
            "Rizky Ramadhan", "Putri Wulandari", "Agus Setiawan", "Rina Kusuma",
            "Hendra Wijaya", "Novi Anggraini", "Dian Permata", "Wahyu Hidayat",
            "Fitri Handayani", "Joko Susilo", "Ratna Sari", "Bambang Prasetyo",
            "Mega Puspita", "Eko Nugroho", "Sari Indah", "Yusuf Maulana",
            "Lina Marlina", "Arief Rahman", "Wati Suryani", "Dedi Kurniawan",
            "Ayu Lestari", "Rudi Hartono", "Nisa Fitriani", "Bayu Anggara",
            "Sri Mulyani", "Fajar Setiadi", "Indra Gunawan", "Tika Rahmawati",
        ]
        signup = api_call_with_retry(client.signup_create_account,
                                     name=random.choice(names), phone=phone, email="", country="ID")
        if signup["status"] not in (200, 201):
            err = get_error_code(signup)
            if "phone_already_taken" not in err:
                log.error("[%s] Signup failed: %s", phone, signup["body"])
                return None
        log.info("[%s] Signup success (uid=%s)", phone, client.user_uuid)
        account_created = True

        # === Phase 2: Refresh ===
        time.sleep(5)
        refresh = api_call_with_retry(client.refresh_token)
        if refresh["status"] not in (200, 201):
            log.error("[%s] Token refresh failed: %d (account saved, resume later)", phone, refresh["status"])
            _save_account(phone, local, pin, aid, client)
            success = True
            return {"phone": phone, "aid": aid, "pin": pin, "client": client, "local": local}
        log.info("[%s] Token refreshed", phone)

        # === Phase 3: GoPay Init ===
        time.sleep(2)
        api_call_with_retry(client.gopay_init)
        time.sleep(2)
        api_call_with_retry(client.gopay_get_profiles)
        time.sleep(2)
        profile = api_call_with_retry(client.get_user_profile)
        is_pin_set = profile["body"].get("data", {}).get("is_pin_setup", False) if profile["status"] == 200 else False

        if is_pin_set:
            log.info("[%s] PIN already set", phone)
        else:
            # === Phase 4: PIN Setup ===
            log.info("[%s] Setting PIN...", phone)
            provider.request_another(aid)
            time.sleep(2)

            pin_otp_r = api_call_with_retry(client.pin_request_otp)
            if pin_otp_r["status"] not in (200, 201):
                log.error("[%s] PIN OTP request failed: %d (account saved, resume later)", phone, pin_otp_r["status"])
                _save_account(phone, local, pin, aid, client)
                success = True
                return {"phone": phone, "aid": aid, "pin": pin, "client": client, "local": local}

            pin_code = provider.wait_code(aid, timeout=60)
            if not pin_code:
                log.warning("[%s] PIN OTP timeout 60s, resending...", phone)
                resend_body = {
                    "client_id": _GOJEK_CLIENT_ID,
                    "client_secret": _GOJEK_CLIENT_SECRET,
                    "flow": "goto_pin_wa_sms",
                    "verification_id": client.auth.verification_id,
                    "verification_method": "otp_sms",
                }
                time.sleep(2)
                resend = client._sso_post("/cvs/v1/initiate", resend_body)
                if resend["status"] in (200, 201):
                    inner = resend["body"].get("data", resend["body"])
                    client.auth.otp_token = inner.get("otp_token", "")
                    provider.request_another(aid)
                    pin_code = provider.wait_code(aid, timeout=60)

            if not pin_code:
                log.error("[%s] PIN OTP not received (account saved, resume later)", phone)
                _save_account(phone, local, pin, aid, client)
                success = True
                return {"phone": phone, "aid": aid, "pin": pin, "client": client, "local": local}
            log.info("[%s] PIN OTP: %s", phone, pin_code)

            time.sleep(2)
            pin_verify = api_call_with_retry(client.pin_verify_otp, pin_code)
            if pin_verify["status"] not in (200, 201):
                log.error("[%s] PIN verify failed: %d (account saved, resume later)", phone, pin_verify["status"])
                _save_account(phone, local, pin, aid, client)
                success = True
                return {"phone": phone, "aid": aid, "pin": pin, "client": client, "local": local}

            time.sleep(2)
            pin_result = api_call_with_retry(client.pin_setup, pin)
            if pin_result["status"] not in (200, 201):
                log.error("[%s] PIN setup failed: %d (account saved, resume later)", phone, pin_result["status"])
                _save_account(phone, local, pin, aid, client)
                success = True
                return {"phone": phone, "aid": aid, "pin": pin, "client": client, "local": local}
            log.info("[%s] PIN set OK", phone)

        # === Phase 5: Full login to get login-session token ===
        # Consent only triggers 1 Rp when called with a login-session JWE token.
        # GoPay App uses different client creds + app identity than Gojek App.
        log.info("[%s] Re-login for login-session token...", phone)
        time.sleep(5)
        import opai.core.gojek_client as _gc
        _orig_cid, _orig_csec = _gc.CLIENT_ID, _gc.CLIENT_SECRET
        _orig_appid, _orig_ver = client.appid, client.version
        _saved_access = client.auth.access_token
        _saved_refresh = client.auth.refresh_token
        try:
            _gc.CLIENT_ID = "gopay:consumer:app"
            _gc.CLIENT_SECRET = "raOUumeMRBNifqvZRFjvsgTnjAlaA9"
            client.appid = "com.gojek.gopay"
            client.version = "2.8.0"

            def _wait_login_otp():
                provider.request_another(aid)
                return provider.wait_code(aid, timeout=120)

            login_r = client.login("+62", local, pin, otp_callback=_wait_login_otp)
            if login_r["status"] in (200, 201):
                log.info("[%s] Login OK, got login-session token", phone)
            else:
                log.warning("[%s] Login failed: %d (consent may not trigger 1 Rp)", phone, login_r["status"])
                client.auth.access_token = _saved_access
                client.auth.refresh_token = _saved_refresh
        except Exception as e:
            log.warning("[%s] Login failed: %s (consent may not trigger 1 Rp)", phone, e)
            client.auth.access_token = _saved_access
            client.auth.refresh_token = _saved_refresh
        finally:
            _gc.CLIENT_ID, _gc.CLIENT_SECRET = _orig_cid, _orig_csec
            client.appid, client.version = _orig_appid, _orig_ver

        # === Phase 6: Accept consents (triggers 1 Rp initial credit) ===
        time.sleep(2)
        try:
            consent_r = api_call_with_retry(client.accept_consents, "signIn")
            if consent_r["status"] in (200, 201):
                log.info("[%s] Consents accepted", phone)
            else:
                log.warning("[%s] Consent accept returned %d (non-fatal)", phone, consent_r["status"])
        except Exception as e:
            log.warning("[%s] Consent accept failed: %s (non-fatal)", phone, e)

        _save_account(phone, local, pin, aid, client)

        success = True
        return {"phone": phone, "aid": aid, "pin": pin, "client": client, "local": local}

    except Exception as e:
        if account_created:
            log.error("[%s] Post-signup exception: %s (account saved, resume later)", phone, e)
            _save_account(phone, local, pin, aid, client)
            success = True
            return {"phone": phone, "aid": aid, "pin": pin, "client": client, "local": local}
        log.exception("[%s] Registration exception: %s", phone, e)
        return None
    finally:
        if not success:
            try:
                provider.cancel(aid)
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Job handling
# ---------------------------------------------------------------------------

def _job_remaining_sec(job: dict) -> float:
    expires = job.get("expires_at", "")
    if not expires:
        return 3600
    try:
        exp = datetime.fromisoformat(expires.replace("Z", "+00:00"))
        return (exp - datetime.now(timezone.utc)).total_seconds()
    except Exception:
        return 3600


def _get_envelope_did() -> str:
    try:
        url = f"{INBOX_URL}/api/envelopes"
        req = urllib.request.Request(url)
        cred = base64.b64encode(f"{INBOX_USER}:{INBOX_PASS}".encode()).decode()
        req.add_header("Authorization", f"Basic {cred}")
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        for e in data.get("envelopes", []):
            if e.get("status") == "active":
                return e["deeplink_id"]
    except Exception as exc:
        log.debug("Failed to fetch envelope from inbox: %s", exc)
    return ""


# ---------------------------------------------------------------------------
# Payment
# ---------------------------------------------------------------------------

def _pay_job(job: dict, account: dict, inbox_client, provider: SmsProvider, pin: str, proxy: str = "") -> tuple[bool, str]:
    job_id = job["id"]
    midtrans_url = job.get("provider_url") or job.get("paypal_url") or ""
    phone = account["local"]
    log.info("[job:%s] Paying with %s (protocol)", job_id[:8], account["phone"])

    try:
        payment = GoPayPayment(proxy=proxy)

        def wait_otp(ph: str, timeout: int = 120) -> Optional[str]:
            try:
                provider.request_another(account["aid"])
            except Exception:
                pass
            time.sleep(2)
            return provider.wait_code(account["aid"], timeout=timeout)

        result = payment.pay(
            midtrans_url=midtrans_url,
            phone=phone,
            country_code="62",
            pin=pin,
            wait_otp=wait_otp,
        )

        detail = result.get("detail", "")
        if result.get("success"):
            log.info("[job:%s] Payment SUCCESS!", job_id[:8])
            try:
                inbox_client._req("PUT", f"/api/jobs/{job_id}/paid")
            except Exception as e:
                log.error("[job:%s] Mark paid failed: %s", job_id[:8], e)
            return True, detail
        else:
            log.warning("[job:%s] Payment failed: %s", job_id[:8], detail)
            try:
                inbox_client._req("PUT", f"/api/jobs/{job_id}/cancel")
            except Exception:
                pass
            return False, detail

    except GoPayFraudDenyError as e:
        log.warning("[job:%s] FRAUD DENIED: %s", job_id[:8], e)
        try:
            inbox_client._req("PUT", f"/api/jobs/{job_id}/cancel")
        except Exception:
            pass
        return False, "fraud_deny -- phone burned"

    except Exception as e:
        log.exception("[job:%s] Payment exception: %s", job_id[:8], e)
        try:
            inbox_client._req("PUT", f"/api/jobs/{job_id}/cancel")
        except Exception:
            pass
        return False, str(e)


def _claim_job(inbox, min_remaining: float = MIN_REMAINING_SEC) -> Optional[dict]:
    try:
        job = inbox._req("POST", "/api/jobs/claim_next", data={
            "prefer_paypal_url": False, "prefer_oldest": True, "provider": "gopay",
        })
    except RuntimeError as e:
        if "HTTP 404" not in str(e):
            log.warning("Inbox poll error: %s", e)
        return None
    except Exception as e:
        log.warning("Inbox poll error: %s", e)
        return None

    if job is None:
        return None

    url = job.get("provider_url") or job.get("paypal_url") or ""
    if "midtrans" not in url:
        return None

    remaining = _job_remaining_sec(job)
    if remaining < min_remaining:
        log.info("Job %s: %.0fs left < %ds, cancelling", job["id"][:8], remaining, min_remaining)
        try:
            inbox._req("PUT", f"/api/jobs/{job['id']}/cancel")
        except Exception:
            pass
        return None

    return job


# ---------------------------------------------------------------------------
# Phone reactivation
# ---------------------------------------------------------------------------

_PHONE_LIFETIME = 1080



def _resume_account(phone: str, proxy: str = "") -> Optional[dict]:
    if not os.path.exists(ACCOUNTS_FILE):
        log.error("[resume] %s not found", ACCOUNTS_FILE)
        return None
    accounts = json.loads(open(ACCOUNTS_FILE, encoding="utf-8").read())
    digits = phone.strip().lstrip("+")
    entry = None
    for a in accounts:
        a_digits = a["phone"].strip().lstrip("+")
        if a_digits == digits or a.get("local", "") == digits or digits.endswith(a.get("local", "\x00")):
            entry = a
            break
    if not entry:
        log.error("[resume] phone %s not found in %s", phone, ACCOUNTS_FILE)
        return None

    if not proxy:
        proxy = _make_proxy()
    client = GojekClient.from_phone(entry["phone"], proxy=proxy)
    client.auth.access_token = entry["access_token"]
    client.auth.refresh_token = entry["refresh_token"]
    client.user_uuid = entry.get("customer_id", "")

    log.info("[resume] Refreshing token for %s...", entry["phone"])
    try:
        r = client.refresh_token()
        if r["status"] in (200, 201):
            log.info("[resume] Token refreshed OK for %s", entry["phone"])
        else:
            log.warning("[resume] Token refresh returned %d, trying with existing token", r["status"])
    except Exception as e:
        log.warning("[resume] Token refresh failed: %s, trying with existing token", e)

    return {
        "phone": entry["phone"],
        "client": client,
        "aid": entry.get("activation_id", ""),
        "pin": entry.get("pin", DEFAULT_PIN),
        "local": entry.get("local", ""),
        "resumed": True,
    }


# ---------------------------------------------------------------------------
# Worker loop
# ---------------------------------------------------------------------------

def _worker_loop(
    inbox, provider: SmsProvider, pin: str, stop: threading.Event,
    worker_id: int,
    resume_phone: str = "",
):
    tag = f"[w{worker_id}]"
    envelope_did = _get_envelope_did()

    while not stop.is_set():
        # === Register or resume ===
        if resume_phone:
            log.info("%s Resuming account %s...", tag, resume_phone)
            proxy = _make_proxy()
            account = _resume_account(resume_phone, proxy)
            resume_phone = ""
        else:
            new_did = _get_envelope_did()
            if new_did:
                envelope_did = new_did
            log.info("%s Registering new GoPay account...", tag)
            proxy = _make_proxy()
            account = _register_one(provider, pin, proxy, envelope_did)
            if account == "NO_STOCK":
                # no number at current price -> escalate and retry sooner
                provider.escalate_price()
                account = None

        if not account or not isinstance(account, dict):
            log.warning("%s Registration/resume failed, retry in 10s", tag)
            stop.wait(10)
            continue

        phone = account["phone"]
        client = account["client"]
        aid = account["aid"]
        is_resumed = account.get("resumed", False)
        register_time = 0 if is_resumed else time.time()
        log.info("%s Account ready: %s%s", tag, phone, " (resumed)" if is_resumed else "")

        # === Wait for balance >= MIN_BALANCE_RP ===
        balance_ok = False
        max_wait = 3600
        wait_start = time.time()
        phone_activated_at = register_time
        reactivate_count = 0
        max_reactivates = 3
        while not stop.is_set():
            if time.time() - wait_start > max_wait:
                log.warning("%s Waited %ds for balance, giving up", tag, max_wait)
                break

            phone_age = time.time() - phone_activated_at
            if phone_age > _PHONE_LIFETIME - 120:
                if reactivate_count < max_reactivates:
                    log.info("%s Phone expiring during balance wait, reactivating (%d/%d)...",
                             tag, reactivate_count + 1, max_reactivates)
                    new_aid = provider.reactivate(aid)
                    if new_aid:
                        aid = new_aid
                        account["aid"] = new_aid
                        phone_activated_at = time.time()
                        reactivate_count += 1
                    else:
                        log.warning("%s Reactivate failed during balance wait, phone may be lost", tag)
                        reactivate_count += 1

            bal = _check_balance(client)
            if bal >= MIN_BALANCE_RP:
                log.info("%s Balance=%d Rp (>=%d), ready!", tag, bal, MIN_BALANCE_RP)
                _update_account_balance(phone, bal, client)
                _inbox_delete_account(phone)
                balance_ok = True
                break
            elif bal >= 0:
                waited = int(time.time() - wait_start)
                log.info("%s Balance=%d Rp (need >=%d), waiting 15s... (%ds elapsed)", tag, bal, MIN_BALANCE_RP, waited)
                stop.wait(15)
            else:
                log.warning("%s Balance check failed, trying token refresh", tag)
                try:
                    client.refresh_token()
                except Exception:
                    pass
                stop.wait(30)

        if not balance_ok:
            log.info("%s No balance after waiting, registering new account", tag)
            continue

        # === Payment loop ===
        while not stop.is_set():
            phone_age = time.time() - phone_activated_at
            if phone_age > _PHONE_LIFETIME - 120:
                if reactivate_count >= max_reactivates:
                    log.info("%s Max reactivates (%d) reached, retiring phone", tag, max_reactivates)
                    break
                log.info("%s Phone expiring, reactivating (%d/%d)...", tag, reactivate_count + 1, max_reactivates)
                new_aid = provider.reactivate(aid)
                if new_aid:
                    aid = new_aid
                    account["aid"] = new_aid
                    phone_activated_at = time.time()
                    reactivate_count += 1
                    log.info("%s Reactivated, new aid=%s", tag, new_aid)
                else:
                    log.warning("%s Reactivate failed, retiring phone", tag)
                    break

            job = _claim_job(inbox)
            if not job:
                stop.wait(POLL_INTERVAL)
                continue

            remaining = _job_remaining_sec(job)
            phone_left = _PHONE_LIFETIME - (time.time() - phone_activated_at)
            log.info("%s Job %s -> %s (job %.0fs, phone %.0fs)",
                     tag, job["id"][:8], phone, remaining, phone_left)

            success, detail = _pay_job(job, account, inbox, provider, pin, proxy=proxy)
            if success:
                log.info("%s Job %s paid!", tag, job["id"][:8])
                break

            if "fraud_deny" in detail.lower() or "fraud denied" in detail.lower() or "burned" in detail.lower():
                log.warning("%s FRAUD DENIED, retiring phone", tag)
                break

            if "already linked" in detail.lower():
                log.warning("%s Already linked, retiring phone", tag)
                break

            log.warning("%s Job %s failed (%s), next job", tag, job["id"][:8], detail[:60])

        # === Release phone ===
        try:
            provider.done(aid)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------

def run_worker(
    max_workers: int = 3,
    pin: str = DEFAULT_PIN,
    poll_interval: float = POLL_INTERVAL,
    resume_phones: Optional[list] = None,
    api_key: str = "",
    sms_provider_name: str = "",
):
    from .payment_inbox import PaymentInboxClient

    if not api_key:
        api_key = cfg.get("sms.smscloud", "api_key") or cfg.get("sms.herosms", "api_key")
    if not api_key:
        api_key_file = cfg.get("sms.herosms", "api_key_file")
        if api_key_file and os.path.exists(api_key_file):
            api_key = open(api_key_file).read().strip()
    if not api_key:
        log.error("No SMS API key. Set sms.smscloud.api_key or sms.herosms.api_key in config.json")
        return

    provider = create_sms_provider(sms_provider_name, api_key)
    log.info("SMS provider: %s", type(provider).__name__)

    inbox = PaymentInboxClient(base_url=INBOX_URL, basic_auth=(INBOX_USER, INBOX_PASS))
    stop = threading.Event()

    resume_phones = resume_phones or []
    actual_workers = max(max_workers, len(resume_phones))
    log.info("Worker started: workers=%d poll=%.0fs resume=%s ttl=%ds",
             actual_workers, poll_interval, resume_phones or "(none)", GOPAY_ACCOUNT_TTL)
    _inbox_ttl_cleanup()

    threads = []
    for i in range(actual_workers):
        rp = resume_phones[i] if i < len(resume_phones) else ""
        t = threading.Thread(
            target=_worker_loop,
            args=(inbox, provider, pin, stop, i),
            kwargs={"resume_phone": rp},
            daemon=True, name=f"w{i}",
        )
        t.start()
        threads.append(t)
        time.sleep(2)

    try:
        while True:
            alive = sum(1 for t in threads if t.is_alive())
            if alive == 0:
                log.error("All workers dead, exiting")
                break
            time.sleep(30)
    except KeyboardInterrupt:
        log.info("Shutting down")
        stop.set()


def main():
    import argparse
    parser = argparse.ArgumentParser(description="GoPay Protocol Worker")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--pin", default=DEFAULT_PIN)
    parser.add_argument("--poll", type=float, default=POLL_INTERVAL)
    parser.add_argument("--api-key", default="", help="SMS API key (or set in config.json)")
    parser.add_argument("--dry-run", action="store_true", help="Register one account only, no inbox")
    parser.add_argument("--resume", nargs="+", metavar="PHONE", help="Resume from existing accounts")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s", datefmt="%H:%M:%S")

    if args.dry_run:
        log.info("=== DRY RUN: register one account ===")
        api_key = args.api_key or cfg.get("sms.smscloud", "api_key") or cfg.get("sms.herosms", "api_key")
        if not api_key:
            log.error("No API key")
            return
        provider = create_sms_provider("", api_key)
        proxy = _make_proxy()
        envelope_did = _get_envelope_did()
        result = _register_one(provider, args.pin, proxy, envelope_did)
        if isinstance(result, dict):
            log.info("SUCCESS: %s pin=%s", result["phone"], args.pin)
        else:
            log.error("FAILED")
        provider.release_unused(keep=(result["aid"] if isinstance(result, dict) else None))
        return

    run_worker(max_workers=args.workers, pin=args.pin, poll_interval=args.poll,
               resume_phones=args.resume, api_key=args.api_key)


if __name__ == "__main__":
    main()
