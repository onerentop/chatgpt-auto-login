"""OTP helpers — IMAP for Outlook, TOTP for Gmail.

Extracted from protocol_register.py for reuse across the register flow
and the new liveness_login flow. fetch_imap_otp / get_imap_baseline
bodies are byte-for-byte copies of the originals; only added `log=None`
callback parameter to decouple from protocol_register._log.
"""
import os
import time
import re
import imaplib
import socket
import email as email_lib
from contextlib import contextmanager
from urllib.parse import urlencode

try:
    import socks  # PySocks
    _HAS_SOCKS = True
except ImportError:
    _HAS_SOCKS = False


@contextmanager
def _imap_socket_proxy():
    """Monkey-patch socket.socket 路由 IMAP 流量到 sing-box HTTP CONNECT（或
    SOCKS5）代理，with 块结束后还原，避免污染 curl_cffi 等其他模块的 socket。

    通过 env LIVENESS_IMAP_PROXY 控制：
      - unset / 空 → 直连（保留旧行为）
      - http://host:port → HTTP CONNECT tunnel
      - socks5://host:port → SOCKS5
      - socks4://host:port → SOCKS4
    默认 http://127.0.0.1:7890（sing-box mixed 端口）。
    """
    proxy_url = os.environ.get("LIVENESS_IMAP_PROXY", "http://127.0.0.1:7890")
    if not proxy_url or not _HAS_SOCKS:
        yield
        return
    from urllib.parse import urlparse
    p = urlparse(proxy_url)
    if p.scheme in ("http", "https"):
        ptype = socks.HTTP
    elif p.scheme.startswith("socks5"):
        ptype = socks.SOCKS5
    elif p.scheme == "socks4":
        ptype = socks.SOCKS4
    else:
        yield
        return
    host = p.hostname or "127.0.0.1"
    port = p.port or 7890
    orig_socket = socket.socket
    socks.set_default_proxy(ptype, host, port)
    socket.socket = socks.socksocket
    try:
        yield
    finally:
        socket.socket = orig_socket
        socks.set_default_proxy()  # 清掉 default 避免污染其他模块


def fetch_imap_otp(email_addr, client_id, refresh_token, baseline_uid, timeout=90, log=None):
    """Poll Outlook IMAP for OTP code after baseline_uid.

    Returns 6-digit code as string, or None on timeout / parse fail.
    `log` is an optional callback `(str) -> None` for progress messages.
    """
    if log is None:
        log = lambda _m: None
    token_body = urlencode({"client_id": client_id, "grant_type": "refresh_token",
        "refresh_token": refresh_token, "scope": "https://outlook.office.com/IMAP.AccessAsUser.All"})
    from curl_cffi import requests as curl_requests
    r = curl_requests.post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
        headers={"Content-Type": "application/x-www-form-urlencoded"}, data=token_body, timeout=15)
    imap_token = r.json().get("access_token")
    if not imap_token:
        return None

    start = time.time()
    for attempt in range(30):
        if time.time() - start > timeout:
            break
        imap = None
        with _imap_socket_proxy():
            try:
                imap = imaplib.IMAP4_SSL("outlook.office365.com", 993, timeout=15)
                auth_str = f"user={email_addr}\x01auth=Bearer {imap_token}\x01\x01"
                imap.authenticate("XOAUTH2", lambda x: auth_str.encode())
                imap.select("INBOX")
                _, msgs = imap.search(None, f"UID {baseline_uid + 1}:*")
                new_uids = [u for u in msgs[0].split() if int(u) > baseline_uid]
                for uid in reversed(new_uids):
                    _, data = imap.fetch(uid, "(BODY[])")
                    raw = data[0][1]
                    msg = email_lib.message_from_bytes(raw)
                    subject = str(msg.get("Subject", ""))
                    from_addr = str(msg.get("From", ""))
                    if "openai" in from_addr.lower() or "chatgpt" in subject.lower() or "code" in subject.lower():
                        m = re.search(r"\b(\d{6})\b", subject)
                        if m:
                            return m.group(1)
                        body = ""
                        if msg.is_multipart():
                            for part in msg.walk():
                                if part.get_content_type() == "text/html":
                                    body = part.get_payload(decode=True).decode("utf-8", errors="ignore")
                                    break
                        else:
                            body = msg.get_payload(decode=True).decode("utf-8", errors="ignore")
                        body_clean = re.sub(r"<[^>]+>", " ", body)
                        m = re.search(r"\b(\d{6})\b", body_clean)
                        if m:
                            return m.group(1)
            except Exception as e:
                if attempt == 0:
                    log(f"IMAP poll error: {str(e)[:50]}")
            finally:
                if imap:
                    try:
                        imap.logout()
                    except Exception:
                        pass
        time.sleep(3)
    return None


def get_imap_baseline(email_addr, client_id, refresh_token):
    """Get current max UID from Outlook IMAP."""
    try:
        token_body = urlencode({"client_id": client_id, "grant_type": "refresh_token",
            "refresh_token": refresh_token, "scope": "https://outlook.office.com/IMAP.AccessAsUser.All"})
        from curl_cffi import requests as curl_requests
        r = curl_requests.post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
            headers={"Content-Type": "application/x-www-form-urlencoded"}, data=token_body, timeout=15)
        imap_token = r.json().get("access_token")
        if not imap_token:
            return 0
        with _imap_socket_proxy():
            imap = imaplib.IMAP4_SSL("outlook.office365.com", 993, timeout=15)
            auth_str = f"user={email_addr}\x01auth=Bearer {imap_token}\x01\x01"
            imap.authenticate("XOAUTH2", lambda x: auth_str.encode())
            imap.select("INBOX")
            _, msgs = imap.search(None, "ALL")
            uids = msgs[0].split()
            baseline = int(uids[-1]) if uids else 0
            imap.logout()
            return baseline
    except Exception:
        return 0


def gen_totp(secret):
    """Generate current 6-digit TOTP from Gmail TOTP base32 secret.
    Lazy imports pyotp (new dependency). Returns string '123456'.
    """
    import pyotp
    return pyotp.TOTP(secret).now()
