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
        b._LOCKED_LOGIN, b._LOCKED_SERVER = 43210, "ExnessDemoServer"
        b._DEMO_PREVIEWS.clear()
        b._DEMO_ORDER_REPLIES.clear()
        b._DEMO_ORDER_UNCERTAIN = False
        b.DEMO_ORDER_EXECUTION_ENABLED = True
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
            visible=True, trade_mode=4, volume_min=0.01, volume_max=100.0,
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
        request = {"symbol": "EURUSD", "side": "BUY", "volume": 100.0, "sl": 99.9, "tp": 100.3}
        request.update(overrides)
        return request

    def test_unconfirmed_order_and_app_close_are_refused_without_execution_calls(self):
        order = self.bridge.handle_order(self.demo_request())
        close = self.bridge.handle_close({"ticket": 123})
        self.assertEqual(order["type"], "error")
        self.assertIn("Explicit confirmation is required", order["message"])
        self.assertEqual(close["type"], "error")
        self.assertIn("cannot close positions", close["message"])
        self.fake_mt5.order_send.assert_not_called()
        self.fake_mt5.PositionClose.assert_not_called()

    def test_live_account_is_rejected_before_preview_or_order_send(self):
        self.fake_mt5.account_info.return_value.trade_mode = self.fake_mt5.ACCOUNT_TRADE_MODE_REAL
        preview = self.bridge.handle_demo_preview(self.demo_request())
        self.assertEqual(preview["type"], "error")
        self.assertIn("demo-only", preview["message"])
        self.fake_mt5.order_send.assert_not_called()

    def test_missing_mt5_demo_mode_constant_fails_closed(self):
        del self.fake_mt5.ACCOUNT_TRADE_MODE_DEMO
        preview = self.bridge.handle_demo_preview(self.demo_request())
        self.assertEqual(preview["type"], "error")
        self.assertIn("demo-only", preview["message"])
        self.assertFalse(self.bridge.handle_account({}).get("demo"))
        self.fake_mt5.order_send.assert_not_called()

    def test_preview_then_manual_confirmation_sends_one_demo_market_order(self):
        request = self.demo_request()
        preview = self.bridge.handle_demo_preview(request)
        self.assertEqual(preview["type"], "order_preview", preview)
        self.assertTrue(preview["manual_only"])
        self.assertLessEqual(preview["risk_pct"], self.bridge.DEMO_MAX_RISK_PCT)
        self.assertGreaterEqual(preview["rr"], self.bridge.DEMO_MIN_REWARD_RISK)
        self.fake_mt5.order_send.assert_not_called()

        order = self.bridge.handle_order({
            **request, "preview_id": preview["preview_id"], "intent_id": "demoIntent1234567890",
            "confirmed": True,
        })
        self.assertEqual(order["type"], "filled", order)
        self.assertTrue(order["demo"])
        self.assertEqual(order["ticket"], 9001)
        self.fake_mt5.order_send.assert_called_once()
        sent = self.fake_mt5.order_send.call_args.args[0]
        self.assertEqual(sent["symbol"], "US30Cash")
        self.assertEqual(sent["sl"], 99.9)
        self.assertEqual(sent["tp"], 100.3)
        self.assertIn("AURUM-DEMO-", sent["comment"])

        # A repeated message with the same unique intent replays the reply, not the order send.
        duplicate = self.bridge.handle_order({
            **request, "preview_id": preview["preview_id"], "intent_id": "demoIntent1234567890",
            "confirmed": True,
        })
        self.assertEqual(duplicate, order)
        self.fake_mt5.order_send.assert_called_once()

    def test_mandatory_stop_target_and_account_caps_fail_closed(self):
        self.assertEqual(self.bridge.handle_demo_preview(self.demo_request(sl=0))["type"], "error")
        self.assertEqual(self.bridge.handle_demo_preview(self.demo_request(tp=0))["type"], "error")
        self.fake_mt5.positions_get.return_value = [types.SimpleNamespace(ticket=1)]
        full = self.bridge.handle_demo_preview(self.demo_request())
        self.assertEqual(full["type"], "error")
        self.assertIn("open positions", full["message"])
        self.fake_mt5.order_send.assert_not_called()

    def test_excessive_risk_daily_loss_stale_quotes_and_missing_history_block(self):
        self.fake_mt5.order_calc_profit.side_effect = lambda action, _symbol, volume, open_price, close_price: -10.0 if close_price < open_price else 10.0
        excessive = self.bridge.handle_demo_preview(self.demo_request())
        self.assertEqual(excessive["type"], "error")
        self.assertIn("caps it at", excessive["message"])

        self.setUp()
        self.fake_mt5.history_deals_get.return_value = [types.SimpleNamespace(profit=-25, commission=0, swap=0, fee=0)]
        daily = self.bridge.handle_demo_preview(self.demo_request())
        self.assertEqual(daily["type"], "error")
        self.assertIn("daily-loss limit", daily["message"])

        self.setUp()
        self.fake_mt5.symbol_info_tick.return_value.time = int(time.time()) - 120
        stale = self.bridge.handle_demo_preview(self.demo_request())
        self.assertEqual(stale["type"], "error")
        self.assertIn("No fresh Exness demo tick", stale["message"])

        self.setUp()
        self.fake_mt5.history_deals_get.return_value = None
        unknown = self.bridge.handle_demo_preview(self.demo_request())
        self.assertEqual(unknown["type"], "error")
        self.assertIn("could not be verified", unknown["message"])
        self.fake_mt5.order_send.assert_not_called()

    def test_partial_or_pending_result_is_uncertain_and_never_retried(self):
        self.fake_mt5.order_send.return_value.retcode = self.fake_mt5.TRADE_RETCODE_DONE_PARTIAL
        preview = self.bridge.handle_demo_preview(self.demo_request())
        result = self.bridge.handle_order({
            **self.demo_request(), "preview_id": preview["preview_id"],
            "intent_id": "partialIntent1234567", "confirmed": True,
        })
        self.assertEqual(result["type"], "error")
        self.assertIn("partial or pending", result["message"])
        self.fake_mt5.order_send.assert_called_once()
        duplicate = self.bridge.handle_order({
            **self.demo_request(), "preview_id": preview["preview_id"],
            "intent_id": "partialIntent1234567", "confirmed": True,
        })
        self.assertEqual(duplicate, result)
        self.fake_mt5.order_send.assert_called_once()
        new_preview = self.bridge.handle_demo_preview(self.demo_request())
        blocked = self.bridge.handle_order({
            **self.demo_request(), "preview_id": new_preview["preview_id"],
            "intent_id": "newIntent12345678901", "confirmed": True,
        })
        self.assertEqual(blocked["type"], "error")
        self.assertIn("no further app order will be sent", blocked["message"])
        self.fake_mt5.order_send.assert_called_once()

    def test_preview_cannot_be_changed_or_replayed(self):
        preview = self.bridge.handle_demo_preview(self.demo_request())
        changed = self.bridge.handle_order({
            **self.demo_request(volume=200.0), "preview_id": preview["preview_id"],
            "intent_id": "demoIntent2234567890", "confirmed": True,
        })
        self.assertEqual(changed["type"], "error")
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
        self.fake_mt5.symbol_info.return_value = types.SimpleNamespace(volume_min=0.1, trade_contract_size=1.0, trade_mode=4, digits=2)
        reply = self.bridge.handle_quote({"symbols": ["US30"]})
        self.assertEqual(reply["type"], "quotes")
        self.assertEqual(reply["quotes"][0]["trade_mode"], 4)


if __name__ == "__main__":
    unittest.main()
