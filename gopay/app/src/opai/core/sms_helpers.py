"""Generic API error helpers — shared by all protocol code.

SMS-provider-specific functions have moved to sms_herosms.py and sms_cloud.py.
"""
from __future__ import annotations

import logging
import time

log = logging.getLogger(__name__)


def is_waf_block(result: dict) -> bool:
    body = result.get("body", {})
    if isinstance(body, dict) and "raw" in body:
        return "WAF Block Page" in body["raw"]
    return False


def is_rate_limited(result: dict) -> bool:
    errors = result.get("body", {}).get("errors", [])
    if errors:
        code = errors[0].get("code", "")
        return "ratelimit" in code.lower() or "rate_limit" in code.lower()
    return result.get("status") == 429


def get_error_code(result: dict) -> str:
    errors = result.get("body", {}).get("errors", [])
    return errors[0].get("code", "") if errors else ""


def api_call_with_retry(fn, *args, max_retries: int = 3, **kwargs) -> dict:
    """Retry API call on WAF block or transient errors."""
    result = {}
    for attempt in range(max_retries + 1):
        result = fn(*args, **kwargs)
        if result["status"] in (200, 201, 204):
            return result
        if is_waf_block(result):
            if attempt < max_retries:
                wait = 5 * (attempt + 1)
                log.warning("WAF blocked, retrying in %ds... (%d/%d)", wait, attempt + 1, max_retries)
                time.sleep(wait)
                continue
        if is_rate_limited(result):
            log.warning("Rate limited (429), returning immediately for IP rotation")
            return result
        return result
    return result
