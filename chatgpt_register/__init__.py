"""
ChatGPT 批量自动注册模块 (纯协议版)
依赖: pip install curl_cffi
"""
from chatgpt_register.chatgpt_register import (
    ChatGPTRegister,
    SentinelTokenGenerator,
    build_sentinel_token,
    fetch_sentinel_challenge,
    create_temp_email,
    wait_for_verification_email,
    _generate_password,
    _random_name,
    _random_birthdate,
    _random_chrome_version,
    _save_codex_tokens,
    _register_one,
    run_batch as run_batch_protocol,
    ENABLE_OAUTH,
    OAUTH_REQUIRED,
)

__all__ = [
    "ChatGPTRegister",
    "SentinelTokenGenerator",
    "build_sentinel_token",
    "fetch_sentinel_challenge",
    "create_temp_email",
    "wait_for_verification_email",
    "_generate_password",
    "_random_name",
    "_random_birthdate",
    "_random_chrome_version",
    "_save_codex_tokens",
    "_register_one",
    "run_batch_protocol",
    "ENABLE_OAUTH",
    "OAUTH_REQUIRED",
]
