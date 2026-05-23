#!/usr/bin/env python3
"""Submit Stripe checkout billing + select PayPal, return PayPal redirect URL.

Input: JSON on stdin  { cs_id, pk, country, currency, street, city, state, zip,
                       name, email, proxy }
Output: JSON lines on stdout — log lines as {"log":"..."}, final as {"status":...}

Mirrors the user-driven flow on pay.openai.com when the user picks PayPal:
  1. POST /v1/payment_pages/{cs_id}/init          (load session, get init_checksum)
  2. POST /v1/payment_methods                     (type=paypal + billing_details)
  3. POST /v1/payment_pages/{cs_id}/confirm       (payment_method=pm_xxx + key + amount)
     -> response contains next_action.redirect_to_url.url = PayPal agreement URL

Reference (authoritative):
  Gpt-Agreement-Payment/CTF-pay/card/_monolith.py
    :2782 init_checkout()                 — /init form fields, extract init_checksum
    :4406 create_paypal_payment_method()  — /v1/payment_methods type=paypal
    :7351 confirm_payment()               — /v1/payment_pages/<id>/confirm form fields
    :7499 confirm POST URL
    :7521 next_action extraction (top-level / payment_intent / setup_intent)
    :7012 _handle_paypal_redirect()       — PayPal URL handler
    :9085 use_paypal branch / redirect_to_url.url extraction
"""
import sys, json, random, re, uuid, string
from curl_cffi import requests as cr

_CHROME = ['chrome146', 'chrome142', 'chrome136', 'chrome133a', 'chrome131', 'chrome124']
_STRIPE_API = "https://api.stripe.com"
_STRIPE_VERSION_BASE = "2025-03-31.basil"
_STRIPE_VERSION_FULL = (
    "2025-03-31.basil; "
    "checkout_server_update_beta=v1; "
    "checkout_manual_approval_preview=v1"
)
_RUNTIME_VERSION = "6f8494a281"
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/146.0.0.0 Safari/537.36"
)


def _log(m):
    print(json.dumps({"log": f"  [StripeBilling] {m}"}), flush=True)


def _emit(payload):
    print(json.dumps(payload), flush=True)


def _gen_fp():
    def _id():
        return uuid.uuid4().hex + uuid.uuid4().hex[:6]
    return _id(), _id(), _id()


def _gen_elements_session_id():
    chars = string.ascii_letters + string.digits
    return "elements_session_" + "".join(random.choices(chars, k=11))


def _stripe_headers():
    return {
        "User-Agent": _USER_AGENT,
        "Accept": "application/json",
        "Origin": "https://js.stripe.com",
        "Referer": "https://js.stripe.com/",
    }


