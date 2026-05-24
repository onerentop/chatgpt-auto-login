#!/usr/bin/env python3
"""Probe ChatGPT /backend-api/accounts/check via curl_cffi (Cloudflare bypass).

Input: JSON on stdin  { access_token, proxy_url, impersonate?, timeout_ms? }
   access_token: JWT bearer for /accounts/check
   proxy_url:    HTTP proxy URL, e.g. http://127.0.0.1:7890 (None for direct)
   impersonate:  curl_cffi browser fingerprint to PIN. If omitted, rotates
                 through _CHROME on Cloudflare-403 retry (3 attempts).
   timeout_ms:   request timeout in ms, default 10000

Output: JSON-lines on stdout — streaming {"log":"..."} and final terminal object:
   {"status":"ok",    "http":200, "plan_type":"plus|free|deactivated|...", "reason":null}
   {"status":"error", "http":<int>, "plan_type":null, "reason":"<msg>"}

NB: Module-level imports must NOT print to stdout (would pollute JSON-lines
protocol). curl_cffi import is safe — it doesn't print on import.

Mirrors the multi-impersonate retry pattern from checkout_link.py — Cloudflare
periodically blacklists specific JA3 fingerprints, so rotating is the only way
to keep success rates near 100%.
"""
import sys, json, random
from curl_cffi import requests as cr

CHECK_URL = 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27'

# Same pool as checkout_link.py. chrome131 was being Cloudflare-blocked
# 100% of the time in 2026-05-24 testing; chrome146 / chrome142 currently work.
_CHROME = ['chrome146', 'chrome142', 'chrome136', 'chrome133a', 'chrome131', 'chrome124']


def _log(m):
    print(json.dumps({"log": f"  [Liveness] {m}"}), flush=True)


def _emit(payload):
    print(json.dumps(payload), flush=True)


def _extract_plan_type(body):
    """Pull plan_type from /accounts/check response.

    Real shape (observed 2026-05-24):
        body.accounts[<account_uuid>].account.{plan_type, is_deactivated}

    The <account_uuid> key is a dynamic UUID, not 'default' — the v2.28
    initial implementation hard-coded 'default' which never matched. Fall
    back to legacy shapes seen in older API versions.
    """
    accounts = body.get('accounts') or {}
    if accounts and isinstance(accounts, dict):
        # Take the first account entry (typically there's only one per token)
        first = next(iter(accounts.values()), None)
        if isinstance(first, dict):
            acct = first.get('account') or first
            if isinstance(acct, dict):
                if acct.get('is_deactivated') is True:
                    return 'deactivated'
                pt = acct.get('plan_type')
                if pt:
                    return pt
    # Legacy fallbacks
    legacy = body.get('account_plan') or body or {}
    return (
        legacy.get('plan_type')
        or (legacy.get('entitlement') or {}).get('subscription_plan')
        or 'unknown'
    )


def _probe_once(access_token, proxies, impersonate, timeout_s):
    """Single attempt. Returns (action, payload_dict).

    action one of:
        'success'  → terminal ok response
        'fail'     → terminal error (no retry — real auth/permission failure)
        'retry'    → Cloudflare HTML challenge, try a different impersonate
        'network'  → transient network error, also terminal (caller stops)
    """
    try:
        res = cr.get(
            CHECK_URL,
            headers={'Authorization': f'Bearer {access_token}'},
            proxies=proxies,
            impersonate=impersonate,
            timeout=timeout_s,
        )
    except Exception as e:
        return ('network', {"status": "error", "http": 0, "plan_type": None, "reason": f"exception: {str(e)[:80]}"})

    http = res.status_code
    body_text = res.text or ''
    is_html = body_text.lstrip().startswith('<')

    if http == 200:
        try:
            body = res.json()
        except Exception as e:
            return ('fail', {"status": "error", "http": 200, "plan_type": None, "reason": f"json parse: {str(e)[:60]}"})
        plan_type = _extract_plan_type(body)
        return ('success', {"status": "ok", "http": 200, "plan_type": plan_type, "reason": None})

    if http == 401:
        return ('fail', {"status": "error", "http": 401, "plan_type": None, "reason": "token_expired"})

    if http == 403:
        # HTML body = Cloudflare TLS challenge → retry with a different impersonate.
        # JSON body = real OpenAI auth/permission failure → no retry helps.
        # Mirror checkout_link.py:56's discriminator.
        if is_html:
            return ('retry', {"status": "error", "http": 403, "plan_type": None, "reason": "cloudflare blocked"})
        return ('fail', {"status": "error", "http": 403, "plan_type": None, "reason": "account forbidden"})

    if http == 429:
        return ('fail', {"status": "error", "http": 429, "plan_type": None, "reason": "rate limited"})

    if http >= 500:
        return ('network', {"status": "error", "http": http, "plan_type": None, "reason": f"http {http}"})

    return ('fail', {"status": "error", "http": http, "plan_type": None, "reason": f"http {http}"})


def main():
    try:
        inp = json.loads(sys.stdin.read())
    except Exception as e:
        _emit({"status": "error", "http": 0, "plan_type": None, "reason": f"stdin parse: {str(e)[:60]}"})
        return

    access_token = inp.get('access_token', '')
    proxy_url = inp.get('proxy_url') or None
    fixed_impersonate = inp.get('impersonate')  # None → rotate _CHROME on retry
    timeout_s = (inp.get('timeout_ms', 10000)) / 1000.0

    if not access_token:
        _emit({"status": "error", "http": 0, "plan_type": None, "reason": "no access_token"})
        return

    proxies = {'http': proxy_url, 'https': proxy_url} if proxy_url else None

    # 3 attempts; each Cloudflare-403 retry picks a different impersonate.
    last_payload = None
    used_imps = []
    for attempt in range(3):
        imp = fixed_impersonate or random.choice([c for c in _CHROME if c not in used_imps] or _CHROME)
        used_imps.append(imp)
        _log(f"GET /accounts/check attempt {attempt+1}/3 via {imp}, proxy={'on' if proxy_url else 'off'}")
        action, payload = _probe_once(access_token, proxies, imp, timeout_s)
        last_payload = payload
        if action in ('success', 'fail', 'network'):
            _emit(payload)
            return
        # action == 'retry' → try another impersonate

    # All 3 attempts hit Cloudflare → emit the final blocked payload
    _emit(last_payload or {"status": "error", "http": 0, "plan_type": None, "reason": "all retries failed"})


if __name__ == '__main__':
    main()
