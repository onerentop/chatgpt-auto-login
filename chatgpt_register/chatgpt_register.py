"""Slimmed chatgpt_register — sentinel token generator only.

Vendored from `cliproxyaccountcleaner/chatgpt_register/chatgpt_register.py`.
Stripped to the 3 symbols actually consumed by protocol_register.py:
  - SentinelTokenGenerator
  - fetch_sentinel_challenge
  - build_sentinel_token

The original 2700+ line file also contained batch account registration,
codex token persistence, temp email signup, password/name generators,
and a ChatGPTRegister class — all unused by this project.
"""
import uuid
import json
import random
import time
import base64
from datetime import datetime


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
            "windowControlsOverlay−[object WindowControlsOverlay]",
            "scheduling−[object Scheduling]",
            "pdfViewerEnabled−true",
            "hardwareConcurrency−16",
            "deviceMemory−8",
            "maxTouchPoints−0",
            "cookieEnabled−true",
            "vendor−Google Inc.",
            "language−en-US",
            "onLine−true",
            "webdriver−false",
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
