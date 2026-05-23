#!/usr/bin/env python3
"""Confirm ChatGPT Plus subscription activation after PayPal redirect.

Input: JSON on stdin  { access_token, approval_url, proxy, poll_interval_ms, max_wait_ms }
Output: JSON line on stdout - log lines as {"log":"..."}, final as {"status":...}

Flow:
  1. GET approval_url with Bearer access_token (follow redirects within reason)
     to trigger ChatGPT-side commit of the PayPal agreement.
  2. Poll https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27 every
     poll_interval_ms (default 2000) until subscription_plan normalizes to
     plus/pro/team OR has_active_subscription flips to True, or until
     max_wait_ms (default 30000) elapses.

Reference (authoritative):
  - Gpt-Agreement-Payment/webui/backend/account_validator.py:90-195
      _CHECK_V4_URL constant
      _probe_check_v4_plan(): GET /backend-api/accounts/check/v4-2023-04-27,
        plan extracted from accounts.default.entitlement.subscription_plan,
        normalized via _subscription_plan_to_normal (chatgptplusplan -> plus,
        chatgptproplan -> pro, chatgptteamplan -> team).
      Headers required: Authorization Bearer, Accept, User-Agent, Referer.
      Uses curl_cffi impersonate="chrome136" to avoid CF bot challenges.
  - Gpt-Agreement-Payment/CTF-pay/card/_monolith.py:6712-7092 (PayPal approve
      flow context, plus result.return_url GET pattern at :7003-7008).

NOTE: /backend-api/me returns user profile but NOT live subscription state;
the authoritative endpoint is /backend-api/accounts/check/v4-2023-04-27.
Reason strings namespaced with approval_* or approve_*.
"""
import sys, json, time, random
from curl_cffi import requests as cr

_CHROME = ['chrome146', 'chrome142', 'chrome136', 'chrome133a', 'chrome131', 'chrome124']
_CHATGPT_API = "https://chatgpt.com/backend-api"
_CHECK_V4_URL = (
    f"{_CHATGPT_API}/accounts/check/v4-2023-04-27"
    "?timezone_offset_min=-540"
)
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/146.0.0.0 Safari/537.36"
)
_ACTIVE_PLANS = ("plus", "pro", "team", "enterprise")


def _log(m):
    print(json.dumps({"log": f"  [Approval] {m}"}), flush=True)


def _emit(payload):
    print(json.dumps(payload), flush=True)


def _normalize_plan(sp):
    """Mirror account_validator._subscription_plan_to_normal.

    Samples observed:
      chatgptplusplan -> plus
      chatgptteamplan -> team
      chatgptproplan  -> pro
      chatgptfreeplan -> free
    """
    raw = (sp or "").strip().lower()
    if not raw:
        return ""
    if "team" in raw:
        return "team"
    if "pro" in raw and "plus" not in raw:
        return "pro"
    if "plus" in raw:
        return "plus"
    if "free" in raw:
        return "free"
    return raw[:40]


