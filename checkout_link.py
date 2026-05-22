#!/usr/bin/env python3
"""Fetch ChatGPT Plus checkout link via curl_cffi (Chrome JA3 fingerprint).
Input: JSON on stdin  { access_token, country, currency, promo_id, proxy }
Output: JSON lines on stdout — log lines as {"log":"..."}, final as {"status":...}
"""
import sys, json, random, re
from curl_cffi import requests as cr

_CHROME = ['chrome146', 'chrome142', 'chrome136', 'chrome133a', 'chrome131', 'chrome124']

def _log(m):
    print(json.dumps({"log": f"  [Checkout] {m}"}), flush=True)

def main():
    inp = json.loads(sys.stdin.read())
    token = inp['access_token']
    body = {
        "entry_point": "all_plans_pricing_modal",
        "plan_name": "chatgptplusplan",
        "billing_details": {
            "country": inp.get('country', 'JP'),
            "currency": inp.get('currency', 'JPY'),
        },
        "cancel_url": "https://chatgpt.com/#pricing",
        "checkout_ui_mode": "hosted",
        "promo_campaign": {
            "promo_campaign_id": inp.get('promo_id', 'plus-1-month-free'),
            "is_coupon_from_query_param": False,
        },
    }
    proxies = {'http': inp['proxy'], 'https': inp['proxy']} if inp.get('proxy') else None

    for attempt in range(3):
        imp = random.choice(_CHROME)
        _log(f"Attempt {attempt+1}/3 with impersonate={imp}")
        try:
            r = cr.post(
                "https://chatgpt.com/backend-api/payments/checkout",
                json=body,
                headers={'Authorization': f'Bearer {token}', 'Accept': 'application/json'},
                impersonate=imp,
                proxies=proxies,
                timeout=20,
            )
            text = r.text
            m = re.search(r'https://pay\.openai\.com[^\s"\\)]+', text)
            if m:
                print(json.dumps({"status": "success", "link": m.group(0), "raw": text[:500]}))
                return
            _log(f"No link in response (status={r.status_code}): {text[:120]}")
            if r.status_code in (401, 403):
                print(json.dumps({"status": "no_link", "link": "", "raw": text[:500]}))
                return
        except Exception as e:
            _log(f"Retry-able error: {str(e)[:80]}")
    print(json.dumps({"status": "error", "error": "All 3 attempts failed"}))

if __name__ == "__main__":
    main()
