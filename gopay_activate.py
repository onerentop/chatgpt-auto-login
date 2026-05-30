#!/usr/bin/env python3
"""Phase 4+5: GoPay 钱包注册 + Midtrans 支付（单脚本合并）。

同一个印尼号收 4 次 SMS OTP：
  1. signup OTP（Gojek 注册）
  2. PIN setup OTP
  3. login 2FA OTP（拿 login-session token 触发 1Rp consent）
  4. Midtrans linking OTP（支付绑定）

Input:  JSON on stdin  { midtrans_url, pin, timeout }
Output: JSON lines on stdout — log lines as {"log":"..."}, final as {"status":...}
Env:    GOPAY_PROXY=<印尼代理>, OPAI_CONFIG_FILE=<gopay config path>

换号重试模式与 gopay-deploy/_register_one 一致：
  _register_one 返回 None=号码不可用(已注册) → 外层循环重试
  _register_one 返回 "NO_STOCK"/"RATE_LIMITED" → 不可重试
  _register_one 返回 dict → 成功
"""
import sys, os, json, logging, random, time, string

_GOPAY_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gopay", "app", "src")
sys.path.insert(0, _GOPAY_ROOT)

from opai.core.sms_provider import create_sms_provider
from opai.core.gojek_client import GojekClient
from opai.core.gopay_payment_protocol import GoPayPayment, GoPayFraudDenyError
from opai.core.sms_helpers import api_call_with_retry, is_rate_limited, is_waf_block
import opai.core.gojek_client as _gc

log = logging.getLogger(__name__)

_NAMES = [
    "Budi Santoso", "Adi Pratama", "Siti Rahayu", "Dewi Lestari",
    "Rizky Ramadhan", "Putri Wulandari", "Agus Setiawan", "Rina Kusuma",
    "Hendra Wijaya", "Novi Anggraini", "Dian Permata", "Wahyu Hidayat",
    "Fitri Handayani", "Joko Susilo", "Ratna Sari", "Bambang Prasetyo",
]


def _log(m):
    print(json.dumps({"log": f"  [GoPay] {m}"}), flush=True)


def _emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def _load_config():
    cfg_path = os.environ.get("GOPAY_CONFIG_FILE", "")
    if not cfg_path:
        cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
    if not os.path.exists(cfg_path):
        return {}
    with open(cfg_path) as f:
        return json.load(f)


SINGBOX_GOPAY_PORT = 27890
ROTATE_IP_URL = "http://127.0.0.1:3000/api/gopay-activate/rotate-ip"


def _rotate_ip():
    """调 Node API 重启 sing-box 换 IPRoyal session（新 IP）。"""
    try:
        import urllib.request
        req = urllib.request.Request(ROTATE_IP_URL, method="POST", data=b"{}")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=15) as resp:
            _log(f"IP rotated: {resp.read().decode()[:80]}")
            time.sleep(5)
            return True
    except Exception as e:
        _log(f"IP rotate failed: {e} (falling back to 30s wait)")
        time.sleep(30)
        return False


def _make_proxy(cfg):
    """返回 GoPay 代理地址。优先用 sing-box 27890（已绑 WLAN 转发到 IPRoyal，绕 TUN）。"""
    direct = os.environ.get("GOPAY_PROXY", "")
    if direct:
        return direct
    id_cfg = cfg.get("proxy", {}).get("idGopay", {})
    if id_cfg.get("enabled") and id_cfg.get("proxyTemplate"):
        return f"http://127.0.0.1:{SINGBOX_GOPAY_PORT}"
    return ""


