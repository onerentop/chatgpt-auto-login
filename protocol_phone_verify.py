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


def classify_reject(resp):
    """v2.40.3/v2.40.5: 细分 OpenAI phone-start 拒号类型。返回 (kind, detail)。
    kind:
        None         → 不是拒号（200 / 5xx / 网络错误等）
        "rate-limit" → rate_limit_exceeded —— 账号级速率限制，换号也拒，立刻 break + markSaturated
        "fraud"      → fraud_guard 类（"phone numbers similar to yours suspicious"）—— 账号风控
        "voip"       → voip_phone_disallowed —— 号是 VoIP，所有账号都会拒，立刻 break + markSaturated
        "phone"      → 其它未知 4xx —— 保守 release + retry（可能临时网络问题）
    """
    if not (400 <= resp.status_code < 500):
        return (None, "")
    try:
        data = resp.json()
        err = data.get("error") or {}
        code = (err.get("code") or "").lower()
        msg = err.get("message") or ""
    except Exception:
        code = ""
        msg = (resp.text or "")[:200]
    if "rate_limit" in code or "rate limit" in msg.lower() or "too many" in msg.lower():
        return ("rate-limit", f"{code}: {msg[:200]}")
    if "fraud" in code or "suspicious" in msg.lower() or "similar to yours" in msg.lower():
        return ("fraud", f"{code}: {msg[:200]}")
    if "voip" in code or "voip" in msg.lower():
        return ("voip", f"{code}: {msg[:200]}")
    # 其他 4xx + invalid_request_error 视为未知号问题（保守 retry）
    return ("phone", f"{code or 'HTTP'} {resp.status_code}: {msg[:200]}")


def is_phone_rejected(resp):
    """v2.40.0 兼容 wrapper — 仍返 boolean。新代码用 classify_reject。"""
    kind, _ = classify_reject(resp)
    return kind is not None


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
    _log("verify: main() entered")
    try:
        raw = sys.stdin.read()
        _log(f"verify: stdin read {len(raw)} bytes")
        inp = json.loads(raw)
    except Exception as e:
        print(json.dumps({"status": "submit-error", "detail": f"bad stdin: {e}"}), flush=True)
        return

    ss = inp.get("session_state") or {}
    phone = inp.get("phone", "")
    sms_cfg = inp.get("sms") or {}
    proxy_url = inp.get("proxy_url")
    _ua = ss.get('user_agent', '')
    _m = re.search(r'Chrome/(\d+)', _ua)
    _log(f"verify: phone={phone} provider={sms_cfg.get('provider')} cookies={len(ss.get('cookies', []))} ua_chrome={_m.group(1) if _m else '?'} proxy={'yes' if proxy_url else 'no'}")

    _log("verify: rebuilding session...")
    s = rebuild_session(ss, proxy_url)
    _log("verify: session rebuilt OK")

    # Step 1: phone-start
    # Phase 0 confirmed: path = /api/accounts/add-phone/send, payload = {"phone_number": ...}, 无需 sentinel
    PHONE_START_PATH = "/api/accounts/add-phone/send"
    _log(f"verify: POST {PHONE_START_PATH} phone={phone}")
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
    _log(f"verify: phone-start status={r.status_code} body={(r.text or '')[:200]}")
    reject_kind, reject_detail = classify_reject(r)
    if reject_kind == "rate-limit":
        # 账号级 rate limit，换号也会拒 → 立刻 break + markSaturated（号在 OpenAI 那边触发限流）
        print(json.dumps({"status": "rate-limited", "detail": reject_detail}), flush=True)
        return
    if reject_kind == "fraud":
        # 账号被 fraud_guard 拦 → markSaturated
        print(json.dumps({"status": "fraud-blocked", "detail": reject_detail}), flush=True)
        return
    if reject_kind == "voip":
        # 号是 VoIP，所有账号都会被拒 → markSaturated（v2.40.5）
        print(json.dumps({"status": "voip-blocked", "detail": reject_detail}), flush=True)
        return
    if reject_kind == "phone":
        # 未知号问题，保守 release + retry 换号
        print(json.dumps({"status": "phone-rejected", "detail": reject_detail}), flush=True)
        return
    if not has_sms_prompt(r):
        print(json.dumps({"status": "submit-error", "detail": f"phone-start unexpected: {r.status_code} {r.text[:300]}"}), flush=True)
        return

    # Step 2: poll SMS
    _log(f"verify: polling SMS (provider={sms_cfg.get('provider')})")
    code = poll_sms(sms_cfg, max_attempts=30, interval=3, proxy_url=proxy_url)
    if not code:
        print(json.dumps({"status": "sms-timeout"}), flush=True)
        return
    _log(f"verify: got SMS code (len={len(code)})")

    # Step 3: phone-validate
    # v2.40.0 smoke confirmed: path = /api/accounts/phone-otp/validate (NOT add-phone/validate)
    # 对应 phone-start 响应 page.type=phone_otp_verification → endpoint 用 phone-otp 命名空间。
    # 无需 sentinel。
    PHONE_VALIDATE_PATH = "/api/accounts/phone-otp/validate"
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
        print(json.dumps({"status": "validate-error", "detail": f"HTTP {r.status_code} {r.text[:300]}"}), flush=True)
        return
    data = {}
    try:
        data = r.json()
    except Exception:
        pass
    continue_url = data.get("continue_url", "")
    if not continue_url:
        print(json.dumps({"status": "validate-error", "detail": "no continue_url in validate response"}), flush=True)
        return

    # 至此 OpenAI 已接受号 + 验证码 → 之后失败属 post-validate-error（保留 binding）

    # Step 4: follow continue → localhost:1455 → 拿 auth_code
    auth_code = follow_continue_for_auth_code(s, continue_url)
    if not auth_code:
        print(json.dumps({"status": "post-validate-error", "detail": "no auth_code from continue_url"}), flush=True)
        return

    # Step 5: oauth/token exchange
    tokens = exchange_code(s, auth_code, ss["code_verifier"], ss["client_id"], ss["redirect_uri"])
    if not tokens.get("access_token"):
        print(json.dumps({"status": "post-validate-error", "detail": "token exchange empty"}), flush=True)
        return

    print(json.dumps({"status": "ok", "tokens": tokens}), flush=True)


if __name__ == "__main__":
    # v2.40.2: top-level try/except 包整个 main，任何未处理异常都返 JSON status
    # 避免 ImpersonateError 等 Python exception 直接 stderr，被 Node spawn 收到无法解析
    try:
        main()
    except Exception as _e:
        import traceback as _tb
        print(json.dumps({"status": "submit-error", "detail": f"{type(_e).__name__}: {str(_e)[:200]} | {_tb.format_exc()[-500:]}"}), flush=True)
