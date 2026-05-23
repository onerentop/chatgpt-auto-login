#!/usr/bin/env python3
"""Perform PKCE OAuth code-flow against auth.openai.com to exchange access_token for refresh_token.

Input: JSON on stdin  { access_token, client_id, redirect_uri, scope, proxy }
Output: JSON line on stdout — log lines as {"log":"..."}, final as {"status":...}

PKCE protocol (mirrors existing Playwright flow in utils.js fetchTokensViaPKCE +
_monolith.py:_exchange_refresh_token_with_session):
  1. Generate code_verifier (64 random bytes -> base64url) + code_challenge
     (sha256(verifier_string) -> base64url)
  2. GET https://auth.openai.com/oauth/authorize?... &code_challenge=...&code_challenge_method=S256
     Header: Authorization: Bearer <access_token>
     Extra params: id_token_add_organizations=true, codex_cli_simplified_flow=true
     Expect 302 redirect to redirect_uri?code=<auth_code>&state=<state>
  3. POST https://auth.openai.com/oauth/token (form-urlencoded — matches _monolith.py:5553-5565)
     grant_type=authorization_code, code, code_verifier, client_id, redirect_uri
     Response JSON: { access_token, refresh_token, id_token, ... }

OAuth constants (verified from utils.js:130-134 and _monolith.py:5183/5242-5257):
  client_id    = "app_EMoamEEZ73f0CkXaXp7hrann"
  redirect_uri = "http://localhost:1455/auth/callback"
  scope        = "openid email profile offline_access"

References:
  - utils.js:122-369 (existing Playwright PKCE flow — authoritative for constants)
  - Gpt-Agreement-Payment/CTF-pay/card/_monolith.py:5216-5573 (HTTP PKCE reference)
    :5239-5246 PKCE verifier/challenge gen (64 random bytes, base64url-nopad)
    :5247-5257 /oauth/authorize URL construction (with id_token_add_organizations etc.)
    :5553-5565 /oauth/token form-urlencoded exchange

IMPORTANT LIMITATION (verified via smoke test 2026-05-23):
This script attempts a "headless" authorize step using the user's existing
access_token as a Bearer credential. OpenAI's /oauth/authorize endpoint does
accept the call and returns 302, but the redirect chain is:
    /oauth/authorize           -> 302 /api/oauth/oauth2/auth
    /api/oauth/oauth2/auth     -> 302 /api/accounts/login?login_challenge=...
    /api/accounts/login        -> 302 /log-in
    /log-in                    -> 200 (HTML login page)
i.e., the Bearer access_token is NOT honored as session credential by Ory
Hydra; a real cookie-based login session is required. The reference
_monolith.py:_exchange_refresh_token_with_session (line 5216+) also uses a
full Camoufox browser, not pure HTTP, confirming HTTP-only PKCE is not viable
against the current openai auth stack.

If the caller already has session cookies (e.g., from a previous login.js
run), those should be injected. For now this script can be used to validate
constants/protocol shape — it will return pkce_redirect_not_callback with the
HTML login URL when Bearer alone is insufficient (the expected current
behavior). Future enhancement: accept `cookies` field in input and attach
them to the curl_cffi Session.
"""
import sys, json, hashlib, base64, secrets, random, re
from curl_cffi import requests as cr

_CHROME = ['chrome146', 'chrome142', 'chrome136', 'chrome133a', 'chrome131', 'chrome124']
_AUTH_HOST = "https://auth.openai.com"

# Defaults sourced from utils.js:130-134 (existing fetchTokensViaPKCE) and
# _monolith.py:5183 (_OPENAI_CODEX_CLIENT_ID). Caller may override via input JSON.
_DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
_DEFAULT_REDIRECT_URI = "http://localhost:1455/auth/callback"
_DEFAULT_SCOPE = "openid email profile offline_access"


def _log(m):
    print(json.dumps({"log": f"  [PKCE] {m}"}), flush=True)


def _emit(payload):
    print(json.dumps(payload), flush=True)


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def _gen_pkce():
    # 64 random bytes matches _monolith.py:5245; utils.js uses 32 — both valid per RFC 7636.
    verifier_bytes = secrets.token_bytes(64)
    verifier = _b64url(verifier_bytes)
    challenge = _b64url(hashlib.sha256(verifier.encode()).digest())
    return verifier, challenge


