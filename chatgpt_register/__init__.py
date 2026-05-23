"""chatgpt_register — slimmed vendored package.

Only sentinel token generation; consumed by protocol_register.py.
"""
from chatgpt_register.chatgpt_register import (
    SentinelTokenGenerator,
    fetch_sentinel_challenge,
    build_sentinel_token,
)
from chatgpt_register.sentinel_browser import get_sentinel_token_browser

__all__ = [
    "SentinelTokenGenerator",
    "fetch_sentinel_challenge",
    "build_sentinel_token",
    "get_sentinel_token_browser",
]
