"""
ChatGPT 批量自动注册工具 (并发版) - GPTMail 临时邮箱版
依赖: pip install curl_cffi
功能: 使用 GPTMail 临时邮箱，并发自动注册 ChatGPT 账号，自动获取 OTP 验证码
"""

import os
import re
import uuid
import json
import random
import string
import time
import sys
import threading
import traceback
import secrets
import hashlib
import base64
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse, parse_qs, urlencode, quote

from curl_cffi import requests as curl_requests
try:
    from curl_cffi import CurlHttpVersion
    _HTTP_VERSION_1_1 = CurlHttpVersion.V1_1
except (ImportError, AttributeError):
    # 兼容旧版 curl_cffi
    _HTTP_VERSION_1_1 = None

try:
    # 尝试作为模块导入
    from .sentinel_browser import get_sentinel_token_browser
except ImportError:
    try:
        # 尝试直接运行脚本时导入
        from sentinel_browser import get_sentinel_token_browser
    except ImportError:
        def get_sentinel_token_browser(device_id: str, proxy: str = None) -> str:
            return None

# ================= 加载配置 =================
def _load_config():
    """从 config.json 加载配置，环境变量优先级更高"""
    config = {
        "total_accounts": 3,
        "gptmail_api_base": "https://mail.chatgpt.org.uk/api",
        "gptmail_api_key": "",
        "proxy": "",
        "output_file": "registered_accounts.txt",
        "enable_oauth": True,
        "oauth_required": True,
        "oauth_issuer": "https://auth.openai.com",
        "oauth_client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
        "oauth_redirect_uri": "http://localhost:1455/auth/callback",
        "ak_file": "ak.txt",
        "rk_file": "rk.txt",
        "token_json_dir": "codex_tokens",
    }

    config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                file_config = json.load(f)
                config.update(file_config)
        except Exception as e:
            print(f"⚠️ 加载 config.json 失败: {e}")

    # 环境变量优先级更高
    config["gptmail_api_base"] = os.environ.get("GPTMAIL_API_BASE", config["gptmail_api_base"])
    config["gptmail_api_key"] = os.environ.get("GPTMAIL_API_KEY", config["gptmail_api_key"])
    config["proxy"] = os.environ.get("PROXY", config["proxy"])
    config["total_accounts"] = int(os.environ.get("TOTAL_ACCOUNTS", config["total_accounts"]))
    config["enable_oauth"] = os.environ.get("ENABLE_OAUTH", config["enable_oauth"])
    config["oauth_required"] = os.environ.get("OAUTH_REQUIRED", config["oauth_required"])
    config["oauth_issuer"] = os.environ.get("OAUTH_ISSUER", config["oauth_issuer"])
    config["oauth_client_id"] = os.environ.get("OAUTH_CLIENT_ID", config["oauth_client_id"])
    config["oauth_redirect_uri"] = os.environ.get("OAUTH_REDIRECT_URI", config["oauth_redirect_uri"])
    config["ak_file"] = os.environ.get("AK_FILE", config["ak_file"])
    config["rk_file"] = os.environ.get("RK_FILE", config["rk_file"])
    config["token_json_dir"] = os.environ.get("TOKEN_JSON_DIR", config["token_json_dir"])

    return config


def _as_bool(value):
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


_CONFIG = _load_config()
GPTMAIL_API_BASE = _CONFIG["gptmail_api_base"]
GPTMAIL_API_KEY = _CONFIG["gptmail_api_key"]
DEFAULT_TOTAL_ACCOUNTS = _CONFIG["total_accounts"]
DEFAULT_PROXY = _CONFIG["proxy"]
DEFAULT_OUTPUT_FILE = _CONFIG["output_file"]
ENABLE_OAUTH = _as_bool(_CONFIG.get("enable_oauth", True))
OAUTH_REQUIRED = _as_bool(_CONFIG.get("oauth_required", True))
OAUTH_ISSUER = _CONFIG["oauth_issuer"].rstrip("/")
OAUTH_CLIENT_ID = _CONFIG["oauth_client_id"]
OAUTH_REDIRECT_URI = _CONFIG["oauth_redirect_uri"]
AK_FILE = _CONFIG["ak_file"]
RK_FILE = _CONFIG["rk_file"]
TOKEN_JSON_DIR = _CONFIG["token_json_dir"]

if not GPTMAIL_API_KEY:
    print("⚠️ 警告: 未设置 GPTMAIL_API_KEY，请在 config.json 中设置或设置环境变量")
    print("   文件: config.json -> gptmail_api_key")
    print("   环境变量: export GPTMAIL_API_KEY='your_api_key_here'")

# 全局线程锁
_print_lock = threading.Lock()
_file_lock = threading.Lock()

# OpenAI 拒绝的邮箱域名 TLD 黑名单 (unsupported_email)
# 通过真实测试发现：.shop / .top / .sbs / .my.id 等低信誉 TLD 会被拒绝
# .org / .foundation 等常规 TLD 可以通过
_BLOCKED_EMAIL_TLDS = {
    ".shop", ".top", ".sbs", ".xyz", ".click", ".link",
    ".online", ".site", ".fun", ".icu", ".buzz", ".rest",
    ".bid", ".loan", ".racing", ".win", ".stream", ".party",
    ".review", ".trade", ".date", ".faith", ".accountant",
    ".cricket", ".download", ".gdn", ".men", ".work",
    ".cf", ".ga", ".gq", ".ml", ".tk",  # 免费域名 TLD
    ".cn", ".cd",  # 国别 TLD，OpenAI 可能拒绝
    ".fitness", ".guru", ".ninja", ".rocks", ".agency",  # 新 gTLD 可能被拒
}

# 检测随机字符域名（如 rgxkl.cn, cthldws.shop）
_VOWELS = set("aeiou")


def _looks_like_random_domain(domain: str) -> bool:
    """检测域名是否像随机生成的字符串（辅音堆叠无意义域名）。

    例如: rgxkl.cn, cthldws.shop, nvztftb.shop → True
          endingimpunity.com, stepsofhope.co.uk → False
    """
    # 取第一段（去掉 TLD 及多级子域）
    parts = domain.split(".")
    name_part = parts[0]
    if len(name_part) <= 5:
        return False  # 短域名不好判断（可能是正常缩写如 wmct, sylu）

    # 统计元音占比：正常单词元音比约 30-50%，随机字符串通常 < 15%
    vowel_count = sum(1 for c in name_part.lower() if c in _VOWELS)
    vowel_ratio = vowel_count / len(name_part)
    if vowel_ratio < 0.12 and len(name_part) >= 6:
        return True

    # 连续辅音超过 4 个
    max_consonant_run = 0
    current_run = 0
    for c in name_part.lower():
        if c.isalpha() and c not in _VOWELS:
            current_run += 1
            max_consonant_run = max(max_consonant_run, current_run)
        else:
            current_run = 0
    if max_consonant_run >= 5:
        return True

    return False


def _is_email_domain_acceptable(email_or_domain: str) -> bool:
    """检查邮箱域名是否可能被 OpenAI 接受"""
    if "@" in email_or_domain:
        domain = email_or_domain.split("@")[1].lower()
    else:
        domain = email_or_domain.lower()

    # 检查 TLD 黑名单
    for tld in _BLOCKED_EMAIL_TLDS:
        if domain.endswith(tld):
            return False

    # 检查多级 TLD (如 .my.id, .co.id)
    if domain.endswith(".my.id") or domain.endswith(".co.id"):
        return False

    # 检测随机字符域名
    if _looks_like_random_domain(domain):
        return False

    return True


# ----- GPTMail 可用域名缓存 -----
# 首次获取邮箱时通过随机采样发现可用域名，之后所有请求复用
_good_domain_lock = threading.Lock()
_good_domains: list[str] = []       # 已验证可用的域名列表
_good_domains_ready = False          # 是否已完成域名发现


def _discover_good_domains(session, headers, api_base: str,
                           sample_count: int = 15) -> list[str]:
    """通过随机采样 GPTMail，发现可被 OpenAI 接受的域名。

    采样 sample_count 次 GET /generate-email，收集域名并过滤。
    对发现的域名额外做 POST 验证，确保 GPTMail 也支持该域名。
    返回可用域名列表（去重）。
    """
    found: dict[str, None] = {}  # 用 dict 保持发现顺序
    for _ in range(sample_count):
        try:
            r = session.get(
                f"{api_base}/generate-email",
                headers=headers,
                timeout=15,
            )
            if r.status_code != 200:
                continue
            data = r.json()
            email = data.get("data", {}).get("email", "")
            if "@" not in email:
                continue
            domain = email.split("@")[1]
            if _is_email_domain_acceptable(domain) and domain not in found:
                found[domain] = None
        except Exception:
            continue

    # 对发现的域名做 POST 验证，确保 GPTMail 自身也支持
    verified: list[str] = []
    for domain in found:
        try:
            r = session.post(
                f"{api_base}/generate-email",
                json={"domain": domain},
                headers={**headers, "Content-Type": "application/json"},
                timeout=10,
            )
            if r.status_code == 200:
                verified.append(domain)
            elif r.status_code == 400:
                # GPTMail 不支持该域名，跳过
                try:
                    err = r.json().get("error", "")
                except Exception:
                    err = r.text[:100]
                with _print_lock:
                    print(f"[GPTMail] 域名 {domain} 不受支持，已排除: {err}")
        except Exception:
            # 网络错误不排除该域名（可能是临时问题）
            verified.append(domain)

    return verified


def _ensure_good_domains(session, headers, api_base: str) -> list[str]:
    """确保已发现可用域名（线程安全、只执行一次）。"""
    global _good_domains, _good_domains_ready
    if _good_domains_ready and _good_domains:
        return _good_domains

    with _good_domain_lock:
        # Double-check
        if _good_domains_ready and _good_domains:
            return _good_domains

        with _print_lock:
            print("[GPTMail] 首次采样发现可用域名中...")
        domains = _discover_good_domains(session, headers, api_base, sample_count=15)
        if domains:
            _good_domains = domains
            with _print_lock:
                print(f"[GPTMail] 发现 {len(domains)} 个可用域名: {', '.join(domains[:5])}{'...' if len(domains) > 5 else ''}")
        else:
            with _print_lock:
                print("[GPTMail] 警告: 未发现可用域名，将使用随机模式")
        _good_domains_ready = True
        return _good_domains


