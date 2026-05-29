import unittest
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from checkout_link import extract_midtrans_url


class TestMidtransExtract(unittest.TestCase):
    def test_extracts_v3_redirection_url(self):
        text = 'foo https://app.midtrans.com/snap/v3/redirection/8a7b6c5d-1234-4abc-9def-0123456789ab?lang=en bar'
        self.assertEqual(
            extract_midtrans_url(text),
            'https://app.midtrans.com/snap/v3/redirection/8a7b6c5d-1234-4abc-9def-0123456789ab',
        )

    def test_extracts_v4_redirection_url(self):
        text = '"redirect":"https://app.midtrans.com/snap/v4/redirection/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"'
        self.assertEqual(
            extract_midtrans_url(text),
            'https://app.midtrans.com/snap/v4/redirection/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        )

    def test_returns_empty_when_absent(self):
        self.assertEqual(extract_midtrans_url('no midtrans here, only https://pay.openai.com/c/pay/cs_live_x'), '')


if __name__ == '__main__':
    unittest.main()