def main():
    try:
        inp = json.loads(sys.stdin.read())
    except Exception as e:
        _emit({"status": "error", "reason": "approval_bad_input", "detail": str(e)[:80]})
        return

    access_token = inp.get('access_token', '')
    approval_url = inp.get('approval_url', '')
    proxy = inp.get('proxy') or None
    proxies = {'http': proxy, 'https': proxy} if proxy else None
    poll_interval_ms = int(inp.get('poll_interval_ms', 2000))
    max_wait_ms = int(inp.get('max_wait_ms', 30000))

    if not access_token or not access_token.startswith("eyJ"):
        _emit({"status": "error", "reason": "approval_invalid_access_token"})
        return
    if not approval_url:
        _emit({"status": "error", "reason": "approval_missing_url"})
        return

    imp = random.choice(_CHROME)
    _log(f"impersonate={imp}, poll={poll_interval_ms}ms, max_wait={max_wait_ms}ms")

    # Headers used for both the approval GET and the subsequent check/v4 polls.
    # Referer chatgpt.com matches the browser flow (PayPal returns the user to
    # chatgpt.com/agreements/approve which then redirects to chatgpt.com).
    common_headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
        "User-Agent": _USER_AGENT,
        "Referer": "https://chatgpt.com/",
    }

    # Step 1: GET approval URL to trigger ChatGPT-side commit of the agreement.
    # The browser uses text/html Accept here; mirror it so the server returns
    # the post-approval landing page rather than a JSON error envelope.
    approve_headers = dict(common_headers)
    approve_headers["Accept"] = (
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    )
    try:
        r = cr.get(
            approval_url,
            headers=approve_headers,
            impersonate=imp,
            proxies=proxies,
            timeout=15,
            allow_redirects=True,
        )
    except Exception as e:
        _emit({"status": "error", "reason": "approve_fetch", "detail": str(e)[:120]})
        return

    final_url = str(getattr(r, "url", "") or "")
    _log(f"approval HTTP {r.status_code}, final URL: {final_url[:120]}")
    if r.status_code >= 400:
        body = ""
        try:
            body = (r.text or "")[:300]
        except Exception:
            pass
        _emit({
            "status": "error",
            "reason": f"approve_http_{r.status_code}",
            "body": body,
        })
        return

    # Step 2: Poll /backend-api/accounts/check/v4-2023-04-27 until plan flips
    # to plus/pro/team. Reference: account_validator.py:120-195.
    deadline = time.time() + max_wait_ms / 1000.0
    poll_secs = poll_interval_ms / 1000.0
    last_plan = ""
    last_sub_plan = ""
    last_active = None
    last_status_code = 0
    poll_count = 0
    while time.time() < deadline:
        poll_count += 1
        try:
            me = cr.get(
                _CHECK_V4_URL,
                headers=common_headers,
                impersonate=imp,
                proxies=proxies,
                timeout=10,
            )
        except Exception as e:
            _log(f"check/v4 poll error (continuing): {type(e).__name__}: {str(e)[:60]}")
            time.sleep(poll_secs)
            continue

        last_status_code = getattr(me, "status_code", 0)
        if last_status_code == 401:
            # Token may have been revoked after plan flip; treat as terminal.
            _emit({
                "status": "error",
                "reason": "approval_check_401",
                "body": "access_token rejected by check/v4 (possibly revoked on plan change)",
            })
            return
        if last_status_code != 200:
            _log(f"check/v4 HTTP {last_status_code} (continuing)")
            time.sleep(poll_secs)
            continue

        try:
            data = me.json()
        except Exception:
            _log("check/v4 200 non-json (continuing)")
            time.sleep(poll_secs)
            continue
        if not isinstance(data, dict):
            time.sleep(poll_secs)
            continue

        acc = (data.get("accounts") or {}).get("default") or {}
        ent = acc.get("entitlement") or {}
        has_active = bool(ent.get("has_active_subscription"))
        sub_plan = str(ent.get("subscription_plan") or "")
        plan = _normalize_plan(sub_plan)
        if not plan:
            plan = "free" if not has_active else "unknown"

        last_plan = plan
        last_sub_plan = sub_plan
        last_active = has_active
        _log(
            f"poll #{poll_count} sub_plan={sub_plan!r} plan={plan} "
            f"active={has_active}"
        )

        if plan.lower() in _ACTIVE_PLANS:
            _emit({"status": "success", "data": {
                "plan_type": plan,
                "subscription_plan": sub_plan,
                "is_subscribed": True,
                "has_active_subscription": has_active,
                "polls": poll_count,
            }})
            return
        # Some flows return has_active_subscription=True even when subscription_plan
        # is still propagating; accept that as success too.
        if has_active and plan not in ("free", ""):
            _emit({"status": "success", "data": {
                "plan_type": plan,
                "subscription_plan": sub_plan,
                "is_subscribed": True,
                "has_active_subscription": True,
                "polls": poll_count,
            }})
            return

        time.sleep(poll_secs)

    _emit({
        "status": "error",
        "reason": "approval_no_plus_after_timeout",
        "body": (
            f"last_plan={last_plan} last_sub_plan={last_sub_plan!r} "
            f"last_active={last_active} last_http={last_status_code} "
            f"polls={poll_count}"
        ),
    })


if __name__ == "__main__":
    main()
