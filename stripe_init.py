#!/usr/bin/env python3
"""Probe Stripe payment_pages/init for a pay.openai.com cs_live session.

Input: JSON on stdin  { cs_id, pk, proxy }
   cs_id: cs_live_* session id (from OpenAI checkout response)
   pk:    pk_live_* Stripe publishable key (from OpenAI checkout response,
          surfaced by checkout_link.py as the "pk" field)
   proxy: HTTP proxy URL; default = direct (use main proxy 7890 from caller)
Output: JSON line on stdout — log lines as {"log":"..."}, final as {"status":...}

Single-step protocol:
  POST https://api.stripe.com/v1/payment_pages/{cs_id}/init  with key=pk
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
    cs_id = inp.get('cs_id', '')
    pk = inp.get('pk', '')
    proxy = inp.get('proxy') or None
    proxies = {'http': proxy, 'https': proxy} if proxy else None

    if not re.match(r'^cs_live_[A-Za-z0-9]+$', cs_id):
        _emit({"status": "error", "reason": "invalid_cs_id"})
        return
    if not re.match(r'^pk_live_[A-Za-z0-9]+$', pk):
        _emit({"status": "error", "reason": "invalid_pk"})
        return

    imp = random.choice(_CHROME)
    _log(f"impersonate={imp}, cs={cs_id[:25]}..., pk={pk[:15]}..., proxy={'(set)' if proxy else '(direct)'}")

    init_url = f"https://api.stripe.com/v1/payment_pages/{cs_id}/init"
    try:
        init_resp = cr.post(
            init_url,
            data={"key": pk, "browser_locale": "en-US"},
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
