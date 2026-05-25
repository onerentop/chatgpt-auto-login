# protocol_phone_verify.py — 协议模式 add_phone 单次 attempt HTTP 流程
# v2.40.0：与浏览器模式 utils.js v2.39.4 功能等价。
# 此脚本只跑一次 attempt，retry / phone-pool 操作全在 Node。
import json
import re
import sys
import time

from _pkce_common import (
    AUTH, _log,
    follow_continue_for_auth_code,
    exchange_code,
    rebuild_session,
)
# 注意：phone-start 已 Phase 0 confirmed 无需 sentinel；phone-validate 推测同样无需
# （smoke test 待验证）。故此处不再 import get_sentinel_token。若 phone-validate
# smoke test 失败再补回。


def is_phone_rejected(resp):
    """判定 phone-start 响应是否表示 OpenAI 拒号。
    Phase 0 confirmed: HTTP 4xx + body.error.type == 'invalid_request_error' 即拒号
    （已观测 error.code = 'voip_phone_disallowed'；其它 code 后续累积）。
    所有 4xx 一律算 rejected（保守策略）—— release+retry 比 hang/submit-error 好。
    """
    if 400 <= resp.status_code < 500:
        return True
    try:
        data = resp.json()
        err = data.get("error") or {}
        if err.get("type") == "invalid_request_error":
            return True
    except Exception:
        pass
    return False


def has_sms_prompt(resp):
    """判定 phone-start 是否进入"等待 SMS 输入"状态。
    Phase 0 推测：成功响应 200 + body.continue_url（OpenAI 一致用 continue_url
    串联多步流程 — authorize/continue → email-verification → add-phone → ...）。
    Smoke test 待确认 page.type 真实值。
    """
    if not resp.ok:
        return False
    try:
        data = resp.json()
        if data.get("continue_url"):
            return True
        page_type = (data.get("page") or {}).get("type", "")
        return any(kw in page_type.lower() for kw in ["sms", "phone_verify", "phone_code", "verify_phone"])
    except Exception:
        return False


def poll_sms(sms_cfg, max_attempts=30, interval=3, proxy_url=None):
    """轮询 SMS provider 拿 6 位验证码。local 用 GET URL，zhusms 用 GET /api/order/status。"""
    import requests  # stdlib-friendly
    provider = sms_cfg.get("provider", "local")
    proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else None
    for _ in range(max_attempts):
        try:
            if provider == "local":
                r = requests.get(sms_cfg["url"], proxies=proxies, timeout=10)
                if r.ok:
                    m = re.search(r"\b(\d{6})\b", r.text)
                    if m:
                        return m.group(1)
            else:  # zhusms
                headers = {
                    "Cookie": sms_cfg.get("cookie", ""),
                    "Origin": sms_cfg["base_url"],
                    "Referer": sms_cfg["base_url"] + "/",
                }
                r = requests.get(
                    f"{sms_cfg['base_url']}/api/order/status?order_no={sms_cfg['order_no']}",
                    headers=headers,
                    proxies=proxies,
                    timeout=10,
                )
                if r.ok:
                    m = re.search(r"\b(\d{6})\b", json.dumps(r.json()))
                    if m:
                        return m.group(1)
        except Exception:
            pass
        time.sleep(interval)
    return None


def main():
    try:
        inp = json.loads(sys.stdin.read())
    except Exception as e:
        print(json.dumps({"status": "submit-error", "detail": f"bad stdin: {e}"}))
        return

    ss = inp.get("session_state") or {}
    phone = inp.get("phone", "")
    sms_cfg = inp.get("sms") or {}
    proxy_url = inp.get("proxy_url")

    s = rebuild_session(ss, proxy_url)

    # Step 1: phone-start
    # Phase 0 confirmed: path = /api/accounts/add-phone/send, payload = {"phone_number": ...}, 无需 sentinel
    PHONE_START_PATH = "/api/accounts/add-phone/send"
    r = s.post(
        f"{AUTH}{PHONE_START_PATH}",
        json={"phone_number": phone},
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": AUTH,
            "Referer": ss.get("current_url", AUTH + "/add-phone"),
            "oai-device-id": ss["device_id"],
        },
        timeout=30,
    )
    if is_phone_rejected(r):
        print(json.dumps({"status": "phone-rejected", "detail": f"HTTP {r.status_code} {r.text[:120]}"}))
        return
    if not has_sms_prompt(r):
        print(json.dumps({"status": "submit-error", "detail": f"phone-start unexpected: {r.status_code} {r.text[:120]}"}))
        return

    # Step 2: poll SMS
    code = poll_sms(sms_cfg, max_attempts=30, interval=3, proxy_url=proxy_url)
    if not code:
        print(json.dumps({"status": "sms-timeout"}))
        return

    # Step 3: phone-validate
    # Phase 0 推测：path = /api/accounts/add-phone/validate，无需 sentinel；smoke test 待验证
    PHONE_VALIDATE_PATH = "/api/accounts/add-phone/validate"
    r = s.post(
        f"{AUTH}{PHONE_VALIDATE_PATH}",
        json={"code": code},  # payload 来自 Phase 0（code 字段名仍是推测）
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": AUTH,
            "Referer": ss.get("current_url", AUTH + "/add-phone"),
            "oai-device-id": ss["device_id"],
        },
        timeout=30,
    )
    if not r.ok:
        print(json.dumps({"status": "validate-error", "detail": f"HTTP {r.status_code} {r.text[:120]}"}))
        return
    data = {}
    try:
        data = r.json()
    except Exception:
        pass
    continue_url = data.get("continue_url", "")
    if not continue_url:
        print(json.dumps({"status": "validate-error", "detail": "no continue_url in validate response"}))
        return

    # 至此 OpenAI 已接受号 + 验证码 → 之后失败属 post-validate-error（保留 binding）

    # Step 4: follow continue → localhost:1455 → 拿 auth_code
    auth_code = follow_continue_for_auth_code(s, continue_url)
    if not auth_code:
        print(json.dumps({"status": "post-validate-error", "detail": "no auth_code from continue_url"}))
        return

    # Step 5: oauth/token exchange
    tokens = exchange_code(s, auth_code, ss["code_verifier"], ss["client_id"], ss["redirect_uri"])
    if not tokens.get("access_token"):
        print(json.dumps({"status": "post-validate-error", "detail": "token exchange empty"}))
        return

    print(json.dumps({"status": "ok", "tokens": tokens}))


if __name__ == "__main__":
    main()