def main():
    try:
        inp = json.loads(sys.stdin.read())
    except Exception as e:
        _emit({"status": "error", "reason": "pkce_bad_input", "detail": str(e)[:80]})
        return

    access_token = inp.get('access_token', '')
    client_id = inp.get('client_id') or _DEFAULT_CLIENT_ID
    redirect_uri = inp.get('redirect_uri') or _DEFAULT_REDIRECT_URI
    scope = inp.get('scope') or _DEFAULT_SCOPE
    proxy = inp.get('proxy') or None
    proxies = {'http': proxy, 'https': proxy} if proxy else None

    if not access_token or not access_token.startswith("eyJ"):
        _emit({"status": "error", "reason": "pkce_invalid_access_token"})
        return
    if not client_id or not redirect_uri:
        _emit({"status": "error", "reason": "pkce_missing_oauth_config"})
        return

    verifier, challenge = _gen_pkce()
    state = _b64url(secrets.token_bytes(24))
    imp = random.choice(_CHROME)
    _log(f"impersonate={imp}, client_id={client_id[:24]}..., redirect_uri={redirect_uri}")

    # Step 1: GET /oauth/authorize — expect 302 redirect with ?code=...
    # Bearer auth is a best-effort attempt; OpenAI may still require cookie session.
    auth_params = {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "scope": scope,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "id_token_add_organizations": "true",
        "codex_cli_simplified_flow": "true",
    }
    try:
        auth_resp = cr.get(
            f"{_AUTH_HOST}/oauth/authorize",
            params=auth_params,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
            impersonate=imp,
            proxies=proxies,
            timeout=15,
            allow_redirects=False,
        )
    except Exception as e:
        _emit({"status": "error", "reason": "pkce_authorize_fetch", "detail": str(e)[:120]})
        return

    _log(f"authorize -> {auth_resp.status_code}")

    if auth_resp.status_code not in (301, 302, 303, 307, 308):
        # Either 200 (login page HTML — needs interactive session) or 4xx (auth error)
        _emit({
            "status": "error",
            "reason": f"pkce_authorize_{auth_resp.status_code}",
            "body": auth_resp.text[:400],
        })
        return

    redirect_location = auth_resp.headers.get("location") or auth_resp.headers.get("Location")
    if not redirect_location:
        _emit({"status": "error", "reason": "pkce_no_redirect_location"})
        return
    _log(f"authorize redirect: {redirect_location[:100]}...")

    # Check whether redirect actually went to our callback (success) or to a login page (failure)
    if redirect_uri not in redirect_location and "localhost:1455" not in redirect_location:
        _emit({
            "status": "error",
            "reason": "pkce_redirect_not_callback",
            "body": redirect_location[:300],
        })
        return

    # Parse code from redirect URL query
    code_match = re.search(r"[?&]code=([^&]+)", redirect_location)
    if not code_match:
        _emit({
            "status": "error",
            "reason": "pkce_no_code_in_redirect",
            "body": redirect_location[:300],
        })
        return
    auth_code = code_match.group(1)
    _log(f"got auth code: {auth_code[:12]}...")

    # Step 2: POST /oauth/token — form-urlencoded, matches _monolith.py:5553-5565
    token_form = {
        "grant_type": "authorization_code",
        "client_id": client_id,
        "code": auth_code,
        "redirect_uri": redirect_uri,
        "code_verifier": verifier,
    }
    try:
        token_resp = cr.post(
            f"{_AUTH_HOST}/oauth/token",
            data=token_form,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
            },
            impersonate=imp,
            proxies=proxies,
            timeout=30,
        )
    except Exception as e:
        _emit({"status": "error", "reason": "pkce_token_fetch", "detail": str(e)[:120]})
        return

    if token_resp.status_code != 200:
        _emit({
            "status": "error",
            "reason": f"pkce_token_exchange_{token_resp.status_code}",
            "body": token_resp.text[:400],
        })
        return
    try:
        tokens = token_resp.json()
    except Exception:
        _emit({"status": "error", "reason": "pkce_token_not_json", "body": token_resp.text[:400]})
        return

    rt = tokens.get("refresh_token")
    at = tokens.get("access_token")
    if not rt:
        _emit({
            "status": "error",
            "reason": "pkce_no_refresh_token",
            "body": json.dumps(tokens)[:400],
        })
        return

    _log(f"refresh_token obtained: {rt[:20]}...")
    # Return shape aligned with utils.js fetchTokensViaPKCE for downstream compat
    _emit({"status": "success", "data": {
        "access_token": at,
        "refresh_token": rt,
        "id_token": tokens.get("id_token", ""),
        "expires_in": tokens.get("expires_in", 3600),
    }})


if __name__ == "__main__":
    main()
