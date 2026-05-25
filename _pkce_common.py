# _pkce_common.py — PKCE / add-phone 公共函数
# 从 protocol_register.py 抽出，共享给 protocol_phone_verify.py
import json
import re
import sys
from urllib.parse import parse_qs, urlparse

AUTH = "https://auth.openai.com"
BASE = "https://chatgpt.com"


def _log(msg):
    print(json.dumps({"log": msg}))
    sys.stdout.flush()


def get_sentinel_token(session, device_id, flow="authorize_continue", user_agent=""):
    return ""