def main():
    try:
        inp = json.loads(sys.stdin.read())
    except Exception as e:
        _emit({"status": "error", "reason": "bad_input", "detail": str(e)[:80]})
        return

    cs_id = inp.get('cs_id', '')
    pk = inp.get('pk', '')
    country = inp.get('country', 'US')
    street = inp.get('street', '')
    city = inp.get('city', '')
    state = inp.get('state', '')
    zip_code = inp.get('zip', '')
    # Normalize US state full names → 2-letter codes (Stripe rejects full names → "Invalid ZIP code.")
    _US_STATES = {
        "alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA",
        "colorado":"CO","connecticut":"CT","delaware":"DE","florida":"FL","georgia":"GA",
        "hawaii":"HI","idaho":"ID","illinois":"IL","indiana":"IN","iowa":"IA","kansas":"KS",
        "kentucky":"KY","louisiana":"LA","maine":"ME","maryland":"MD","massachusetts":"MA",
        "michigan":"MI","minnesota":"MN","mississippi":"MS","missouri":"MO","montana":"MT",
        "nebraska":"NE","nevada":"NV","new hampshire":"NH","new jersey":"NJ","new mexico":"NM",
        "new york":"NY","north carolina":"NC","north dakota":"ND","ohio":"OH","oklahoma":"OK",
        "oregon":"OR","pennsylvania":"PA","rhode island":"RI","south carolina":"SC",
        "south dakota":"SD","tennessee":"TN","texas":"TX","utah":"UT","vermont":"VT",
        "virginia":"VA","washington":"WA","west virginia":"WV","wisconsin":"WI","wyoming":"WY",
        "district of columbia":"DC",
    }
    if country == 'US' and state:
        state = _US_STATES.get(state.strip().lower(), state)
    _log(f"billing: country={country} state={state} city={city!r} zip={zip_code!r}")
    name = inp.get('name', 'Stripe Customer')
    email = inp.get('email', 'customer@example.com')
    proxy = inp.get('proxy') or None
    proxies = {'http': proxy, 'https': proxy} if proxy else None

    if not re.match(r'^cs_live_[A-Za-z0-9]+$', cs_id):
        _emit({"status": "error", "reason": "invalid_cs_id"})
        return
    if not re.match(r'^pk_live_[A-Za-z0-9]+$', pk):
        _emit({"status": "error", "reason": "invalid_pk"})
        return

    imp = random.choice(_CHROME)
    guid, muid, sid = _gen_fp()
    stripe_js_id = str(uuid.uuid4())
    elements_session_id = _gen_elements_session_id()
    elements_session_config_id = str(uuid.uuid4())
    _log(f"impersonate={imp} cs={cs_id[:25]}... pk={pk[:18]}...")

    headers = _stripe_headers()

    # ─────────────────────────────────────────────────────────────
    # Step 1: POST /v1/payment_pages/{cs_id}/init
    # Drives the elements_session_client[client_betas] beta flags so the
    # server returns init_checksum + total_summary.due needed by /confirm.
    # ─────────────────────────────────────────────────────────────
    init_url = f"{_STRIPE_API}/v1/payment_pages/{cs_id}/init"
    init_data = {
        "browser_locale": "en-US",
        "browser_timezone": "America/Chicago",
        "elements_session_client[elements_init_source]": "custom_checkout",
        "elements_session_client[referrer_host]": "chatgpt.com",
        "elements_session_client[stripe_js_id]": stripe_js_id,
        "elements_session_client[locale]": "en-US",
        "elements_session_client[is_aggregation_expected]": "false",
        "elements_session_client[session_id]": elements_session_id,
        "elements_session_client[client_betas][0]": "custom_checkout_server_updates_1",
        "elements_session_client[client_betas][1]": "custom_checkout_manual_approval_1",
        "key": pk,
        "_stripe_version": _STRIPE_VERSION_FULL,
    }
    _log("[1/3] POST /init")
    try:
        init_resp = cr.post(
            init_url, data=init_data, headers=headers,
            impersonate=imp, proxies=proxies, timeout=20,
        )
    except Exception as e:
        _emit({"status": "error", "reason": f"init_fetch: {str(e)[:80]}"})
        return
    if init_resp.status_code != 200:
        _emit({"status": "error", "reason": f"stripe_init_{init_resp.status_code}",
               "body": init_resp.text[:300]})
        return
    try:
        init_payload = init_resp.json()
    except Exception:
        _emit({"status": "error", "reason": "init_not_json", "body": init_resp.text[:300]})
        return

    init_checksum = init_payload.get("init_checksum", "")
    total_summary = init_payload.get("total_summary") or {}
    expected_amount = total_summary.get("due")
    if expected_amount is None:
        expected_amount = (init_payload.get("invoice") or {}).get("amount_due")
    if expected_amount is None:
        line_items = init_payload.get("line_items") or []
        expected_amount = sum(item.get("amount", 0) for item in line_items)
    expected_amount = str(expected_amount if expected_amount is not None else 0)

    consent_collection = init_payload.get("consent_collection") or {}
    needs_tos = consent_collection.get("terms_of_service") not in (None, "", "none")
    top_checkout_config_id = init_payload.get("config_id", "")
    return_url_from_init = init_payload.get("return_url") or init_payload.get("url") or ""
    pm_types_init = init_payload.get("payment_method_types") or []
    _log(f"      init_checksum={init_checksum[:12]}... amount={expected_amount} "
         f"needs_tos={needs_tos} pm_types={pm_types_init}")

    # ─────────────────────────────────────────────────────────────
    # Step 2: POST /v1/payment_methods   (type=paypal)
    # Reference _monolith.py:4433-4465 — these are the exact fields.
    # ─────────────────────────────────────────────────────────────
    pm_url = f"{_STRIPE_API}/v1/payment_methods"
    pm_data = {
        "type": "paypal",
        "billing_details[name]": name,
        "billing_details[email]": email,
        "billing_details[address][country]": country,
        "billing_details[address][line1]": street,
        "billing_details[address][city]": city,
        "billing_details[address][postal_code]": zip_code,
        "billing_details[address][state]": state,
        "payment_user_agent": (
            f"stripe.js/{_RUNTIME_VERSION}; stripe-js-v3/{_RUNTIME_VERSION}; "
            "payment-element; deferred-intent"
        ),
        "referrer": "https://chatgpt.com",
        "time_on_page": str(random.randint(25000, 55000)),
        "client_attribution_metadata[client_session_id]": stripe_js_id,
        "client_attribution_metadata[checkout_session_id]": cs_id,
        "client_attribution_metadata[checkout_config_id]": top_checkout_config_id,
        "client_attribution_metadata[elements_session_id]": elements_session_id,
        "client_attribution_metadata[elements_session_config_id]": elements_session_config_id,
        "client_attribution_metadata[merchant_integration_source]": "elements",
        "client_attribution_metadata[merchant_integration_subtype]": "payment-element",
        "client_attribution_metadata[merchant_integration_version]": "2021",
        "client_attribution_metadata[payment_intent_creation_flow]": "deferred",
        "client_attribution_metadata[payment_method_selection_flow]": "automatic",
        "client_attribution_metadata[merchant_integration_additional_elements][0]": "payment",
        "client_attribution_metadata[merchant_integration_additional_elements][1]": "address",
        "guid": guid,
        "muid": muid,
        "sid": sid,
        "key": pk,
        "_stripe_version": _STRIPE_VERSION_BASE,
    }
    _log("[2/3] POST /v1/payment_methods type=paypal")
    try:
        pm_resp = cr.post(
            pm_url, data=pm_data, headers=headers,
            impersonate=imp, proxies=proxies, timeout=20,
        )
    except Exception as e:
        _emit({"status": "error", "reason": f"pm_fetch: {str(e)[:80]}"})
        return
    if pm_resp.status_code != 200:
        _emit({"status": "error", "reason": f"stripe_pm_{pm_resp.status_code}",
               "body": pm_resp.text[:300]})
        return
    try:
        pm_obj = pm_resp.json()
    except Exception:
        _emit({"status": "error", "reason": "pm_not_json", "body": pm_resp.text[:300]})
        return
    pm_id = pm_obj.get("id", "")
    if not pm_id.startswith("pm_"):
        _emit({"status": "error", "reason": "pm_missing_id", "body": pm_resp.text[:300]})
        return
    _log(f"      pm_id={pm_id}")

    # ─────────────────────────────────────────────────────────────
    # Step 3: POST /v1/payment_pages/{cs_id}/confirm
    # Reference _monolith.py:7430-7516 — these are the exact fields when
    # confirm_mode != inline_payment_method_data (i.e. shared payment_method).
    # ─────────────────────────────────────────────────────────────
    confirm_url = f"{_STRIPE_API}/v1/payment_pages/{cs_id}/confirm"
    confirm_data = {
        "guid": guid,
        "muid": muid,
        "sid": sid,
        "expected_amount": expected_amount,
        "expected_payment_method_type": "paypal",
        "key": pk,
        "_stripe_version": _STRIPE_VERSION_FULL,
        "init_checksum": init_checksum,
        "version": _RUNTIME_VERSION,
        "return_url": return_url_from_init,
        "elements_session_client[elements_init_source]": "custom_checkout",
        "elements_session_client[referrer_host]": "chatgpt.com",
        "elements_session_client[stripe_js_id]": stripe_js_id,
        "elements_session_client[locale]": "en-US",
        "elements_session_client[is_aggregation_expected]": "false",
        "elements_session_client[session_id]": elements_session_id,
        "elements_session_client[client_betas][0]": "custom_checkout_server_updates_1",
        "elements_session_client[client_betas][1]": "custom_checkout_manual_approval_1",
        "client_attribution_metadata[client_session_id]": stripe_js_id,
        "client_attribution_metadata[checkout_session_id]": cs_id,
        "client_attribution_metadata[checkout_config_id]": top_checkout_config_id,
        "client_attribution_metadata[elements_session_id]": elements_session_id,
        "client_attribution_metadata[elements_session_config_id]": elements_session_config_id,
        "client_attribution_metadata[merchant_integration_source]": "checkout",
        "client_attribution_metadata[merchant_integration_subtype]": "payment-element",
        "client_attribution_metadata[merchant_integration_version]": "custom",
        "client_attribution_metadata[payment_intent_creation_flow]": "deferred",
        "client_attribution_metadata[payment_method_selection_flow]": "automatic",
        "client_attribution_metadata[merchant_integration_additional_elements][0]": "payment",
        "client_attribution_metadata[merchant_integration_additional_elements][1]": "address",
        "payment_method": pm_id,
    }
    if needs_tos:
        confirm_data["consent[terms_of_service]"] = "accepted"

    _log("[3/3] POST /confirm")
    try:
        cresp = cr.post(
            confirm_url, data=confirm_data, headers=headers,
            impersonate=imp, proxies=proxies, timeout=25,
        )
    except Exception as e:
        _emit({"status": "error", "reason": f"confirm_fetch: {str(e)[:80]}"})
        return

    # Reference _monolith.py:7504-7514 — Stripe sometimes 400s on a missing
    # terms_of_service consent; retry once with the consent set.
    if (
        cresp.status_code == 400
        and "consent[terms_of_service]" not in confirm_data
        and "terms of service" in (cresp.text or "").lower()
    ):
        _log("      retry confirm with consent[terms_of_service]=accepted")
        confirm_data["consent[terms_of_service]"] = "accepted"
        try:
            cresp = cr.post(
                confirm_url, data=confirm_data, headers=headers,
                impersonate=imp, proxies=proxies, timeout=25,
            )
        except Exception as e:
            _emit({"status": "error", "reason": f"confirm_retry_fetch: {str(e)[:80]}"})
            return

    if cresp.status_code != 200:
        _emit({"status": "error", "reason": f"stripe_billing_{cresp.status_code}",
               "body": cresp.text[:400]})
        return

    try:
        confirm_payload = cresp.json()
    except Exception:
        _emit({"status": "error", "reason": "confirm_not_json", "body": cresp.text[:400]})
        return

    # Reference _monolith.py:9085-9103 — search next_action across
    # top-level, payment_intent, setup_intent.
    next_action = None
    top_na = confirm_payload.get("next_action")
    if isinstance(top_na, dict) and top_na.get("type") == "redirect_to_url":
        next_action = top_na
    if not next_action:
        for key in ("payment_intent", "setup_intent"):
            obj = confirm_payload.get(key)
            if isinstance(obj, dict):
                na = obj.get("next_action")
                if isinstance(na, dict) and na.get("type") == "redirect_to_url":
                    next_action = na
                    break

    if not next_action:
        _emit({"status": "error", "reason": "no_next_action",
               "body": json.dumps(confirm_payload)[:500]})
        return

    redirect_info = next_action.get("redirect_to_url") or {}
    if isinstance(redirect_info, dict):
        paypal_url = redirect_info.get("url", "")
    elif isinstance(redirect_info, str):
        paypal_url = redirect_info
    else:
        paypal_url = ""

    if not paypal_url:
        _emit({"status": "error", "reason": "no_redirect_url",
               "body": json.dumps(confirm_payload)[:500]})
        return

    pi_obj = confirm_payload.get("payment_intent")
    payment_intent_id = pi_obj.get("id") if isinstance(pi_obj, dict) else None
    si_obj = confirm_payload.get("setup_intent")
    setup_intent_id = si_obj.get("id") if isinstance(si_obj, dict) else None

    _log(f"PayPal URL: {paypal_url[:80]}...")
    _emit({
        "status": "success",
        "data": {
            "paypal_redirect_url": paypal_url,
            "payment_intent_id": payment_intent_id,
            "setup_intent_id": setup_intent_id,
            "payment_method_id": pm_id,
        },
    })


if __name__ == "__main__":
    main()
