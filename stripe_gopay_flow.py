#!/usr/bin/env python3
"""Phase 3: Stripe GoPay 全协议链路 — 从 ChatGPT accessToken 到 Midtrans snap URL。

4 步纯协议（JP 代理），无需浏览器：
  1. POST chatgpt.com/backend-api/payments/checkout → cs_live + pk_live
  2. POST api.stripe.com/v1/payment_pages/{cs}/init  → eid, session 详情
  3. POST api.stripe.com/v1/payment_pages/{cs}/confirm → SetupIntent redirect URL
  4. GET  pm-redirects.stripe.com/authorize/...       → 302 → Midtrans snap URL

Input:  JSON on stdin  { access_token }
Output: JSON lines on stdout — log lines as {"log":"..."}, final as {"status":...}

验证日期：2026-05-30（全链路 probe 通过）
"""
import sys, os, json, random, re

_DEFAULT_PROXY = os.environ.get('HTTPS_PROXY') or 'http://127.0.0.1:7891'
os.environ['HTTPS_PROXY'] = _DEFAULT_PROXY
os.environ['HTTP_PROXY'] = _DEFAULT_PROXY
os.environ.setdefault('NO_PROXY', '127.0.0.1,localhost')

from curl_cffi import requests as cr

_CHROME = ['chrome146', 'chrome142', 'chrome136', 'chrome133a', 'chrome131', 'chrome124']
_MIDTRANS_RE = re.compile(r'https://app\.midtrans\.com/snap/v[34]/redirection/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')

_ID_ADDRESSES = [
    {"name": "Budi Santoso",    "city": "Jakarta",   "line1": "Jl. Sudirman No. 1",        "zip": "10110", "state": "DKI Jakarta"},
    {"name": "Siti Rahayu",     "city": "Surabaya",  "line1": "Jl. Pemuda No. 35",          "zip": "60271", "state": "Jawa Timur"},
    {"name": "Agus Wijaya",     "city": "Bandung",   "line1": "Jl. Asia Afrika No. 65",     "zip": "40111", "state": "Jawa Barat"},
    {"name": "Dewi Lestari",    "city": "Medan",     "line1": "Jl. Gatot Subroto No. 12",   "zip": "20112", "state": "Sumatera Utara"},
    {"name": "Eko Prasetyo",    "city": "Semarang",  "line1": "Jl. Pandanaran No. 88",      "zip": "50134", "state": "Jawa Tengah"},
    {"name": "Rina Wulandari",  "city": "Yogyakarta","line1": "Jl. Malioboro No. 52",       "zip": "55213", "state": "DI Yogyakarta"},
    {"name": "Hendra Gunawan",  "city": "Makassar",  "line1": "Jl. Sultan Hasanuddin No. 3","zip": "90111", "state": "Sulawesi Selatan"},
    {"name": "Putri Amelia",    "city": "Denpasar",  "line1": "Jl. Teuku Umar No. 27",      "zip": "80114", "state": "Bali"},
    {"name": "Rahmat Hidayat",  "city": "Tangerang", "line1": "Jl. MH Thamrin No. 15",      "zip": "15117", "state": "Banten"},
    {"name": "Novi Susanti",    "city": "Bekasi",    "line1": "Jl. Ahmad Yani No. 41",       "zip": "17141", "state": "Jawa Barat"},
]


def _log(m):
    print(json.dumps({"log": f"  [StripeGoPay] {m}"}), flush=True)


def _emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def _step1_checkout(token, imp):
    """POST chatgpt checkout with country=ID, currency=IDR."""
    body = {
        "entry_point": "all_plans_pricing_modal",
        "plan_name": "chatgptplusplan",
        "billing_details": {"country": "ID", "currency": "IDR"},
        "cancel_url": "https://chatgpt.com/#pricing",
        "checkout_ui_mode": "hosted",
        "promo_campaign": {
            "promo_campaign_id": "plus-1-month-free",
            "is_coupon_from_query_param": False,
        },
    }
    r = cr.post(
        "https://chatgpt.com/backend-api/payments/checkout",
        json=body,
        headers={'Authorization': f'Bearer {token}', 'Accept': 'application/json'},
        impersonate=imp,
        timeout=20,
    )
    if r.status_code == 401:
        return None, "checkout_401"
    if r.status_code == 403:
        is_cf = r.text.lstrip().startswith('<')
        return None, "checkout_cf_403" if is_cf else "checkout_403"
    if r.status_code != 200:
        return None, f"checkout_http_{r.status_code}"
    try:
        data = r.json()
    except Exception:
        return None, "checkout_not_json"
    cs_id = data.get("checkout_session_id", "")
    pk = data.get("publishable_key", "")
    if not cs_id or not pk:
        return None, "checkout_no_cs_or_pk"
    return {"cs_id": cs_id, "pk": pk, "raw": data}, None


def _step2_init(cs_id, pk, imp):
    """POST Stripe init to get eid and confirm gopay is available."""
    r = cr.post(
        f"https://api.stripe.com/v1/payment_pages/{cs_id}/init",
        data={"key": pk, "browser_locale": "en-US"},
        impersonate=imp,
        timeout=15,
    )
    if r.status_code != 200:
        return None, f"init_http_{r.status_code}"
    try:
        data = r.json()
    except Exception:
        return None, "init_not_json"
    eid = data.get("eid", "")
    pm_types = data.get("payment_method_types", [])
    if "gopay" not in pm_types:
        return None, f"init_no_gopay_in_{pm_types}"
    amount_due = 0
    inv = data.get("invoice")
    if inv:
        amount_due = inv.get("amount_due", 0)
    return {"eid": eid, "payment_method_types": pm_types, "amount_due": amount_due}, None


