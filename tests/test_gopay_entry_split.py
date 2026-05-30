"""Tests for gopay_activate.py register/pay/full mode split.

Uses unittest.mock to avoid real network/SMS calls.
Drive main() by patching sys.stdin and capturing stdout.
"""
import sys
import os
import io
import json
import unittest
from unittest.mock import patch, MagicMock, call

# Make gopay_activate importable without the gopay subpackage being real.
# We stub out the third-party imports before importing the module under test.
_GOPAY_ROOT = os.path.join(os.path.dirname(__file__), '..')

# --- Stub the subpackage symbols gopay_activate imports at module-level ---
_fake_sms_mod = MagicMock()
_fake_gojek_mod = MagicMock()
_fake_payment_mod = MagicMock()
_fake_helpers_mod = MagicMock()
_fake_gc_mod = MagicMock()

# GoPayFraudDenyError must be a real exception class so raise/except works
class _FakeGoPayFraudDenyError(Exception):
    pass

_fake_payment_mod.GoPayPayment = MagicMock()
_fake_payment_mod.GoPayFraudDenyError = _FakeGoPayFraudDenyError

sys.modules.setdefault('opai', MagicMock())
sys.modules.setdefault('opai.core', MagicMock())
sys.modules['opai.core.sms_provider'] = _fake_sms_mod
sys.modules['opai.core.gojek_client'] = _fake_gojek_mod
sys.modules['opai.core.gopay_payment_protocol'] = _fake_payment_mod
sys.modules['opai.core.sms_helpers'] = _fake_helpers_mod

import importlib
sys.path.insert(0, _GOPAY_ROOT)
import gopay_activate as ga

# Patch the module-level GoPayFraudDenyError to our real exception class
ga.GoPayFraudDenyError = _FakeGoPayFraudDenyError


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _stdin(obj):
    return io.StringIO(json.dumps(obj))


def _run_main(stdin_obj):
    """Run ga.main() with given stdin, return list of parsed JSON outputs."""
    captured = io.StringIO()
    with patch('sys.stdin', stdin_obj), patch('sys.stdout', captured):
        ga.main()
    output = captured.getvalue()
    results = []
    for line in output.strip().split('\n'):
        line = line.strip()
        if line:
            try:
                results.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return results


def _make_account_dict():
    return {"local": "81234567890", "aid": "aid-001", "phone": "+6281234567890"}


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

class TestRegisterMode(unittest.TestCase):
    """mode='register': only _do_register runs; phase3/5 NOT called."""

    def _base_patches(self):
        return {
            '_load_config': patch.object(ga, '_load_config', return_value={
                'gopay': {'defaultPin': '123456', 'smsProvider': 'smsbower'},
                'phonePool': {'smsbower': {'apiKey': 'k'}},
            }),
            'create_sms_provider': patch.object(ga, 'create_sms_provider', return_value=MagicMock()),
            '_make_proxy': patch.object(ga, '_make_proxy', return_value='http://proxy:1234'),
            '_register_one': patch.object(ga, '_register_one', return_value=_make_account_dict()),
            '_phase3_stripe': patch.object(ga, '_phase3_stripe', return_value='https://midtrans/snap/xxx'),
            '_phase5_pay': patch.object(ga, '_phase5_pay', return_value={'success': True, 'transaction_status': 'settlement'}),
            '_rotate_ip': patch.object(ga, '_rotate_ip', return_value=True),
        }

    def test_register_success_emits_registered_not_pay_phases(self):
        """Successful register: final emit is 'registered'; phase3/5 never called."""
        patches = self._base_patches()
        with patches['_load_config'], patches['create_sms_provider'], \
             patches['_make_proxy'], \
             patches['_register_one'] as mock_reg, \
             patches['_phase3_stripe'] as mock_p3, \
             patches['_phase5_pay'] as mock_p5, \
             patches['_rotate_ip']:

            results = _run_main(_stdin({'mode': 'register', 'pin': '123456'}))

        # Only one final result line (the registered emit)
        final = [r for r in results if 'status' in r]
        self.assertEqual(len(final), 1)
        self.assertEqual(final[0]['status'], 'registered')
        self.assertIn('account', final[0])
        self.assertIn('proxy', final[0])
        self.assertIn('phone', final[0])

        # Phase 3 and Phase 5 MUST NOT have been called
        mock_p3.assert_not_called()
        mock_p5.assert_not_called()

        # _register_one was called (via _do_register)
        mock_reg.assert_called()

    def test_register_all_fail_emits_gopay_reg_fail(self):
        """All 20 attempts return None → emit gopay_reg_fail."""
        patches = self._base_patches()
        # _register_one always returns None (number not usable)
        patches['_register_one'] = patch.object(ga, '_register_one', return_value=None)

        with patches['_load_config'], patches['create_sms_provider'], \
             patches['_make_proxy'], \
             patches['_register_one'] as mock_reg, \
             patches['_phase3_stripe'] as mock_p3, \
             patches['_phase5_pay'] as mock_p5, \
             patches['_rotate_ip'], \
             patch('time.sleep'):  # avoid 20×3s real sleep in unit test

            results = _run_main(_stdin({'mode': 'register', 'pin': '123456'}))

        final = [r for r in results if 'status' in r]
        self.assertEqual(len(final), 1)
        self.assertEqual(final[0]['status'], 'gopay_reg_fail')

        mock_p3.assert_not_called()
        mock_p5.assert_not_called()
        # Should have attempted 20 times
        self.assertEqual(mock_reg.call_count, 20)

    def test_register_account_fields_in_emit(self):
        """Emitted account dict contains local, aid, phone."""
        patches = self._base_patches()
        with patches['_load_config'], patches['create_sms_provider'], \
             patches['_make_proxy'], patches['_register_one'], \
             patches['_phase3_stripe'], patches['_phase5_pay'], patches['_rotate_ip']:

            results = _run_main(_stdin({'mode': 'register'}))

        final = [r for r in results if r.get('status') == 'registered']
        self.assertEqual(len(final), 1)
        acc = final[0]['account']
        self.assertIn('local', acc)
        self.assertIn('aid', acc)
        self.assertIn('phone', acc)


