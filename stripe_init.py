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
import sys, os, json, random, re

# v2.42 Task 2: 系统级透明代理。必须在 curl_cffi import 之前设 env，让
# Session() 构造时读到正确 HTTPS_PROXY。Node 父进程已通过 server/proxy/global.js
# 注入；这里只兜底默认值。
_DEFAULT_PROXY = os.environ.get('HTTPS_PROXY') or 'http://127.0.0.1:7890'
os.environ['HTTPS_PROXY'] = _DEFAULT_PROXY
os.environ['HTTP_PROXY'] = _DEFAULT_PROXY
os.environ.setdefault('NO_PROXY', '127.0.0.1,localhost')

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
    # v2.42 Task 2: 不再读 stdin proxy —— curl_cffi 自动用 HTTPS_PROXY env

    if not re.match(r'^cs_live_[A-Za-z0-9]+$', cs_id):
        _emit({"status": "error", "reason": "invalid_cs_id"})
        return
    if not re.match(r'^pk_live_[A-Za-z0-9]+$', pk):
        _emit({"status": "error", "reason": "invalid_pk"})
        return

    imp = random.choice(_CHROME)
    _log(f"impersonate={imp}, cs={cs_id[:25]}..., pk={pk[:15]}...")

    init_url = f"https://api.stripe.com/v1/payment_pages/{cs_id}/init"
    try:
        init_resp = cr.post(
            init_url,
            data={"key": pk, "browser_locale": "en-US"},
            impersonate=imp,
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