# Chrome 指纹配置: impersonate 与 sec-ch-ua 必须匹配真实浏览器
# 优先使用新版本，旧版本作为后备（按版本号降序排列）
_ALL_CHROME_PROFILES = [
    {
        "major": 146, "impersonate": "chrome146",
        "build": 7876, "patch_range": (10, 100),
        "sec_ch_ua": '"Chromium";v="146", "Google Chrome";v="146", "Not/A)Brand";v="24"',
    },
    {
        "major": 145, "impersonate": "chrome145",
        "build": 7823, "patch_range": (10, 100),
        "sec_ch_ua": '"Chromium";v="145", "Google Chrome";v="145", "Not/A)Brand";v="24"',
    },
    {
        "major": 142, "impersonate": "chrome142",
        "build": 7600, "patch_range": (10, 100),
        "sec_ch_ua": '"Chromium";v="142", "Google Chrome";v="142", "Not:A-Brand";v="99"',
    },
    {
        "major": 136, "impersonate": "chrome136",
        "build": 7103, "patch_range": (48, 175),
        "sec_ch_ua": '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
    },
    {
        "major": 133, "impersonate": "chrome133a",
        "build": 6943, "patch_range": (33, 153),
        "sec_ch_ua": '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
    },
    {
        "major": 131, "impersonate": "chrome131",
        "build": 6778, "patch_range": (69, 205),
        "sec_ch_ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    },
    {
        "major": 124, "impersonate": "chrome124",
        "build": 6367, "patch_range": (60, 207),
        "sec_ch_ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    },
]

# 模块加载时自动检测 curl_cffi 支持的 impersonate 版本
def _detect_supported_profiles():
    supported = []
    for p in _ALL_CHROME_PROFILES:
        try:
            s = curl_requests.Session(impersonate=p["impersonate"])
            s.close()
            supported.append(p)
        except Exception:
            pass
    if not supported:
        # 全部不支持时回退到不指定 impersonate
        supported = [_ALL_CHROME_PROFILES[-1]]  # 用最旧的兜底
    return supported

_CHROME_PROFILES = _detect_supported_profiles()
with _print_lock:
    _names = [p["impersonate"] for p in _CHROME_PROFILES]
    print(f"[Init] 可用 Chrome 指纹: {_names}")


def _random_chrome_version():
    profile = random.choice(_CHROME_PROFILES)
    major = profile["major"]
    build = profile["build"]
    patch = random.randint(*profile["patch_range"])
    full_ver = f"{major}.0.{build}.{patch}"
    ua = f"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{full_ver} Safari/537.36"
    return profile["impersonate"], major, full_ver, ua, profile["sec_ch_ua"]


def _random_delay(low=0.1, high=0.3):
    time.sleep(random.uniform(low, high))


def _make_trace_headers():
    trace_id = random.randint(10**17, 10**18 - 1)
    parent_id = random.randint(10**17, 10**18 - 1)
    tp = f"00-{uuid.uuid4().hex}-{format(parent_id, '016x')}-01"
    return {
        "traceparent": tp, "tracestate": "dd=s:1;o:rum",
        "x-datadog-origin": "rum", "x-datadog-sampling-priority": "1",
        "x-datadog-trace-id": str(trace_id), "x-datadog-parent-id": str(parent_id),
    }


def _generate_pkce():
    code_verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).rstrip(b"=").decode("ascii")
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return code_verifier, code_challenge


class SentinelTokenGenerator:
    """纯 Python 版本 sentinel token 生成器（PoW）"""

    MAX_ATTEMPTS = 500000
    ERROR_PREFIX = "wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D"

    def __init__(self, device_id=None, user_agent=None):
        self.device_id = device_id or str(uuid.uuid4())
        self.user_agent = user_agent or (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/145.0.0.0 Safari/537.36"
        )
        self.requirements_seed = str(random.random())
        self.sid = str(uuid.uuid4())

    @staticmethod
    def _fnv1a_32(text: str):
        h = 2166136261
        for ch in text:
            h ^= ord(ch)
            h = (h * 16777619) & 0xFFFFFFFF
        h ^= (h >> 16)
        h = (h * 2246822507) & 0xFFFFFFFF
        h ^= (h >> 13)
        h = (h * 3266489909) & 0xFFFFFFFF
        h ^= (h >> 16)
        h &= 0xFFFFFFFF
        return format(h, "08x")

    def _get_config(self):
        # 模拟真实的浏览器环境数据（SDK 20260219f9f6，25 元素）
        screen_val = random.choice([2667, 2745, 2880, 3000, 2560, 2200, 2160])
        now = datetime.now()  # 本地时间
        # 时区信息
        utc_offset = now.astimezone().utcoffset()
        offset_hours = int(utc_offset.total_seconds() // 3600) if utc_offset else 0
        offset_minutes = int((abs(utc_offset.total_seconds()) % 3600) // 60) if utc_offset else 0
        tz_str = f"GMT{'+' if offset_hours >= 0 else '-'}{abs(offset_hours):02d}{offset_minutes:02d}"
        tz_names = {8: "中国标准时间", 0: "Coordinated Universal Time", -5: "Eastern Standard Time",
                    -8: "Pacific Standard Time", 9: "日本標準時", 1: "Central European Standard Time"}
        tz_name = tz_names.get(offset_hours, "Coordinated Universal Time")
        date_str = now.strftime(f"%a %b %d %Y %H:%M:%S {tz_str} ({tz_name})")
        js_heap_limit = 4294967296  # Chrome 最新值
        perf_now = random.uniform(1000, 50000)
        time_origin = time.time() * 1000 - perf_now
        # 更新 SDK 版本
        script_src = random.choice([
            "https://sentinel.openai.com/sentinel/20260219f9f6/sdk.js",
            "https://sentinel.openai.com/backend-api/sentinel/sdk.js",
        ])
        # 模拟 navigator 属性值（属性名+实际值，Unicode minus 分隔）
        nav_prop_values = [
            "windowControlsOverlay\u2212[object WindowControlsOverlay]",
            "scheduling\u2212[object Scheduling]",
            "pdfViewerEnabled\u2212true",
            "hardwareConcurrency\u221216",
            "deviceMemory\u22128",
            "maxTouchPoints\u22120",
            "cookieEnabled\u2212true",
            "vendor\u2212Google Inc.",
            "language\u2212en-US",
            "onLine\u2212true",
            "webdriver\u2212false",
        ]
        nav_val = random.choice(nav_prop_values)
        doc_key = random.choice(["location", "implementation", "URL", "documentURI", "compatMode"])
        win_key = random.choice(["__oai_so_bm", "__oai_logHTML", "__NEXT_DATA__",
                                  "__next_f", "__oai_SSR_TTI", "__oai_SSR_HTML",
                                  "__reactEvents", "__RUNTIME_CONFIG__"])
        hardware_concurrency = random.choice([4, 8, 12, 16])

        return [
            screen_val,            # [0] screen.width + screen.height (int)
            date_str,              # [1] 本地时间（含时区）
            js_heap_limit,         # [2] 内存限制
            random.random(),       # [3] 占位，后被 nonce 替换
            self.user_agent,       # [4] UserAgent
            script_src,            # [5] script src
            None,                  # [6] 脚本版本
            random.choice(["en-US", "zh-CN", "en"]),  # [7] 构建版本
            "en-US",               # [8] 语言
            "en-US,en",            # [9] 占位，后被耗时替换
            random.random(),       # [10] 随机数
            nav_val,               # [11] navigator 属性（属性名∸值）
            doc_key,               # [12] document key
            win_key,               # [13] window key
            perf_now,              # [14] performance.now
            self.sid,              # [15] 会话 UUID
            "",                    # [16] URL 参数
            hardware_concurrency,  # [17] CPU 核心数
            time_origin,           # [18] timeOrigin
            0,                     # [19] Number("ai" in window)
            0,                     # [20] Number("InstallTrigger" in window)
            0,                     # [21] Number("cache" in window)
            0,                     # [22] Number("data" in window)
            0,                     # [23] Number("solana" in window)
            0,                     # [24] Number("dump" in window)
        ]

    @staticmethod
    def _base64_encode(data):
        raw = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        return base64.b64encode(raw).decode("ascii")

    def _run_check(self, start_time, seed, difficulty, config, nonce):
        config[3] = nonce
        config[9] = round((time.time() - start_time) * 1000)
        data = self._base64_encode(config)
        hash_hex = self._fnv1a_32(seed + data)
        diff_len = len(difficulty)
        if hash_hex[:diff_len] <= difficulty:
            return data + "~S"
        return None

    def generate_token(self, seed=None, difficulty=None):
        seed = seed if seed is not None else self.requirements_seed
        difficulty = str(difficulty or "0")
        start_time = time.time()
        config = self._get_config()

        for i in range(self.MAX_ATTEMPTS):
            result = self._run_check(start_time, seed, difficulty, config, i)
            if result:
                return "gAAAAAB" + result
        return "gAAAAAB" + self.ERROR_PREFIX + self._base64_encode(str(None))

    def generate_requirements_token(self):
        config = self._get_config()
        config[3] = 1
        config[9] = round(random.uniform(5, 50))
        data = self._base64_encode(config)
        return "gAAAAAC" + data


def fetch_sentinel_challenge(session, device_id, flow="authorize_continue", user_agent=None,
                             sec_ch_ua=None, impersonate=None):
    generator = SentinelTokenGenerator(device_id=device_id, user_agent=user_agent)
    req_body = {
        "p": generator.generate_requirements_token(),
        "id": device_id,
        "flow": flow,
    }
    headers = {
        "Content-Type": "text/plain;charset=UTF-8",
        "Referer": "https://sentinel.openai.com/backend-api/sentinel/frame.html",
        "Origin": "https://sentinel.openai.com",
        "User-Agent": user_agent or "Mozilla/5.0",
        "sec-ch-ua": sec_ch_ua or '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
    }

    kwargs = {
        "data": json.dumps(req_body),
        "headers": headers,
        "timeout": 20,
    }


    try:
        resp = session.post("https://sentinel.openai.com/backend-api/sentinel/req", **kwargs)
    except Exception:
        return None

    if resp.status_code != 200:
        return None

    try:
        return resp.json()
    except Exception:
        return None


def build_sentinel_token(session, device_id, flow="authorize_continue", user_agent=None,
                         sec_ch_ua=None, impersonate=None):
    challenge = fetch_sentinel_challenge(
        session,
        device_id,
        flow=flow,
        user_agent=user_agent,
        sec_ch_ua=sec_ch_ua,
        impersonate=impersonate,
    )
    if not challenge:
        return None

    c_value = challenge.get("token", "")
    # 参照 codex_oauth_loop：不检查 c_value 是否为空，服务端可能返回空 token

    pow_data = challenge.get("proofofwork") or {}
    generator = SentinelTokenGenerator(device_id=device_id, user_agent=user_agent)

    if pow_data.get("required") and pow_data.get("seed"):
        p_value = generator.generate_token(
            seed=pow_data.get("seed"),
            difficulty=pow_data.get("difficulty", "0"),
        )
    else:
        p_value = generator.generate_requirements_token()

    return json.dumps({
        "p": p_value,
        "t": "",
        "c": c_value,
        "id": device_id,
        "flow": flow,
    }, separators=(",", ":"))


def _extract_code_from_url(url: str):
    if not url or "code=" not in url:
        return None
    try:
        return parse_qs(urlparse(url).query).get("code", [None])[0]
    except Exception:
        return None


def _decode_jwt_payload(token: str):
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return {}
        payload = parts[1]
        padding = 4 - len(payload) % 4
        if padding != 4:
            payload += "=" * padding
        decoded = base64.urlsafe_b64decode(payload)
        return json.loads(decoded)
    except Exception:
        return {}


def _save_codex_tokens(email: str, tokens: dict):
    access_token = tokens.get("access_token", "")
    refresh_token = tokens.get("refresh_token", "")
    id_token = tokens.get("id_token", "")

    if access_token:
        with _file_lock:
            with open(AK_FILE, "a", encoding="utf-8") as f:
                f.write(f"{access_token}\n")

    if refresh_token:
        with _file_lock:
            with open(RK_FILE, "a", encoding="utf-8") as f:
                f.write(f"{refresh_token}\n")

    if not access_token:
        return

    payload = _decode_jwt_payload(access_token)
    auth_info = payload.get("https://api.openai.com/auth", {})
    account_id = auth_info.get("chatgpt_account_id", "")

    exp_timestamp = payload.get("exp")
    expired_str = ""
    if isinstance(exp_timestamp, int) and exp_timestamp > 0:
        from datetime import datetime, timezone, timedelta

        exp_dt = datetime.fromtimestamp(exp_timestamp, tz=timezone(timedelta(hours=8)))
        expired_str = exp_dt.strftime("%Y-%m-%dT%H:%M:%S+08:00")

    from datetime import datetime, timezone, timedelta

    now = datetime.now(tz=timezone(timedelta(hours=8)))
    token_data = {
        "type": "codex",
        "email": email,
        "expired": expired_str,
        "id_token": id_token,
        "account_id": account_id,
        "access_token": access_token,
        "last_refresh": now.strftime("%Y-%m-%dT%H:%M:%S+08:00"),
        "refresh_token": refresh_token,
    }

    base_dir = os.path.dirname(os.path.abspath(__file__))
    token_dir = TOKEN_JSON_DIR if os.path.isabs(TOKEN_JSON_DIR) else os.path.join(base_dir, TOKEN_JSON_DIR)
    os.makedirs(token_dir, exist_ok=True)

    token_path = os.path.join(token_dir, f"{email}.json")
    with _file_lock:
        with open(token_path, "w", encoding="utf-8") as f:
            json.dump(token_data, f, ensure_ascii=False)


def _generate_password(length=14):
    lower = string.ascii_lowercase
    upper = string.ascii_uppercase
    digits = string.digits
    special = "!@#$%&*"
    pwd = [random.choice(lower), random.choice(upper),
           random.choice(digits), random.choice(special)]
    all_chars = lower + upper + digits + special
    pwd += [random.choice(all_chars) for _ in range(length - 4)]
    random.shuffle(pwd)
    return "".join(pwd)


# ================= GPTMail 邮箱函数 =================

def _create_gptmail_session(proxy=None, impersonate=None):
    """创建 GPTMail 请求会话（带 TLS 指纹模拟，避免 curl (35) TLS 错误）"""
    if impersonate is None:
        impersonate = _CHROME_PROFILES[0]["impersonate"] if _CHROME_PROFILES else "chrome120"
    kwargs = {"impersonate": impersonate}
    if _HTTP_VERSION_1_1 is not None:
        kwargs["http_version"] = _HTTP_VERSION_1_1
    session = curl_requests.Session(**kwargs)
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
    })
    if proxy:
        session.proxies = {"http": proxy, "https": proxy}
    return session


def create_temp_email(proxy=None):
    """通过 GPTMail API 创建临时邮箱，返回 email 地址。

    优先使用 POST 指定可用域名方式生成，避免获取到被 OpenAI 拒绝的域名。
    首次调用时自动采样发现可用域名并全局缓存。
    """
    if not GPTMAIL_API_KEY:
        raise Exception("GPTMAIL_API_KEY 未设置，无法创建临时邮箱")

    api_base = GPTMAIL_API_BASE.rstrip("/")
    url = f"{api_base}/generate-email"
    headers = {"X-API-Key": GPTMAIL_API_KEY}
    session = _create_gptmail_session(proxy)
    impersonate = "chrome131"

    # 确保已发现可用域名
    good = _ensure_good_domains(session, headers, api_base, impersonate)

    max_retries = 3
    for attempt in range(max_retries):
        try:
            # 优先 POST 指定可用域名
            if good:
                chosen = random.choice(good)
                res = session.post(
                    url,
                    json={"domain": chosen},
                    headers={**headers, "Content-Type": "application/json"},
                    timeout=15,
                )
            else:
                res = session.get(url, headers=headers, timeout=15)

            if res.status_code == 429:
                try:
                    err_data = res.json()
                    err_msg = err_data.get("error", "")
                except Exception:
                    err_msg = res.text[:200]
                if "quota" in str(err_msg).lower() or "exceeded" in str(err_msg).lower():
                    raise Exception(f"GPTMail API 配额耗尽: {err_msg}")
                raise Exception(f"GPTMail API 限流 (429): {err_msg}")

            if res.status_code == 401 or res.status_code == 403:
                raise Exception(f"GPTMail API Key 无效 ({res.status_code}): {res.text[:200]}")

            if res.status_code != 200:
                # 如果是 400 "Unsupported domain"，从全局缓存移除该域名
                if res.status_code == 400 and good:
                    try:
                        err_text = res.text[:300]
                        if "Unsupported domain" in err_text or "unsupported" in err_text.lower():
                            with _good_domain_lock:
                                if chosen in _good_domains:
                                    _good_domains.remove(chosen)
                                    with _print_lock:
                                        print(f"[GPTMail] 域名 {chosen} 已从缓存移除 (Unsupported)")
                    except Exception:
                        pass
                raise Exception(f"创建邮箱失败: {res.status_code} - {res.text[:200]}")

            data = res.json()
            email_addr = data.get("data", {}).get("email", "")
            if not email_addr:
                raise Exception(f"GPTMail 返回无效响应: {data}")

            return email_addr

        except Exception as e:
            err_str = str(e)
            if any(kw in err_str for kw in ("配额耗尽", "Key 无效", "quota", "exceeded", "401", "403")):
                raise
            if attempt < max_retries - 1:
                # TLS/curl 错误时重建 session
                if "curl" in err_str.lower() or "tls" in err_str.lower() or "ssl" in err_str.lower():
                    session = _create_gptmail_session(proxy, impersonate)
                    good = _ensure_good_domains(session, headers, api_base, impersonate)
                wait = 3 + attempt * 2 + random.uniform(0, 2)
                time.sleep(wait)
                continue
            raise Exception(f"GPTMail 创建邮箱失败: {e}")


def _extract_verification_code(email_content: str):
    """从邮件内容提取 6 位验证码"""
    if not email_content:
        return None

    patterns = [
        r"Verification code:?\s*(\d{6})",
        r"code is\s*(\d{6})",
        r"代码为[:：]?\s*(\d{6})",
        r"验证码[:：]?\s*(\d{6})",
        r">\s*(\d{6})\s*<",
        r"(?<![#&])\b(\d{6})\b",
    ]

    for pattern in patterns:
        matches = re.findall(pattern, email_content, re.IGNORECASE)
        for code in matches:
            if code == "177010":  # 已知误判
                continue
            return code
    return None


def wait_for_verification_email(email_addr: str, timeout: int = 120, proxy=None):
    """通过 GPTMail API 等待并提取 OpenAI 验证码"""
    if not GPTMAIL_API_KEY:
        return None

    api_base = GPTMAIL_API_BASE.rstrip("/")
    url = f"{api_base}/emails?email={quote(email_addr)}"
    headers = {"X-API-Key": GPTMAIL_API_KEY}
    session = _create_gptmail_session(proxy)
    code_re = re.compile(r"(?<!\d)(\d{6})(?!\d)")

    start_time = time.time()
    poll_count = 0

    while time.time() - start_time < timeout:
        try:
            res = session.get(
                url,
                headers=headers,
                timeout=15,
            )

            if res.status_code == 200:
                data = res.json()
                emails_list = data.get("data", {}).get("emails", [])

                for mail_item in emails_list:
                    from_addr = (mail_item.get("from_address") or "").lower()
                    if "openai" not in from_addr:
                        continue
                    # 从 subject 和 html_content 中提取验证码
                    for field in ("subject", "html_content"):
                        content = mail_item.get(field, "")
                        if content:
                            code = _extract_verification_code(content)
                            if code:
                                return code
        except Exception:
            pass

        poll_count += 1
        interval = 2 if poll_count <= 5 else 3
        time.sleep(interval)

    return None


def _random_name():
    first = random.choice([
        "James", "Emma", "Liam", "Olivia", "Noah", "Ava", "Ethan", "Sophia",
        "Lucas", "Mia", "Mason", "Isabella", "Logan", "Charlotte", "Alexander",
        "Amelia", "Benjamin", "Harper", "William", "Evelyn", "Henry", "Abigail",
        "Sebastian", "Emily", "Jack", "Elizabeth",
    ])
    last = random.choice([
        "Smith", "Johnson", "Brown", "Davis", "Wilson", "Moore", "Taylor",
        "Clark", "Hall", "Young", "Anderson", "Thomas", "Jackson", "White",
        "Harris", "Martin", "Thompson", "Garcia", "Robinson", "Lewis",
        "Walker", "Allen", "King", "Wright", "Scott", "Green",
    ])
    return f"{first} {last}"


def _random_birthdate():
    y = random.randint(1985, 2002)
    m = random.randint(1, 12)
    d = random.randint(1, 28)
    return f"{y}-{m:02d}-{d:02d}"


class ChatGPTRegister:
    BASE = "https://chatgpt.com"
    AUTH = "https://auth.openai.com"

    def __init__(self, proxy: str = None, tag: str = "", request_timeout: int = 15):
        self.tag = tag  # 线程标识，用于日志
        self.request_timeout = request_timeout  # HTTP 请求超时(秒)
        self.device_id = str(uuid.uuid4())
        self.auth_session_logging_id = str(uuid.uuid4())
        self.impersonate, self.chrome_major, self.chrome_full, self.ua, self.sec_ch_ua = _random_chrome_version()

        _sess_kwargs = {"impersonate": self.impersonate}
        if _HTTP_VERSION_1_1 is not None:
            _sess_kwargs["http_version"] = _HTTP_VERSION_1_1
        self.session = curl_requests.Session(**_sess_kwargs)

        self.proxy = proxy
        if self.proxy:
            self.session.proxies = {"http": self.proxy, "https": self.proxy}

        self.session.headers.update({
            "User-Agent": self.ua,
            "Accept-Language": random.choice([
                "en-US,en;q=0.9", "en-US,en;q=0.9,zh-CN;q=0.8",
                "en,en-US;q=0.9", "en-US,en;q=0.8",
            ]),
            "sec-ch-ua": self.sec_ch_ua, "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"', "sec-ch-ua-arch": '"x86"',
            "sec-ch-ua-bitness": '"64"',
            "sec-ch-ua-full-version": f'"{self.chrome_full}"',
            "sec-ch-ua-platform-version": f'"{random.randint(10, 15)}.0.0"',
        })

        self.session.cookies.set("oai-did", self.device_id, domain="chatgpt.com")
        # auth.openai.com 也需要 oai-did，否则 register/create_account 等接口
        # 无法关联 device 上下文，导致 400 "Failed to create account"
        self.session.cookies.set("oai-did", self.device_id, domain="auth.openai.com")
        self.session.cookies.set("oai-did", self.device_id, domain=".auth.openai.com")
        self._callback_url = None

    def _request(self, method: str, url: str, max_retries: int = 3, **kwargs):
        """带超时和自动重试的 HTTP 请求封装。

        超时后自动重试，避免因代理/网络波动导致整个注册失败。
        """
        kwargs.setdefault("timeout", self.request_timeout)
        last_exc = None
        for attempt in range(max_retries):
            try:
                if method.upper() == "GET":
                    return self.session.get(url, **kwargs)
                else:
                    return self.session.post(url, **kwargs)
            except Exception as e:
                last_exc = e
                err_str = str(e)
                is_timeout = "timed out" in err_str.lower() or "timeout" in err_str.lower()
                if is_timeout and attempt < max_retries - 1:
                    wait = 2 * (attempt + 1)
                    self._print(f"[Retry] {method} {url[:60]}... 超时, 重试 {attempt+2}/{max_retries} (等{wait}s)")
                    time.sleep(wait)
                    continue
                raise last_exc

    def _log(self, step, method, url, status, body=None):
        prefix = f"[{self.tag}] " if self.tag else ""
        lines = [
            f"\n{'='*60}",
            f"{prefix}[Step] {step}",
            f"{prefix}[{method}] {url}",
            f"{prefix}[Status] {status}",
        ]
        if body:
            try:
                lines.append(f"{prefix}[Response] {json.dumps(body, indent=2, ensure_ascii=False)[:1000]}")
            except Exception:
                lines.append(f"{prefix}[Response] {str(body)[:1000]}")
        lines.append(f"{'='*60}")
        with _print_lock:
            print("\n".join(lines))

    def _print(self, msg):
        prefix = f"[{self.tag}] " if self.tag else ""
        with _print_lock:
            print(f"{prefix}{msg}")

    # ==================== GPTMail 临时邮箱 ====================

    def _create_gptmail_session(self):
        """创建或复用 GPTMail 请求会话（带 TLS 指纹模拟，避免 curl (35) TLS 错误）"""
        if hasattr(self, '_gptmail_session') and self._gptmail_session is not None:
            return self._gptmail_session
        _gpt_kwargs = {"impersonate": self.impersonate}
        if _HTTP_VERSION_1_1 is not None:
            _gpt_kwargs["http_version"] = _HTTP_VERSION_1_1
        session = curl_requests.Session(**_gpt_kwargs)
        session.headers.update({
            "User-Agent": self.ua,
            "Accept": "application/json",
        })
        if self.proxy:
            session.proxies = {"http": self.proxy, "https": self.proxy}
        self._gptmail_session = session
        return session

    def create_temp_email(self):
        """通过 GPTMail API 创建临时邮箱，返回 email 地址。

        使用 POST 指定可用域名方式生成，避免获取到被 OpenAI 拒绝的域名。
        首次调用时自动采样发现可用域名并全局缓存。
        """
        if not GPTMAIL_API_KEY:
            raise Exception("GPTMAIL_API_KEY 未设置，无法创建临时邮箱")

        api_base = GPTMAIL_API_BASE.rstrip("/")
        url = f"{api_base}/generate-email"
        headers = {"X-API-Key": GPTMAIL_API_KEY}
        session = self._create_gptmail_session()

        # 确保已发现可用域名
        good = _ensure_good_domains(session, headers, api_base)

        max_retries = 3
        for attempt in range(max_retries):
            try:
                if good:
                    chosen = random.choice(good)
                    res = session.post(
                        url,
                        json={"domain": chosen},
                        headers={**headers, "Content-Type": "application/json"},
                        timeout=15,
                    )
                else:
                    res = session.get(url, headers=headers, timeout=15)

                if res.status_code == 429:
                    try:
                        err_data = res.json()
                        err_msg = err_data.get("error", "")
                    except Exception:
                        err_msg = res.text[:200]
                    if "quota" in str(err_msg).lower() or "exceeded" in str(err_msg).lower():
                        raise Exception(f"GPTMail API 配额耗尽: {err_msg}")
                    raise Exception(f"GPTMail API 限流 (429): {err_msg}")

                if res.status_code == 401 or res.status_code == 403:
                    raise Exception(f"GPTMail API Key 无效 ({res.status_code}): {res.text[:200]}")

                if res.status_code != 200:
                    # 如果是 400 "Unsupported domain"，从全局缓存移除该域名
                    if res.status_code == 400 and good:
                        try:
                            err_text = res.text[:300]
                            if "Unsupported domain" in err_text or "unsupported" in err_text.lower():
                                with _good_domain_lock:
                                    if chosen in _good_domains:
                                        _good_domains.remove(chosen)
                                        self._print(f"[GPTMail] 域名 {chosen} 已从缓存移除 (Unsupported)")
                        except Exception:
                            pass
                    raise Exception(f"创建邮箱失败: {res.status_code} - {res.text[:200]}")

                data = res.json()
                email_addr = data.get("data", {}).get("email", "")
                if not email_addr:
                    raise Exception(f"GPTMail 返回无效响应: {data}")

                return email_addr

            except Exception as e:
                err_str = str(e)
                if any(kw in err_str for kw in ("配额耗尽", "Key 无效", "quota", "exceeded", "401", "403")):
                    raise
                if attempt < max_retries - 1:
                    self._print(f"[GPTMail] 创建邮箱失败 (尝试 {attempt + 1}/{max_retries}): {e}")
                    # TLS/curl 错误时销毁缓存的 session，下次重试创建新 session
                    if "curl" in err_str.lower() or "tls" in err_str.lower() or "ssl" in err_str.lower():
                        self._gptmail_session = None
                        session = self._create_gptmail_session()
                        good = _ensure_good_domains(session, headers, api_base)
                    wait = 3 + attempt * 2 + random.uniform(0, 2)
                    time.sleep(wait)
                    continue
                raise Exception(f"GPTMail 创建邮箱失败: {e}")

    def _extract_verification_code(self, email_content: str):
        """从邮件内容提取 6 位验证码"""
        if not email_content:
            return None

        patterns = [
            r"Verification code:?\s*(\d{6})",
            r"code is\s*(\d{6})",
            r"代码为[:：]?\s*(\d{6})",
            r"验证码[:：]?\s*(\d{6})",
            r">\s*(\d{6})\s*<",
            r"(?<![#&])\b(\d{6})\b",
        ]

        for pattern in patterns:
            matches = re.findall(pattern, email_content, re.IGNORECASE)
            for code in matches:
                if code == "177010":  # 已知误判
                    continue
                return code
        return None

    def wait_for_verification_email(self, email_addr: str, timeout: int = 120):
        """通过 GPTMail API 等待并提取 OpenAI 验证码"""
        self._print(f"[OTP] 等待验证码邮件 (最多 {timeout}s)...")

        if not GPTMAIL_API_KEY:
            self._print("[OTP] GPTMAIL_API_KEY 未设置")
            return None

        api_base = GPTMAIL_API_BASE.rstrip("/")
        url = f"{api_base}/emails?email={quote(email_addr)}"
        headers = {"X-API-Key": GPTMAIL_API_KEY}
        session = self._create_gptmail_session()

        start_time = time.time()
        poll_count = 0

        while time.time() - start_time < timeout:
            try:
                res = session.get(
                    url,
                    headers=headers,
                    timeout=15,
                )

                if res.status_code == 200:
                    data = res.json()
                    emails_list = data.get("data", {}).get("emails", [])

                    for mail_item in emails_list:
                        from_addr = (mail_item.get("from_address") or "").lower()
                        if "openai" not in from_addr:
                            continue
                        # 从 subject 和 html_content 中提取验证码
                        for field in ("subject", "html_content"):
                            content = mail_item.get(field, "")
                            if content:
                                code = self._extract_verification_code(content)
                                if code:
                                    self._print(f"[OTP] 验证码: {code}")
                                    if not hasattr(self, '_used_otp_codes'):
                                        self._used_otp_codes = set()
                                    self._used_otp_codes.add(code)
                                    return code
            except Exception:
                pass

            poll_count += 1
            elapsed = int(time.time() - start_time)
            # 前5次每2秒轮询，之后每3秒
            interval = 2 if poll_count <= 5 else 3
            if poll_count % 3 == 0:
                self._print(f"[OTP] 等待中... ({elapsed}s/{timeout}s)")
            time.sleep(interval)

        self._print(f"[OTP] 超时 ({timeout}s)")
        return None

    # ==================== 注册流程 ====================

    def _rebuild_session(self):
        """用新的 Chrome 指纹重建 session（应对 Cloudflare 403）"""
        old_imp = self.impersonate
        self.impersonate, self.chrome_major, self.chrome_full, self.ua, self.sec_ch_ua = _random_chrome_version()
        # 避免选到同一个指纹
        attempts = 0
        while self.impersonate == old_imp and attempts < 5:
            self.impersonate, self.chrome_major, self.chrome_full, self.ua, self.sec_ch_ua = _random_chrome_version()
            attempts += 1

        self.device_id = str(uuid.uuid4())
        self.auth_session_logging_id = str(uuid.uuid4())
        _rb_kwargs = {"impersonate": self.impersonate}
        if _HTTP_VERSION_1_1 is not None:
            _rb_kwargs["http_version"] = _HTTP_VERSION_1_1
        self.session = curl_requests.Session(**_rb_kwargs)
        if self.proxy:
            self.session.proxies = {"http": self.proxy, "https": self.proxy}
        self.session.headers.update({
            "User-Agent": self.ua,
            "Accept-Language": random.choice([
                "en-US,en;q=0.9", "en-US,en;q=0.9,zh-CN;q=0.8",
                "en,en-US;q=0.9", "en-US,en;q=0.8",
            ]),
            "sec-ch-ua": self.sec_ch_ua, "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"', "sec-ch-ua-arch": '"x86"',
            "sec-ch-ua-bitness": '"64"',
            "sec-ch-ua-full-version": f'"{self.chrome_full}"',
            "sec-ch-ua-platform-version": f'"{random.randint(10, 15)}.0.0"',
        })
        self.session.cookies.set("oai-did", self.device_id, domain="chatgpt.com")
        self.session.cookies.set("oai-did", self.device_id, domain="auth.openai.com")
        self.session.cookies.set("oai-did", self.device_id, domain=".auth.openai.com")
        self._print(f"[Rebuild] 切换指纹: {old_imp} -> {self.impersonate}")

    def visit_homepage(self):
        url = f"{self.BASE}/"
        max_homepage_retries = 5
        for attempt in range(max_homepage_retries):
            r = self._request("GET", url, headers={
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                "Upgrade-Insecure-Requests": "1",
            }, allow_redirects=True)
            self._log("0. Visit homepage", "GET", url, r.status_code,
                       {"cookies_count": len(self.session.cookies)})
            if r.status_code == 200:
                return  # 成功
            if r.status_code == 403 and attempt < max_homepage_retries - 1:
                wait = min(2 * (attempt + 1), 10) + random.uniform(0.5, 2.0)
                self._print(f"[Homepage] 403 被拦截, 切换指纹重试 {attempt+2}/{max_homepage_retries} (等{wait:.0f}s)...")
                time.sleep(wait)
                self._rebuild_session()
                continue
            # 非 403 或已耗尽重试
            if r.status_code != 200:
                raise Exception(f"访问首页失败 (HTTP {r.status_code}), 可能被 Cloudflare 拦截")

    def get_csrf(self) -> str:
        url = f"{self.BASE}/api/auth/csrf"
        r = self._request("GET", url, headers={"Accept": "application/json", "Referer": f"{self.BASE}/"})
        if r.status_code != 200:
            raise Exception(f"获取 CSRF 失败 (HTTP {r.status_code}), 首页 session 可能无效")
        try:
            data = r.json()
        except Exception:
            raise Exception(f"CSRF 响应非 JSON (HTTP {r.status_code}): {r.text[:200]}")
        token = data.get("csrfToken", "")
        self._log("1. Get CSRF", "GET", url, r.status_code, data)
        if not token:
            raise Exception("Failed to get CSRF token")
        return token

    def signin(self, email: str, csrf: str) -> str:
        url = f"{self.BASE}/api/auth/signin/openai"
        params = {
            "prompt": "login", "ext-oai-did": self.device_id,
            "auth_session_logging_id": self.auth_session_logging_id,
            "screen_hint": "login_or_signup", "login_hint": email,
        }
        form_data = {"callbackUrl": f"{self.BASE}/", "csrfToken": csrf, "json": "true"}
        r = self._request("POST", url, params=params, data=form_data, headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json", "Referer": f"{self.BASE}/", "Origin": self.BASE,
        })
        try:
            data = r.json()
        except Exception:
            raise Exception(f"Signin 响应非 JSON (HTTP {r.status_code}): {r.text[:200]}")
        authorize_url = data.get("url", "")
        self._log("2. Signin", "POST", url, r.status_code, data)
        if not authorize_url:
            raise Exception("Failed to get authorize URL")
        return authorize_url

    def authorize(self, url: str) -> str:
        r = self._request("GET", url, headers={
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Referer": f"{self.BASE}/", "Upgrade-Insecure-Requests": "1",
        }, allow_redirects=True)
        final_url = str(r.url)
        self._log("3. Authorize", "GET", url, r.status_code, {"final_url": final_url})
        return final_url

    def register(self, email: str, password: str):
        url = f"{self.AUTH}/api/accounts/user/register"

        max_register_retries = 3
        last_status, last_data = 0, {}

        for reg_attempt in range(max_register_retries):
            headers = {"Content-Type": "application/json", "Accept": "application/json",
                        "Referer": f"{self.AUTH}/create-account/password", "Origin": self.AUTH,
                        "User-Agent": self.ua, "oai-device-id": self.device_id,
                        "sec-ch-ua": self.sec_ch_ua, "sec-ch-ua-mobile": "?0",
                        "sec-ch-ua-platform": '"Windows"'}
            headers.update(_make_trace_headers())

            # 生成 sentinel PoW token
            try:
                # 首先尝试借用 Playwright 获取带 Turnstile 的完整 Token
                sentinel_token = get_sentinel_token_browser(self.device_id, self.proxy)
                if sentinel_token:
                    self._print("[Sentinel] register PoW token (Browser/Turnstile) 已生成")
                else:
                    self._print("[Sentinel] 回退到纯协议生成 register PoW token...")
                    sentinel_token = build_sentinel_token(
                        self.session, self.device_id,
                        flow="username_password_create",
                        user_agent=self.ua,
                        sec_ch_ua=self.sec_ch_ua,
                    )
                    if sentinel_token and reg_attempt == 0:
                        self._print("[Sentinel] register PoW token (纯协议) 已生成")

                if sentinel_token:
                    headers["openai-sentinel-token"] = sentinel_token
                else:
                    self._print("[Sentinel] register PoW token 获取失败，继续尝试")
            except Exception as e:
                self._print(f"[Sentinel] register PoW 异常: {e}")

            # 补充新版 SDK 要求的能力头
            headers["ext-passkey-client-capabilities"] = "conditional-create,conditional-get"

            r = self._request("POST", url, json={"username": email, "password": password}, headers=headers)
            try: data = r.json()
            except Exception: data = {"text": r.text[:500]}
            last_status, last_data = r.status_code, data

            if r.status_code == 200:
                self._log("4. Register", "POST", url, r.status_code, data)
                return r.status_code, data

            # 400 "Failed to create account" 可能是暂时性的，延迟重试
            if r.status_code == 400 and reg_attempt < max_register_retries - 1:
                wait = (reg_attempt + 1) * 3 + random.uniform(1, 3)
                self._print(
                    f"[Register] 400 错误, 延迟重试 {reg_attempt + 2}/{max_register_retries} "
                    f"(等 {wait:.1f}s)..."
                )
                time.sleep(wait)
                continue

            # 非 400 或已耗尽重试
            self._log("4. Register", "POST", url, r.status_code, data)
            return r.status_code, data

        self._log("4. Register", "POST", url, last_status, last_data)
        return last_status, last_data

    def send_otp(self):
        url = f"{self.AUTH}/api/accounts/email-otp/send"
        r = self._request("GET", url, headers={
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Referer": f"{self.AUTH}/create-account/password", "Upgrade-Insecure-Requests": "1",
            "oai-device-id": self.device_id,
        }, allow_redirects=True)
        try: data = r.json()
        except Exception: data = {"final_url": str(r.url), "status": r.status_code}
        self._log("5. Send OTP", "GET", url, r.status_code, data)

        # 请求 email-verification 页面（获取后续 cookie，参照 codex_oauth_loop）
        try:
            url_verify = f"{self.AUTH}/email-verification"
            r2 = self._request("GET", url_verify, headers={
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Referer": f"{self.AUTH}/create-account/password", "Upgrade-Insecure-Requests": "1",
                "oai-device-id": self.device_id,
            }, allow_redirects=True)
            self._print(f"[send_otp] email-verification 状态码: {r2.status_code}")
        except Exception as e:
            self._print(f"[send_otp] email-verification 请求异常（非致命）: {e}")

        return r.status_code, data

    def validate_otp(self, code: str):
        url = f"{self.AUTH}/api/accounts/email-otp/validate"
        headers = {"Content-Type": "application/json", "Accept": "application/json",
                    "Referer": f"{self.AUTH}/email-verification", "Origin": self.AUTH,
                    "ext-passkey-client-capabilities": "conditional-create,conditional-get",
                    "oai-device-id": self.device_id,
                    "sec-ch-ua": self.sec_ch_ua, "sec-ch-ua-mobile": "?0",
                    "sec-ch-ua-platform": '"Windows"'}
        headers.update(_make_trace_headers())
        # 获取 sentinel PoW token（validate OTP 也需要）
        try:
            sentinel_token = build_sentinel_token(
                self.session, self.device_id,
                flow="email_otp_validate",
                user_agent=self.ua,
                sec_ch_ua=self.sec_ch_ua,
            )
            if sentinel_token:
                headers["openai-sentinel-token"] = sentinel_token
                self._print("[Sentinel] validate_otp PoW token 已生成")
            else:
                # 退化为本地生成的 token
                headers["openai-sentinel-token"] = self.sentinel_gen.generate_token()
                self._print("[Sentinel] validate_otp 退化为本地 token")
        except Exception as e:
            self._print(f"[Sentinel] validate_otp token 生成异常: {e}")
            headers["openai-sentinel-token"] = self.sentinel_gen.generate_token()
        r = self._request("POST", url, json={"code": code}, headers=headers)
        try: data = r.json()
        except Exception: data = {"text": r.text[:500]}
        self._log("6. Validate OTP", "POST", url, r.status_code, data)
        return r.status_code, data

    def create_account(self, name: str, birthdate: str):
        url = f"{self.AUTH}/api/accounts/create_account"
        headers = {"Content-Type": "application/json", "Accept": "application/json",
                    "Referer": f"{self.AUTH}/about-you", "Origin": self.AUTH,
                    "User-Agent": self.ua, "oai-device-id": self.device_id,
                    "sec-ch-ua": self.sec_ch_ua, "sec-ch-ua-mobile": "?0",
                    "sec-ch-ua-platform": '"Windows"'}
        headers.update(_make_trace_headers())

        # 生成 sentinel PoW token —— OpenAI 可能要求 create_account 也携带
        try:
            # 优先调用浏览器获取带 Turnstile 的完整 token
            sentinel_token = get_sentinel_token_browser(self.device_id, self.proxy)
            if sentinel_token:
                self._print("[Sentinel] create_account PoW token (Browser/Turnstile) 已生成")
            else:
                self._print("[Sentinel] 回退到纯协议生成 create_account PoW token...")
                sentinel_token = build_sentinel_token(
                    self.session, self.device_id,
                    flow="create_account",
                    user_agent=self.ua,
                    sec_ch_ua=self.sec_ch_ua,
                )
                if sentinel_token:
                    self._print("[Sentinel] create_account PoW token (纯协议) 已生成")

            if sentinel_token:
                headers["openai-sentinel-token"] = sentinel_token
            else:
                self._print("[Sentinel] create_account PoW token 获取失败，继续尝试")
        except Exception as e:
            self._print(f"[Sentinel] create_account PoW 异常: {e}")

        headers["ext-passkey-client-capabilities"] = "conditional-create,conditional-get"

        r = self._request("POST", url, json={"name": name, "birthdate": birthdate}, headers=headers)
        try: data = r.json()
        except Exception: data = {"text": r.text[:500]}
        self._log("7. Create Account", "POST", url, r.status_code, data)
        if isinstance(data, dict):
            cb = data.get("continue_url") or data.get("url") or data.get("redirect_url")
            if cb:
                self._callback_url = cb
        return r.status_code, data

    def callback(self, url: str = None):
        if not url:
            url = self._callback_url
        if not url:
            self._print("[!] No callback URL, skipping.")
            return None, None
        r = self._request("GET", url, headers={
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Upgrade-Insecure-Requests": "1",
        }, allow_redirects=True)
        self._log("8. Callback", "GET", url, r.status_code, {"final_url": str(r.url)})
        return r.status_code, {"final_url": str(r.url)}

    # ==================== 自动注册主流程 ====================

    def run_register(self, email, password, name, birthdate):
        """使用 GPTMail 的注册流程"""
        self.visit_homepage()
        _random_delay(0.5, 1.5)
        csrf = self.get_csrf()
        _random_delay(0.3, 0.8)
        auth_url = self.signin(email, csrf)
        _random_delay(0.5, 1.2)

        final_url = self.authorize(auth_url)
        final_path = urlparse(final_url).path
        _random_delay(0.5, 1.0)

        self._print(f"Authorize → {final_path}")

        need_otp = False

        if "create-account/password" in final_path:
            self._print("全新注册流程")
            _random_delay(0.8, 2.0)
            status, data = self.register(email, password)
            if status != 200:
                # register 阶段尚未建立 OTP session，可以安全 rebuild 并重走整个流程
                self._print(f"[Register] 首次失败 ({status}), 尝试切换指纹重走流程...")
                _random_delay(3.0, 6.0)
                self._rebuild_session()
                self.visit_homepage()
                _random_delay(0.5, 1.5)
                csrf = self.get_csrf()
                _random_delay(0.3, 0.8)
                auth_url = self.signin(email, csrf)
                _random_delay(0.5, 1.2)
                final_url = self.authorize(auth_url)
                final_path = urlparse(final_url).path
                self._print(f"[Register] 重试后 Authorize → {final_path}")
                if "create-account/password" in final_path:
                    _random_delay(0.8, 2.0)
                    status, data = self.register(email, password)
                    if status != 200:
                        raise Exception(f"Register 失败 ({status}): {data}")
                elif "email-verification" in final_path or "email-otp" in final_path:
                    self._print("重试后跳到 OTP 验证阶段")
                    need_otp = True
                elif "about-you" in final_path:
                    self._print("重试后跳到填写信息阶段")
                    _random_delay(1.0, 2.5)
                    self.create_account(name, birthdate)
                    _random_delay(0.5, 1.0)
                    self.callback()
                    return True
                elif "callback" in final_path or "chatgpt.com" in final_url:
                    self._print("重试后账号已完成注册")
                    return True
                else:
                    raise Exception(f"Register 重试失败 ({status}): {data}")
            if status == 200 and not need_otp:
                _random_delay(0.5, 1.0)
                self.send_otp()
                need_otp = True
        elif "email-verification" in final_path or "email-otp" in final_path:
            self._print("跳到 OTP 验证阶段 (authorize 已触发 OTP，不再重复发送)")
            need_otp = True
        elif "about-you" in final_path:
            self._print("跳到填写信息阶段")
            _random_delay(1.0, 2.5)
            self.create_account(name, birthdate)
            _random_delay(0.5, 1.0)
            self.callback()
            return True
        elif "callback" in final_path or "chatgpt.com" in final_url:
            self._print("账号已完成注册")
            return True
        else:
            self._print(f"未知跳转: {final_url}")
            self.register(email, password)
            self.send_otp()
            need_otp = True

        if need_otp:
            # 使用 GPTMail 等待验证码
            otp_code = self.wait_for_verification_email(email)
            if not otp_code:
                raise Exception("未能获取验证码")

            _random_delay(0.5, 1.2)
            status, data = self.validate_otp(otp_code)
            if status != 200:
                self._print("验证码失败，重试...")
                self.send_otp()
                _random_delay(1.0, 2.0)
                otp_code = self.wait_for_verification_email(email, timeout=60)
                if not otp_code:
                    raise Exception("重试后仍未获取验证码")
                _random_delay(0.5, 1.2)
                status, data = self.validate_otp(otp_code)
                if status != 200:
                    raise Exception(f"验证码失败 ({status}): {data}")

        _random_delay(1.0, 2.5)

        # create_account 可能因 registration_disallowed 失败（IP 速率限制或指纹检测）。
        # 注意: 此阶段已完成 OTP 验证，session 中有宝贵的 auth cookies，
        # 绝对不能调用 _rebuild_session()，否则 cookies 丢失导致 invalid_state (409)。
        max_create_retries = 3
        for create_attempt in range(max_create_retries):
            status, data = self.create_account(name, birthdate)
            if status == 200:
                break  # 成功

            err_code = ""
            err_msg = ""
            if isinstance(data, dict):
                err_obj = data.get("error", {})
                if isinstance(err_obj, dict):
                    err_code = err_obj.get("code", "")
                    err_msg = err_obj.get("message", "")

            if err_code == "unsupported_email":
                raise Exception(f"邮箱域名被 OpenAI 拒绝 (unsupported_email): {err_msg}")

            if err_code == "invalid_state":
                # session 已失效，重试无意义（不能 rebuild 否则丢 auth cookies）
                raise Exception(f"Create account 失败 (409 invalid_state): session 已过期，需重新注册")

            if err_code == "registration_disallowed" and create_attempt < max_create_retries - 1:
                wait_secs = (create_attempt + 1) * 8 + random.uniform(3, 8)
                self._print(
                    f"[Create] registration_disallowed, 保持 session 延迟重试 "
                    f"{create_attempt + 2}/{max_create_retries} (等 {wait_secs:.1f}s)..."
                )
                time.sleep(wait_secs)
                # 不调用 _rebuild_session()！保留 auth cookies
                continue

            raise Exception(f"Create account 失败 ({status}): {data}")

        if status != 200:
            raise Exception(f"Create account 最终失败 ({status}): {data}")

        _random_delay(0.1, 0.2)
        self.callback()
        return True

    def _decode_oauth_session_cookie(self):
        jar = getattr(self.session.cookies, "jar", None)
        if jar is not None:
            cookie_items = list(jar)
        else:
            cookie_items = []

        for c in cookie_items:
            name = getattr(c, "name", "") or ""
            if "oai-client-auth-session" not in name:
                continue

            raw_val = (getattr(c, "value", "") or "").strip()
            if not raw_val:
                continue

            candidates = [raw_val]
            try:
                from urllib.parse import unquote

                decoded = unquote(raw_val)
                if decoded != raw_val:
                    candidates.append(decoded)
            except Exception:
                pass

            for val in candidates:
                try:
                    if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                        val = val[1:-1]

                    part = val.split(".")[0] if "." in val else val
                    pad = 4 - len(part) % 4
                    if pad != 4:
                        part += "=" * pad
                    raw = base64.urlsafe_b64decode(part)
                    data = json.loads(raw.decode("utf-8"))
                    if isinstance(data, dict):
                        return data
                except Exception:
                    continue
        return None

    def _oauth_allow_redirect_extract_code(self, url: str, referer: str = None):
        headers = {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Upgrade-Insecure-Requests": "1",
            "User-Agent": self.ua,
        }
        if referer:
            headers["Referer"] = referer

        try:
            resp = self.session.get(
                url,
                headers=headers,
                allow_redirects=True,
                timeout=30,
            )
            final_url = str(resp.url)
            code = _extract_code_from_url(final_url)
            if code:
                self._print("[OAuth] allow_redirect 命中最终 URL code")
                return code

            for r in getattr(resp, "history", []) or []:
                loc = r.headers.get("Location", "")
                code = _extract_code_from_url(loc)
                if code:
                    self._print("[OAuth] allow_redirect 命中 history Location code")
                    return code
                code = _extract_code_from_url(str(r.url))
                if code:
                    self._print("[OAuth] allow_redirect 命中 history URL code")
                    return code
        except Exception as e:
            maybe_localhost = re.search(r'(https?://localhost[^\s\'\"]+)', str(e))
            if maybe_localhost:
                code = _extract_code_from_url(maybe_localhost.group(1))
                if code:
                    self._print("[OAuth] allow_redirect 从 localhost 异常提取 code")
                    return code
            self._print(f"[OAuth] allow_redirect 异常: {e}")

        return None

    def _oauth_follow_for_code(self, start_url: str, referer: str = None, max_hops: int = 16):
        headers = {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Upgrade-Insecure-Requests": "1",
            "User-Agent": self.ua,
        }
        if referer:
            headers["Referer"] = referer

        current_url = start_url
        last_url = start_url

        for hop in range(max_hops):
            try:
                resp = self.session.get(
                    current_url,
                    headers=headers,
                    allow_redirects=False,
                    timeout=30,
                )
            except Exception as e:
                maybe_localhost = re.search(r'(https?://localhost[^\s\'\"]+)', str(e))
                if maybe_localhost:
                    code = _extract_code_from_url(maybe_localhost.group(1))
                    if code:
                        self._print(f"[OAuth] follow[{hop + 1}] 命中 localhost 回调")
                        return code, maybe_localhost.group(1)
                self._print(f"[OAuth] follow[{hop + 1}] 请求异常: {e}")
                return None, last_url

            last_url = str(resp.url)
            self._print(f"[OAuth] follow[{hop + 1}] {resp.status_code} {last_url[:140]}")
            code = _extract_code_from_url(last_url)
            if code:
                return code, last_url

            if resp.status_code in (301, 302, 303, 307, 308):
                loc = resp.headers.get("Location", "")
                if not loc:
                    return None, last_url
                if loc.startswith("/"):
                    loc = f"{OAUTH_ISSUER}{loc}"
                code = _extract_code_from_url(loc)
                if code:
                    return code, loc
                current_url = loc
                headers["Referer"] = last_url
                continue

            return None, last_url

        return None, last_url

    def _oauth_submit_workspace_and_org(self, consent_url: str):
        # 先 GET consent 页面（设置 cookies + 触发服务端状态更新，参照 codex_oauth_loop 步骤4a）
        self._print("[OAuth] GET consent 页面（触发 cookie 更新）...")
        try:
            resp_consent = self.session.get(
                consent_url,
                headers={
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Upgrade-Insecure-Requests": "1",
                    "User-Agent": self.ua,
                },
                allow_redirects=False,
                timeout=30,
            )
            if resp_consent.status_code in (301, 302, 303, 307, 308):
                loc = resp_consent.headers.get("Location", "")
                tmp_code = _extract_code_from_url(loc)
                if tmp_code:
                    self._print("[OAuth] consent GET 直接 302 获取到 code")
                    return tmp_code
                # 继续跟踪重定向
                code, _ = self._oauth_follow_for_code(
                    loc if loc.startswith("http") else f"{OAUTH_ISSUER}{loc}",
                    referer=consent_url
                )
                if code:
                    self._print("[OAuth] consent 302 跟踪获取到 code")
                    return code
            elif resp_consent.status_code == 200:
                self._print(f"[OAuth] consent 页面已加载 ({len(resp_consent.text)} bytes)")
        except Exception as e:
            maybe_localhost = re.search(r'(https?://localhost[^\s\'\"]+)', str(e))
            if maybe_localhost:
                code = _extract_code_from_url(maybe_localhost.group(1))
                if code:
                    self._print("[OAuth] consent GET 从 ConnectionError 提取到 code")
                    return code
            self._print(f"[OAuth] consent GET 异常: {e}")

        session_data = self._decode_oauth_session_cookie()
        if not session_data:
            jar = getattr(self.session.cookies, "jar", None)
            if jar is not None:
                cookie_names = [getattr(c, "name", "") for c in list(jar)]
            else:
                cookie_names = list(self.session.cookies.keys())
            self._print(f"[OAuth] 无法解码 oai-client-auth-session, cookies={cookie_names[:12]}")
            return None

        # 打印 session 内容用于调试（参照 codex_oauth_loop）
        self._print(f"[OAuth] session keys: {list(session_data.keys())}")

        workspaces = session_data.get("workspaces", [])
        if not workspaces:
            self._print("[OAuth] session 中没有 workspace 信息")
            # 打印 session 完整内容供调试
            try:
                import json as _json
                self._print(f"[OAuth] session 完整内容: {_json.dumps(session_data, indent=2)[:1500]}")
            except Exception:
                pass

        workspace_id = (workspaces[0] if workspaces else {}).get("id")

        h = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": OAUTH_ISSUER,
            "Referer": consent_url,
            "User-Agent": self.ua,
            "oai-device-id": self.device_id,
        }
        h.update(_make_trace_headers())

        if not workspace_id:
            # 参照 codex_oauth_loop 备用策略：workspace 为空时，
            # 用 allow_redirects=True GET consent 页面，
            # 从最终 URL 或 ConnectionError 中提取 code
            self._print("[OAuth] workspace为空，尝试 GET consent (allow_redirects=True) 提取 code...")
            try:
                resp = self.session.get(
                    consent_url,
                    headers={
                        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                        "Upgrade-Insecure-Requests": "1",
                        "User-Agent": self.ua,
                    },
                    allow_redirects=True,
                    timeout=30,
                )
                final_url = str(resp.url)
                self._print(f"[OAuth] consent GET -> {resp.status_code}, final={final_url[:140]}")
                code = _extract_code_from_url(final_url)
                if code:
                    self._print("[OAuth] 从 consent 最终 URL 提取到 code")
                    return code
                # 检查重定向链中的 Location
                for r in getattr(resp, "history", []) or []:
                    loc = r.headers.get("Location", "")
                    code = _extract_code_from_url(loc)
                    if code:
                        self._print("[OAuth] 从 consent 重定向链提取到 code")
                        return code
            except Exception as e:
                # 预期：localhost 连接失败，从错误信息中提取回调 URL
                maybe_localhost = re.search(r'(https?://localhost[^\s\'\"]+)', str(e))
                if maybe_localhost:
                    code = _extract_code_from_url(maybe_localhost.group(1))
                    if code:
                        self._print("[OAuth] 从 consent ConnectionError 提取到 code")
                        return code
                self._print(f"[OAuth] consent GET 异常: {e}")
            return None
        else:
            resp = self.session.post(
                f"{OAUTH_ISSUER}/api/accounts/workspace/select",
                json={"workspace_id": workspace_id},
                headers=h,
                allow_redirects=False,
                timeout=30,
            )
            self._print(f"[OAuth] workspace/select -> {resp.status_code}")

        if resp.status_code in (301, 302, 303, 307, 308):
            loc = resp.headers.get("Location", "")
            if loc.startswith("/"):
                loc = f"{OAUTH_ISSUER}{loc}"
            code = _extract_code_from_url(loc)
            if code:
                return code
            code, _ = self._oauth_follow_for_code(loc, referer=consent_url)
            if not code:
                code = self._oauth_allow_redirect_extract_code(loc, referer=consent_url)
            return code

        if resp.status_code != 200:
            self._print(f"[OAuth] workspace/select 失败: {resp.status_code}")
            return None

        try:
            ws_data = resp.json()
        except Exception:
            self._print("[OAuth] workspace/select 响应不是 JSON")
            return None

        ws_next = ws_data.get("continue_url", "")
        orgs = ws_data.get("data", {}).get("orgs", [])
        ws_page = (ws_data.get("page") or {}).get("type", "")
        self._print(f"[OAuth] workspace/select page={ws_page or '-'} next={(ws_next or '-')[:140]}")

        org_id = None
        project_id = None
        if orgs:
            org_id = (orgs[0] or {}).get("id")
            projects = (orgs[0] or {}).get("projects", [])
            if projects:
                project_id = (projects[0] or {}).get("id")

        if org_id:
            org_body = {"org_id": org_id}
            if project_id:
                org_body["project_id"] = project_id

            h_org = dict(h)
            if ws_next:
                h_org["Referer"] = ws_next if ws_next.startswith("http") else f"{OAUTH_ISSUER}{ws_next}"

            resp_org = self.session.post(
                f"{OAUTH_ISSUER}/api/accounts/organization/select",
                json=org_body,
                headers=h_org,
                allow_redirects=False,
                timeout=30,
            )
            self._print(f"[OAuth] organization/select -> {resp_org.status_code}")
            if resp_org.status_code in (301, 302, 303, 307, 308):
                loc = resp_org.headers.get("Location", "")
                if loc.startswith("/"):
                    loc = f"{OAUTH_ISSUER}{loc}"
                code = _extract_code_from_url(loc)
                if code:
                    return code
                code, _ = self._oauth_follow_for_code(loc, referer=h_org.get("Referer"))
                if not code:
                    code = self._oauth_allow_redirect_extract_code(loc, referer=h_org.get("Referer"))
                return code

            if resp_org.status_code == 200:
                try:
                    org_data = resp_org.json()
                except Exception:
                    self._print("[OAuth] organization/select 响应不是 JSON")
                    return None

                org_next = org_data.get("continue_url", "")
                org_page = (org_data.get("page") or {}).get("type", "")
                self._print(f"[OAuth] organization/select page={org_page or '-'} next={(org_next or '-')[:140]}")
                if org_next:
                    if org_next.startswith("/"):
                        org_next = f"{OAUTH_ISSUER}{org_next}"
                    code, _ = self._oauth_follow_for_code(org_next, referer=h_org.get("Referer"))
                    if not code:
                        code = self._oauth_allow_redirect_extract_code(org_next, referer=h_org.get("Referer"))
                    return code

        if ws_next:
            if ws_next.startswith("/"):
                ws_next = f"{OAUTH_ISSUER}{ws_next}"
            code, _ = self._oauth_follow_for_code(ws_next, referer=consent_url)
            if not code:
                code = self._oauth_allow_redirect_extract_code(ws_next, referer=consent_url)
            return code

        return None

    def perform_codex_oauth_login_http(self, email: str, password: str, email_addr: str = None):
        self._print("[OAuth] 开始执行 Codex OAuth 纯协议流程...")

        # 关键修复（参照 codex_oauth_loop）：为 OAuth 创建全新干净 session
        # 注册流程遗留的 cookies（chatgpt.com 域等）会干扰 OAuth 流程，导致拿不到 login_session
        # 注意：不要在 session 上设置额外 headers，impersonate 会自动处理 TLS 指纹头
        _oauth_kwargs = {"impersonate": self.impersonate}
        if _HTTP_VERSION_1_1 is not None:
            _oauth_kwargs["http_version"] = _HTTP_VERSION_1_1
        self.session = curl_requests.Session(**_oauth_kwargs)
        if self.proxy:
            self.session.proxies = {"http": self.proxy, "https": self.proxy}

        # 兼容两种 domain 形式，确保 auth 域也带 oai-did
        self.session.cookies.set("oai-did", self.device_id, domain=".auth.openai.com")
        self.session.cookies.set("oai-did", self.device_id, domain="auth.openai.com")

        code_verifier, code_challenge = _generate_pkce()
        state = secrets.token_urlsafe(24)

        authorize_params = {
            "response_type": "code",
            "client_id": OAUTH_CLIENT_ID,
            "redirect_uri": OAUTH_REDIRECT_URI,
            "scope": "openid profile email offline_access",
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
            "state": state,
        }
        authorize_url = f"{OAUTH_ISSUER}/oauth/authorize?{urlencode(authorize_params)}"

        def _oauth_json_headers(referer: str):
            h = {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Origin": OAUTH_ISSUER,
                "Referer": referer,
                "User-Agent": self.ua,
                "oai-device-id": self.device_id,
                "ext-passkey-client-capabilities": "conditional-create,conditional-get",
            }
            h.update(_make_trace_headers())
            return h

        def _bootstrap_oauth_session():
            self._print("[OAuth] 1/7 GET /oauth/authorize")
            # 403 重试机制：Cloudflare 拦截时切换指纹重试（参照 codex_oauth_loop）
            max_retries = 3
            r = None
            for attempt in range(max_retries + 1):
                try:
                    if attempt > 0:
                        backoff = 3 * (2 ** (attempt - 1)) + random.uniform(1, 3)
                        self._print(f"[OAuth] 第{attempt}次重试，等待 {backoff:.1f}s，切换指纹...")
                        time.sleep(backoff)
                        # 切换 Chrome 指纹，但保留 device_id
                        saved_device_id = self.device_id
                        imp, major, full, ua, sec_ch_ua = _random_chrome_version()
                        self.impersonate = imp
                        self.ua = ua
                        self.sec_ch_ua = sec_ch_ua
                        _retry_kwargs = {"impersonate": self.impersonate}
                        if _HTTP_VERSION_1_1 is not None:
                            _retry_kwargs["http_version"] = _HTTP_VERSION_1_1
                        self.session = curl_requests.Session(**_retry_kwargs)
                        if self.proxy:
                            self.session.proxies = {"http": self.proxy, "https": self.proxy}
                        self.device_id = saved_device_id  # 恢复 device_id
                        self.session.cookies.set("oai-did", self.device_id, domain=".auth.openai.com")
                        self.session.cookies.set("oai-did", self.device_id, domain="auth.openai.com")

                    r = self.session.get(
                        authorize_url,
                        headers={
                            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                            "Accept-Language": "en-US,en;q=0.9",
                            "User-Agent": self.ua,
                            "sec-ch-ua": self.sec_ch_ua,
                            "sec-ch-ua-mobile": "?0",
                            "sec-ch-ua-platform": '"Windows"',
                            "sec-fetch-dest": "document",
                            "sec-fetch-mode": "navigate",
                            "sec-fetch-site": "none",
                            "sec-fetch-user": "?1",
                            "Upgrade-Insecure-Requests": "1",
                        },
                        allow_redirects=True,
                        timeout=30,
                    )

                    if r.status_code == 403:
                        self._print(f"[OAuth] ⚠️ Cloudflare 403 拦截 (尝试 {attempt+1}/{max_retries+1})")
                        if attempt < max_retries:
                            continue
                        else:
                            self._print("[OAuth] ❌ 403 重试次数耗尽，OAuth 授权失败")
                            return False, ""
                    break  # 非 403，跳出重试循环
                except Exception as e:
                    self._print(f"[OAuth] /oauth/authorize 异常: {e}")
                    if attempt < max_retries:
                        continue
                    return False, ""

            if r is None:
                return False, ""

            final_url = str(r.url)
            redirects = len(getattr(r, "history", []) or [])
            self._print(f"[OAuth] /oauth/authorize -> {r.status_code}, final={(final_url or '-')[:140]}, redirects={redirects}")

            has_login = any(getattr(c, "name", "") == "login_session" for c in self.session.cookies)
            self._print(f"[OAuth] login_session: {'已获取' if has_login else '未获取'}")

            if not has_login:
                self._print("[OAuth] 未拿到 login_session，尝试访问 oauth2 auth 入口")
                oauth2_url = f"{OAUTH_ISSUER}/api/oauth/oauth2/auth"
                try:
                    r2 = self.session.get(
                        oauth2_url,
                        headers={
                            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                            "Accept-Language": "en-US,en;q=0.9",
                            "Referer": authorize_url,
                            "User-Agent": self.ua,
                            "sec-ch-ua": self.sec_ch_ua,
                            "sec-ch-ua-mobile": "?0",
                            "sec-ch-ua-platform": '"Windows"',
                            "sec-fetch-dest": "document",
                            "sec-fetch-mode": "navigate",
                            "sec-fetch-site": "same-origin",
                            "sec-fetch-user": "?1",
                            "Upgrade-Insecure-Requests": "1",
                        },
                        params=authorize_params,
                        allow_redirects=True,
                        timeout=30,
                    )
                    final_url = str(r2.url)
                    redirects2 = len(getattr(r2, "history", []) or [])
                    self._print(f"[OAuth] /api/oauth/oauth2/auth -> {r2.status_code}, final={(final_url or '-')[:140]}, redirects={redirects2}")
                except Exception as e:
                    self._print(f"[OAuth] /api/oauth/oauth2/auth 异常: {e}")

                has_login = any(getattr(c, "name", "") == "login_session" for c in self.session.cookies)
                self._print(f"[OAuth] login_session(重试): {'已获取' if has_login else '未获取'}")

            return has_login, final_url

        def _post_authorize_continue(referer_url: str):
            # 先尝试通过浏览器获取 Turnstile Sentinel Token
            sentinel_authorize = get_sentinel_token_browser(self.device_id, self.proxy)
            if sentinel_authorize:
                self._print("[Sentinel] OAuth authorize_continue PoW token (Browser/Turnstile) 已生成")
            else:
                self._print("[Sentinel] 回退到纯协议生成 OAuth authorize_continue PoW token...")
                sentinel_authorize = build_sentinel_token(
                    self.session,
                    self.device_id,
                    flow="authorize_continue",
                    user_agent=self.ua,
                    sec_ch_ua=self.sec_ch_ua,
                )
            if not sentinel_authorize:
                self._print("[OAuth] authorize_continue 的 sentinel token 获取失败")
                return None

            headers_continue = _oauth_json_headers(referer_url)
            headers_continue["openai-sentinel-token"] = sentinel_authorize

            try:
                return self.session.post(
                    f"{OAUTH_ISSUER}/api/accounts/authorize/continue",
                    json={"username": {"kind": "email", "value": email}},
                    headers=headers_continue,
                    timeout=30,
                    allow_redirects=False,
                )
            except Exception as e:
                self._print(f"[OAuth] authorize/continue 异常: {e}")
                return None

        has_login_session, authorize_final_url = _bootstrap_oauth_session()
        if not authorize_final_url:
            return None

        continue_referer = authorize_final_url if authorize_final_url.startswith(OAUTH_ISSUER) else f"{OAUTH_ISSUER}/log-in"

        self._print("[OAuth] 2/7 POST /api/accounts/authorize/continue")
        resp_continue = _post_authorize_continue(continue_referer)
        if resp_continue is None:
            return None

        self._print(f"[OAuth] /authorize/continue -> {resp_continue.status_code}")
        if resp_continue.status_code == 400 and "invalid_auth_step" in (resp_continue.text or ""):
            self._print("[OAuth] invalid_auth_step，重新 bootstrap 后重试一次")
            has_login_session, authorize_final_url = _bootstrap_oauth_session()
            if not authorize_final_url:
                return None
            continue_referer = authorize_final_url if authorize_final_url.startswith(OAUTH_ISSUER) else f"{OAUTH_ISSUER}/log-in"
            resp_continue = _post_authorize_continue(continue_referer)
            if resp_continue is None:
                return None
            self._print(f"[OAuth] /authorize/continue(重试) -> {resp_continue.status_code}")

        if resp_continue.status_code != 200:
            self._print(f"[OAuth] 邮箱提交失败: {resp_continue.text[:180]}")
            return None

        try:
            continue_data = resp_continue.json()
        except Exception:
            self._print("[OAuth] authorize/continue 响应解析失败")
            return None

        continue_url = continue_data.get("continue_url", "")
        page_type = (continue_data.get("page") or {}).get("type", "")
        self._print(f"[OAuth] continue page={page_type or '-'} next={(continue_url or '-')[:140]}")

        self._print("[OAuth] 3/7 POST /api/accounts/password/verify")

        resp_verify = None
        max_pwd_retries = 2

        # 关键修复（参照 codex_oauth_loop）：在提交密码（可能触发自动发邮件）前，
        # 提前记录旧邮件 ID 列表，否则若发件太快，新验证码可能被当作旧邮件跳过
        otp_email = email_addr or email
        old_mail_ids = set()
        if otp_email:
            try:
                api_base = GPTMAIL_API_BASE.rstrip("/")
                pre_mail_url = f"{api_base}/emails?email={quote(otp_email)}"
                pre_mail_session = self._create_gptmail_session()
                pre_res = pre_mail_session.get(
                    pre_mail_url,
                    headers={"X-API-Key": GPTMAIL_API_KEY},
                    timeout=10,
                )
                if pre_res.status_code == 200:
                    pre_data = pre_res.json()
                    pre_emails = pre_data.get("data", {}).get("emails", [])
                    for e_item in pre_emails:
                        mail_id = e_item.get("id")
                        if mail_id:
                            old_mail_ids.add(mail_id)
                    self._print(f"[OAuth] 预收集旧邮件 ID: {len(old_mail_ids)} 封")
            except Exception as e:
                self._print(f"[OAuth] 预收集旧邮件异常（非致命）: {e}")
        
        for pwd_attempt in range(max_pwd_retries):
            # 先尝试通过浏览器获取 Turnstile Sentinel Token
            sentinel_pwd = get_sentinel_token_browser(self.device_id, self.proxy)
            if sentinel_pwd:
                self._print("[Sentinel] OAuth password_verify PoW token (Browser/Turnstile) 已生成")
            else:
                self._print("[Sentinel] 回退到纯协议生成 OAuth password_verify PoW token...")
                sentinel_pwd = build_sentinel_token(
                    self.session,
                    self.device_id,
                    flow="password_verify",
                    user_agent=self.ua,
                    sec_ch_ua=self.sec_ch_ua,
                )
            if not sentinel_pwd:
                self._print("[OAuth] password_verify 的 sentinel token 获取失败")
                return None

            headers_verify = _oauth_json_headers(f"{OAUTH_ISSUER}/log-in/password")
            headers_verify["openai-sentinel-token"] = sentinel_pwd

            try:
                resp_verify = self.session.post(
                    f"{OAUTH_ISSUER}/api/accounts/password/verify",
                    json={"password": password},
                    headers=headers_verify,
                    timeout=30,
                    allow_redirects=False,
                )
            except Exception as e:
                self._print(f"[OAuth] password/verify 异常: {e}")
                return None

            self._print(f"[OAuth] /password/verify -> {resp_verify.status_code}")
            
            if resp_verify.status_code == 200:
                break
                
            err_text = resp_verify.text[:180]
            self._print(f"[OAuth] 密码校验失败 (尝试 {pwd_attempt+1}/{max_pwd_retries}): {err_text}")
            
            if "invalid_state" in err_text or resp_verify.status_code in (409, 401, 400):
                if pwd_attempt < max_pwd_retries - 1:
                    self._print("[OAuth] Session 可能已失效，重新 bootstrap 整个 OAuth 会话并重试...")
                    time.sleep(2)
                    has_login_session, authorize_final_url = _bootstrap_oauth_session()
                    if authorize_final_url:
                        continue_referer = authorize_final_url if authorize_final_url.startswith(OAUTH_ISSUER) else f"{OAUTH_ISSUER}/log-in"
                        resp_continue = _post_authorize_continue(continue_referer)
                        if resp_continue and resp_continue.status_code == 200:
                            self._print("[OAuth] 重新 continue 成功，准备重试 password/verify")
                            time.sleep(1)
                            continue
            
            return None
            
        if not resp_verify or resp_verify.status_code != 200:
            return None

        try:
            verify_data = resp_verify.json()
        except Exception:
            self._print("[OAuth] password/verify 响应解析失败")
            return None

        continue_url = verify_data.get("continue_url", "") or continue_url
        page_type = (verify_data.get("page") or {}).get("type", "") or page_type
        self._print(f"[OAuth] verify page={page_type or '-'} next={(continue_url or '-')[:140]}")

        need_oauth_otp = (
            page_type == "email_otp_verification"
            or "email-verification" in (continue_url or "")
            or "email-otp" in (continue_url or "")
        )

        if need_oauth_otp:
            self._print("[OAuth] 4/7 检测到邮箱 OTP 验证")
            # 使用传入的 email_addr 或 email 参数来查询 GPTMail
            otp_email = email_addr or email
            if not otp_email:
                self._print("[OAuth] OAuth 阶段需要邮箱 OTP，但无法查询邮件")
                return None

            headers_otp = _oauth_json_headers(f"{OAUTH_ISSUER}/email-verification")
            # 排除注册阶段已用过的验证码
            used_codes = getattr(self, '_used_otp_codes', set()).copy()
            otp_success = False

            # 短暂等待新的 OAuth OTP 邮件到达（最多 60 秒）
            self._print(f"[OAuth] 等待新的 OTP 邮件（排除已用: {used_codes}，跳过 {len(old_mail_ids)} 封旧邮件）...")
            api_base = GPTMAIL_API_BASE.rstrip("/")
            mail_url = f"{api_base}/emails?email={quote(otp_email)}"
            mail_headers = {"X-API-Key": GPTMAIL_API_KEY}
            mail_session = self._create_gptmail_session()
            deadline = time.time() + 60

            new_code = None
            poll_count = 0
            while time.time() < deadline:
                try:
                    res = mail_session.get(
                        mail_url,
                        headers=mail_headers,
                        timeout=10,
                    )
                    if res.status_code == 200:
                        data = res.json()
                        emails_list = data.get("data", {}).get("emails", [])
                        for mail_item in emails_list:
                            # 通过邮件 ID 跳过旧邮件（预收集）
                            mail_id = mail_item.get("id")
                            if mail_id and mail_id in old_mail_ids:
                                continue
                            from_addr = (mail_item.get("from_address") or "").lower()
                            if "openai" not in from_addr:
                                continue
                            for field in ("subject", "html_content"):
                                content = mail_item.get(field, "")
                                if content:
                                    code = self._extract_verification_code(content)
                                    if code and code not in used_codes:
                                        new_code = code
                                        break
                            if new_code:
                                break
                except Exception:
                    pass
                if new_code:
                    break
                poll_count += 1
                elapsed = int(time.time() - (deadline - 60))
                if poll_count % 3 == 0:
                    self._print(f"[OAuth] OTP 等待新邮件... ({elapsed}s/60s)")
                time.sleep(2)

            if not new_code:
                self._print("[OAuth] 60 秒内未收到新的 OTP 邮件，OAuth 失败")
                return None

            self._print(f"[OAuth] 尝试新 OTP: {new_code}")
            try:
                resp_otp = self.session.post(
                    f"{OAUTH_ISSUER}/api/accounts/email-otp/validate",
                    json={"code": new_code},
                    headers=headers_otp,
                    timeout=30,
                    allow_redirects=False,
                )
            except Exception as e:
                self._print(f"[OAuth] email-otp/validate 异常: {e}")
                return None

            self._print(f"[OAuth] /email-otp/validate -> {resp_otp.status_code}")
            if resp_otp.status_code != 200:
                self._print(f"[OAuth] OTP 验证失败 ({resp_otp.status_code}): {resp_otp.text[:160]}")
                return None

            try:
                otp_data = resp_otp.json()
            except Exception:
                self._print("[OAuth] email-otp/validate 响应解析失败")
                return None

            continue_url = otp_data.get("continue_url", "") or continue_url
            page_type = (otp_data.get("page") or {}).get("type", "") or page_type
            self._print(f"[OAuth] OTP 验证通过 page={page_type or '-'} next={(continue_url or '-')[:140]}")
            otp_success = True

        # ===== about-you 处理（参照 codex_oauth_loop）=====
        # 新注册账号 OTP 验证后可能进入 about-you（填写姓名生日），需要处理
        if "about-you" in (continue_url or "") or "about_you" in page_type:
            self._print("[OAuth] 检测到 about-you 步骤，处理中...")
            # 先 GET about-you 页面，服务端可能因账号已存在而跳转 consent
            try:
                h_about = {
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Upgrade-Insecure-Requests": "1",
                    "User-Agent": self.ua,
                    "Referer": f"{OAUTH_ISSUER}/email-verification",
                }
                resp_about = self.session.get(
                    f"{OAUTH_ISSUER}/about-you",
                    headers=h_about, timeout=30, allow_redirects=True,
                )
                about_url = str(resp_about.url)
                self._print(f"[OAuth] GET about-you -> {resp_about.status_code}, URL: {about_url[:100]}")

                if "consent" in about_url or "organization" in about_url:
                    continue_url = about_url
                    page_type = "consent"
                    self._print(f"[OAuth] about-you 已跳转到 consent: {continue_url[:100]}")
                else:
                    # 需要 POST create_account
                    import random as _rnd
                    _first = ["James", "Mary", "John", "Linda", "Robert", "Sarah", "Michael", "Emma"]
                    _last = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Wilson", "Taylor", "Davis"]
                    _name = f"{_rnd.choice(_first)} {_rnd.choice(_last)}"
                    _y = _rnd.randint(1995, 2002)
                    _m = _rnd.randint(1, 12)
                    _d = _rnd.randint(1, 28)
                    _bdate = f"{_y}-{_m:02d}-{_d:02d}"

                    h_create = _oauth_json_headers(f"{OAUTH_ISSUER}/about-you")
                    ca_sentinel = build_sentinel_token(
                        self.session, self.device_id, flow="oauth_create_account",
                        user_agent=self.ua, sec_ch_ua=self.sec_ch_ua,
                    )
                    if ca_sentinel:
                        h_create["openai-sentinel-token"] = ca_sentinel

                    resp_create = self.session.post(
                        f"{OAUTH_ISSUER}/api/accounts/create_account",
                        json={"name": _name, "birthdate": _bdate},
                        headers=h_create, timeout=30,
                    )
                    self._print(f"[OAuth] create_account -> {resp_create.status_code}")

                    if resp_create.status_code == 200:
                        try:
                            ca_data = resp_create.json()
                            continue_url = ca_data.get("continue_url", "") or continue_url
                            page_type = (ca_data.get("page") or {}).get("type", "") or page_type
                            self._print(f"[OAuth] 个人信息已提交, page={page_type}, next={continue_url[:100]}")
                        except Exception:
                            pass
                    elif resp_create.status_code == 400 and "already_exists" in (resp_create.text or ""):
                        self._print("[OAuth] 账号已存在，直接跳转 consent")
                        continue_url = f"{OAUTH_ISSUER}/sign-in-with-chatgpt/codex/consent"
                        page_type = "consent"
                    else:
                        self._print(f"[OAuth] create_account 失败: {resp_create.text[:200]}")
            except Exception as e:
                self._print(f"[OAuth] about-you 处理异常: {e}")

        # ===== add-phone 处理 =====
        # 新注册账号可能被要求绑定手机，通过重新访问 authorize URL 跳过
        if "add-phone" in (continue_url or "") or "add_phone" in page_type:
            self._print("[OAuth] 检测到 add-phone，通过重新访问 authorize URL 跳过...")
            # 策略：已完成认证的 session 重新 GET /oauth/authorize，服务端应该直接 302 到 callback
            try:
                r_reauth = self.session.get(
                    authorize_url,
                    headers={
                        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                        "User-Agent": self.ua,
                        "Referer": f"{OAUTH_ISSUER}/add-phone",
                        "Upgrade-Insecure-Requests": "1",
                        "sec-fetch-dest": "document",
                        "sec-fetch-mode": "navigate",
                        "sec-fetch-site": "same-origin",
                    },
                    allow_redirects=False,
                    timeout=30,
                )
                self._print(f"[OAuth] re-authorize -> {r_reauth.status_code}")

                if r_reauth.status_code in (301, 302, 303, 307, 308):
                    loc = r_reauth.headers.get("Location", "")
                    self._print(f"[OAuth] re-authorize redirect: {loc[:140]}")
                    tmp_code = _extract_code_from_url(loc)
                    if tmp_code:
                        continue_url = loc
                        page_type = "has_code"
                    else:
                        # 可能跳到 consent 或其他中间页
                        if loc.startswith("/"):
                            loc = f"{OAUTH_ISSUER}{loc}"
                        continue_url = loc
                        page_type = ""
                        if "consent" in loc:
                            page_type = "consent"
                else:
                    # 200 - 可能还在 add-phone 或者到了 consent SPA
                    final_reauth_url = str(r_reauth.url)
                    if "consent" in final_reauth_url:
                        continue_url = final_reauth_url
                        page_type = "consent"
                    else:
                        # 最终尝试 allow_redirects=True
                        continue_url = f"{OAUTH_ISSUER}/sign-in-with-chatgpt/codex/consent"
                        page_type = "consent"
            except Exception as e:
                maybe_localhost = re.search(r'(https?://localhost[^\s\'\"]+)', str(e))
                if maybe_localhost:
                    continue_url = maybe_localhost.group(1)
                    page_type = "has_code"
                    self._print("[OAuth] re-authorize 直接拿到 localhost callback")
                else:
                    self._print(f"[OAuth] re-authorize 异常: {e}")
                    continue_url = f"{OAUTH_ISSUER}/sign-in-with-chatgpt/codex/consent"
                    page_type = "consent"

        # ===== consent 直接返回的情况 =====
        if "consent" in page_type and not continue_url:
            continue_url = f"{OAUTH_ISSUER}/sign-in-with-chatgpt/codex/consent"

        code = None
        consent_url = continue_url
        if consent_url and consent_url.startswith("/"):
            consent_url = f"{OAUTH_ISSUER}{consent_url}"

        if not consent_url:
            consent_url = f"{OAUTH_ISSUER}/sign-in-with-chatgpt/codex/consent"

        # 先检查 URL 中是否已经有 code
        if consent_url:
            code = _extract_code_from_url(consent_url)

        if not code and consent_url:
            self._print("[OAuth] 5/7 跟随 continue_url 提取 code")
            code, _ = self._oauth_follow_for_code(consent_url, referer=f"{OAUTH_ISSUER}/log-in/password")

        consent_hint = (
            ("consent" in (consent_url or ""))
            or ("sign-in-with-chatgpt" in (consent_url or ""))
            or ("workspace" in (consent_url or ""))
            or ("organization" in (consent_url or ""))
            or ("consent" in page_type)
            or ("organization" in page_type)
        )

        if not code and consent_hint:
            if not consent_url:
                consent_url = f"{OAUTH_ISSUER}/sign-in-with-chatgpt/codex/consent"
            self._print("[OAuth] 6/7 执行 workspace/org 选择")
            code = self._oauth_submit_workspace_and_org(consent_url)

        # 终极备用策略：重新 GET authorize_url，已认证 session 应该直接拿到 code
        if not code:
            self._print("[OAuth] 6/7 终极备用：重新 GET authorize URL...")
            try:
                code, _ = self._oauth_follow_for_code(authorize_url, referer=f"{OAUTH_ISSUER}/sign-in-with-chatgpt/codex/consent")
            except Exception:
                pass
            if not code:
                code = self._oauth_allow_redirect_extract_code(authorize_url, referer=f"{OAUTH_ISSUER}/sign-in-with-chatgpt/codex/consent")

        if not code:
            fallback_consent = f"{OAUTH_ISSUER}/sign-in-with-chatgpt/codex/consent"
            self._print("[OAuth] 6/7 回退 consent 路径重试")
            code = self._oauth_submit_workspace_and_org(fallback_consent)
            if not code:
                code, _ = self._oauth_follow_for_code(fallback_consent, referer=f"{OAUTH_ISSUER}/log-in/password")

        if not code:
            self._print("[OAuth] 未获取到 authorization code")
            return None

        self._print("[OAuth] 7/7 POST /oauth/token")
        token_resp = self.session.post(
            f"{OAUTH_ISSUER}/oauth/token",
            headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": self.ua},
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": OAUTH_REDIRECT_URI,
                "client_id": OAUTH_CLIENT_ID,
                "code_verifier": code_verifier,
            },
            timeout=60,
        )
        self._print(f"[OAuth] /oauth/token -> {token_resp.status_code}")

        if token_resp.status_code != 200:
            self._print(f"[OAuth] token 交换失败: {token_resp.status_code} {token_resp.text[:200]}")
            return None

        try:
            data = token_resp.json()
        except Exception:
            self._print("[OAuth] token 响应解析失败")
            return None

        if not data.get("access_token"):
            self._print("[OAuth] token 响应缺少 access_token")
            return None

        self._print("[OAuth] Codex Token 获取成功")
        return data


