import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
BRIDGE_DIR = ROOT / "bridge"


class ExnessBridgeReadOnlyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original_modules = {name: sys.modules.get(name) for name in ("MetaTrader5", "websockets")}
        sys.path.insert(0, str(BRIDGE_DIR))

        fake_mt5 = types.ModuleType("MetaTrader5")
        fake_websockets = types.ModuleType("websockets")
        fake_websockets.exceptions = types.SimpleNamespace(
            ConnectionClosed=type("ConnectionClosed", (Exception,), {})
        )
        sys.modules["MetaTrader5"] = fake_mt5
        sys.modules["websockets"] = fake_websockets

        spec = importlib.util.spec_from_file_location(
            "mt5_bridge_readonly_under_test", BRIDGE_DIR / "mt5_bridge.py"
        )
        cls.bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.bridge)
        cls.fake_mt5 = fake_mt5

    @classmethod
    def tearDownClass(cls):
        sys.path.remove(str(BRIDGE_DIR))
        for name, old in cls.original_modules.items():
            if old is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = old
        sys.modules.pop("mt5_bridge_readonly_under_test", None)

    def test_order_and_close_are_refused_before_mt5_calls(self):
        self.fake_mt5.order_send = Mock(side_effect=AssertionError("must not send"))
        self.fake_mt5.PositionClose = Mock(side_effect=AssertionError("must not close"))

        order = self.bridge.handle_order({"symbol": "US30", "side": "BUY", "volume": 1})
        close = self.bridge.handle_close({"ticket": 123})

        self.assertEqual(order["type"], "error")
        self.assertIn("disabled in this local verification build", order["message"])
        self.assertIn("no order was sent", order["message"])
        self.assertEqual(close["type"], "error")
        self.assertIn("disabled in this local verification build", close["message"])
        self.assertIn("no close was sent", close["message"])
        self.fake_mt5.order_send.assert_not_called()
        self.fake_mt5.PositionClose.assert_not_called()

    def test_exact_server_required_before_terminal_access(self):
        self.fake_mt5.terminal_info = Mock(side_effect=AssertionError("must not attach"))
        reply = self.bridge.handle_login({"login": 123456, "password": "local-only"})
        self.assertEqual(reply["type"], "error")
        self.assertIn("exact Exness MT5 server is required", reply["message"])
        self.fake_mt5.terminal_info.assert_not_called()

    def test_unbound_bridge_identity_fails_closed(self):
        self.bridge._LOCKED_LOGIN = None
        self.bridge._LOCKED_SERVER = None
        self.assertIsNotNone(self.bridge._locked_identity_error())

    def test_index_symbol_suffix_must_be_unique_in_connected_terminal(self):
        self.fake_mt5.symbol_info = Mock(return_value=None)
        self.fake_mt5.symbols_get = Mock(return_value=[
            types.SimpleNamespace(name="US30Cash"),
            types.SimpleNamespace(name="US30m"),
        ])
        self.assertIsNone(self.bridge.resolve_symbol("US30"))
        self.fake_mt5.symbols_get.return_value = [types.SimpleNamespace(name="US30Cash")]
        self.fake_mt5.symbol_info.side_effect = lambda name: types.SimpleNamespace(visible=True) if name == "US30Cash" else None
        self.assertEqual(self.bridge.resolve_symbol("US30"), "US30Cash")

    def test_quote_includes_terminal_trade_mode_for_truthful_index_status(self):
        self.bridge._LOCKED_LOGIN = 43210
        self.bridge._LOCKED_SERVER = "ExnessRealServer"
        self.fake_mt5.account_info = Mock(return_value=types.SimpleNamespace(
            login=43210, server="ExnessRealServer", company="Exness (KE) Limited"
        ))
        self.bridge.resolve_symbol = Mock(return_value="US30Cash")
        self.fake_mt5.symbol_info_tick = Mock(return_value=types.SimpleNamespace(bid=40000.0, ask=40001.0, time=1770000000))
        self.fake_mt5.symbol_info = Mock(return_value=types.SimpleNamespace(volume_min=0.1, trade_contract_size=1.0, trade_mode=4, digits=2))
        reply = self.bridge.handle_quote({"symbols": ["US30"]})
        self.assertEqual(reply["type"], "quotes")
        self.assertEqual(reply["quotes"][0]["trade_mode"], 4)
        self.assertEqual(reply["quotes"][0]["time"], 1770000000)
        self.assertEqual(reply["quotes"][0]["digits"], 2)

    def test_locked_identity_rejects_account_or_server_switch(self):
        self.bridge._LOCKED_LOGIN = 43210
        self.bridge._LOCKED_SERVER = "ExnessRealServer"
        self.fake_mt5.account_info = Mock(return_value=types.SimpleNamespace(
            login=99999, server="ExnessRealServer", company="Exness (KE) Limited"
        ))
        self.assertIsNotNone(self.bridge._locked_identity_error())
        self.fake_mt5.account_info.return_value = types.SimpleNamespace(
            login=43210, server="OtherServer", company="Exness (KE) Limited"
        )
        self.assertIsNotNone(self.bridge._locked_identity_error())


if __name__ == "__main__":
    unittest.main()
