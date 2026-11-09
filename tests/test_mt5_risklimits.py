import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge.risklimits import validate_open_positions, MAX_MT5_OPEN_POSITIONS
from bridge.marketmeta import market_category


class Mt5OpenPositionLimitTests(unittest.TestCase):
    def test_unavailable_positions_fail_closed(self):
        result = validate_open_positions(None, 10)
        self.assertFalse(result["ok"])
        self.assertIn("could not be verified", result["reason"])

    def test_below_existing_cap_passes(self):
        self.assertTrue(validate_open_positions([], 10)["ok"])
        self.assertTrue(validate_open_positions([object()], 10)["ok"])

    def test_at_or_above_cap_blocks(self):
        result = validate_open_positions([object()] * 10, 10)
        self.assertFalse(result["ok"])
        self.assertEqual(result["count"], 10)
        self.assertEqual(result["limit"], 10)
        self.assertIn("no order was sent", result["reason"])
        self.assertFalse(validate_open_positions([object()] * 11, 10)["ok"])

    def test_server_limit_can_be_lower_but_never_higher_than_existing_cap(self):
        self.assertEqual(validate_open_positions([object()] * 2, 2)["limit"], 2)
        result = validate_open_positions([object()] * MAX_MT5_OPEN_POSITIONS, 99)
        self.assertFalse(result["ok"])
        self.assertEqual(result["limit"], MAX_MT5_OPEN_POSITIONS)

    def test_invalid_limits_fail_closed(self):
        self.assertFalse(validate_open_positions([], 0)["ok"])
        self.assertFalse(validate_open_positions([], "invalid")["ok"])

    def test_market_category_comes_from_broker_metadata_and_unknown_stays_other(self):
        cases = [
            ("Forex\\Majors", "EUR/USD", "", "forex"),
            ("Commodities\\Energies", "Brent Crude", "UKOIL", "energies"),
            ("Metals", "Gold Spot", "XAUUSD", "metals"),
            ("Shares\\US", "Apple Inc.", "AAPL", "stocks"),
            ("ETFs", "Exchange Traded Fund", "SPY", "etfs"),
            ("Bonds", "US Treasury", "UST10Y", "bonds"),
            ("", "Mystery contract", "XYZ", "other"),
        ]
        for path, description, name, expected in cases:
            with self.subTest(expected=expected, name=name):
                self.assertEqual(market_category(path, description, name), expected)


if __name__ == "__main__":
    unittest.main()