def _register_one(provider, pin, proxy):
    """注册一个 GoPay 钱包（含 1Rp）。

    返回值与 gopay-deploy/_register_one 一致：
      dict  → 成功 {"client", "phone", "local", "aid"}
      None  → 号码不可用（已注册），外层重试
      "NO_STOCK" / "RATE_LIMITED" → 字符串，不可重试
    """
    phone, aid = provider.get_number()
    if not phone:
        return "NO_STOCK"

    local = phone.lstrip("+")
    if local.startswith("62"):
        local = local[2:]

    _log(f"Rented phone: +62{local}")
    client = GojekClient.from_phone(phone, proxy=proxy)
    success = False

    try:
        # Step 1: 检查号码是否已注册
        time.sleep(2)
        methods = api_call_with_retry(client.get_login_methods, "+62", local)
        if is_rate_limited(methods) or is_waf_block(methods):
            _log("Rate limited / WAF, need IP rotation")
            return "RATE_LIMITED"
        if methods["status"] in (200, 201):
            _log(f"+62{local} already registered, skipping")
            return None

        # Step 2: Signup OTP
        _log("Requesting signup OTP...")
        otp_result = client.signup_request_otp(phone)
        if is_rate_limited(otp_result):
            return "RATE_LIMITED"
        if otp_result["status"] not in (200, 201):
            _log(f"Signup OTP failed: {otp_result['status']}")
            return None

        otp = provider.wait_code(aid, timeout=60)
        if not otp:
            _log("Signup OTP timeout")
            return None
        _log(f"Signup OTP received: {otp}")

        time.sleep(2)
        verify = api_call_with_retry(client.signup_verify_otp, otp, phone)
        if verify["status"] not in (200, 201):
            _log(f"Signup verify failed: {verify['status']}")
            return None

        time.sleep(2)
        signup = api_call_with_retry(client.signup_create_account,
                                     name=random.choice(_NAMES), phone=phone, email="", country="ID")
        if signup["status"] not in (200, 201):
            _log(f"Signup failed: {signup['body']}")
            return None
        _log(f"Account created (uid={client.user_uuid})")
        success = True  # 账号已创建，后续失败也不 cancel 号码

        # Step 3: Refresh token
        time.sleep(5)
        refresh = api_call_with_retry(client.refresh_token)
        if refresh["status"] not in (200, 201):
            _log(f"Token refresh failed: {refresh['status']}")
            return None

        # Step 4: GoPay Init
        time.sleep(2)
        api_call_with_retry(client.gopay_init)
        time.sleep(2)
        api_call_with_retry(client.gopay_get_profiles)
        time.sleep(2)
        profile = api_call_with_retry(client.get_user_profile)
        is_pin_set = profile["body"].get("data", {}).get("is_pin_setup", False) if profile["status"] == 200 else False

        if not is_pin_set:
            # Step 5: PIN Setup (OTP #2)
            _log("Setting up PIN...")
            provider.request_another(aid)
            time.sleep(2)
            pin_otp_r = api_call_with_retry(client.pin_request_otp)
            if pin_otp_r["status"] not in (200, 201):
                _log(f"PIN OTP request failed: {pin_otp_r['status']}")
                return None

            pin_code = provider.wait_code(aid, timeout=60)
            if not pin_code:
                _log("PIN OTP timeout, resending...")
                resend_body = {
                    "client_id": _gc.CLIENT_ID,
                    "client_secret": _gc.CLIENT_SECRET,
                    "flow": "goto_pin_wa_sms",
                    "verification_id": client.auth.verification_id,
                    "verification_method": "otp_sms",
                }
                time.sleep(2)
                resend = client._sso_post("/cvs/v1/initiate", resend_body)
                if resend["status"] in (200, 201):
                    inner = resend["body"].get("data", resend["body"])
                    client.auth.otp_token = inner.get("otp_token", "")
                    provider.request_another(aid)
                    pin_code = provider.wait_code(aid, timeout=60)
            if not pin_code:
                _log("PIN OTP not received")
                return None
            _log(f"PIN OTP received: {pin_code}")

            time.sleep(2)
            pin_verify = api_call_with_retry(client.pin_verify_otp, pin_code)
            if pin_verify["status"] not in (200, 201):
                _log(f"PIN verify failed: {pin_verify['status']}")
                return None

            time.sleep(2)
            pin_result = api_call_with_retry(client.pin_setup, pin)
            if pin_result["status"] not in (200, 201):
                _log(f"PIN setup failed: {pin_result['status']}")
                return None
            _log("PIN set OK")
        else:
            _log("PIN already set")

        # Step 6: Full login for login-session token (OTP #3)
        _log("Re-login for login-session token...")
        time.sleep(5)
        _orig_cid, _orig_csec = _gc.CLIENT_ID, _gc.CLIENT_SECRET
        _orig_appid, _orig_ver = client.appid, client.version
        _saved_access = client.auth.access_token
        _saved_refresh = client.auth.refresh_token
        try:
            _gc.CLIENT_ID = "gopay:consumer:app"
            _gc.CLIENT_SECRET = "raOUumeMRBNifqvZRFjvsgTnjAlaA9"
            client.appid = "com.gojek.gopay"
            client.version = "2.8.0"

            def _wait_login_otp():
                _log("Requesting login 2FA OTP...")
                provider.request_another(aid)
                code = provider.wait_code(aid, timeout=120)
                if code:
                    _log(f"Login 2FA OTP received: {code}")
                else:
                    _log("Login 2FA OTP timeout (120s)")
                return code

            login_r = client.login("+62", local, pin, otp_callback=_wait_login_otp)
            if login_r["status"] in (200, 201):
                _log("Login OK, got login-session token")
            else:
                detail = login_r.get("body", {})
                _log(f"Login failed: {login_r['status']} detail={str(detail)[:200]}")
                client.auth.access_token = _saved_access
                client.auth.refresh_token = _saved_refresh
        except Exception as e:
            _log(f"Login exception: {e} (consent may not trigger 1 Rp)")
            client.auth.access_token = _saved_access
            client.auth.refresh_token = _saved_refresh
        finally:
            _gc.CLIENT_ID, _gc.CLIENT_SECRET = _orig_cid, _orig_csec
            client.appid, client.version = _orig_appid, _orig_ver

        # Step 7: Accept consents → triggers 1 Rp credit
        time.sleep(2)
        try:
            consent_r = api_call_with_retry(client.accept_consents, "signIn")
            if consent_r["status"] in (200, 201):
                _log("Consents accepted")
            else:
                _log(f"Consent returned {consent_r['status']} (non-fatal)")
        except Exception as e:
            _log(f"Consent failed: {e} (non-fatal)")

        # Step 8: Wait for 1 Rp balance
        _log("Waiting for 1 Rp balance...")
        for i in range(12):
            time.sleep(5)
            bal = client.get_balance()
            if bal["status"] == 200:
                data = bal["body"].get("data", [])
                if isinstance(data, list) and data:
                    bal_obj = data[0].get("balance", {})
                    amt = bal_obj.get("value", 0) if isinstance(bal_obj, dict) else (bal_obj if isinstance(bal_obj, (int, float)) else 0)
                    if amt > 0:
                        _log(f"Balance: {amt}")
                        success = True
                        return {"client": client, "phone": phone, "local": local, "aid": aid}
        _log("WARNING: balance still 0 after 60s, proceeding anyway")
        success = True
        return {"client": client, "phone": phone, "local": local, "aid": aid}

    except Exception as e:
        _log(f"Registration exception: {e}")
        return None
    finally:
        if not success:
            try:
                provider.cancel(aid)
            except Exception:
                pass


