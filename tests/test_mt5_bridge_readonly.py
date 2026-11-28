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
        b._MT5_CLOSE_REPLIES.clear()
        b._MT5_ORDER_UNCERTAIN = False
        b.MT5_MANUAL_ORDER_EXECUTION_ENABLED = True
        b.MT5_MANUAL_CLOSE_ENABLED = True
        m.ACCOUNT_TRADE_MODE_DEMO = 0
        m.ACCOUNT_TRADE_MODE_REAL = 2
        m.POSITION_TYPE_BUY = 0
        m.POSITION_TYPE_SELL = 1
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

    def test_unconfirmed_order_and_app_close_are_refused_without_execution_calls(self):
        order = self.bridge.handle_order(self.demo_request())
        close = self.bridge.handle_close({"ticket": 123})
        self.assertEqual(order["type"], "error")
        self.assertIn("Explicit per-order confirmation is required", order["message"])
        self.assertEqual(close["type"], "error")
        self.assertIn("Explicit per-close confirmation is required", close["message"])
        self.fake_mt5.order_send.assert_not_called()
        self.fake_mt5.PositionClose.assert_not_called()

    def test_direct_one_click_real_and_demo_orders_execute_with_optional_sl_tp_and_mode_verification(self):
        # REAL 1-click order without SL/TP succeeds when MT5 account is verified REAL
        self.fake_mt5.account_info.return_value.trade_mode = self.fake_mt5.ACCOUNT_TRADE_MODE_REAL
        direct_real = self.bridge.handle_order({
            "environment": "real", "symbol": "EURUSD", "side": "BUY", "volume": 100.0,
            "sl": 0, "tp": 0, "direct": True, "confirmed": True,
            "intent_id": "oneClickReal12345678",
        })
        self.assertEqual(direct_real["type"], "filled", direct_real)
        self.assertTrue(direct_real["direct"])
        self.assertEqual(direct_real["environment"], "real")
        self.assertFalse(direct_real["demo"])
        self.fake_mt5.order_send.assert_called_once()
        sent = self.fake_mt5.order_send.call_args.args[0]
        self.assertEqual(sent["sl"], 0.0)
        self.assertEqual(sent["tp"], 0.0)
        self.assertIn("AURUM-1C-REAL-", sent["comment"])

        # Replay of same intent_id returns cached fill without resending
        replay = self.bridge.handle_order({
            "environment": "real", "symbol": "EURUSD", "side": "BUY", "volume": 100.0,
            "sl": 0, "tp": 0, "direct": True, "confirmed": True,
            "intent_id": "oneClickReal12345678",
        })
        self.assertEqual(replay, direct_real)
        self.fake_mt5.order_send.assert_called_once()

        # Wrong account mode (requesting demo on a REAL terminal) is rejected without sending
        wrong_mode = self.bridge.handle_order({
            "environment": "demo", "symbol": "EURUSD", "side": "BUY", "volume": 100.0,
            "sl": 0, "tp": 0, "direct": True, "confirmed": True,
            "intent_id": "oneClickWrongMode123",
        })
        self.assertEqual(wrong_mode["type"], "error")
        self.assertIn("Selected account mode does not match", wrong_mode["message"])
        self.fake_mt5.order_send.assert_called_once()

    def test_manual_close_sends_opposite_deal_for_verified_open_position(self):
        self.fake_mt5.account_info.return_value.trade_mode = self.fake_mt5.ACCOUNT_TRADE_MODE_REAL
        self.fake_mt5.positions_get.return_value = [
            types.SimpleNamespace(
                ticket=7788, symbol="US30Cash", type=self.fake_mt5.POSITION_TYPE_BUY,
                volume=0.25, price_open=99.5, profit=12.5, sl=98.0, tp=102.0
            )
        ]
        self.fake_mt5.symbol_info_tick.return_value = types.SimpleNamespace(bid=100.2, ask=100.4, time=int(time.time()))
        self.fake_mt5.order_send.return_value = types.SimpleNamespace(
            retcode=self.fake_mt5.TRADE_RETCODE_DONE, order=9902, deal=5502, price=100.2, comment="closed"
        )
        closed = self.bridge.handle_close({
            "ticket": 7788, "environment": "real", "confirmed": True,
            "intent_id": "closeRealPos12345678",
        })
        self.assertEqual(closed["type"], "closed", closed)
        self.assertEqual(closed["ticket"], 7788)
        self.assertEqual(closed["environment"], "real")
        self.assertFalse(closed["demo"])
        self.assertEqual(closed["price"], 100.2)
        self.fake_mt5.order_send.assert_called_once()
        close_req = self.fake_mt5.order_send.call_args.args[0]
        self.assertEqual(close_req["position"], 7788)
        self.assertEqual(close_req["type"], self.fake_mt5.ORDER_TYPE_SELL)
        self.assertEqual(close_req["volume"], 0.25)

        # Duplicate close intent replays without sending twice
        dup = self.bridge.handle_close({
            "ticket": 7788, "environment": "real", "confirmed": True,
            "intent_id": "closeRealPos12345678",
        })
        self.assertEqual(dup, closed)
        self.fake_mt5.order_send.assert_called_once()

    def test_wrong_explicit_mode_is_rejected_before_preview_or_order_send(self):
        self.fake_mt5.account_info.return_value.trade_mode = self.fake_mt5.ACCOUNT_TRADE_MODE_REAL
        preview = self.bridge.handle_order_preview(self.demo_request())
        self.assertEqual(preview["type"], "error")
        self.assertIn("Selected account mode does not match", preview["message"])
        missing_mode = self.bridge.handle_order_preview({key: value for key, value in self.demo_request().items() if key != "environment"})
        self.assertEqual(missing_mode["type"], "error")
        self.assertIn("Select DEMO or REAL explicitly", missing_mode["message"])
        self.fake_mt5.order_send.assert_not_called()

    def test_account_mode_switch_after_preview_refuses_without_send(self):
        self.fake_mt5.account_info.return_value.trade_mode = self.fake_mt5.ACCOUNT_TRADE_MODE_REAL
        request = self.demo_request(environment="real")
        preview = self.bridge.handle_order_preview(request)
        self.assertEqual(preview["type"], "order_preview")
        self.fake_mt5.account_info.return_value.trade_mode = self.fake_mt5.ACCOUNT_TRADE_MODE_DEMO
        order = self.bridge.handle_order({
            **request, "preview_id": preview["preview_id"], "intent_id": "modeSwitch1234567890",
            "confirmed": True,
        })
        self.assertEqual(order["type"], "error")
        self.assertIn("Selected account mode does not match", order["message"])
        self.fake_mt5.order_send.assert_not_called()

    def test_verified_real_account_can_preview_and_send_only_after_explicit_confirmation(self):
        self.fake_mt5.account_info.return_value.trade_mode = self.fake_mt5.ACCOUNT_TRADE_MODE_REAL
        request = self.demo_request(environment="real")
        preview = self.bridge.handle_order_preview(request)
        self.assertEqual(preview["type"], "order_preview", preview)
        self.assertEqual(preview["environment"], "real")
        self.assertFalse(preview["demo"])
        self.assertTrue(preview["manual_only"])
        self.assertLessEqual(preview["risk_pct"], self.bridge.MT5_MAX_RISK_PCT)
        self.fake_mt5.order_send.assert_not_called()

        order = self.bridge.handle_order({
            **request, "preview_id": preview["preview_id"], "intent_id": "realIntent1234567890",
            "confirmed": True,
        })
        self.assertEqual(order["type"], "filled", order)
        self.assertFalse(order["demo"])
        self.assertEqual(order["environment"], "real")
        self.assertEqual(order["ticket"], 9001)
        sent = self.fake_mt5.order_send.call_args.args[0]
        self.assertIn("AURUM-REAL-", sent["comment"])
        self.fake_mt5.order_send.assert_called_once()

    def test_broker_minimum_above_notional_cap_is_exempt_but_risk_guard_still_binds(self):
        # Broker floor (2,000 lots = $200,000 notional) exceeds the $10,000 intent cap
        # ($100 request x1.5 vs $1,000 equity x10); the floor itself is exempt, and the
        # 0.5% buffered-risk guard must still refuse the oversized stop loss.
        self.fake_mt5.symbol_info.return_value.volume_min = 2000.0
        self.fake_mt5.symbol_info.return_value.volume_step = 1.0
        reply = self.bridge.handle_order_preview(self.demo_request(volume=100.0))
        self.assertEqual(reply["type"], "error")
        self.assertNotIn("Broker minimum size", reply["message"])
        self.assertIn("caps it at 0.5%", reply["message"])
        self.assertIn("No order was sent", reply["message"])
        self.fake_mt5.order_send.assert_not_called()

    def test_min_lot_floor_above_notional_cap_previews_at_broker_minimum(self):
        # A $15,000 broker floor above the $10,000 cap previews successfully when the
        # stop keeps the buffered loss inside the 0.5%-of-equity guard.
        info = self.fake_mt5.symbol_info.return_value
        info.volume_min = 150.0
        info.volume_max = 1000.0
        info.volume_step = 1.0
        reply = self.bridge.handle_order_preview(self.demo_request(volume=100.0, sl=99.99, tp=100.3))
        self.assertEqual(reply["type"], "order_preview", reply)
        self.assertEqual(reply["lots"], 150.0)
        self.assertLessEqual(reply["risk_pct"], self.bridge.MT5_MAX_RISK_PCT)
        self.fake_mt5.order_send.assert_not_called()

    def test_preview_and_confirm_preserve_explicit_minimum_lots_for_all_categories(self):
        for symbol, vmin, contract, price in (
            ("EURUSD", 0.01, 100000, 1.1),
            ("XAUUSD", 0.01, 100, 1424.26),
            ("US30Cash", 0.1, 1, 44000),
            ("BTCUSD", 0.001, 1, 90000),
            ("AAPL", 1, 1, 230),
            ("OIL", 0.05, 1000, 70),
        ):
            for side in ("BUY", "SELL"):
                with self.subTest(symbol=symbol, side=side):
                    self.setUp()
                    info = self.fake_mt5.symbol_info.return_value
                    info.name = symbol
                    info.volume_min = info.volume_step = vmin
                    info.trade_contract_size = contract
                    self.fake_mt5.symbol_info_tick.return_value.bid = price
                    self.fake_mt5.symbol_info_tick.return_value.ask = price
                    direction = 1 if side == "BUY" else -1
                    req = self.demo_request(symbol=symbol, side=side, volume=1, lots=vmin,
                                            strict_min_volume=True, sl=price - direction * 0.01,
                                            tp=price + direction * 0.03)
                    preview = self.bridge.handle_order_preview(req)
                    self.assertEqual(preview["type"], "order_preview", preview)
                    self.assertAlmostEqual(preview["lots"], vmin)
                    self.assertAlmostEqual(preview["exposure"], vmin * contract * price)
                    self.fake_mt5.order_send.assert_not_called()
                    # Every confirmation rebuilds the plan using those SAME explicit lots.
                    filled = self.bridge.handle_order({**req, "preview_id": preview["preview_id"],
                        "confirmed": True, "intent_id": "minimumLots1234567890"})
                    self.assertEqual(filled["type"], "filled", filled)
                    self.assertAlmostEqual(self.fake_mt5.order_send.call_args.args[0]["volume"], vmin)

    def test_strict_preview_rejects_undersized_usd_without_silent_minimum_rounding(self):
        self.fake_mt5.symbol_info.return_value.trade_contract_size = 100
        self.fake_mt5.symbol_info_tick.return_value.bid = 1424.26
        self.fake_mt5.symbol_info_tick.return_value.ask = 1424.26
        reply = self.bridge.handle_order_preview(self.demo_request(volume=1, strict_min_volume=True,
            sl=1424, tp=1425))
        self.assertEqual(reply["type"], "error", reply)
        self.assertIn("1,424.26 notional", reply["message"])
        self.fake_mt5.order_send.assert_not_called()

    def test_changed_explicit_lots_after_preview_cannot_execute(self):
        req = self.demo_request(lots=0.01, strict_min_volume=True)
        preview = self.bridge.handle_order_preview(req)
        self.assertEqual(preview["type"], "order_preview", preview)
        reply = self.bridge.handle_order({**req, "lots": 0.02, "preview_id": preview["preview_id"],
            "confirmed": True, "intent_id": "changedLots1234567890"})
        self.assertEqual(reply["type"], "error", reply)
        self.assertIn("changed since preview", reply["message"])
        self.fake_mt5.order_send.assert_not_called()

    def target_position(self):
        return types.SimpleNamespace(ticket=101, symbol="XAUUSD", type=0, volume=0.01,
            price_open=100, price_current=103, profit=3.5, swap=-0.1, sl=95, tp=110)

    def target_close_request(self, **overrides):
        req = {"environment": "demo", "ticket": 101, "confirmed": True,
               "intent_id": "netTargetClose12345678", "net_target_usd": 3.0}
        req.update(overrides)
        return req

    def test_guarded_close_rechecks_current_net_including_costs_before_sending(self):
        pos = self.target_position()
        self.fake_mt5.positions_get.return_value = [pos]
        self.fake_mt5.history_deals_get.return_value = [types.SimpleNamespace(commission=-0.3, fee=0)]
        skipped = self.bridge.handle_close(self.target_close_request(net_target_usd=3.25))
        self.assertEqual(skipped["type"], "close_skipped", skipped)
        self.assertEqual(skipped["reason"], "NET_TARGET_NOT_REACHED")
        self.assertAlmostEqual(skipped["net_profit"], 3.1)
        self.fake_mt5.order_send.assert_not_called()
        # Once the *net*, not the gross, reaches the custom target, submit exactly one close.
        pos.profit = 3.65
        closed = self.bridge.handle_close(self.target_close_request(net_target_usd=3.25))
        self.assertEqual(closed["type"], "closed", closed)
        self.fake_mt5.order_send.assert_called_once()
        self.assertEqual(self.fake_mt5.order_send.call_args.args[0]["position"], 101)
        self.assertEqual(self.bridge.handle_close(self.target_close_request(net_target_usd=3.25)), closed)
        self.fake_mt5.order_send.assert_called_once()

    def test_unknown_costs_cannot_trigger_target_close_or_fabricate_zero_fees(self):
        self.fake_mt5.positions_get.return_value = [self.target_position()]
        self.fake_mt5.history_deals_get.return_value = None
        skipped = self.bridge.handle_close(self.target_close_request())
        self.assertEqual(skipped["type"], "close_skipped", skipped)
        self.assertEqual(skipped["reason"], "NET_PROFIT_UNAVAILABLE")
        positions = self.bridge.handle_positions({})
        self.assertIsNone(positions["list"][0]["net_profit"])
        self.assertFalse(positions["list"][0]["costs_verified"])
        self.fake_mt5.order_send.assert_not_called()

    def test_guarded_close_rejects_invalid_targets_and_uncertain_execution(self):
        self.fake_mt5.positions_get.return_value = [self.target_position()]
        for target in (0, -1, float("nan"), float("inf"), "bad"):
            reply = self.bridge.handle_close(self.target_close_request(net_target_usd=target))
            self.assertEqual(reply["type"], "error", reply)
        self.bridge._MT5_ORDER_UNCERTAIN = True
        reply = self.bridge.handle_close(self.target_close_request())
        self.assertIn("uncertain", reply["message"])
        self.fake_mt5.order_send.assert_not_called()

    def test_partial_close_pauses_further_automatic_target_closes(self):
        self.fake_mt5.positions_get.return_value = [self.target_position()]
        self.fake_mt5.order_send.return_value.retcode = self.fake_mt5.TRADE_RETCODE_DONE_PARTIAL
        reply = self.bridge.handle_close(self.target_close_request())
        self.assertEqual(reply["type"], "error", reply)
        self.assertIn("partial or pending", reply["message"])
        self.assertTrue(self.bridge._MT5_ORDER_UNCERTAIN)
        self.bridge.handle_close(self.target_close_request(intent_id="secondTarget1234567890"))
        self.fake_mt5.order_send.assert_called_once()

    def test_account_advertises_guarded_target_support_and_positions_fail_closed(self):
        self.assertTrue(self.bridge.handle_account({})["net_target_close_supported"])
        self.fake_mt5.positions_get.return_value = None
        self.assertEqual(self.bridge.handle_positions({})["type"], "error")

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

    def test_trade_permission_off_blocks_demo_preview_without_ordering(self):
        self.fake_mt5.terminal_info.return_value.trade_allowed = False
        reply = self.bridge.handle_order_preview(self.demo_request())
        self.assertEqual(reply["type"], "error")
        self.assertIn("MT5 terminal trading permission is off", reply["message"])
        self.assertIn("manually confirmed order", reply["message"])
        self.fake_mt5.order_send.assert_not_called()

    def test_missing_mt5_demo_mode_constant_fails_closed(self):
        del self.fake_mt5.ACCOUNT_TRADE_MODE_DEMO
        preview = self.bridge.handle_order_preview(self.demo_request())
        self.assertEqual(preview["type"], "error")
        self.assertIn("did not expose verified REAL and DEMO", preview["message"])
        self.assertFalse(self.bridge.handle_account({}).get("demo"))
        self.fake_mt5.order_send.assert_not_called()

    def test_preview_then_manual_confirmation_sends_one_demo_market_order(self):
        request = self.demo_request()
        preview = self.bridge.handle_order_preview(request)
        self.assertEqual(preview["type"], "order_preview", preview)
        self.assertTrue(preview["manual_only"])
        self.assertLessEqual(preview["risk_pct"], self.bridge.MT5_MAX_RISK_PCT)
        self.assertGreaterEqual(preview["rr"], self.bridge.MT5_MIN_REWARD_RISK)
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
        self.assertEqual(self.bridge.handle_order_preview(self.demo_request(sl=0))["type"], "error")
        self.assertEqual(self.bridge.handle_order_preview(self.demo_request(tp=0))["type"], "error")
        self.fake_mt5.positions_get.return_value = [types.SimpleNamespace(ticket=1)]
        full = self.bridge.handle_order_preview(self.demo_request())
        self.assertEqual(full["type"], "error")
        self.assertIn("open positions", full["message"])
        self.fake_mt5.order_send.assert_not_called()

    def test_excessive_risk_daily_loss_stale_quotes_and_missing_history_block(self):
        self.fake_mt5.order_calc_profit.side_effect = lambda action, _symbol, volume, open_price, close_price: -10.0 if close_price < open_price else 10.0
        excessive = self.bridge.handle_order_preview(self.demo_request())
        self.assertEqual(excessive["type"], "error")
        self.assertIn("caps it at", excessive["message"])

        self.setUp()
        self.fake_mt5.history_deals_get.return_value = [types.SimpleNamespace(profit=-25, commission=0, swap=0, fee=0)]
        daily = self.bridge.handle_order_preview(self.demo_request())
        self.assertEqual(daily["type"], "error")
        self.assertIn("daily-loss limit", daily["message"])

        self.setUp()
        self.fake_mt5.symbol_info_tick.return_value.time = int(time.time()) - 120
        stale = self.bridge.handle_order_preview(self.demo_request())
        self.assertEqual(stale["type"], "error")
        self.assertIn("No fresh Exness MT5 tick", stale["message"])

        self.setUp()
        self.fake_mt5.history_deals_get.return_value = None
        unknown = self.bridge.handle_order_preview(self.demo_request())
        self.assertEqual(unknown["type"], "error")
        self.assertIn("could not be verified", unknown["message"])
        self.fake_mt5.order_send.assert_not_called()

    def test_partial_or_pending_result_is_uncertain_and_never_retried(self):
        self.fake_mt5.order_send.return_value.retcode = self.fake_mt5.TRADE_RETCODE_DONE_PARTIAL
        preview = self.bridge.handle_order_preview(self.demo_request())
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
        new_preview = self.bridge.handle_order_preview(self.demo_request())
        blocked = self.bridge.handle_order({
            **self.demo_request(), "preview_id": new_preview["preview_id"],
            "intent_id": "newIntent12345678901", "confirmed": True,
        })
        self.assertEqual(blocked["type"], "error")
        self.assertIn("no further app order will be sent", blocked["message"])
        self.fake_mt5.order_send.assert_called_once()

    def test_preview_cannot_be_changed_or_replayed(self):
        preview = self.bridge.handle_order_preview(self.demo_request())
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
        self.fake_mt5.symbol_info.return_value = types.SimpleNamespace(
            volume_min=0.1, volume_max=50.0, volume_step=0.1, trade_contract_size=1.0,
            currency_base="USD", currency_profit="USD", currency_margin="USD", trade_mode=4, digits=2,
            point=0.01, tick_size=0.01, tick_value=1.0, trade_stops_level=10,
            path="Indices\\US30", description="Wall Street 30"
        )
        reply = self.bridge.handle_quote({"symbols": ["US30"]})
        self.assertEqual(reply["type"], "quotes")
        quote = reply["quotes"][0]
        self.assertEqual(quote["trade_mode"], 4)
        self.assertEqual(quote["volume_min"], 0.1)
        self.assertEqual(quote["volume_step"], 0.1)
        self.assertEqual(quote["contract_size"], 1.0)
        self.assertEqual(quote["currency_profit"], "USD")
        # Full broker-reported specification with explicit source and timestamp.
        self.assertEqual(quote["point"], 0.01)
        self.assertEqual(quote["tick_size"], 0.01)
        self.assertEqual(quote["tick_value"], 1.0)
        self.assertEqual(quote["trade_stops_level"], 10)
        self.assertEqual(quote["currency_margin"], "USD")
        self.assertEqual(quote["category"], "indices")
        self.assertEqual(quote["spec_source"], "local MT5 terminal")
        self.assertIsInstance(quote["spec_at"], int)
        self.assertLessEqual(abs(quote["spec_at"] - int(time.time())), 5)

    def test_positions_net_profit_strict_min_lot_pending_orders_and_deals_history(self):
        self.bridge._LOCKED_LOGIN = 43210
        self.bridge._LOCKED_SERVER = "ExnessDemoServer"
        self.fake_mt5.account_info.return_value = types.SimpleNamespace(
            login=43210, server="ExnessDemoServer", company="Exness Technologies Ltd",
            balance=1000.0, equity=1003.2, margin=12.0, margin_free=991.2, margin_level=8360.0,
            profit=3.5, currency="USD", leverage=200, trade_mode=0, trade_allowed=True, trade_expert=True,
        )
        self.fake_mt5.ACCOUNT_TRADE_MODE_DEMO = 0
        self.fake_mt5.POSITION_TYPE_BUY = 0
        self.fake_mt5.positions_get.return_value = [
            types.SimpleNamespace(
                ticket=501, symbol="XAUUSDm", type=0, volume=0.02,
                price_open=2640.0, price_current=2641.8, profit=3.60,
                swap=-0.10, sl=2635.0, tp=2650.0,
                time=1760000000, magic=202506, comment="AURUM-1C-DEMO",
            )
        ]
        self.fake_mt5.history_deals_get = Mock(return_value=[
            types.SimpleNamespace(ticket=880, position_id=501, entry=0, commission=-0.30, fee=0.0)
        ])
        pos_res = self.bridge.handle_positions({})
        self.assertEqual(pos_res["type"], "positions")
        self.assertEqual(pos_res["list"][0]["commission"], -0.30)
        self.assertEqual(pos_res["list"][0]["net_profit"], 3.20)

        # Strict minimum-lot guard: explicit 0.005 lots (< 0.01 min) is rejected, NEVER inflated
        self.bridge.resolve_symbol = Mock(return_value="XAUUSDm")
        self.fake_mt5.symbol_info.return_value = types.SimpleNamespace(
            name="XAUUSDm", visible=True, trade_mode=4, trade_contract_size=100.0,
            volume_min=0.01, volume_max=50.0, volume_step=0.01, digits=2, point=0.01,
            trade_stops_level=10, currency_profit="USD", trade_filling_mode=1,
        )
        self.fake_mt5.SYMBOL_TRADE_MODE_FULL = 4
        self.fake_mt5.symbol_info_tick.return_value = types.SimpleNamespace(bid=2640.0, ask=2640.2, time=int(time.time()))
        self.fake_mt5.history_deals_get = Mock(return_value=[])
        plan, err_msg = self.bridge._mt5_direct_order_plan({
            "environment": "demo", "symbol": "XAUUSD", "side": "BUY", "volume": 10, "lots": 0.005
        })
        self.assertIsNone(plan)
        self.assertIn("NOT increased automatically", err_msg)

        # Pending BUY_LIMIT placement, listing & cancellation
        self.fake_mt5.terminal_info = Mock(return_value=types.SimpleNamespace(connected=True, trade_allowed=True))
        self.fake_mt5.TRADE_RETCODE_PLACED = 10008
        self.fake_mt5.TRADE_RETCODE_DONE = 10009
        self.fake_mt5.TRADE_ACTION_PENDING = 5
        self.fake_mt5.TRADE_ACTION_REMOVE = 8
        self.fake_mt5.ORDER_TIME_GTC = 0
        self.fake_mt5.ORDER_FILLING_RETURN = 2
        self.fake_mt5.order_send.return_value = types.SimpleNamespace(retcode=10008, order=8801, comment="placed")
        placed = self.bridge.handle_place_pending({
            "confirmed": True, "environment": "demo", "intent_id": "pendIntent_1234567890",
            "symbol": "XAUUSD", "order_type": "BUY_LIMIT", "entry_price": 2630.0,
            "lots": 0.02, "sl": 2620.0, "tp": 2650.0,
        })
        self.assertEqual(placed["type"], "pending_placed", msg=placed)
        self.assertEqual(placed["ticket"], 8801)

        self.fake_mt5.orders_get = Mock(return_value=[
            types.SimpleNamespace(ticket=8801, symbol="XAUUSDm", type=2, volume_current=0.02, price_open=2630.0, sl=2620.0, tp=2650.0, time_setup=1760000100, comment="AURUM-PEND")
        ])
        pend_list = self.bridge.handle_pending_orders({})
        self.assertEqual(pend_list["type"], "pending_orders")
        self.assertEqual(len(pend_list["list"]), 1)

        self.fake_mt5.order_send.return_value = types.SimpleNamespace(retcode=10009, order=8801, comment="cancelled")
        cancelled = self.bridge.handle_cancel_pending({"confirmed": True, "environment": "demo", "ticket": 8801})
        self.assertEqual(cancelled["type"], "pending_cancelled", msg=cancelled)

        # Deals history with entry deal (entry=0) + exit deal (entry=1) commission & swap -> net_profit
        self.fake_mt5.history_deals_get = Mock(return_value=[
            types.SimpleNamespace(ticket=990, order=770, position_id=501, symbol="XAUUSDm", type=0, entry=0, volume=0.02, price=2640.0, profit=0.0, commission=-0.20, swap=0.0, fee=0.0, time=1760000100, comment="open", reason="0"),
            types.SimpleNamespace(ticket=991, order=771, position_id=501, symbol="XAUUSDm", type=1, entry=1, volume=0.02, price=2642.0, profit=4.0, commission=-0.10, swap=-0.10, fee=0.0, time=1760000200, comment="close", reason="0"),
        ])
        deals = self.bridge.handle_deals_history({"days": 7})
        self.assertEqual(deals["type"], "deals_history")
        out_deal = [d for d in deals["deals"] if d["entry_kind"] == "OUT"][0]
        self.assertAlmostEqual(out_deal["commission"], -0.30)
        self.assertEqual(out_deal["net_profit"], 3.60)


if __name__ == "__main__":
    unittest.main()
