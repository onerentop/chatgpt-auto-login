# app/src/opai/core/sms_cloud.py
"""SMS Cloud (smscloud.sbs) provider implementation."""
from __future__ import annotations

import logging
import re
import time
from typing import Any, Optional

import tls_client

from .sms_provider import SmsProvider

log = logging.getLogger(__name__)

SMSCLOUD_BASE = "https://smscloud.sbs/api/system"


class SmsCloudProvider(SmsProvider):

    def __init__(self, api_key: str, service_code: str = "ni", country_code: int = 6, max_price: float = 0):
        self.api_key = api_key
        self.service_code = service_code
        self.country_code = country_code
        self.max_price = max_price
        self._used_codes: set[str] = set()
        self._current_price: float = 0
        self._tiers: list[float] = []
        self._rented: dict[str, float] = {}  # order_id -> rent timestamp

    def _get(self, path: str, params: dict | None = None, retries: int = 3) -> dict[str, Any]:
        headers = {"apiKey": self.api_key, "Content-Type": "application/json"}
        url = f"{SMSCLOUD_BASE}{path}"
        for i in range(1, retries + 1):
            try:
                s = tls_client.Session(client_identifier="chrome_120")
                r = s.get(url, params=params or {}, headers=headers, timeout_seconds=30)
                return r.json()
            except Exception as e:
                log.debug("smscloud _get attempt %d (%s): %s", i, path, e)
                if i < retries:
                    time.sleep(3)
        return {"code": -1, "message": "request failed", "data": None}

    def _parse_number_resp(self, resp: dict) -> tuple[Optional[str], Optional[str]]:
        if resp.get("code") != 0 or not resp.get("data"):
            return None, None
        data = resp["data"]
        phone_number = data.get("phoneNumber", "")
        full_phone = phone_number if phone_number.startswith("+") else f"+{phone_number}"
        order_id = str(data["id"])
        cost = data.get("creditAmount", "?")
        log.info("smscloud getNumber: %s (order %s, cost %.2f)", full_phone, order_id, cost)
        self._current_price = float(cost) if cost != "?" else self._current_price
        self._rented[order_id] = time.time()
        return full_phone, order_id

    def _load_tiers(self) -> list[float]:
        inv = self._get("/public/sms/getInventory", {"serviceCode": self.service_code})
        for item in inv.get("data", []):
            if item.get("country") == self.country_code:
                price_map = item.get("freePriceMap")
                if isinstance(price_map, str):
                    import json as _json
                    price_map = _json.loads(price_map)
                if isinstance(price_map, dict):
                    return sorted(float(p) for p in price_map.keys())
        return []

    def get_number(self) -> tuple[Optional[str], Optional[str]]:
        """Get a number at current price tier. Returns (None, None) if no stock at this price."""
        base_params = {"serviceCode": self.service_code, "countryCode": self.country_code}
        if self._current_price > 0:
            resp = self._get("/public/sms/flexible", {**base_params, "maxPrice": self._current_price})
        else:
            resp = self._get("/public/sms/getNumber", base_params)
        return self._parse_number_resp(resp)

    def escalate_price(self) -> bool:
        """Move to next price tier. Return False if already at max or no tiers left."""
        if not self._tiers:
            self._tiers = self._load_tiers()
        if not self._tiers:
            return False
        cap = self.max_price if self.max_price > 0 else self._tiers[-1]
        for price in self._tiers:
            if price > self._current_price and price <= cap:
                log.info("smscloud: escalating price %.2f -> %.2f", self._current_price, price)
                self._current_price = price
                return True
        log.warning("smscloud: max price %.2f reached, cannot escalate further", cap)
        return False

    def wait_code(self, order_id: str, timeout: int = 120) -> Optional[str]:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                resp = self._get(f"/public/sms/orders/sync/{order_id}")
            except Exception:
                time.sleep(5)
                continue
            if resp.get("code") != 0:
                log.warning("smscloud sync error: %s", resp.get("message", resp))
                return None
            data = resp.get("data")
            if data and data.get("code"):
                raw_code = data["code"]
                m = re.search(r"\b(\d{4,6})\b", raw_code)
                code = m.group(1) if m else raw_code
                if code not in self._used_codes:
                    self._used_codes.add(code)
                    return code
                log.debug("smscloud: code %s already used, waiting for new one", code)
            time.sleep(5)
        return None

    def request_another(self, order_id: str) -> bool:
        try:
            resp = self._get(f"/public/sms/orders/resend/{order_id}")
            ok = resp.get("code") == 0
            log.info("smscloud resend %s: %s", order_id, "OK" if ok else resp.get("message"))
            return ok
        except Exception:
            return False

    def cancel(self, order_id: str) -> None:
        try:
            resp = self._get(f"/public/sms/orders/cancel/{order_id}")
            if resp.get("code") == 0:
                self._rented.pop(order_id, None)
                log.info("smscloud cancelled order %s (refunded)", order_id)
            else:
                # code 50002 = order too young (<2min); keep tracked for retry
                log.debug("smscloud cancel %s not ready: %s", order_id, resp.get("message"))
        except Exception:
            pass

    def done(self, order_id: str) -> None:
        try:
            self._get(f"/public/sms/orders/finish/{order_id}")
            self._rented.pop(order_id, None)
        except Exception:
            pass

    def release_unused(self, keep: Optional[str] = None, max_wait: float = 150) -> None:
        """Cancel all rented-but-unused orders (refund), except `keep`.

        SMS Cloud requires an order to be ~2 min old before it can be cancelled,
        so this retries until each order is old enough or max_wait elapses.
        """
        targets = {oid for oid in self._rented if oid != keep}
        if not targets:
            return
        log.info("smscloud: releasing %d unused order(s)...", len(targets))
        deadline = time.time() + max_wait
        while targets and time.time() < deadline:
            for oid in list(targets):
                age = time.time() - self._rented.get(oid, 0)
                if age < 125:
                    continue  # too young to cancel yet
                resp = self._get(f"/public/sms/orders/cancel/{oid}")
                if resp.get("code") == 0:
                    self._rented.pop(oid, None)
                    targets.discard(oid)
                    log.info("smscloud: released order %s (refunded)", oid)
            if targets:
                time.sleep(5)
        if targets:
            log.warning("smscloud: %d order(s) not released (will auto-expire): %s",
                        len(targets), ", ".join(targets))
