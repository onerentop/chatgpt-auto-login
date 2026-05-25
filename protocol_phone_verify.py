# protocol_phone_verify.py — 协议模式 add_phone 单次 attempt HTTP 流程
# v2.40.0：与浏览器模式 utils.js v2.39.4 功能等价。
# 此脚本只跑一次 attempt，retry / phone-pool 操作全在 Node。
import json
import re
import sys
import time

from _pkce_common import (
    AUTH, _log,
    get_sentinel_token,
    follow_continue_for_auth_code,
    exchange_code,
    rebuild_session,
)


def is_phone_rejected(resp):
    """判定 phone-start 响应是否表示 OpenAI 拒号（红字"无法发送验证码"）。
    根据 Phase 0 抓包报告 docs/superpowers/research/2026-05-26-openai-add-phone-http.md
    判定条件填入此函数。占位实现：HTTP 4xx 一律算拒；JSON body 含 error/code 字段也算。"""
    if resp.status_code >= 400 and resp.status_code < 500:
        return True
    try:
        data = resp.json()
        # Phase 0 报告确认具体 error key — 占位用通用判定
        err = (data.get("error") or "").lower()
        code = (data.get("code") or "").lower()
        for kw in ["phone_send_failed", "unable_to_send", "cannot_send", "phone_rejected"]:
            if kw in err or kw in code:
                return True
    except Exception:
        pass
    return False


def has_sms_prompt(resp):
    """判定 phone-start 响应是否进入"等待 SMS 输入"状态。Phase 0 报告填入。"""
    if not resp.ok:
        return False
    try:
        data = resp.json()
        page_type = (data.get("page") or {}).get("type", "")
        if "sms" in page_type.lower() or "phone_verify" in page_type or "code" in page_type:
            return True
        # 或者根据 continue_url 路径判定
        cont = data.get("continue_url", "")
        if "sms" in cont or "verify-phone" in cont or "phone-code" in cont:
            return True
    except Exception:
        pass
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
    sentinel = get_sentinel_token(s, ss["device_id"], flow="phone_start", user_agent=ss["user_agent"]) or ""
    # NOTE: endpoint path 来自 Phase 0 报告 — 替换为真实 path
    PHONE_START_PATH = "/api/accounts/phone/start"
    r = s.post(
        f"{AUTH}{PHONE_START_PATH}",
        json={"phone": phone},  # payload schema 来自 Phase 0 报告
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": AUTH,
            "Referer": ss.get("current_url", AUTH + "/add-phone"),
            "oai-device-id": ss["device_id"],
            "openai-sentinel-token": sentinel,
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
    sentinel = get_sentinel_token(s, ss["device_id"], flow="phone_validate", user_agent=ss["user_agent"]) or ""
    PHONE_VALIDATE_PATH = "/api/accounts/phone/validate"  # 来自 Phase 0
    r = s.post(
        f"{AUTH}{PHONE_VALIDATE_PATH}",
        json={"code": code},  # payload 来自 Phase 0
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": AUTH,
            "Referer": ss.get("current_url", AUTH + "/add-phone"),
            "oai-device-id": ss["device_id"],
            "openai-sentinel-token": sentinel,
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
