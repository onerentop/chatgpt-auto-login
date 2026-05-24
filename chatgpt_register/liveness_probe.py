#!/usr/bin/env python3
"""Probe ChatGPT /backend-api/accounts/check via curl_cffi (Cloudflare bypass).

Input: JSON on stdin  { access_token, proxy_url, impersonate?, timeout_ms? }
   access_token: JWT bearer for /accounts/check
   proxy_url:    HTTP proxy URL, e.g. http://127.0.0.1:7890 (None for direct)
   impersonate:  curl_cffi browser fingerprint, default 'chrome131'
   timeout_ms:   request timeout in ms, default 10000

Output: JSON-lines on stdout — streaming {"log":"..."} and final terminal object:
   {"status":"ok",    "http":200, "plan_type":"plus|free|...", "reason":null}
   {"status":"error", "http":<int>, "plan_type":null,         "reason":"<msg>"}

NB: Module-level imports must NOT print to stdout (would pollute JSON-lines
protocol). curl_cffi import is safe — it doesn't print on import.
"""
import sys, json
from curl_cffi import requests as cr

CHECK_URL = 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27'


def _log(m):
    print(json.dumps({"log": f"  [Liveness] {m}"}), flush=True)


def _emit(payload):
    print(json.dumps(payload), flush=True)


def _extract_plan_type(body):
    """Mirror the JS extractPlanType fallback chain."""
    a = (body.get('accounts') or {}).get('default') or body.get('account_plan') or body or {}
    return (
        a.get('plan_type')
        or (a.get('entitlement') or {}).get('subscription_plan')
        or (((a.get('entitlement') or {}).get('plan') or {}).get('name'))
        or a.get('subscription_plan')
        or 'unknown'
    )


def main():
    try:
        inp = json.loads(sys.stdin.read())
    except Exception as e:
        _emit({"status": "error", "http": 0, "plan_type": None, "reason": f"stdin parse: {str(e)[:60]}"})
        return

    access_token = inp.get('access_token', '')
    proxy_url = inp.get('proxy_url') or None
    impersonate = inp.get('impersonate', 'chrome131')
    timeout_s = (inp.get('timeout_ms', 10000)) / 1000.0

    if not access_token:
        _emit({"status": "error", "http": 0, "plan_type": None, "reason": "no access_token"})
        return

    proxies = {'http': proxy_url, 'https': proxy_url} if proxy_url else None
    _log(f"GET /accounts/check via {impersonate}, proxy={'on' if proxy_url else 'off'}")

    try:
        res = cr.get(
            CHECK_URL,
            headers={'Authorization': f'Bearer {access_token}'},
            proxies=proxies,
            impersonate=impersonate,
            timeout=timeout_s,
        )
    except Exception as e:
        msg = str(e)[:80]
        _emit({"status": "error", "http": 0, "plan_type": None, "reason": f"exception: {msg}"})
        return

    http = res.status_code

    if http == 200:
        try:
            body = res.json()
        except Exception as e:
            _emit({"status": "error", "http": 200, "plan_type": None, "reason": f"json parse: {str(e)[:60]}"})
            return
        plan_type = _extract_plan_type(body)
        _emit({"status": "ok", "http": 200, "plan_type": plan_type, "reason": None})
        return

    if http == 401:
        _emit({"status": "error", "http": 401, "plan_type": None, "reason": "token_expired"})
        return

    if http == 403:
        text = res.text[:200] if res.text else ''
        if '__cf_chl' in text or 'cf-mitigated' in text or 'Cloudflare' in text:
            reason = 'cloudflare blocked'
        else:
            reason = 'account forbidden'
        _emit({"status": "error", "http": 403, "plan_type": None, "reason": reason})
        return

    if http == 429:
        _emit({"status": "error", "http": 429, "plan_type": None, "reason": "rate limited"})
        return

    _emit({"status": "error", "http": http, "plan_type": None, "reason": f"http {http}"})


if __name__ == '__main__':
    main()
