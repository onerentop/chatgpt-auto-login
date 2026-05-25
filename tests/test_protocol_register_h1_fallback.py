import unittest
from unittest.mock import MagicMock
import sys
import os
import types

# Stub curl_cffi BEFORE importing protocol_register so module-level HTTP11 is set
# to a sentinel object instead of None. Test cases identify HTTP/1.1 retries by
# matching this sentinel in the http_version kwarg.
HTTP11_SENTINEL = 'HTTP11_SENTINEL'
fake_curl_cffi = types.ModuleType('curl_cffi')
fake_curl_cffi.CurlHttpVersion = types.SimpleNamespace(V1_1=HTTP11_SENTINEL)
fake_curl_cffi.requests = types.SimpleNamespace(Session=MagicMock)
sys.modules.setdefault('curl_cffi', fake_curl_cffi)

# Also stub the vendored chatgpt_register package — protocol_register imports
# build_sentinel_token / get_sentinel_token_browser at module load time.
fake_chatgpt_register = types.ModuleType('chatgpt_register')
fake_cr_inner = types.ModuleType('chatgpt_register.chatgpt_register')
fake_cr_inner.build_sentinel_token = lambda *a, **kw: ''
fake_sb_inner = types.ModuleType('chatgpt_register.sentinel_browser')
fake_sb_inner.get_sentinel_token_browser = lambda *a, **kw: ''
fake_otp_inner = types.ModuleType('chatgpt_register.otp')
fake_otp_inner.fetch_imap_otp = lambda *a, **kw: None
fake_otp_inner.get_imap_baseline = lambda *a, **kw: 0
sys.modules.setdefault('chatgpt_register', fake_chatgpt_register)
sys.modules.setdefault('chatgpt_register.chatgpt_register', fake_cr_inner)
sys.modules.setdefault('chatgpt_register.sentinel_browser', fake_sb_inner)
sys.modules.setdefault('chatgpt_register.otp', fake_otp_inner)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import protocol_register
# Silence _log so test output isn't polluted by JSON log lines.
protocol_register._log = lambda msg: None
from protocol_register import _post_with_h1_fallback


class H1FallbackTest(unittest.TestCase):
    def test_h2_success_no_retry(self):
        # HTTP/2 returns 200 → no retry, return as-is
        resp = MagicMock(status_code=200, text='{"ok":true}')
        session = MagicMock()
        session.post.return_value = resp
        out = _post_with_h1_fallback(session, 'https://x/y', json={'a': 1})
        self.assertEqual(out, resp)
        self.assertEqual(session.post.call_count, 1)
        self.assertNotIn('http_version', session.post.call_args.kwargs)

    def test_h2_400_invalid_r_retries_h1(self):
        # HTTP/2 returns 400 with 'invalid_r' → retry with HTTP/1.1
        resp_h2 = MagicMock(status_code=400, text='{"error":{"type":"invalid_request"}}')
        resp_h1 = MagicMock(status_code=200, text='{"ok":true}')
        session = MagicMock()
        session.post.side_effect = [resp_h2, resp_h1]
        out = _post_with_h1_fallback(session, 'https://x/y', json={'a': 1})
        self.assertEqual(out, resp_h1)
        self.assertEqual(session.post.call_count, 2)
        self.assertEqual(session.post.call_args_list[1].kwargs.get('http_version'), HTTP11_SENTINEL)

    def test_h2_raises_retries_h1(self):
        # HTTP/2 raises TLS/curl exception → retry with HTTP/1.1
        resp_h1 = MagicMock(status_code=200, text='{"ok":true}')
        session = MagicMock()
        session.post.side_effect = [Exception('curl: TLS error'), resp_h1]
        out = _post_with_h1_fallback(session, 'https://x/y', json={'a': 1})
        self.assertEqual(out, resp_h1)
        self.assertEqual(session.post.call_count, 2)
        self.assertEqual(session.post.call_args_list[1].kwargs.get('http_version'), HTTP11_SENTINEL)

    def test_h2_400_other_error_no_retry(self):
        # 400 but body doesn't contain 'invalid_r' → no retry, return as-is
        resp = MagicMock(status_code=400, text='{"error":{"type":"too_many_requests"}}')
        session = MagicMock()
        session.post.return_value = resp
        out = _post_with_h1_fallback(session, 'https://x/y', json={'a': 1})
        self.assertEqual(out, resp)
        self.assertEqual(session.post.call_count, 1)


if __name__ == '__main__':
    unittest.main()