# ==================== 并发批量注册 ====================

def _register_one(idx, total, proxy, output_file):
    """单个注册任务 (在线程中运行) - 使用 GPTMail 临时邮箱

    如果遇到 unsupported_email 错误，自动用新邮箱重试整个流程。
    """
    max_email_retries = 3  # 因邮箱域名被拒绝最多重试 3 次

    for email_retry in range(max_email_retries):
        reg = None
        try:
            reg = ChatGPTRegister(proxy=proxy, tag=f"{idx}")

            # 1. 创建 GPTMail 临时邮箱（已含域名过滤）
            reg._print("[GPTMail] 创建临时邮箱...")
            email = reg.create_temp_email()
            tag = email.split("@")[0]
            reg.tag = tag  # 更新 tag

            chatgpt_password = _generate_password()
            name = _random_name()
            birthdate = _random_birthdate()

            with _print_lock:
                print(f"\n{'='*60}")
                print(f"  [{idx}/{total}] 注册: {email}" + (f" (重试 {email_retry+1})" if email_retry > 0 else ""))
                print(f"  ChatGPT密码: {chatgpt_password}")
                print(f"  姓名: {name} | 生日: {birthdate}")
                print(f"{'='*60}")

            # 2. 执行注册流程
            reg.run_register(email, chatgpt_password, name, birthdate)

            # 3. OAuth（可选）
            oauth_ok = True
            if ENABLE_OAUTH:
                reg._print("[OAuth] 开始获取 Codex Token...")
                tokens = reg.perform_codex_oauth_login_http(email, chatgpt_password, email_addr=email)
                oauth_ok = bool(tokens and tokens.get("access_token"))
                if oauth_ok:
                    _save_codex_tokens(email, tokens)
                    reg._print("[OAuth] Token 已保存")
                else:
                    msg = "OAuth 获取失败"
                    if OAUTH_REQUIRED:
                        raise Exception(f"{msg}（oauth_required=true）")
                    reg._print(f"[OAuth] {msg}（按配置继续）")

            # 4. 线程安全写入结果
            with _file_lock:
                with open(output_file, "a", encoding="utf-8") as out:
                    out.write(f"{email}----{chatgpt_password}----oauth={'ok' if oauth_ok else 'fail'}\n")

            with _print_lock:
                print(f"\n[OK] [{tag}] {email} 注册成功!")
            return True, email, None

        except Exception as e:
            error_msg = str(e)
            # unsupported_email: 邮箱域名被拒绝，用新邮箱重试
            if "unsupported_email" in error_msg and email_retry < max_email_retries - 1:
                with _print_lock:
                    print(f"[RETRY] [{idx}] 邮箱域名被 OpenAI 拒绝, 换新邮箱重试 ({email_retry+2}/{max_email_retries})...")
                time.sleep(1)
                continue
            with _print_lock:
                print(f"\n[FAIL] [{idx}] 注册失败: {error_msg}")
                traceback.print_exc()
            return False, None, error_msg


