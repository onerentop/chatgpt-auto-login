#!/usr/bin/env python3
"""Probe Stripe payment_pages/init for a pay.openai.com cs_live session.

Input: JSON on stdin  { cs_id, proxy }
Output: JSON line on stdout — log lines as {"log":"..."}, final as {"status":...}

Two-step protocol:
  1) GET https://pay.openai.com/c/pay/{cs_id}  -> extract pk_live_* from HTML
  2) POST https://api.stripe.com/v1/payment_pages/{cs_id}/init  with key=pk_live_*
     -> JSON containing invoice.amount_due / currency / total_discount_amounts,
        payment_method_types
"""
import sys, json, random, re
from curl_cffi import requests as cr

_CHROME = ['chrome146', 'chrome142', 'chrome136', 'chrome133a', 'chrome131', 'chrome124']

def _log(m):
    print(json.dumps({"log": f"  [StripeInit] {m}"}), flush=True)

def _emit(payload):
    print(json.dumps(payload), flush=True)

def main():
    inp = json.loads(sys.stdin.read())
    cs_id = inp['cs_id']
    proxy = inp.get('proxy') or None
    proxies = {'http': proxy, 'https': proxy} if proxy else None

    if not re.match(r'^cs_live_[A-Za-z0-9]+$', cs_id):
        _emit({"status": "error", "reason": "invalid_cs_id"})
        return

    imp = random.choice(_CHROME)
    _log(f"impersonate={imp}, proxy={'(set)' if proxy else '(direct)'}")

    # Step 1: get pk_live_* from pay.openai.com page
    page_url = f"https://pay.openai.com/c/pay/{cs_id}"
    try:
        page_resp = cr.get(page_url, impersonate=imp, proxies=proxies, timeout=15)
    except Exception as e:
        _emit({"status": "error", "reason": f"page_fetch: {str(e)[:80]}"})
        return
    if page_resp.status_code != 200:
        _emit({"status": "error", "reason": f"page_http_{page_resp.status_code}"})
        return
    m = re.search(r'pk_live_[A-Za-z0-9]+', page_resp.text)
    if not m:
        _emit({"status": "error", "reason": "no_pk_in_page"})
        return
    pk = m.group(0)
    _log(f"found {pk[:20]}...")

    # Step 2: POST init
    init_url = f"https://api.stripe.com/v1/payment_pages/{cs_id}/init"
    try:
        init_resp = cr.post(
            init_url,
            data={"key": pk, "eager_browser_locale": "en-US", "expected_amount": ""},
            impersonate=imp,
            proxies=proxies,
            timeout=15,
        )
    except Exception as e:
        _emit({"status": "error", "reason": f"init_fetch: {str(e)[:80]}"})
        return
    if init_resp.status_code != 200:
        _emit({"status": "error", "reason": f"init_http_{init_resp.status_code}", "body": init_resp.text[:200]})
        return
    try:
        data = init_resp.json()
    except Exception:
        _emit({"status": "error", "reason": "init_not_json", "body": init_resp.text[:200]})
        return

    _emit({"status": "success", "data": data})

if __name__ == "__main__":
    main()
