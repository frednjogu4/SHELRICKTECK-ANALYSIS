import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "bridge"))
from localapiauth import api_proxy_authorized


class LocalApiAuthTests(unittest.TestCase):
    def test_disabled_gate_preserves_legacy_bridge_mode(self):
        self.assertTrue(api_proxy_authorized("", "", "192.168.1.23"))

    def test_loopback_browser_can_use_local_api_without_reentering_token(self):
        self.assertTrue(api_proxy_authorized("local-secret", "", "127.0.0.1"))
        self.assertTrue(api_proxy_authorized("local-secret", "", "::1"))

    def test_lan_client_requires_exact_token(self):
        self.assertTrue(api_proxy_authorized("local-secret", "local-secret", "192.168.1.23"))
        self.assertFalse(api_proxy_authorized("local-secret", "", "192.168.1.23"))
        self.assertFalse(api_proxy_authorized("local-secret", "wrong-secret", "192.168.1.23"))

    def test_non_loopback_address_does_not_bypass(self):
        self.assertFalse(api_proxy_authorized("local-secret", "", "8.8.8.8"))


if __name__ == "__main__":
    unittest.main()
