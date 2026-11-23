import importlib.util
import sys
import time
import types
import unittest
from pathlib import Path
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
BRIDGE_DIR = ROOT / "bridge"


class ExnessBridgeDemoSafetyTests(unittest.TestCase):
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
        spec = importlib.util.spec_from_file_location("mt5_bridge_demo_under_test", BRIDGE_DIR / "mt5_bridge.py")
        cls.bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.bridge)
        cls.fake_mt5 = fake_mt5
        cls.original_resolve_symbol = cls.bridge.resolve_symbol

    @classmethod
    def tearDownClass(cls):
        sys.path.remove(str(BRIDGE_DIR))
        for name, old in cls.original_modules.items():
            if old is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = old
        sys.modules.pop("mt5_bridge_demo_under_test", None)

    def setUp(self):
        b, m = self.bridge, self.fake_mt5
        b.resolve_symbol = type(self).original_resolve_symbol
        b._LOCKED_LOGIN, b._LOCKED_SERVER = 43210, "ExnessDemoServer"
        b._MT5_PREVIEWS.clear()
        b._MT5_ORDER_REPLIES.clear()
        b._MT5_ORDER_UNCERTAIN = False
        m.ACCOUNT_TRADE_MODE_DEMO = 0
        m.ACCOUNT_TRADE_MODE_REAL = 2
        m.ORDER_TYPE_BUY = 0
        m.ORDER_TYPE_SELL = 1
        m.TRADE_ACTION_DEAL = 1
        m.ORDER_TIME_GTC = 0
        m.ORDER_FILLING_IOC = 1
        m.TRADE_RETCODE_DONE = 10009
        m.TRADE_RETCODE_DONE_PARTIAL = 10010
        m.TRADE_RETCODE_PLACED = 10008
        m.account_info = Mock(return_value=types.SimpleNamespace(
            login=43210, server="ExnessDemoServer", company="Exness (KE) Limited",
            currency="USD", trade_mode=0, equity=1000.0, balance=1000.0,
            margin_free=1000.0, leverage=100
        ))
        m.terminal_info = Mock(return_value=types.SimpleNamespace(connected=True, trade_allowed=True))
        m.symbol_info = Mock(return_value=types.SimpleNamespace(
            name="US30Cash", visible=True, trade_mode=4, volume_min=0.01, volume_max=100.0,
            volume_step=0.01, trade_contract_size=1.0, point=0.01,
            digits=2, trade_stops_level=0, trade_filling_mode=0
        ))
        m.symbol_info_tick = Mock(return_value=types.SimpleNamespace(bid=100.0, ask=100.0, time=int(time.time())))
        m.symbols_get = Mock(return_value=[])
        m.symbol_select = Mock(return_value=True)
        m.positions_get = Mock(return_value=[])
        m.history_deals_get = Mock(return_value=[])
        m.order_calc_profit = Mock(side_effect=lambda action, _symbol, volume, open_price, close_price:
                                   (close_price - open_price) * volume * (1 if action == m.ORDER_TYPE_BUY else -1))
        m.order_calc_margin = Mock(return_value=10.0)
        m.order_send = Mock(return_value=types.SimpleNamespace(
            retcode=m.TRADE_RETCODE_DONE, order=9001, price=100.0, comment="done"
        ))
        m.PositionClose = Mock(side_effect=AssertionError("demo app close must remain unavailable"))

    def demo_request(self, **overrides):
        request = {"environment": "demo", "symbol": "EURUSD", "side": "BUY", "volume": 100.0, "sl": 99.9, "tp": 100.3}
        request.update(overrides)
        return request

    def test_broker_order_placement_is_disabled_for_demo_and_real_without_mt5_calls(self):
        self.assertFalse(self.bridge.MT5_MANUAL_ORDER_EXECUTION_ENABLED)
        for environment in ("demo", "real"):
            request = self.demo_request(environment=environment)
            preview = self.bridge.handle_order_preview(request)
            order = self.bridge.handle_order({
                **request, "preview_id": "a-valid-but-unusable-preview-id",
                "intent_id": "disabledIntent123456", "confirmed": True,
            })
            self.assertEqual(preview["type"], "error")
            self.assertIn("order placement is disabled", preview["message"])
            self.assertEqual(order["type"], "error")
            self.assertIn("order execution is disabled", order["message"])
        close = self.bridge.handle_close({"ticket": 123})
        self.assertEqual(close["type"], "error")
        self.assertIn("closing is disabled", close["message"])
        self.fake_mt5.account_info.assert_not_called()
        self.fake_mt5.terminal_info.assert_not_called()
        self.fake_mt5.order_send.assert_not_called()
        self.fake_mt5.PositionClose.assert_not_called()

    def test_m15_history_is_read_only_and_uses_mt5_tick_volume(self):
        self.fake_mt5.TIMEFRAME_M1 = 1
        self.fake_mt5.TIMEFRAME_M5 = 5
        self.fake_mt5.TIMEFRAME_M15 = 15
        self.fake_mt5.TIMEFRAME_H1 = 60
        self.bridge.resolve_symbol = lambda _requested: "US30Cash"
        rows = [{"time": 1_800_000_000 + i * 900, "open": 100.0, "high": 101.0,
                 "low": 99.0, "close": 100.5, "tick_volume": 123} for i in range(60)]
        self.fake_mt5.copy_rates_from_pos = Mock(return_value=rows)
        reply = self.bridge.handle_history({"symbol": "US30", "timeframe": "M15", "count": 250})
        self.assertEqual(reply["type"], "history")
        self.fake_mt5.copy_rates_from_pos.assert_called_once_with("US30Cash", 15, 0, 250)
        self.assertEqual(reply["candles"][0]["volume"], 123)
        self.fake_mt5.order_send.assert_not_called()

    def test_mt5_symbol_mapping_resolves_unique_suffix_prefix_and_visible_aliases(self):
        info = types.SimpleNamespace(name="XAUUSDm", visible=True, volume_min=0.01)
        self.fake_mt5.symbols_get.return_value = [types.SimpleNamespace(name="XAUUSDm")]
        self.fake_mt5.symbol_info.side_effect = lambda name: info if name == "XAUUSDm" else None
        self.fake_mt5.symbol_select.return_value = True
        self.assertEqual(self.bridge.resolve_symbol("XAU/USD"), "XAUUSDm")
        self.assertEqual(self.bridge.resolve_symbol("XAUUSDm"), "XAUUSDm")

        prefixed = types.SimpleNamespace(name="mEURUSD", visible=False)
        self.fake_mt5.symbols_get.return_value = [types.SimpleNamespace(name="mEURUSD")]
        self.fake_mt5.symbol_info.side_effect = lambda name: prefixed if name == "mEURUSD" else None
        self.assertEqual(self.bridge.resolve_symbol("EURUSD"), "mEURUSD")

        primary = types.SimpleNamespace(name="XAUUSDm", visible=True)
        alternate = types.SimpleNamespace(name="XAUUSD.pro", visible=False)
        self.fake_mt5.symbols_get.return_value = [types.SimpleNamespace(name="XAUUSDm"), types.SimpleNamespace(name="XAUUSD.pro")]
        self.fake_mt5.symbol_info.side_effect = lambda name: {"XAUUSDm": primary, "XAUUSD.pro": alternate}.get(name)
        self.assertEqual(self.bridge.resolve_symbol("XAUUSD"), "XAUUSDm")

    def test_mt5_symbol_mapping_fails_closed_when_multiple_visible_variants(self):
        infos = {
            "XAUUSDm": types.SimpleNamespace(name="XAUUSDm", visible=True),
            "XAUUSD.pro": types.SimpleNamespace(name="XAUUSD.pro", visible=True),
        }
        self.fake_mt5.symbols_get.return_value = [types.SimpleNamespace(name=name) for name in infos]
        self.fake_mt5.symbol_info.side_effect = lambda name: infos.get(name)
        reply = self.bridge.handle_history({"symbol": "XAUUSD", "timeframe": "M1"})
        self.assertEqual(reply["type"], "error")
        self.assertIn("matches multiple broker symbols", reply["message"])
        self.assertIn("XAUUSDm", reply["message"])
        self.assertIn("XAUUSD.pro", reply["message"])
        self.fake_mt5.order_send.assert_not_called()

    def test_exact_server_identity_and_quote_fields_remain_read_only(self):
        self.bridge._LOCKED_LOGIN = None
        self.bridge._LOCKED_SERVER = None
        self.assertIsNotNone(self.bridge._locked_identity_error())
        self.bridge._LOCKED_LOGIN = 43210
        self.bridge._LOCKED_SERVER = "ExnessDemoServer"
        self.fake_mt5.account_info.return_value.login = 99999
        self.assertIsNotNone(self.bridge._locked_identity_error())
        self.fake_mt5.account_info.return_value.login = 43210

        self.bridge.resolve_symbol = Mock(return_value="US30Cash")
        self.fake_mt5.symbol_info_tick.return_value = types.SimpleNamespace(bid=40000.0, ask=40001.0, time=int(time.time()))
        self.fake_mt5.symbol_info.return_value = types.SimpleNamespace(
            volume_min=0.1, volume_max=50.0, volume_step=0.1, trade_contract_size=1.0,
            currency_base="USD", currency_profit="USD", trade_mode=4, digits=2
        )
        reply = self.bridge.handle_quote({"symbols": ["US30"]})
        self.assertEqual(reply["type"], "quotes")
        quote = reply["quotes"][0]
        self.assertEqual(quote["trade_mode"], 4)
        self.assertEqual(quote["volume_min"], 0.1)
        self.assertEqual(quote["volume_step"], 0.1)
        self.assertEqual(quote["contract_size"], 1.0)
        self.assertEqual(quote["currency_profit"], "USD")


if __name__ == "__main__":
    unittest.main()