def _step3_confirm(cs_id, pk, eid, imp, amount_due=0):
    """POST Stripe confirm with GoPay payment method."""
    addr = random.choice(_ID_ADDRESSES)
    data = {
        'key': pk,
        'eid': eid,
        'expected_amount': str(amount_due),
        'expected_payment_method_type': 'gopay',
        'payment_method_data[type]': 'gopay',
        'payment_method_data[billing_details][name]': addr['name'],
        'payment_method_data[billing_details][address][country]': 'ID',
        'payment_method_data[billing_details][address][city]': addr['city'],
        'payment_method_data[billing_details][address][line1]': addr['line1'],
        'payment_method_data[billing_details][address][postal_code]': addr['zip'],
        'payment_method_data[billing_details][address][state]': addr['state'],
        'consent[terms_of_service]': 'accepted',
        'return_url': 'https://chatgpt.com/payments/success',
    }
    r = cr.post(
        f"https://api.stripe.com/v1/payment_pages/{cs_id}/confirm",
        data=data,
        impersonate=imp,
        timeout=30,
    )
    if r.status_code != 200:
        try:
            err = r.json()
            msg = err.get("error", {}).get("message", "")[:200]
        except Exception:
            msg = r.text[:200]
        return None, f"confirm_http_{r.status_code}: {msg}"
    try:
        resp = r.json()
    except Exception:
        return None, "confirm_not_json"
    si = resp.get("setup_intent") or resp.get("payment_intent")
    if not si:
        return None, "confirm_no_intent"
    na = si.get("next_action", {})
    redirect_url = ""
    if na.get("type") == "redirect_to_url":
        redirect_url = na.get("redirect_to_url", {}).get("url", "")
    if not redirect_url:
        status = si.get("status", "")
        if status == "succeeded":
            return {"redirect_url": "", "intent_status": "succeeded", "intent_id": si.get("id", "")}, None
        return None, f"confirm_no_redirect (intent_status={status})"
    return {"redirect_url": redirect_url, "intent_id": si.get("id", "")}, None


def _step4_follow_redirect(redirect_url, imp):
    """Follow Stripe redirect to get Midtrans snap URL."""
    r = cr.get(redirect_url, impersonate=imp, timeout=15, allow_redirects=False)
    if r.status_code not in (301, 302, 303, 307):
        m = _MIDTRANS_RE.search(r.text or "")
        if m:
            return m.group(0), None
        return None, f"redirect_http_{r.status_code}_no_location"
    location = r.headers.get('Location', '')
    m = _MIDTRANS_RE.search(location)
    if m:
        return m.group(0), None
    if location:
        r2 = cr.get(location, impersonate=imp, timeout=15, allow_redirects=False)
        m2 = _MIDTRANS_RE.search(r2.headers.get('Location', '') + (r2.text or ''))
        if m2:
            return m2.group(0), None
    return None, f"redirect_no_midtrans (location={location[:120]})"


def main():
    inp = json.loads(sys.stdin.read())
    token = inp['access_token']
    imp = random.choice(_CHROME)

    # Step 1: Checkout
    _log(f"Step 1: checkout (country=ID, currency=IDR, imp={imp})")
    checkout, err = _step1_checkout(token, imp)
    if err:
        _emit({"status": "error", "reason": err})
        return
    cs_id = checkout["cs_id"]
    pk = checkout["pk"]
    _log(f"checkout → cs={cs_id[:30]}...")

    # Step 2: Init
    _log("Step 2: Stripe init")
    init_data, err = _step2_init(cs_id, pk, imp)
    if err:
        _emit({"status": "error", "reason": err})
        return
    _log(f"init → eid={init_data['eid'][:20]}..., gopay=✓, amount_due={init_data['amount_due']}")

    # Step 3: Confirm
    _log("Step 3: Stripe confirm (GoPay + billing ID)")
    confirm, err = _step3_confirm(cs_id, pk, init_data["eid"], imp, init_data["amount_due"])
    if err:
        _emit({"status": "error", "reason": err})
        return
    if not confirm["redirect_url"]:
        _log("confirm → intent succeeded directly (no redirect needed)")
        _emit({"status": "success", "midtrans_url": "", "cs_id": cs_id,
               "snap_token": "", "amount": init_data["amount_due"], "currency": "idr",
               "note": "SetupIntent succeeded without redirect"})
        return
    _log(f"confirm → redirect to pm-redirects.stripe.com")

    # Step 4: Follow redirect
    _log("Step 4: follow redirect → Midtrans snap URL")
    midtrans_url, err = _step4_follow_redirect(confirm["redirect_url"], imp)
    if err:
        _emit({"status": "error", "reason": err})
        return
    snap_m = re.search(r'/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$', midtrans_url)
    snap_token = snap_m.group(1) if snap_m else ""
    _log(f"Midtrans snap URL obtained: {midtrans_url[:80]}")

    _emit({
        "status": "success",
        "midtrans_url": midtrans_url,
        "cs_id": cs_id,
        "snap_token": snap_token,
        "amount": init_data["amount_due"],
        "currency": "idr",
    })


if __name__ == "__main__":
    main()
