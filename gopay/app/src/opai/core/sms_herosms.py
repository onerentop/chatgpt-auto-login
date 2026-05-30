# app/src/opai/core/sms_herosms.py
"""Hero-SMS provider implementation."""
from __future__ import annotations

import json as _json
import logging
import re
import time
from typing import Optional

import tls_client

from .sms_provider import SmsProvider

log = logging.getLogger(__name__)

HEROSMS_API = "https://hero-sms.com"
SMS_TIMEOUT = 120


class HeroSmsProvider(SmsProvider):

    def __init__(self, api_key: str, service_code: str = "ni", country_code: int = 6, max_price: float = 0):
        self.api_key = api_key
        self.service_code = service_code
        self.country_code = country_code
        self.max_price = max_price
        self._used_codes: set[str] = set()
        self._current_price: float = 0
        self._tiers: list[float] = []
        self._rented: dict[str, float] = {}

    def _api(self, action: str, params: dict | None = None, retries: int = 3) -> str:
        p = {"api_key": self.api_key, "action": action}
        if params:
            p.update(params)
        for i in range(1, retries + 1):
            try:
                s = tls_client.Session(client_identifier="chrome_120")
                r = s.get(f"{HEROSMS_API}/stubs/handler_api.php", params=p, timeout_seconds=30)
                return r.text.strip()
            except Exception as e:
                log.debug("herosms _api attempt %d: %s", i, e)
                if i < retries:
                    time.sleep(3)
        raise RuntimeError(f"herosms {action} failed after {retries} retries")

    def _api_json(self, action: str, params: dict | None = None, retries: int = 3) -> dict:
        p = {"api_key": self.api_key, "action": action}
        if params:
            p.update(params)
        for i in range(1, retries + 1):
            try:
                s = tls_client.Session(client_identifier="chrome_120")
                r = s.get(f"{HEROSMS_API}/stubs/handler_api.php", params=p, timeout_seconds=30)
                return r.json()
            except Exception as e:
                log.debug("herosms _api_json attempt %d: %s", i, e)
                if i < retries:
                    time.sleep(3)
        return {}

    def _load_tiers(self) -> list[float]:
        data = self._api_json("getPrices", {
            "service": self.service_code,
            "country": str(self.country_code),
        })
        country_key = str(self.country_code)
        if isinstance(data, dict) and country_key in data:
            service_data = data[country_key].get(self.service_code, {})
            if isinstance(service_data, dict) and "cost" in service_data:
                return [float(service_data["cost"])]
        if isinstance(data, list):
            for entry in data:
                if isinstance(entry, dict) and country_key in entry:
                    service_data = entry[country_key].get(self.service_code, {})
                    if isinstance(service_data, dict) and "cost" in service_data:
                        return [float(service_data["cost"])]
        offers = self._api_json("getTopCountriesByService", {"service": self.service_code, "freePrice": "true"})
        if isinstance(offers, dict):
            for key, item in offers.items():
                if isinstance(item, dict) and item.get("country") == self.country_code:
                    price_map = item.get("physicalPriceMap", {})
                    if isinstance(price_map, dict):
                        return sorted(float(p) for p in price_map.keys())
        if isinstance(offers, list):
            for item in offers:
                if isinstance(item, dict) and item.get("country") == self.country_code:
                    price_map = item.get("physicalPriceMap", {})
                    if isinstance(price_map, dict):
                        return sorted(float(p) for p in price_map.keys())
        return []

    def get_number(self) -> tuple[Optional[str], Optional[str]]:
        params = {"service": self.service_code, "country": str(self.country_code)}
        if self._current_price > 0:
            params["maxPrice"] = str(self._current_price)
        resp = self._api("getNumber", params)
        log.info("getNumber: %s", resp)
        if resp.startswith("ACCESS_NUMBER:"):
            parts = resp.split(":")
            aid = parts[1]
            phone = f"+{parts[2]}"
            self._rented[aid] = time.time()
            return phone, aid
        if resp.startswith("WRONG_MAX_PRICE:"):
            min_price = resp.split(":", 1)[1]
            log.info("herosms: min price for this location is %s", min_price)
        log.warning("getNumber failed: %s", resp)
        return None, None

    def escalate_price(self) -> bool:
        if not self._tiers:
            self._tiers = self._load_tiers()
        if not self._tiers:
            return False
        cap = self.max_price if self.max_price > 0 else self._tiers[-1]
        for price in self._tiers:
            if price > self._current_price and price <= cap:
                log.info("herosms: escalating price %.4f -> %.4f", self._current_price, price)
                self._current_price = price
                return True
        log.warning("herosms: max price %.4f reached, cannot escalate further", cap)
        return False

    def wait_code(self, order_id: str, timeout: int = SMS_TIMEOUT) -> Optional[str]:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                resp = self._api("getStatus", {"id": order_id})
            except Exception:
                time.sleep(5)
                continue
            if resp.startswith("STATUS_OK:"):
                raw = resp.split(":", 1)[1]
                m = re.search(r"\b(\d{4,6})\b", raw)
                code = m.group(1) if m else raw
                if code not in self._used_codes:
                    self._used_codes.add(code)
                    return code
                log.debug("herosms: code %s already used, waiting for new one", code)
            if resp == "STATUS_CANCEL":
                log.warning("SMS activation cancelled")
                return None
            time.sleep(5)
        return None

    def request_another(self, order_id: str) -> bool:
        try:
            resp = self._api("setStatus", {"id": order_id, "status": "3"})
            log.info("request_another: %s", resp)
            return "ACCESS_RETRY_GET" in resp
        except Exception:
            return False

    def cancel(self, order_id: str) -> None:
        try:
            resp = self._api("setStatus", {"id": order_id, "status": "8"})
            if "ACCESS_CANCEL" in resp:
                self._rented.pop(order_id, None)
                log.info("herosms cancelled order %s", order_id)
            else:
                log.debug("herosms cancel %s: %s", order_id, resp)
        except Exception:
            pass

    def done(self, order_id: str) -> None:
        try:
            self._api("setStatus", {"id": order_id, "status": "6"})
            self._rented.pop(order_id, None)
        except Exception:
            pass

    def reactivate(self, order_id: str) -> Optional[str]:
        try:
            s = tls_client.Session(client_identifier="chrome_120")
            r = s.post(f"{HEROSMS_API}/stubs/handler_api.php", params={
                "api_key": self.api_key, "action": "reactivate", "id": order_id,
            }, timeout_seconds=15)
            log.info("[reactivate] aid=%s -> %d: %s", order_id, r.status_code, r.text[:200])
            if r.status_code == 200:
                data = r.json()
                new_aid = str(data.get("activationId", ""))
                if new_aid:
                    self._rented[new_aid] = time.time()
                    self._rented.pop(order_id, None)
                    return new_aid
            return None
        except Exception as e:
            log.warning("[reactivate] aid=%s failed: %s", order_id, e)
            return None

    def release_unused(self, keep: Optional[str] = None, max_wait: float = 150) -> None:
        targets = {oid for oid in self._rented if oid != keep}
        if not targets:
            return
        log.info("herosms: releasing %d unused order(s)...", len(targets))
        deadline = time.time() + max_wait
        while targets and time.time() < deadline:
            for oid in list(targets):
                age = time.time() - self._rented.get(oid, 0)
                if age < 125:
                    continue
                try:
                    resp = self._api("setStatus", {"id": oid, "status": "8"})
                    if "ACCESS_CANCEL" in resp:
                        self._rented.pop(oid, None)
                        targets.discard(oid)
                        log.info("herosms: released order %s", oid)
                except Exception:
                    pass
            if targets:
                time.sleep(5)
        if targets:
            log.warning("herosms: %d order(s) not released (will auto-expire): %s",
                        len(targets), ", ".join(targets))