def run_batch(total_accounts: int = 3, output_file="registered_accounts.txt",
              max_workers=3, proxy=None):
    """并发批量注册 - GPTMail 临时邮箱版"""

    if not GPTMAIL_API_KEY:
        print("❌ 错误: 未设置 GPTMAIL_API_KEY")
        print("   请在 config.json 中设置 gptmail_api_key")
        print("   或设置环境变量: export GPTMAIL_API_KEY='your_api_key_here'")
        print("   Windows: set GPTMAIL_API_KEY=your_api_key_here")
        return

    actual_workers = min(max_workers, total_accounts)
    print(f"\n{'#'*60}")
    print(f"  ChatGPT 批量自动注册 (GPTMail 临时邮箱版)")
    print(f"  注册数量: {total_accounts} | 并发数: {actual_workers}")
    print(f"  GPTMail: {GPTMAIL_API_BASE}")
    print(f"  OAuth: {'开启' if ENABLE_OAUTH else '关闭'} | required: {'是' if OAUTH_REQUIRED else '否'}")
    if ENABLE_OAUTH:
        print(f"  OAuth Issuer: {OAUTH_ISSUER}")
        print(f"  OAuth Client: {OAUTH_CLIENT_ID}")
        print(f"  Token输出: {TOKEN_JSON_DIR}/, {AK_FILE}, {RK_FILE}")
    print(f"  输出文件: {output_file}")
    print(f"{'#'*60}\n")

    success_count = 0
    fail_count = 0
    start_time = time.time()

    with ThreadPoolExecutor(max_workers=actual_workers) as executor:
        futures = {}
        for idx in range(1, total_accounts + 1):
            future = executor.submit(
                _register_one, idx, total_accounts, proxy, output_file
            )
            futures[future] = idx

        for future in as_completed(futures):
            idx = futures[future]
            try:
                ok, email, err = future.result()
                if ok:
                    success_count += 1
                else:
                    fail_count += 1
                    print(f"  [账号 {idx}] 失败: {err}")
            except Exception as e:
                fail_count += 1
                with _print_lock:
                    print(f"[FAIL] 账号 {idx} 线程异常: {e}")

    elapsed = time.time() - start_time
    avg = elapsed / total_accounts if total_accounts else 0
    print(f"\n{'#'*60}")
    print(f"  注册完成! 耗时 {elapsed:.1f} 秒")
    print(f"  总数: {total_accounts} | 成功: {success_count} | 失败: {fail_count}")
    print(f"  平均速度: {avg:.1f} 秒/个")
    if success_count > 0:
        print(f"  结果文件: {output_file}")
    print(f"{'#'*60}")


