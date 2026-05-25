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
        # phone-start: 200 + sms prompt
        phone_start_resp = MagicMock(ok=True, status_code=200, text='{"page":{"type":"phone_sms_code"}}')
        phone_start_resp.json.return_value = {"page": {"type": "phone_sms_code"}}
        # phone-validate: 200 + continue_url
        validate_resp = MagicMock(ok=True, status_code=200, text='{"continue_url":"https://auth.openai.com/cont"}')
        validate_resp.json.return_value = {"continue_url": "https://auth.openai.com/cont"}
        fake_session.post.side_effect = [phone_start_resp, validate_resp]
        fake_session.headers = {}
        fake_session.cookies = MagicMock()

        # Mock rebuild_session 返回 fake_session
        # Mock follow_continue_for_auth_code 返回 "test-code"
        # Mock exchange_code 返回 tokens
        # Mock get_sentinel_token 返回 ""
        # Mock poll_sms 返回 "123456"
        with patch.object(pv, "rebuild_session", return_value=fake_session), \
             patch.object(pv, "get_sentinel_token", return_value="sentinel-tok"), \
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
        ps_resp.json.return_value = {"page": {"type": "phone_sms_code"}}
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
             patch.object(pv, "get_sentinel_token", return_value=""), \
             patch.object(pv, "follow_continue_for_auth_code", return_value="code-x"), \
             patch.object(pv, "exchange_code", return_value={"access_token": "AT", "refresh_token": "RT", "id_token": "ID"}), \
             patch.object(pv, "poll_sms", return_value="654321"):
            result = self._run_with_input(zhusms_input)

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["tokens"]["refresh_token"], "RT")

    def test_phone_start_rejected(self):
        """phone-start 返回 4xx → status=phone-rejected。"""
        import protocol_phone_verify as pv

        fake_session = MagicMock()
        reject_resp = MagicMock(ok=False, status_code=400, text='{"error":"phone_send_failed"}')
        reject_resp.json.return_value = {"error": "phone_send_failed"}
        fake_session.post.return_value = reject_resp
        fake_session.headers = {}
        fake_session.cookies = MagicMock()

        with patch.object(pv, "rebuild_session", return_value=fake_session), \
             patch.object(pv, "get_sentinel_token", return_value=""):
            result = self._run_with_input(self._build_input())

        self.assertEqual(result["status"], "phone-rejected")
        self.assertIn("400", result["detail"])
        # phone-validate 不应被调用
        self.assertEqual(fake_session.post.call_count, 1)

    def test_sms_timeout(self):
        """phone-start 通过但 poll_sms 30 次都没拿到码 → status=sms-timeout。"""
        import protocol_phone_verify as pv

        fake_session = MagicMock()
        ps_resp = MagicMock(ok=True, status_code=200)
        ps_resp.json.return_value = {"page": {"type": "phone_sms_code"}}
        fake_session.post.return_value = ps_resp
        fake_session.headers = {}
        fake_session.cookies = MagicMock()

        with patch.object(pv, "rebuild_session", return_value=fake_session), \
             patch.object(pv, "get_sentinel_token", return_value=""), \
             patch.object(pv, "poll_sms", return_value=None):
            result = self._run_with_input(self._build_input())

        self.assertEqual(result["status"], "sms-timeout")
        # validate 不应被调用
        self.assertEqual(fake_session.post.call_count, 1)


if __name__ == "__main__":
    unittest.main()