class TestPayMode(unittest.TestCase):
    """mode='pay': phase3 then phase5 back-to-back; account/proxy from stdin."""

    def _base_patches(self, p3_return='https://midtrans/snap/yyy',
                      p5_return=None):
        if p5_return is None:
            p5_return = {'success': True, 'transaction_status': 'settlement'}
        return {
            '_load_config': patch.object(ga, '_load_config', return_value={
                'gopay': {'defaultPin': '123456', 'smsProvider': 'smsbower'},
                'phonePool': {'smsbower': {'apiKey': 'k'}},
            }),
            'create_sms_provider': patch.object(ga, 'create_sms_provider', return_value=MagicMock()),
            '_make_proxy': patch.object(ga, '_make_proxy', return_value='http://proxy:1234'),
            '_register_one': patch.object(ga, '_register_one', return_value=_make_account_dict()),
            '_phase3_stripe': patch.object(ga, '_phase3_stripe', return_value=p3_return),
            '_phase5_pay': patch.object(ga, '_phase5_pay', return_value=p5_return),
            '_rotate_ip': patch.object(ga, '_rotate_ip', return_value=True),
        }

    def test_pay_calls_phase3_then_phase5_in_order(self):
        """phase3 is called BEFORE phase5 (back-to-back order enforced)."""
        call_order = []
        patches = self._base_patches()

        def _p3(access_token, proxy):
            call_order.append('phase3')
            return 'https://midtrans/snap/yyy'

        def _p5(account, pin, midtrans_url, provider, proxy):
            call_order.append('phase5')
            return {'success': True, 'transaction_status': 'settlement'}

        patches['_phase3_stripe'] = patch.object(ga, '_phase3_stripe', side_effect=_p3)
        patches['_phase5_pay'] = patch.object(ga, '_phase5_pay', side_effect=_p5)

        inp = {
            'mode': 'pay',
            'access_token': 'tok_test',
            'account': _make_account_dict(),
            'proxy': 'http://proxy:9090',
        }
        with patches['_load_config'], patches['create_sms_provider'], \
             patches['_make_proxy'], patches['_register_one'], \
             patches['_phase3_stripe'], patches['_phase5_pay'], patches['_rotate_ip']:

            results = _run_main(_stdin(inp))

        self.assertEqual(call_order, ['phase3', 'phase5'],
                         "phase3 must run immediately before phase5 (TTL constraint)")

        final = [r for r in results if 'status' in r]
        self.assertEqual(final[0]['status'], 'success')

    def test_pay_uses_provided_account_and_proxy(self):
        """account and proxy from stdin are passed to _phase5_pay."""
        received = {}
        patches = self._base_patches()

        def _p5(account, pin, midtrans_url, provider, proxy):
            received['account'] = account
            received['proxy'] = proxy
            return {'success': True, 'transaction_status': 'settlement'}

        patches['_phase5_pay'] = patch.object(ga, '_phase5_pay', side_effect=_p5)

        inp = {
            'mode': 'pay',
            'access_token': 'tok_test',
            'account': _make_account_dict(),
            'proxy': 'http://special-proxy:7777',
        }
        with patches['_load_config'], patches['create_sms_provider'], \
             patches['_make_proxy'], patches['_register_one'], \
             patches['_phase3_stripe'], patches['_phase5_pay'], patches['_rotate_ip']:

            _run_main(_stdin(inp))

        self.assertEqual(received['account']['phone'], '+6281234567890')
        self.assertEqual(received['proxy'], 'http://special-proxy:7777')

    def test_pay_fail_emits_gopay_pay_fail(self):
        """_phase5_pay returning non-success → emit gopay_pay_fail."""
        patches = self._base_patches(
            p5_return={'success': False, 'detail': 'charge failed', 'transaction_status': 'deny'}
        )
        inp = {
            'mode': 'pay',
            'access_token': 'tok_test',
            'account': _make_account_dict(),
            'proxy': '',
        }
        with patches['_load_config'], patches['create_sms_provider'], \
             patches['_make_proxy'], patches['_register_one'], \
             patches['_phase3_stripe'], patches['_phase5_pay'], patches['_rotate_ip']:

            results = _run_main(_stdin(inp))

        final = [r for r in results if 'status' in r]
        self.assertEqual(final[0]['status'], 'gopay_pay_fail')
        self.assertEqual(final[0]['detail'], 'charge failed')

    def test_pay_with_midtrans_url_skips_phase3(self):
        """midtrans_url provided in stdin → _phase3_stripe NOT called."""
        patches = self._base_patches()

        inp = {
            'mode': 'pay',
            'access_token': 'tok_test',
            'midtrans_url': 'https://midtrans/snap/already-have',
            'account': _make_account_dict(),
            'proxy': '',
        }
        with patches['_load_config'], patches['create_sms_provider'], \
             patches['_make_proxy'], patches['_register_one'], \
             patches['_phase3_stripe'] as mock_p3, \
             patches['_phase5_pay'] as mock_p5, patches['_rotate_ip']:

            results = _run_main(_stdin(inp))

        mock_p3.assert_not_called()
        mock_p5.assert_called_once()
        # The url passed to phase5 should be the one from stdin
        call_args = mock_p5.call_args
        self.assertIn('https://midtrans/snap/already-have', call_args.args)

        final = [r for r in results if 'status' in r]
        self.assertEqual(final[0]['status'], 'success')

    def test_pay_gopay_fraud_deny_error_emits_gopay_fraud(self):
        """GoPayFraudDenyError in _phase5_pay → emit gopay_fraud."""
        patches = self._base_patches()

        def _p5_fraud(*args, **kwargs):
            raise _FakeGoPayFraudDenyError("antifraud block")

        patches['_phase5_pay'] = patch.object(ga, '_phase5_pay', side_effect=_p5_fraud)

        inp = {
            'mode': 'pay',
            'access_token': 'tok_test',
            'account': _make_account_dict(),
            'proxy': '',
        }
        with patches['_load_config'], patches['create_sms_provider'], \
             patches['_make_proxy'], patches['_register_one'], \
             patches['_phase3_stripe'], patches['_phase5_pay'], patches['_rotate_ip']:

            results = _run_main(_stdin(inp))

        final = [r for r in results if 'status' in r]
        self.assertEqual(final[0]['status'], 'gopay_fraud')
        self.assertIn('antifraud block', final[0]['detail'])