def main():
    print("=" * 60)
    print("  ChatGPT 批量自动注册工具 (GPTMail 临时邮箱版)")
    print("=" * 60)

    # 检查 GPTMail 配置
    if not GPTMAIL_API_KEY:
        print("\n⚠️  警告: 未设置 GPTMAIL_API_KEY")
        print("   请编辑 config.json 设置 gptmail_api_key，或设置环境变量:")
        print("   Windows: set GPTMAIL_API_KEY=your_api_key_here")
        print("   Linux/Mac: export GPTMAIL_API_KEY='your_api_key_here'")
        print("\n   按 Enter 继续尝试运行 (可能会失败)...")
        input()

    # 交互式代理配置
    proxy = DEFAULT_PROXY
    if proxy:
        print(f"[Info] 检测到默认代理: {proxy}")
        use_default = input("使用此代理? (Y/n): ").strip().lower()
        if use_default == "n":
            proxy = input("输入代理地址 (留空=不使用代理): ").strip() or None
    else:
        env_proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") \
                 or os.environ.get("ALL_PROXY") or os.environ.get("all_proxy")
        if env_proxy:
            print(f"[Info] 检测到环境变量代理: {env_proxy}")
            use_env = input("使用此代理? (Y/n): ").strip().lower()
            if use_env == "n":
                proxy = input("输入代理地址 (留空=不使用代理): ").strip() or None
            else:
                proxy = env_proxy
        else:
            proxy = input("输入代理地址 (如 http://127.0.0.1:7890，留空=不使用代理): ").strip() or None

    if proxy:
        print(f"[Info] 使用代理: {proxy}")
    else:
        print("[Info] 不使用代理")

    # 输入注册数量
    count_input = input(f"\n注册账号数量 (默认 {DEFAULT_TOTAL_ACCOUNTS}): ").strip()
    total_accounts = int(count_input) if count_input.isdigit() and int(count_input) > 0 else DEFAULT_TOTAL_ACCOUNTS

    workers_input = input("并发数 (默认 3): ").strip()
    max_workers = int(workers_input) if workers_input.isdigit() and int(workers_input) > 0 else 3

    run_batch(total_accounts=total_accounts, output_file=DEFAULT_OUTPUT_FILE,
              max_workers=max_workers, proxy=proxy)


if __name__ == "__main__":
    main()
