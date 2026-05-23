import logging
import json
from typing import Optional

logger = logging.getLogger("sentinel_browser")

def get_sentinel_token_browser(device_id: str, proxy: Optional[str] = None) -> Optional[str]:
    """
    Launch a headless browser using Playwright to get a full Sentinel token (with Turnstile).
    This handles the mandatory Turnstile challenge required for register/create_account steps.
    Returns the base64-encoded token string.
    """
    try:
        from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError
    except ImportError:
        logger.error("[Sentinel Browser] Playwright is not installed. Please `pip install playwright`.")
        return None

    try:
        with sync_playwright() as p:
            launch_args = {
                "headless": True,
                "args": [
                    "--disable-blink-features=AutomationControlled",
                ]
            }
            if proxy:
                launch_args["proxy"] = {"server": proxy}

            browser = p.chromium.launch(**launch_args)
            context = browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.113 Safari/537.36"
            )

            # Inject the oai-did cookie to link the browser session to our HTTP protocol session
            context.add_cookies([
                {
                    "name": "oai-did",
                    "value": device_id,
                    "domain": "auth.openai.com",
                    "path": "/"
                }
            ])

            page = context.new_page()

            logger.info("[Sentinel Browser] Navigating to auth.openai.com/login...")
            page.goto("https://auth.openai.com/login", wait_until="domcontentloaded", timeout=30000)

            logger.info("[Sentinel Browser] Waiting for SentinelSDK to load...")
            # Wait for SentinelSDK to be attached to the window object
            page.wait_for_function("() => typeof window.SentinelSDK !== 'undefined'", timeout=15000)

            logger.info("[Sentinel Browser] Triggering SentinelSDK.token()... (approx 9 seconds)")
            # Execute the turnstile challenge natively in the browser JS VM
            # We wrap it in a try-catch in JS to handle any potential errors cleanly
            js_script = """
                async () => {
                    try {
                        return await window.SentinelSDK.token();
                    } catch (e) {
                        return 'ERROR:' + e.toString();
                    }
                }
            """
            token_val = page.evaluate(js_script)

            browser.close()

            if isinstance(token_val, str) and token_val.startswith("ERROR:"):
                logger.error(f"[Sentinel Browser] JS execution failed: {token_val}")
                return None

            if token_val:
                logger.info("[Sentinel Browser] Successfully retrieved Sentinel token (with Turnstile)")
                return token_val
            else:
                logger.warning("[Sentinel Browser] SentinelSDK returned empty or null token")
                return None

    except Exception as e:
        logger.error(f"[Sentinel Browser] Playwright execution failed: {e}")
        return None