def _phase5_pay(account, pin, midtrans_url, provider, proxy):
    """Phase 5: Midtrans GoPay 支付（完整 linking + charge 流程）。"""
    local = account["local"]
    aid = account["aid"]

    _log(f"Starting Midtrans payment: {midtrans_url[:60]}...")

    payment = GoPayPayment(proxy=proxy)

    def _wait_otp(p, timeout):
        _log(f"Waiting for linking OTP on {p}...")
        provider.request_another(aid)
        code = provider.wait_code(aid, timeout=timeout)
        if code:
            _log(f"Linking OTP received: {code}")
        else:
            _log("Linking OTP timeout!")
        return code

    result = payment.pay_stripe(
        midtrans_url=midtrans_url,
        phone=local,
        country_code="62",
        pin=pin,
        wait_otp=_wait_otp,
    )
    return result


def _phase3_stripe(access_token, proxy):
    """Phase 3: Stripe 协议链 → Midtrans snap URL。走 JP 代理（7891）。"""
    _log("=== Phase 3: Stripe GoPay checkout ===")
    import subprocess
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stripe_gopay_flow.py")
    env = {**os.environ, "HTTPS_PROXY": "http://127.0.0.1:7891", "HTTP_PROXY": "http://127.0.0.1:7891"}
    inp = json.dumps({"access_token": access_token})
    proc = subprocess.run(
        ["py", "-3", script],
        input=inp, capture_output=True, text=True, timeout=60, env=env,
    )
    result = None
    for line in proc.stdout.strip().split("\n"):
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
            if parsed.get("log"):
                _log(parsed["log"].replace("  [StripeGoPay] ", ""))
            else:
                result = parsed
        except Exception:
            pass
    if not result or result.get("status") != "success":
        reason = result.get("reason", "unknown") if result else proc.stderr[:200]
        raise RuntimeError(f"STRIPE_FAIL: {reason}")
    _log(f"Midtrans URL: {result['midtrans_url'][:60]}...")
    return result["midtrans_url"]


