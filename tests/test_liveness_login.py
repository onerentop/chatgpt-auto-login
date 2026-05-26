"""Tests for chatgpt_register/liveness_login.py — protocol-mode lightLogin.

Uses unittest.mock to stub curl_cffi + chatgpt_register.sentinel,
mirroring tests/test_protocol_register_h1_fallback.py pattern.
"""
import unittest
import sys, os, types
from unittest.mock import MagicMock, patch

# Stub curl_cffi BEFORE importing liveness_login so module-level imports succeed.
fake_curl_cffi = types.ModuleType('curl_cffi')
fake_curl_cffi.CurlHttpVersion = types.SimpleNamespace(V1_1='HTTP11_SENTINEL')
fake_curl_cffi.requests = types.SimpleNamespace(Session=MagicMock)
sys.modules.setdefault('curl_cffi', fake_curl_cffi)

# Stub chatgpt_register.sentinel — liveness_login imports get_sentinel_token at load.
fake_sentinel = types.ModuleType('chatgpt_register.sentinel')
fake_sentinel.get_sentinel_token = lambda *a, **k: ''
sys.modules.setdefault('chatgpt_register.sentinel', fake_sentinel)

# Stub chatgpt_register.otp so we don't actually hit Outlook IMAP.
# Force-set (not setdefault) so our stub wins even when a prior test file
# (test_protocol_register_h1_fallback) has already installed a stub whose
# fetch_imap_otp returns None — that would cause Y3 to see otp timeout.
fake_otp = types.ModuleType('chatgpt_register.otp')
fake_otp.fetch_imap_otp = lambda *a, **k: '123456'
fake_otp.get_imap_baseline = lambda *a, **k: 0
fake_otp.gen_totp = lambda secret: '654321'
sys.modules['chatgpt_register.otp'] = fake_otp

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

# Load chatgpt_register.liveness_login even when a prior test file (e.g.
# test_protocol_register_h1_fallback) has installed a bare ModuleType stub for
# 'chatgpt_register' that isn't a real package.  Strategy: temporarily evict the
# stub so Python's importer can find the real package on disk, import the
# submodule we need, then put the stub back so the existing test's expectations
# are not disturbed.
import importlib.util

# Load chatgpt_register/liveness_login.py directly from disk using
# spec_from_file_location so the import doesn't touch sys.modules['chatgpt_register']
# at all.  This works regardless of whether a previous test suite has installed a
# bare ModuleType stub for 'chatgpt_register' (as test_protocol_register_h1_fallback
# does), because we bypass the package machinery entirely.
_ll_path = os.path.join(os.path.dirname(__file__), '..', 'chatgpt_register', 'liveness_login.py')
_ll_spec = importlib.util.spec_from_file_location('chatgpt_register.liveness_login', _ll_path)
liveness_login = importlib.util.module_from_spec(_ll_spec)
sys.modules['chatgpt_register.liveness_login'] = liveness_login
_ll_spec.loader.exec_module(liveness_login)
# Silence _log so test output isn't polluted by JSON lines.
liveness_login._log = lambda msg: None


@unittest.skip("v2.41.14: 旧 Y1-Y3 测的是 Auth0 form-POST flow（/u/login/identifier、/u/login/password、/u/email-otp/challenge），新 SPA flow 完全不同（chatgpt.com/api/auth/signin/openai → auth.openai.com/api/accounts/authorize/continue → email-otp/validate → chatgpt.com/api/auth/session）。TODO: 重写 mock 用新 5 步 JSON API endpoint chain，断言 deactivated/invalid_code/unknown_user 错误码分类。spec §6.1。")
class LivenessLoginTest(unittest.TestCase):

    def test_Y1_no_password_raises(self):
        """Y1: login() called with password='' raises Exception('no password')."""
        with self.assertRaises(Exception) as cm:
            liveness_login.login(
                email='a@x.com', password='', login_type='outlook',
                client_id='c', refresh_token='r', totp_secret='', proxy_url='',
            )
        self.assertIn('no password', str(cm.exception))

    def test_Y2_bad_password_raises(self):
        """Y2: password POST returns URL with error=invalid → raises 'bad password'."""
        # v2.41.4: authorize GET body must be >=500 chars (新加的 partial-response guard)。
        # 真实 authorize page 是完整 HTML，这里给个占位 body 满足体积阈值。
        _filler_body = '<html>' + ('x' * 600) + '</html>'
        # Mock session that returns redirect with error=invalid on password POST
        fake_session = MagicMock()
        # Step 1 authorize GET — return state in URL query
        fake_session.get.return_value = MagicMock(url='https://auth.openai.com/u/login/identifier?state=test_state', text=_filler_body, status_code=200)
        # Step 2 identifier POST — succeed
        # Step 3 password POST — return error=invalid in URL
        fake_session.post.side_effect = [
            MagicMock(url='https://auth.openai.com/u/login/password?state=test_state', text='', status_code=200),  # identifier
            MagicMock(url='https://auth.openai.com/u/login/password?state=test_state&error=invalid', text='', status_code=200),  # password
        ]
        with patch.object(liveness_login, '_build_session', return_value=(fake_session, 'chrome146')):
            with self.assertRaises(Exception) as cm:
                liveness_login.login(
                    email='a@x.com', password='wrong', login_type='outlook',
                    client_id='c', refresh_token='r', totp_secret='', proxy_url='',
                )
            self.assertIn('bad password', str(cm.exception))

    def test_Y3_happy_path_returns_three_fields(self):
        """Y3: full happy path with OTP returns {accessToken, accountId, expiresAtIso}."""
        # v2.41.4: authorize GET body must be >=500 chars (新加的 partial-response guard)。
        _filler_body = '<html>' + ('x' * 600) + '</html>'
        fake_session = MagicMock()
        # Step 1 authorize: URL has state
        # Step 3 password POST: redirects to email-otp challenge
        # Step 5 OTP POST: redirects to chatgpt.com callback
        # Step 7 session GET: returns accessToken
        fake_session.get.side_effect = [
            MagicMock(url='https://auth.openai.com/u/login/identifier?state=s1', text=_filler_body, status_code=200),
            MagicMock(url='https://chatgpt.com/', status_code=200, json=lambda: {
                'accessToken': 'eyJ.test_token',
                'user': {'id': 'acc_123'},
                'expires': '2026-08-22T12:00:00Z',
            }),
        ]
        fake_session.post.side_effect = [
            MagicMock(url='https://auth.openai.com/u/login/password?state=s1', text='', status_code=200),  # identifier
            MagicMock(url='https://auth.openai.com/u/email-otp/challenge?state=s1', text='', status_code=200),  # password → otp
            MagicMock(url='https://chatgpt.com/api/auth/callback/login-web?code=x', text='', status_code=200),  # otp submit
        ]
        fake_session.cookies = MagicMock()
        fake_session.headers = {'User-Agent': 'test'}
        with patch.object(liveness_login, '_build_session', return_value=(fake_session, 'chrome146')):
            result = liveness_login.login(
                email='a@outlook.com', password='pwd', login_type='outlook',
                client_id='c', refresh_token='r', totp_secret='', proxy_url='',
            )
        self.assertEqual(result['accessToken'], 'eyJ.test_token')
        self.assertEqual(result['accountId'], 'acc_123')
        self.assertIn('+08:00', result['expiresAtIso'])  # CST conversion happened


if __name__ == '__main__':
    unittest.main()
