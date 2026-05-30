# app/src/opai/core/sms_nexsms.py
"""NexSMS (api.nexsms.net) provider implementation."""
from __future__ import annotations

import json as _json
import logging
import re
import time
from typing import Any, Optional

import tls_client

from .sms_provider import SmsProvider

log = logging.getLogger(__name__)

NEXSMS_BASE = "https://api.nexsms.net/api"


class NexSmsProvider(SmsProvider):
    """NexSMS provider.

    Uses phone number as the order identifier throughout the SmsProvider
    interface since NexSMS has no separate activation/order ID concept.
    """

    def __init__(
        self,
        api_key: str,
        service_code: str = "ni",
        country_id: int = 6,
        max_price: float = 0,
    ):
        self.api_key = api_key
        self.service_code = service_code
        self.country_id = country_id
        self.max_price = max_price
        self._used_codes: set[str] = set()
        self._current_price: float = 0
        self._tiers: list[float] = []
        self._rented: dict[str, float] = {}  # phone -> rent timestamp

    def _get(self, path: str, params: dict | None = None, retries: int = 3) -> dict[str, Any]:
        url = f"{NEXSMS_BASE}{path}"
        p = {"apiKey": self.api_key}
        if params:
            p.update(params)
        for i in range(1, retries + 1):
            try:
                s = tls_client.Session(client_identifier="chrome_120")
                r = s.get(url, params=p, timeout_seconds=30)
                return r.json()
            except Exception as e:
                log.debug("nexsms _get attempt %d (%s): %s", i, path, e)
                if i < retries:
                    time.sleep(3)
        return {"code": -1, "message": "request failed", "data": None}

    def _post(self, path: str, body: dict, retries: int = 3) -> dict[str, Any]:
        url = f"{NEXSMS_BASE}{path}?apiKey={self.api_key}"
        for i in range(1, retries + 1):
            try:
                s = tls_client.Session(client_identifier="chrome_120")
                r = s.post(url, json=body, headers={"Content-Type": "application/json"}, timeout_seconds=30)
                return r.json()
            except Exception as e:
                log.debug("nexsms _post attempt %d (%s): %s", i, path, e)
                if i < retries:
                    time.sleep(3)
        return {"code": -1, "message": "request failed", "data": None}

    def _load_tiers(self) -> list[float]:
        resp = self._get("/getCountryByService", {
            "serviceCode": self.service_code,
            "countryId": str(self.country_id),
        })
        if resp.get("code") != 0:
            log.warning("nexsms: failed to load price tiers: %s", resp.get("message"))
            return []
        data = resp.get("data")
        if not data:
            return []
        if isinstance(data, list):
            data = data[0] if data else {}
        price_map = data.get("priceMap", {})
        if isinstance(price_map, dict):
            return sorted(float(p) for p in price_map.keys())
        return []

    def _ensure_price(self):
        if self._current_price > 0:
            return
        if not self._tiers:
            self._tiers = self._load_tiers()
        if self._tiers:
            self._current_price = self._tiers[0]
            log.info("nexsms: starting at lowest price %.4f", self._current_price)

    def get_number(self) -> tuple[Optional[str], Optional[str]]:
        self._ensure_price()
        if self._current_price <= 0:
            log.error("nexsms: no price available")
            return None, None

        resp = self._post("/order/purchase", {
            "serviceCode": self.service_code,
            "countryId": self.country_id,
            "quantity": 1,
            "price": self._current_price,
        })

        if resp.get("code") != 0:
            msg = resp.get("message", "")
            log.warning("nexsms purchase failed: %s", msg)
            return None, None

        data = resp.get("data", {})
        phones = data.get("phoneNumbers", [])
        if not phones:
            log.warning("nexsms: purchase returned no numbers")
            return None, None

        phone_raw = str(phones[0])
        phone = phone_raw if phone_raw.startswith("+") else f"+{phone_raw}"
        cost = data.get("totalAmount", self._current_price)
        log.info("nexsms getNumber: %s (cost %.4f)", phone, float(cost))
        self._rented[phone] = time.time()
        return phone, phone

    def escalate_price(self) -> bool:
        if not self._tiers:
            self._tiers = self._load_tiers()
        if not self._tiers:
            return False
        cap = self.max_price if self.max_price > 0 else self._tiers[-1]
        for price in self._tiers:
            if price > self._current_price and price <= cap:
                log.info("nexsms: escalating price %.4f -> %.4f", self._current_price, price)
                self._current_price = price
                return True
        log.warning("nexsms: max price %.4f reached, cannot escalate further", cap)
        return False

    def wait_code(self, order_id: str, timeout: int = 120) -> Optional[str]:
        phone = order_id.lstrip("+")
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                resp = self._get("/sms/messages", {
                    "phoneNumber": phone,
                    "format": "json_latest",
                })
            except Exception:
                time.sleep(5)
                continue

            if resp.get("code") != 0:
                time.sleep(5)
                continue

            data = resp.get("data")
            if data and isinstance(data, dict):
                code = data.get("code", "")
                if code and code not in self._used_codes:
                    self._used_codes.add(code)
                    return code
                if code:
                    log.debug("nexsms: code %s already used, waiting for new one", code)

            time.sleep(5)
        return None

    def request_another(self, order_id: str) -> bool:
        return True

    def cancel(self, order_id: str) -> None:
        phone = order_id.lstrip("+")
        try:
            resp = self._post("/close/activation", {"phoneNumber": phone})
            if resp.get("code") == 0:
                self._rented.pop(order_id, None)
                log.info("nexsms cancelled %s", phone)
            else:
                log.debug("nexsms cancel %s: %s", phone, resp.get("message"))
        except Exception:
            pass

    def done(self, order_id: str) -> None:
        self._rented.pop(order_id, None)

    def release_unused(self, keep: Optional[str] = None, max_wait: float = 150) -> None:
        targets = {ph for ph in self._rented if ph != keep}
        if not targets:
            return
        log.info("nexsms: releasing %d unused number(s)...", len(targets))
        deadline = time.time() + max_wait
        while targets and time.time() < deadline:
            for ph in list(targets):
                age = time.time() - self._rented.get(ph, 0)
                if age < 125:
                    continue
                phone_raw = ph.lstrip("+")
                try:
                    resp = self._post("/close/activation", {"phoneNumber": phone_raw})
                    if resp.get("code") == 0:
                        self._rented.pop(ph, None)
                        targets.discard(ph)
                        log.info("nexsms: released %s", phone_raw)
                except Exception:
                    pass
            if targets:
                time.sleep(5)
        if targets:
            log.warning("nexsms: %d number(s) not released (will auto-expire): %s",
                        len(targets), ", ".join(targets))