def main():
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s: %(message)s")

    inp = json.loads(sys.stdin.read())
    access_token = inp.get("access_token", "")
    midtrans_url = inp.get("midtrans_url", "")

    cfg = _load_config()
    gopay_cfg = cfg.get("gopay", {})
    pool_cfg = cfg.get("phonePool", {})

    pin = inp.get("pin", "") or gopay_cfg.get("defaultPin", "147258")

    provider_name = gopay_cfg.get("smsProvider", "smsbower")
    provider_params = pool_cfg.get(provider_name, {})
    api_key = provider_params.get("apiKey", "")
    provider = create_sms_provider(provider_name, api_key)

    phone = ""
    account = None
    proxy = ""

    try:
        # Phase 4: 先注册 GoPay 钱包（耗时长，先做）
        _log("=== Phase 4: Register GoPay wallet ===")
        for attempt in range(20):
            proxy = _make_proxy(cfg)
            _log(f"Attempt {attempt+1}/20, proxy: {proxy.split('@')[-1] if '@' in proxy else proxy[:30]}")
            result = _register_one(provider, pin, proxy)

            if isinstance(result, dict):
                account = result
                phone = account["phone"]
                break
            if result == "NO_STOCK":
                provider.escalate_price()
                _log("No stock, escalated price tier")
                time.sleep(5)
                continue
            if result == "RATE_LIMITED":
                _log("429 rate limited, rotating IP...")
                _rotate_ip()
                continue
            _log("Number not usable, retrying in 3s...")
            time.sleep(3)

        if not account:
            _emit({"status": "gopay_reg_fail", "phone": "", "detail": "all 20 attempts failed"})
            return
        _log(f"Registration complete: {phone}")

        # Phase 3: 注册完成后再获取 Midtrans URL（15 分钟有效期，紧接 Phase 5）
        if not midtrans_url:
            if not access_token:
                _emit({"status": "error", "phone": phone, "detail": "no access_token or midtrans_url"})
                return
            midtrans_url = _phase3_stripe(access_token, proxy)

        # Phase 5: 立刻支付（snap token 刚生成，15 分钟内有效）
        _log("=== Phase 5: Pay via GoPay ===")
        pay_result = _phase5_pay(account, pin, midtrans_url, provider, proxy)

        if pay_result.get("success"):
            _emit({
                "status": "success",
                "phone": phone,
                "transaction_status": pay_result.get("transaction_status", "unknown"),
            })
        else:
            _emit({
                "status": "gopay_pay_fail",
                "phone": phone,
                "detail": pay_result.get("detail", "unknown"),
                "transaction_status": pay_result.get("transaction_status", ""),
            })

    except GoPayFraudDenyError as e:
        _log(f"FRAUD DENIED: {e}")
        _emit({"status": "gopay_fraud", "phone": phone, "detail": str(e)[:300]})
    except Exception as e:
        _log(f"Unexpected error: {e}")
        _emit({"status": "gopay_reg_fail", "phone": phone, "detail": str(e)[:300]})


if __name__ == "__main__":
    main()
