#!/usr/bin/env python3
"""Fetch ChatGPT Plus checkout link via curl_cffi (Chrome JA3 fingerprint).
Input: JSON on stdin  { access_token, country, currency, promo_id, proxy }
Output: JSON lines on stdout — log lines as {"log":"..."}, final as {"status":...}
"""
import sys, os, json, random, re

# v2.42 Task 2: 系统级透明代理。必须在 curl_cffi import 之前设 env，让
# Session() 构造时读到正确 HTTPS_PROXY。Node 父进程已通过 server/proxy/global.js
# 注入（JP-only 通道通过 jpUrl 单独 spawn 这个脚本时也会带正确 env）。
_DEFAULT_PROXY = os.environ.get('HTTPS_PROXY') or 'http://127.0.0.1:7890'
os.environ['HTTPS_PROXY'] = _DEFAULT_PROXY
os.environ['HTTP_PROXY'] = _DEFAULT_PROXY
os.environ.setdefault('NO_PROXY', '127.0.0.1,localhost')

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
    # v2.42 Task 2: 不再读 stdin proxy —— curl_cffi 自动用 HTTPS_PROXY env

    for attempt in range(3):
        imp = random.choice(_CHROME)
        _log(f"Attempt {attempt+1}/3 with impersonate={imp}")
        try:
            r = cr.post(
                "https://chatgpt.com/backend-api/payments/checkout",
                json=body,
                headers={'Authorization': f'Bearer {token}', 'Accept': 'application/json'},
                impersonate=imp,
                timeout=20,
            )
            text = r.text
            m = re.search(r'https://pay\.openai\.com[^\s"\\)]+', text)
            if m:
                pk_match = re.search(r'pk_live_[A-Za-z0-9]+', text)
                pk = pk_match.group(0) if pk_match else ""
                print(json.dumps({"status": "success", "link": m.group(0), "pk": pk, "raw": text[:500]}))
                return
            _log(f"No link in response (status={r.status_code}): {text[:120]}")
            # 401 → invalid token, no retry helps.
            # 403 with JSON body → real auth/permission denied.
            # 403 with HTML body → Cloudflare challenge (transient), retry with a different impersonate.
            is_cloudflare_challenge = r.status_code == 403 and text.lstrip().startswith('<')
            if r.status_code == 401 or (r.status_code == 403 and not is_cloudflare_challenge):
                print(json.dumps({"status": "no_link", "link": "", "raw": text[:500]}))
                return
        except Exception as e:
            _log(f"Retry-able error: {str(e)[:80]}")
    print(json.dumps({"status": "error", "error": "All 3 attempts failed"}))

if __name__ == "__main__":
    main()