class TestFullMode(unittest.TestCase):
    """mode='full' (or absent): register THEN phase3 THEN phase5; same as old main()."""

    def _base_patches(self, p5_return=None):
        if p5_return is None:
            p5_return = {'success': True, 'transaction_status': 'settlement'}
        return {
            '_load_config': patch.object(ga, '_load_config', return_value={
                'gopay': {'defaultPin': '123456', 'smsProvider': 'smsbower'},
                'phonePool': {'smsbower': {'apiKey': 'k'}},
            }),
            'create_sms_provider': patch.object(ga, 'create_sms_provider', return_value=MagicMock()),
            '_make_proxy': patch.object(ga, '_make_proxy', return_value='http://proxy:1234'),
            '_register_one': patch.object(ga, '_register_one', return_value=_make_account_dict()),
            '_phase3_stripe': patch.object(ga, '_phase3_stripe', return_value='https://midtrans/snap/zzz'),
            '_phase5_pay': patch.object(ga, '_phase5_pay', return_value=p5_return),
            '_rotate_ip': patch.object(ga, '_rotate_ip', return_value=True),
        }

    def test_full_mode_success(self):
        """full mode: register → phase3 → phase5, success emit."""
        call_order = []

        def _reg(*a, **kw):
            call_order.append('register')
            return _make_account_dict()

        def _p3(*a, **kw):
            call_order.append('phase3')
            return 'https://midtrans/snap/zzz'

        def _p5(*a, **kw):
            call_order.append('phase5')
            return {'success': True, 'transaction_status': 'settlement'}

        patches = self._base_patches()
        patches['_register_one'] = patch.object(ga, '_register_one', side_effect=_reg)
        patches['_phase3_stripe'] = patch.object(ga, '_phase3_stripe', side_effect=_p3)
        patches['_phase5_pay'] = patch.object(ga, '_phase5_pay', side_effect=_p5)

        inp = {'mode': 'full', 'access_token': 'tok_full'}
        with patches['_load_config'], patches['create_sms_provider'], \
             patches['_make_proxy'], patches['_register_one'], \
             patches['_phase3_stripe'], patches['_phase5_pay'], patches['_rotate_ip']:

            results = _run_main(_stdin(inp))

        self.assertEqual(call_order, ['register', 'phase3', 'phase5'])

        final = [r for r in results if 'status' in r]
        self.assertEqual(final[0]['status'], 'success')

    def test_full_mode_default_when_mode_absent(self):
        """No mode key → defaults to full mode (backward compat)."""
        patches = self._base_patches()

        inp = {'access_token': 'tok_no_mode'}
        with patches['_load_config'], patches['create_sms_provider'], \
             patches['_make_proxy'], patches['_register_one'], \
             patches['_phase3_stripe'] as mock_p3, \
             patches['_phase5_pay'] as mock_p5, patches['_rotate_ip']:

            results = _run_main(_stdin(inp))

        # Both phases should have run
        mock_p3.assert_called_once()
        mock_p5.assert_called_once()

        final = [r for r in results if 'status' in r]
        self.assertEqual(final[0]['status'], 'success')

    def test_full_mode_fraud_deny_emits_gopay_fraud(self):
        """GoPayFraudDenyError in full mode → gopay_fraud."""
        patches = self._base_patches()

        def _p5_fraud(*args, **kwargs):
            raise _FakeGoPayFraudDenyError("fraud full mode")

        patches['_phase5_pay'] = patch.object(ga, '_phase5_pay', side_effect=_p5_fraud)

        inp = {'mode': 'full', 'access_token': 'tok_fraud'}
        with patches['_load_config'], patches['create_sms_provider'], \
             patches['_make_proxy'], patches['_register_one'], \
             patches['_phase3_stripe'], patches['_phase5_pay'], patches['_rotate_ip']:

            results = _run_main(_stdin(inp))

        final = [r for r in results if 'status' in r]
        self.assertEqual(final[0]['status'], 'gopay_fraud')

    def test_full_mode_exception_emits_gopay_reg_fail(self):
        """Unexpected Exception in full mode → gopay_reg_fail."""
        patches = self._base_patches()

        def _p5_ex(*args, **kwargs):
            raise RuntimeError("unexpected error")

        patches['_phase5_pay'] = patch.object(ga, '_phase5_pay', side_effect=_p5_ex)

        inp = {'mode': 'full', 'access_token': 'tok_ex'}
        with patches['_load_config'], patches['create_sms_provider'], \
             patches['_make_proxy'], patches['_register_one'], \
             patches['_phase3_stripe'], patches['_phase5_pay'], patches['_rotate_ip']:

            results = _run_main(_stdin(inp))

        final = [r for r in results if 'status' in r]
        self.assertEqual(final[0]['status'], 'gopay_reg_fail')


if __name__ == '__main__':
    unittest.main()
