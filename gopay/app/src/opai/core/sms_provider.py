"""SMS provider abstraction — switchable backends for phone rental and OTP."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Optional

from . import config as cfg


class SmsProvider(ABC):
    """Common interface for all SMS/OTP providers."""

    @abstractmethod
    def get_number(self) -> tuple[Optional[str], Optional[str]]:
        """Rent a phone number. Return (phone_with_country_code, order_id) or (None, None)."""

    @abstractmethod
    def wait_code(self, order_id: str, timeout: int = 120) -> Optional[str]:
        """Poll for OTP code. Return digits-only string or None on timeout."""

    @abstractmethod
    def request_another(self, order_id: str) -> bool:
        """Request SMS resend. Return True on success."""

    @abstractmethod
    def cancel(self, order_id: str) -> None:
        """Cancel the order. Silent on failure."""

    @abstractmethod
    def done(self, order_id: str) -> None:
        """Mark order as finished. Silent on failure."""

    def reactivate(self, order_id: str) -> Optional[str]:
        """Reactivate an expiring number. Return new order_id or None. Optional."""
        return None

    def escalate_price(self) -> bool:
        """Move to next price tier. Return False if not supported or at max."""
        return False

    def release_unused(self, keep: Optional[str] = None, max_wait: float = 150) -> None:
        """Cancel all rented-but-unused orders to refund. Default no-op."""
        return None


def create_sms_provider(
    provider_name: str = "",
    api_key: str = "",
) -> SmsProvider:
    """Factory: instantiate the correct SMS provider from name + key."""
    name = (provider_name or cfg.get("sms", "provider", "smscloud")).lower().strip()

    if name == "smscloud":
        from .sms_cloud import SmsCloudProvider
        key = api_key or cfg.get("sms.smscloud", "api_key")
        service_code = cfg.get("sms.smscloud", "service_code", "ni")
        country_code = int(cfg.get("sms.smscloud", "country_code", 6))
        max_price = float(cfg.get("sms.smscloud", "max_price", 0))
        return SmsCloudProvider(api_key=key, service_code=service_code, country_code=country_code, max_price=max_price)

    if name == "smsbower":
        from .sms_bower import SmsBowerProvider
        key = api_key or cfg.get("sms.smsbower", "api_key")
        service_code = cfg.get("sms.smsbower", "service_code", "ni")
        country_code = int(cfg.get("sms.smsbower", "country_code", 6))
        max_price = float(cfg.get("sms.smsbower", "max_price", 0))
        return SmsBowerProvider(api_key=key, service_code=service_code, country_code=country_code, max_price=max_price)

    if name == "nexsms":
        from .sms_nexsms import NexSmsProvider
        key = api_key or cfg.get("sms.nexsms", "api_key")
        service_code = cfg.get("sms.nexsms", "service_code", "ni")
        country_id = int(cfg.get("sms.nexsms", "country_id", 6))
        max_price = float(cfg.get("sms.nexsms", "max_price", 0))
        return NexSmsProvider(api_key=key, service_code=service_code, country_id=country_id, max_price=max_price)

    from .sms_herosms import HeroSmsProvider
    key = api_key or cfg.get("sms.herosms", "api_key")
    service_code = cfg.get("sms.herosms", "service_code", "ni")
    country_code = int(cfg.get("sms.herosms", "country_code", 6))
    max_price = float(cfg.get("sms.herosms", "max_price", 0))
    return HeroSmsProvider(api_key=key, service_code=service_code, country_code=country_code, max_price=max_price)
