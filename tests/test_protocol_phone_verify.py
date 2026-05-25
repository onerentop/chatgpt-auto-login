"""Tests for protocol_phone_verify.py — single-attempt add_phone HTTP flow."""
import io
import json
import sys
import unittest
from unittest.mock import patch, MagicMock


class TestProtocolPhoneVerify(unittest.TestCase):

    def _build_input(self, **overrides):
        base = {
            "session_state": {
                "cookies": [{"name": "oai-did", "value": "abc", "domain": ".openai.com", "path": "/"}],
                "device_id": "device-xyz",
                "user_agent": "Mozilla/5.0 Chrome/120.0",
                "code_verifier": "cv-xxx",
                "code_challenge": "cc-xxx",
                "redirect_uri": "http://localhost:1455/auth/callback",
                "client_id": "app_test",
                "current_url": "https://auth.openai.com/add-phone",
                "authorize_continue_url": "",
            },
            "phone": "+12282351427",
            "sms": {"provider": "local", "url": "https://sms.example.com/abc"},
            "proxy_url": None,
        }
        base.update(overrides)
        return base

    def _run_with_input(self, input_dict, **mock_kwargs):
        """Run protocol_phone_verify.main() with stdin patched and return parsed stdout JSON."""
        import protocol_phone_verify as pv
        with patch("sys.stdin", io.StringIO(json.dumps(input_dict))), \
             patch("sys.stdout", new_callable=io.StringIO) as fake_out:
            for k, v in mock_kwargs.items():
                setattr(pv, k, v) if not k.startswith("_") else None
            pv.main()
        # 取 stdout 最后一行（前面可能有 log JSON）
        last_line = fake_out.getvalue().strip().split("\n")[-1]
        return json.loads(last_line)

    def test_local_full_success(self):
        """phone-start 通过 → SMS 收到 code → validate 通过 → token exchange 成功 → status=ok"""
        import protocol_phone_verify as pv

        # Mock curl_cffi session
        fake_session = MagicMock()
        # phone-start: 200 + continue_url (Phase 0 校准：has_sms_prompt 依据 continue_url 判定)
        phone_start_resp = MagicMock(ok=True, status_code=200, text='{"continue_url":"https://auth.openai.com/add-phone-verify"}')
        phone_start_resp.json.return_value = {"continue_url": "https://auth.openai.com/add-phone-verify", "method": "GET", "page": {"type": "sms_phone_verify"}}
        # phone-validate: 200 + continue_url
        validate_resp = MagicMock(ok=True, status_code=200, text='{"continue_url":"https://auth.openai.com/cont"}')
        validate_resp.json.return_value = {"continue_url": "https://auth.openai.com/cont"}
        fake_session.post.side_effect = [phone_start_resp, validate_resp]
        fake_session.headers = {}
        fake_session.cookies = MagicMock()

        # Mock rebuild_session 返回 fake_session
        # Mock follow_continue_for_auth_code 返回 "test-code"
        # Mock exchange_code 返回 tokens
        # Mock poll_sms 返回 "123456"
        with patch.object(pv, "rebuild_session", return_value=fake_session), \
             patch.object(pv, "follow_continue_for_auth_code", return_value="test-auth-code"), \
             patch.object(pv, "exchange_code", return_value={"access_token": "AT", "refresh_token": "RT", "id_token": "ID"}), \
             patch.object(pv, "poll_sms", return_value="123456"):
            result = self._run_with_input(self._build_input())

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["tokens"], {"access_token": "AT", "refresh_token": "RT", "id_token": "ID"})
        # 验证调用了 2 次 session.post（phone-start + phone-validate）
        self.assertEqual(fake_session.post.call_count, 2)

    def test_zhusms_full_success(self):
        """zhusms provider: 与 local 同样的 add_phone 主流程，SMS 走 zhusms /api/order/status。"""
        import protocol_phone_verify as pv

        fake_session = MagicMock()
        ps_resp = MagicMock(ok=True, status_code=200)
        ps_resp.json.return_value = {"continue_url": "https://auth.openai.com/add-phone-verify", "method": "GET", "page": {"type": "sms_phone_verify"}}
        val_resp = MagicMock(ok=True, status_code=200)
        val_resp.json.return_value = {"continue_url": "https://auth.openai.com/cont"}
        fake_session.post.side_effect = [ps_resp, val_resp]
        fake_session.headers = {}
        fake_session.cookies = MagicMock()

        zhusms_input = self._build_input(sms={
            "provider": "zhusms",
            "order_no": "ord-123",
            "base_url": "https://zhusms.com",
            "card_key": "ZS-X",
            "cookie": "session=abc",
        })

        with patch.object(pv, "rebuild_session", return_value=fake_session), \
             patch.object(pv, "follow_continue_for_auth_code", return_value="code-x"), \
             patch.object(pv, "exchange_code", return_value={"access_token": "AT", "refresh_token": "RT", "id_token": "ID"}), \
             patch.object(pv, "poll_sms", return_value="654321"):
            result = self._run_with_input(zhusms_input)

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["tokens"]["refresh_token"], "RT")

    def test_phone_start_rejected_voip(self):
        """phone-start 返回 voip_phone_disallowed → status=voip-blocked (v2.40.5)。"""
        import protocol_phone_verify as pv

        fake_session = MagicMock()
        reject_resp = MagicMock(ok=False, status_code=400, text='{"error":{"type":"invalid_request_error","code":"voip_phone_disallowed"}}')
        reject_resp.json.return_value = {"error": {"type": "invalid_request_error", "code": "voip_phone_disallowed"}}
        fake_session.post.return_value = reject_resp
        fake_session.headers = {}
        fake_session.cookies = MagicMock()

        with patch.object(pv, "rebuild_session", return_value=fake_session):
            result = self._run_with_input(self._build_input())

        self.assertEqual(result["status"], "voip-blocked")
        self.assertEqual(fake_session.post.call_count, 1)

    def test_phone_validate_path_is_phone_otp(self):
        """v2.40.6 regression: phone-validate endpoint 必须是 /api/accounts/phone-otp/validate。
        之前 v2.40.0 smoke 实测 /add-phone/validate 返 404 后改成 /phone-otp/validate，
        但临时改动没 commit，多次 hotfix git checkout 时被还原成占位。本测试 grep 源码防回归。"""
        import re as _re
        src = open('protocol_phone_verify.py', 'r', encoding='utf-8').read()
        m = _re.search(r'PHONE_VALIDATE_PATH\s*=\s*["\']([^"\']+)["\']', src)
        self.assertIsNotNone(m, 'PHONE_VALIDATE_PATH 常量丢失')
        self.assertEqual(m.group(1), '/api/accounts/phone-otp/validate',
                         'PHONE_VALIDATE_PATH 错路径（应该是 phone-otp/validate）')

    def test_phone_start_rejected_unknown(self):
        """phone-start 返回未知 error.code → status=phone-rejected（保守 retry）。"""
        import protocol_phone_verify as pv

        fake_session = MagicMock()
        reject_resp = MagicMock(ok=False, status_code=400, text='{"error":{"type":"invalid_request_error","code":"phone_send_failed"}}')
        reject_resp.json.return_value = {"error": {"type": "invalid_request_error", "code": "phone_send_failed"}}
        fake_session.post.return_value = reject_resp
        fake_session.headers = {}
        fake_session.cookies = MagicMock()

        with patch.object(pv, "rebuild_session", return_value=fake_session):
            result = self._run_with_input(self._build_input())

        self.assertEqual(result["status"], "phone-rejected")
        self.assertEqual(fake_session.post.call_count, 1)

    def test_sms_timeout(self):
        """phone-start 通过但 poll_sms 30 次都没拿到码 → status=sms-timeout。"""
        import protocol_phone_verify as pv

        fake_session = MagicMock()
        ps_resp = MagicMock(ok=True, status_code=200)
        ps_resp.json.return_value = {"continue_url": "https://auth.openai.com/add-phone-verify", "method": "GET", "page": {"type": "sms_phone_verify"}}
        fake_session.post.return_value = ps_resp
        fake_session.headers = {}
        fake_session.cookies = MagicMock()

        with patch.object(pv, "rebuild_session", return_value=fake_session), \
             patch.object(pv, "poll_sms", return_value=None):
            result = self._run_with_input(self._build_input())

        self.assertEqual(result["status"], "sms-timeout")
        # validate 不应被调用
        self.assertEqual(fake_session.post.call_count, 1)

    def test_validate_error(self):
        """phone-validate 返回 4xx → status=validate-error。"""
        import protocol_phone_verify as pv

        fake_session = MagicMock()
        ps_resp = MagicMock(ok=True, status_code=200)
        ps_resp.json.return_value = {"continue_url": "https://auth.openai.com/add-phone-verify", "method": "GET", "page": {"type": "sms_phone_verify"}}
        val_resp = MagicMock(ok=False, status_code=400, text='{"error":"invalid_code"}')
        fake_session.post.side_effect = [ps_resp, val_resp]
        fake_session.headers = {}
        fake_session.cookies = MagicMock()

        with patch.object(pv, "rebuild_session", return_value=fake_session), \
             patch.object(pv, "poll_sms", return_value="123456"):
            result = self._run_with_input(self._build_input())

        self.assertEqual(result["status"], "validate-error")

    def test_post_validate_follow_fail(self):
        """phone-validate 通过 + follow continue 拿不到 code → status=post-validate-error (binding 保留)。"""
        import protocol_phone_verify as pv

        fake_session = MagicMock()
        ps_resp = MagicMock(ok=True, status_code=200)
        ps_resp.json.return_value = {"continue_url": "https://auth.openai.com/add-phone-verify", "method": "GET", "page": {"type": "sms_phone_verify"}}
        val_resp = MagicMock(ok=True, status_code=200)
        val_resp.json.return_value = {"continue_url": "https://auth.openai.com/cont"}
        fake_session.post.side_effect = [ps_resp, val_resp]
        fake_session.headers = {}
        fake_session.cookies = MagicMock()

        with patch.object(pv, "rebuild_session", return_value=fake_session), \
             patch.object(pv, "poll_sms", return_value="123456"), \
             patch.object(pv, "follow_continue_for_auth_code", return_value=None):
            result = self._run_with_input(self._build_input())

        self.assertEqual(result["status"], "post-validate-error")
        self.assertIn("auth_code", result["detail"])

    def test_post_validate_token_exchange_fail(self):
        """validate 通过 + follow ok + token exchange empty → status=post-validate-error (binding 保留)。"""
        import protocol_phone_verify as pv

        fake_session = MagicMock()
        ps_resp = MagicMock(ok=True, status_code=200)
        ps_resp.json.return_value = {"continue_url": "https://auth.openai.com/add-phone-verify", "method": "GET", "page": {"type": "sms_phone_verify"}}
        val_resp = MagicMock(ok=True, status_code=200)
        val_resp.json.return_value = {"continue_url": "https://auth.openai.com/cont"}
        fake_session.post.side_effect = [ps_resp, val_resp]
        fake_session.headers = {}
        fake_session.cookies = MagicMock()

        with patch.object(pv, "rebuild_session", return_value=fake_session), \
             patch.object(pv, "poll_sms", return_value="123456"), \
             patch.object(pv, "follow_continue_for_auth_code", return_value="code-x"), \
             patch.object(pv, "exchange_code", return_value={}):
            result = self._run_with_input(self._build_input())

        self.assertEqual(result["status"], "post-validate-error")
        self.assertIn("token exchange", result["detail"])

    def test_rebuild_session_injects_cookies_and_ua(self):
        """rebuild_session 注入 cookies + UA + device_id 正确（直接测公共函数）。"""
        import sys
        # 隔离 module-level stub 污染：tests/test_protocol_register_h1_fallback.py:13 在
        # module load 时把 sys.modules['curl_cffi'].requests.Session 改成 MagicMock，
        # 影响后续 _pkce_common.rebuild_session 内 deferred import。本测试需要真实
        # curl_cffi.Session，强制重 import。
        sys.modules.pop('curl_cffi', None)
        sys.modules.pop('curl_cffi.requests', None)
        from _pkce_common import rebuild_session
        ss = {
            "cookies": [
                {"name": "oai-did", "value": "abc", "domain": ".openai.com", "path": "/"},
                {"name": "session", "value": "xyz", "domain": "auth.openai.com", "path": "/"},
            ],
            "user_agent": "Mozilla/5.0 Chrome/130.0 TestAgent",
            "device_id": "dev-zzz",
        }
        s = rebuild_session(ss)
        # UA 注入
        self.assertEqual(s.headers.get("User-Agent"), "Mozilla/5.0 Chrome/130.0 TestAgent")
        # cookies 注入
        cookie_names = set()
        try:
            for c in s.cookies.jar:
                cookie_names.add(c.name)
        except Exception:
            cookie_names = set(s.cookies.keys())
        self.assertIn("oai-did", cookie_names)
        self.assertIn("session", cookie_names)


if __name__ == "__main__":
    unittest.main()
