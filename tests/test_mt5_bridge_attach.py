"""What the PC bridge tells the app when it cannot attach to MetaTrader 5.

The MetaTrader5 package exists for Windows only, so these tests load
bridge/mt5_bridge.py against a stand-in module. The stand-in keeps a "last
error" the way the package documents it: every call sets it, a successful call
sets (1, 'Success'). That is the behaviour that made the bridge report
"code 1: Success" for a failed attach: it read the error after mt5.shutdown().

The stand-in also takes an account in initialize(), as MetaQuotes documents it
(login, password, server; MetaTrader 5 then logs in to that account as part of
the attach), and answers "Authorization failed" (-6) to an attach without an
account while it is logged in to none. It answers what a test tells it to
answer. What the package really does, step by step, is modelled in
tests/test_mt5_connector_model.py (read from the package's own file). A real
terminal has not been run: the package and the terminal exist for Windows only.

Nothing here contacts a terminal, a broker or the network, and nothing asserts
what a trade analysis concludes.
"""
import http.client
import importlib.util
import inspect
import json
import logging
import os
import re
import sys
import tempfile
import time
import types
import unittest
import unittest.mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BRIDGE_DIR = ROOT / "bridge"
LOGIN = {"login": 123456, "password": "local-only", "server": "Exness-MT5Trial"}
ACCOUNT = (LOGIN["login"], LOGIN["password"], LOGIN["server"])
NOT_LOGGED_IN = (-6, "Terminal: Authorization failed")


class StandInTerminal(types.ModuleType):
    """MetaTrader5 stand-in: initialize() fails with a chosen error until told otherwise."""

    def __init__(self):
        super().__init__("MetaTrader5")
        self.error = (1, "Success")
        self.init_error = (-10005, "IPC timeout")
        self.init_ok = False
        self.init_raises = None
        self.calls = []
        self.attached = False
        self.login_ok = False
        self.login_error = (-6, "Terminal: Authorization failed")
        self.silent_after_attach = None  # an error to report instead of terminal details once attached
        self.while_initializing = None  # called from inside initialize(), as a second request would arrive
        self.account = None
        self.takes_timeout = True  # False: a connector whose initialize() has no 'timeout' keyword
        self.accepts = None  # (login, password, server): initialize() logs in when it is given exactly this account
        self.account_error = None  # the answer to an account that is not accepted (None: init_error)
        self.account_raises = None  # raised by an initialize() that is given an account

    def initialize(self, *args, **kwargs):
        self.calls.append(("initialize", args, kwargs))
        if "timeout" in kwargs and not self.takes_timeout:
            raise TypeError("'timeout' is an invalid keyword argument for initialize()")
        if self.while_initializing is not None:
            self.while_initializing()
        if self.init_raises is not None:
            raise self.init_raises
        if self.init_ok:
            self.attached, self.error = True, (1, "Success")
            return True
        if "login" in kwargs:  # MetaTrader 5 is asked to log in to this account as part of the attach
            if self.account_raises is not None:
                raise self.account_raises
            if (kwargs["login"], kwargs.get("password"), kwargs.get("server")) == self.accepts:
                self.attached, self.error = True, (1, "Success")
                return True
            self.error = self.account_error or self.init_error
            return False
        self.error = self.init_error
        return False

    def shutdown(self):
        self.calls.append(("shutdown", (), {}))
        self.attached, self.error = False, (1, "Success")

    def last_error(self):
        return self.error

    def terminal_info(self):
        self.calls.append(("terminal_info", (), {}))
        if self.attached and self.silent_after_attach is None:
            self.error = (1, "Success")
            return types.SimpleNamespace(trade_allowed=False, name="MetaTrader 5 EXNESS")
        self.error = self.silent_after_attach or (-10004, "No IPC connection")
        return None

    def login(self, *args, **kwargs):
        self.calls.append(("login", args, {"server": kwargs.get("server")}))
        self.error = (1, "Success") if self.login_ok else self.login_error
        return self.login_ok

    def account_info(self):
        self.calls.append(("account_info", (), {}))
        if self.account is not None:
            self.error = (1, "Success")
            return self.account
        self.error = (-10005, "IPC timeout")
        return None

    def count(self, name):
        return sum(1 for call in self.calls if call[0] == name)


def words_the_app_replaces():
    """The words for which the app shows its own help instead of the bridge's message."""
    source = (ROOT / "src" / "main.js").read_text(encoding="utf-8")
    found = re.search(r"/([a-z|]+)/i\.test\(m\)\s*\?\s*'<b>Bridge not reachable\.</b>", source)
    if not found:
        raise AssertionError("src/main.js no longer has the Exness sign-in check this test reads; "
                             "bring _APP_REPLACES_WORDS in bridge/mt5_bridge.py into line with it")
    return found.group(1).split("|")


class AttachMessageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original_modules = {name: sys.modules.get(name) for name in ("MetaTrader5", "websockets")}
        cls.original_env = os.environ.pop("AURUM_MT5_PATH", None)
        sys.path.insert(0, str(BRIDGE_DIR))
        cls.terminal = StandInTerminal()
        fake_websockets = types.ModuleType("websockets")
        fake_websockets.exceptions = types.SimpleNamespace(
            ConnectionClosed=type("ConnectionClosed", (Exception,), {})
        )
        sys.modules["MetaTrader5"] = cls.terminal
        sys.modules["websockets"] = fake_websockets
        spec = importlib.util.spec_from_file_location("mt5_bridge_attach_under_test", BRIDGE_DIR / "mt5_bridge.py")
        cls.bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.bridge)
        cls.replaced = words_the_app_replaces()
        cls.folder = tempfile.TemporaryDirectory()

        cls.look_up = staticmethod(cls.bridge._running_terminals)  # the real look-up; the tests put their own in its place

    @classmethod
    def tearDownClass(cls):
        cls.folder.cleanup()
        sys.path.remove(str(BRIDGE_DIR))
        for name, old in cls.original_modules.items():
            if old is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = old
        sys.modules.pop("mt5_bridge_attach_under_test", None)
        if cls.original_env is not None:
            os.environ["AURUM_MT5_PATH"] = cls.original_env

    def setUp(self):
        logging.disable(logging.CRITICAL)
        terminal, bridge = self.terminal, self.bridge
        terminal.error, terminal.init_error = (1, "Success"), (-10005, "IPC timeout")
        terminal.init_ok, terminal.init_raises, terminal.attached = False, None, False
        terminal.login_ok, terminal.login_error = False, (-6, "Terminal: Authorization failed")
        terminal.silent_after_attach = None
        terminal.while_initializing = None
        terminal.account = None
        terminal.takes_timeout = True
        terminal.accepts = terminal.account_error = terminal.account_raises = None
        terminal.calls = []
        bridge._ATTACH_FAILURE = None
        bridge._CONNECTOR_TAKES_TIMEOUT = True
        bridge._ATTACH_STATE.update(wait_ms=bridge._LOGIN_ATTACH_WAIT_MS, since=0.0, limit_s=0.0)
        bridge._CONFIGURED_MT5_PATH = ""
        bridge.CANDIDATE_PATHS = [None]
        bridge._LOCKED_LOGIN = None
        bridge._LOCKED_SERVER = None
        self.running(None)  # as on a PC where the bridge cannot look for a running MetaTrader 5

    def tearDown(self):
        logging.disable(logging.NOTSET)
        self.bridge._running_terminals = self.look_up

    # ------------------------------------------------------------ helpers
    def use_terminal_file(self, *parts):
        """A real file that stands for an installed terminal executable."""
        path = Path(self.folder.name).joinpath(*parts)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"")
        self.bridge._CONFIGURED_MT5_PATH = str(path)
        self.bridge.CANDIDATE_PATHS = [str(path)]
        return str(path)

    def login_message(self):
        reply = self.bridge.handle_login(dict(LOGIN))
        self.assertEqual(reply["type"], "error")
        return reply["message"]

    def running(self, paths):
        """The MetaTrader 5 programs that are open on the PC: a list of paths, or None when the bridge cannot look."""
        self.bridge._running_terminals = lambda: (None if paths is None else list(paths))

    def version_note(self):
        """How every attach message ends: which bridge file answered."""
        note = self.bridge._version_note()
        self.assertRegex(note, r'^Bridge version 22a, running from "[^"\\]+\\bridge"\.$')
        return note

    def not_logged_in(self, accepts=ACCOUNT):
        """MetaTrader 5 is open and logged in to no account: it attaches only when it is given an account it accepts."""
        self.terminal.init_error = NOT_LOGGED_IN
        self.terminal.accepts = accepts

    def account_as_metatrader_reports_it(self):
        self.terminal.login_ok = True
        self.terminal.account = types.SimpleNamespace(
            login=LOGIN["login"], server=LOGIN["server"], company="Exness (KE) Limited", currency="USD",
            balance=250.0, equity=250.0, margin_free=250.0, leverage=200)

    def attach_calls(self):
        """Every initialize() so far: (the path given, the named arguments)."""
        return [(args, kwargs) for name, args, kwargs in self.terminal.calls if name == "initialize"]

    def assert_reaches_the_user(self, message):
        """The app must show this text itself: none of the words it replaces, and plain ASCII."""
        for word in self.replaced:
            self.assertNotRegex(message, re.compile(word, re.IGNORECASE), f"the app would replace a message with '{word}'")
        message.encode("ascii")

    # ------------------------------------------------------------ the reported fault
    def test_a_failed_attach_reports_the_reason_and_not_code_1_success(self):
        self.terminal.init_error = (-10005, "IPC timeout")
        message = self.login_message()
        self.assertNotIn("code 1", message)
        self.assertNotIn("Success", message)
        self.assertIn("code -10005", message)
        self.assertIn("(step terminal", message)
        self.assertIn("did not answer within 5 seconds", message)
        # the stand-in did reset the error, as the package does: the bridge kept the reason from before
        self.assertEqual(self.terminal.last_error(), (1, "Success"))
        self.assertEqual(self.terminal.count("shutdown"), 1)
        self.assert_reaches_the_user(message)

    def test_every_kind_of_failure_gets_its_own_instruction(self):
        cases = [
            (NOT_LOGGED_IN, "did not log in with the account number, password and server entered in the app", "compare them with your Exness Personal Area"),
            ((-10003, "IPC initialize failed, MetaTrader 5 x64 not found"), "no MetaTrader 5 desktop program was found", "Exness Personal Area"),
            ((-10003, "IPC initialize failed, Pipe server didn't answer in 60 sec"), "did not open its connection for Python", "'Python integration' box"),
            ((-10003, "IPC initialize failed, Process create failed 'C:\\x\\terminal64.exe'"), "could not be started from its saved location", "START_ALL_LOCAL.bat"),
            ((-10005, "IPC timeout"), "did not answer within 5 seconds", "not 'Run as administrator'"),
            ((-5, "Terminal: Invalid version"), "different versions", "Restart MetaTrader 5"),
            ((-10001, "IPC send failed"), "could not be contacted", "Check AURUM_MT5_PATH"),
        ]
        seen = set()
        for error, what, do in cases:
            with self.subTest(error=error):
                self.setUp()
                self.terminal.init_error = error
                message = self.login_message()
                self.assertIn(what, message)
                self.assertIn(do, message)
                self.assertIn(f"code {error[0]}", message)
                self.assertIn("press Connect again" if "START_ALL_LOCAL" not in message else "START_ALL_LOCAL.bat again", message)
                self.assert_reaches_the_user(message)
                seen.add(message)
        self.assertEqual(len(seen), len(cases))

    # ------------------------------------------------------------ a terminal that is not logged in
    def test_a_terminal_that_is_not_logged_in_is_given_the_account_entered_in_the_app(self):
        path = self.use_terminal_file("ExnessKE MT5 Terminal", "terminal64.exe")
        self.not_logged_in()
        self.account_as_metatrader_reports_it()
        reply = self.bridge.handle_login(dict(LOGIN))
        self.assertEqual(reply["type"], "logged", reply)
        # first as always, without an account; MetaTrader 5 answers -6; then once more with the account of the login
        self.assertEqual(self.attach_calls(), [
            ((path,), {"timeout": 5000}),
            ((path,), {"timeout": 4000, "login": 123456, "password": "local-only", "server": "Exness-MT5Trial"}),
        ])
        # The attach with the account is the login: the package sends MetaTrader 5 the same login mt5.login() sends,
        # so mt5.login() is not called after it. The identity checks follow as always.
        self.assertEqual([call[0] for call in self.terminal.calls],
                         ["terminal_info", "initialize", "shutdown", "initialize", "terminal_info", "account_info"])
        self.assertIsNone(self.bridge._ATTACH_FAILURE)
        self.assertEqual(reply["server"], "Exness-MT5Trial")
        self.assertNotIn("123456", reply["account"])
        self.assertEqual((self.bridge._LOCKED_LOGIN, self.bridge._LOCKED_SERVER), (123456, "Exness-MT5Trial"))

    def test_metatrader_is_not_asked_to_log_in_a_second_time_and_the_account_it_reports_is_compared(self):
        # MetaTrader 5 logged in during the attach, but reports another account number than the one it was given.
        self.not_logged_in()
        self.account_as_metatrader_reports_it()
        self.terminal.account.login = 654321
        message = self.login_message()
        self.assertEqual(message, "MetaTrader 5 reported a different account than the one entered. "
                                  "Connection rejected; press Connect again.")
        self.assert_reaches_the_user(message)
        self.assertEqual(self.terminal.count("login"), 0)
        self.assertIsNone(self.bridge._LOCKED_LOGIN)  # nothing was bound

        # The next login finds the terminal attached: no attach of its own, so MetaTrader's own login() as always.
        self.terminal.account.login = LOGIN["login"]
        reply = self.bridge.handle_login(dict(LOGIN))
        self.assertEqual(reply["type"], "logged", reply)
        self.assertEqual(self.terminal.count("login"), 1)
        self.assertEqual(self.terminal.calls[-2], ("login", (123456,), {"server": "Exness-MT5Trial"}))
        self.assertEqual(len(self.attach_calls()), 2)

    def test_a_terminal_that_is_logged_in_already_is_asked_to_log_in_as_it_always_was(self):
        # The attach without an account succeeds: MetaTrader 5 is logged in to some account, not necessarily this one.
        self.terminal.init_ok = True
        self.account_as_metatrader_reports_it()
        reply = self.bridge.handle_login(dict(LOGIN))
        self.assertEqual(reply["type"], "logged", reply)
        self.assertEqual(self.attach_calls(), [((), {"timeout": 5000})])
        self.assertEqual([call[0] for call in self.terminal.calls], ["terminal_info", "initialize", "terminal_info", "login", "account_info"])
        # and a wrong password is still MetaTrader's to refuse
        self.setUp()
        self.terminal.init_ok = True
        message = self.login_message()
        self.assertIn("MT5 rejected the credentials (step login, code -6", message)

    def test_the_identity_checks_after_the_login_reach_the_user_in_their_own_words(self):
        for change, words in [
            (dict(server="Exness-MT5Real"), "MT5 reported a different server than the exact Exness server entered. Connection rejected;"),
            (dict(company="Another Broker Ltd"), "MT5 did not verify an Exness company identity for this account. Connection rejected;"),
        ]:
            with self.subTest(change=change):
                self.setUp()
                self.not_logged_in()
                self.account_as_metatrader_reports_it()
                for name, value in change.items():
                    setattr(self.terminal.account, name, value)
                message = self.login_message()
                self.assertIn(words, message)
                self.assert_reaches_the_user(message)  # with "refused" in it the app showed "Bridge not reachable" instead

    def test_once_metatrader_has_said_not_logged_in_the_next_login_gives_it_the_account_at_once(self):
        self.not_logged_in()
        self.account_as_metatrader_reports_it()
        self.bridge._ATTACH_STATE["wait_ms"] = self.bridge._START_ATTACH_WAIT_MS
        self.assertFalse(self.bridge.attach_terminal())  # the attach at bridge start: no account to give
        self.bridge._ATTACH_STATE["wait_ms"] = self.bridge._LOGIN_ATTACH_WAIT_MS
        self.assertEqual(self.attach_calls(), [((), {"timeout": 60000})])
        self.assertFalse(self.bridge._ATTACH_FAILURE.get("with_account"))

        # A login a moment later is no repeat of that attempt: it brings the account, and only that attach is made.
        self.assertLess(time.time() - self.bridge._ATTACH_FAILURE["at"], self.bridge._ATTACH_REPEAT_QUIET_S)
        reply = self.bridge.handle_login(dict(LOGIN))
        self.assertEqual(reply["type"], "logged", reply)
        self.assertEqual(self.attach_calls()[1:], [((), {"timeout": 4000, "login": 123456, "password": "local-only", "server": "Exness-MT5Trial"})])

    def test_an_account_metatrader_does_not_accept_is_reported_as_that_and_the_next_login_tries_only_the_account(self):
        path = self.use_terminal_file("ExnessKE MT5 Terminal", "terminal64.exe")
        self.not_logged_in(accepts=(LOGIN["login"], "another password", LOGIN["server"]))
        message = self.login_message()
        self.assertEqual(
            message,
            "Cannot attach to MetaTrader 5: MetaTrader 5 did not log in with the account number, password and server "
            "entered in the app, or it has no connection to Exness (step terminal, code -6: Terminal: Authorization "
            "failed). Look at the bottom-right corner of MetaTrader 5. If it shows a connection speed, MetaTrader 5 has "
            "logged in by now: press Connect again. If it says 'Invalid account', Exness did not accept the three: "
            "compare them with your Exness Personal Area (the account must be an MT5 account, the password is the one "
            "of that trading account and not the one of the Exness website, the server is written exactly as shown "
            "there) and press Connect again. If it says 'No connection', MetaTrader 5 cannot get through to Exness: "
            "check the internet connection of this PC. If Connect fails although the corner shows a speed: start "
            "MetaTrader 5 with a normal double-click, not 'Run as administrator', keep only that one MetaTrader 5 open, "
            "then run START_ALL_LOCAL.bat again. "
            'Terminal tried: "ExnessKE MT5 Terminal\\terminal64.exe". ' + self.version_note())
        self.assert_reaches_the_user(message)
        self.assertEqual(len(self.attach_calls()), 2)
        self.assertEqual(self.terminal.count("login"), 0)  # not attached: nothing further is asked of MetaTrader 5
        self.assertTrue(self.bridge._ATTACH_FAILURE["with_account"])

        # the repeat the app sends at once: same words, MetaTrader 5 is left alone
        self.assertEqual(self.login_message(), message)
        self.assertEqual(len(self.attach_calls()), 2)

        # Later, with the password put right: the attach without an account is not made a second time.
        self.bridge._ATTACH_FAILURE["at"] = time.time() - self.bridge._ATTACH_REPEAT_QUIET_S - 0.1
        self.terminal.accepts = ACCOUNT
        self.account_as_metatrader_reports_it()
        reply = self.bridge.handle_login(dict(LOGIN))
        self.assertEqual(reply["type"], "logged", reply)
        self.assertEqual(self.attach_calls()[2:], [((path,), {"timeout": 4000, "login": 123456, "password": "local-only", "server": "Exness-MT5Trial"})])

    def slow_first_attach(self, seconds):
        """The attach without an account takes this long on the bridge's clock; the one with the account takes none."""
        clock = {"now": 1000.0}
        def takes_time():
            if len(self.attach_calls()) == 1:
                clock["now"] += seconds
        self.terminal.while_initializing = takes_time
        return unittest.mock.patch.object(self.bridge, "_now", lambda: clock["now"])

    def test_the_attach_with_the_account_ends_four_seconds_after_the_login_began_to_attach(self):
        self.not_logged_in()
        self.account_as_metatrader_reports_it()
        with self.slow_first_attach(1.2):
            self.assertEqual(self.bridge.handle_login(dict(LOGIN))["type"], "logged")
        waits = [kwargs["timeout"] for _, kwargs in self.attach_calls()]
        self.assertEqual(waits, [5000, 2800])  # 4 s less the 1.2 s the answer "not logged in" took
        self.assertEqual((self.bridge._ACCOUNT_ATTACH_END_MS, self.bridge._ACCOUNT_ATTACH_MIN_MS), (4000, 2000))
        # MetaTrader's own login() follows the attach in the same answer, and the app waits 6 s for that answer
        self.assertLess(self.bridge._ACCOUNT_ATTACH_END_MS, self.bridge._LOGIN_ATTACH_WAIT_MS)

        self.setUp()  # a login that has not finished in that time: the message names the time it had
        self.not_logged_in(accepts=None)
        self.terminal.account_error = (-10005, "IPC timeout")
        with self.slow_first_attach(1.2):
            message = self.login_message()
        self.assertIn("had not finished logging in after 2.8 seconds", message)

    def test_a_login_that_takes_longer_than_its_time_is_reported_as_still_going_on(self):
        # The package sends MetaTrader 5 the login and then asks, for the waiting time, whether it is logged in.
        # "IPC timeout" after that means the time ended first: MetaTrader 5 has the account and goes on.
        path = self.use_terminal_file("ExnessKE MT5 Terminal", "terminal64.exe")
        self.not_logged_in(accepts=None)
        self.terminal.account_error = (-10005, "IPC timeout")
        message = self.login_message()
        self.assertEqual(
            message,
            "Cannot attach to MetaTrader 5: MetaTrader 5 was given the account number, password and server entered "
            "in the app and had not finished logging in after 4 seconds (step terminal, code -10005: IPC time-out). "
            "Give it a few more seconds. Look at the bottom-right corner of MetaTrader 5. If it shows a connection "
            "speed, MetaTrader 5 has logged in by now: press Connect again. If it says 'Invalid account', Exness did "
            "not accept the three: compare them with your Exness Personal Area (the account must be an MT5 account, "
            "the password is the one of that trading account and not the one of the Exness website, the server is "
            "written exactly as shown there) and press Connect again. If it says 'No connection', MetaTrader 5 cannot "
            "get through to Exness: check the internet connection of this PC. "
            'Terminal tried: "ExnessKE MT5 Terminal\\terminal64.exe". ' + self.version_note())
        self.assert_reaches_the_user(message)
        self.assertNotIn("Python integration", message)  # MetaTrader 5 was reached: nothing about how it was started
        self.assertNotIn("Run as administrator", message)

        # The next press, once the quiet time is over, finds MetaTrader 5 logged in: a plain attach, no second account.
        self.bridge._ATTACH_FAILURE["at"] = time.time() - self.bridge._ATTACH_REPEAT_QUIET_S - 0.1
        self.terminal.init_ok = True
        self.account_as_metatrader_reports_it()
        self.assertEqual(self.bridge.handle_login(dict(LOGIN))["type"], "logged")
        self.assertEqual(self.attach_calls()[2:], [((path,), {"timeout": 5000})])

    def test_an_account_with_a_one_time_password_is_sent_to_metatrader_itself(self):
        self.not_logged_in(accepts=None)
        self.terminal.account_error = (-7, "Unsupported authorization mode, OTP or certificate password needed")
        message = self.login_message()
        self.assertIn("this account asks for a one-time password or a certificate, and the app cannot give either to "
                      "MetaTrader 5 (step terminal, code -7: Unsupported authorization mode, OTP or certificate "
                      "password needed). Log in inside MetaTrader 5 yourself: 1) in MetaTrader 5 use File > Login to "
                      "Trade Account", message)
        self.assertNotIn("compare them with your Exness Personal Area", message)
        self.assert_reaches_the_user(message)

    def test_when_too_little_time_is_left_the_next_login_makes_the_attach_with_the_account(self):
        self.not_logged_in()
        self.account_as_metatrader_reports_it()
        with self.slow_first_attach(2.5):  # 1.5 s would be left: under the 2 s the attach with the account needs
            first = self.login_message()
        self.assertEqual(self.attach_calls(), [((), {"timeout": 5000})])
        self.assertIn("is open, but it is not logged in to a trading account", first)
        self.assertIn("Press Connect in the app with the account number, the password and the exact server", first)
        self.assert_reaches_the_user(first)
        # The app repeats a failed login at once. This repeat is not held back: it makes the attach that was not made.
        self.assertLess(time.time() - self.bridge._ATTACH_FAILURE["at"], self.bridge._ATTACH_REPEAT_QUIET_S)
        self.terminal.while_initializing = None
        reply = self.bridge.handle_login(dict(LOGIN))
        self.assertEqual(reply["type"], "logged", reply)
        self.assertEqual(self.attach_calls()[1:], [((), {"timeout": 4000, "login": 123456, "password": "local-only", "server": "Exness-MT5Trial"})])

        self.setUp()  # exactly 2 s left is enough
        self.not_logged_in()
        self.account_as_metatrader_reports_it()
        with self.slow_first_attach(2.0):
            self.assertEqual(self.bridge.handle_login(dict(LOGIN))["type"], "logged")
        self.assertEqual([kwargs["timeout"] for _, kwargs in self.attach_calls()], [5000, 2000])

    def test_the_attach_at_bridge_start_has_no_account_and_says_that_connect_brings_one(self):
        self.not_logged_in()
        self.bridge._ATTACH_STATE["wait_ms"] = self.bridge._START_ATTACH_WAIT_MS
        self.assertFalse(self.bridge.attach_terminal())
        self.assertEqual(self.attach_calls(), [((), {"timeout": 60000})])
        message = self.bridge._attach_failure_message()
        self.assertEqual(
            message,
            "Cannot attach to MetaTrader 5: MetaTrader 5 is open, but it is not logged in to a trading account or has "
            "no connection to Exness (step terminal, code -6: Terminal: Authorization failed). Press Connect in the app "
            "with the account number, the password and the exact server: the bridge passes them to MetaTrader 5, which "
            "then logs in. To log in yourself instead: 1) in MetaTrader 5 use File > Login to Trade Account (account "
            "number, password and the exact server) and wait until the bottom-right corner shows a connection speed and "
            "not 'No connection'; 2) press Connect. If MetaTrader 5 shows your account already: start MetaTrader 5 with "
            "a normal double-click, not 'Run as administrator', keep only that one MetaTrader 5 open, then run "
            "START_ALL_LOCAL.bat again. Terminal tried: the default MetaTrader 5 of this PC (no location is saved). "
            + self.version_note())
        self.assert_reaches_the_user(message)

    def test_only_not_logged_in_makes_the_bridge_give_metatrader_the_account(self):
        answers = [(-10005, "IPC timeout"), (-10003, "IPC initialize failed, MetaTrader 5 x64 not found"),
                   (-10003, "IPC initialize failed, Pipe server didn't answer in 60 sec"), (-5, "Terminal: Invalid version"),
                   (-10001, "IPC send failed"), (1, "Success")]
        for error in answers:
            with self.subTest(error=error):
                self.setUp()
                self.terminal.init_error, self.terminal.accepts = error, ACCOUNT
                self.login_message()
                self.assertEqual(self.attach_calls(), [((), {"timeout": 5000})])
        self.setUp()  # an exception from the connector is no answer from MetaTrader 5 either
        self.terminal.init_raises, self.terminal.accepts = RuntimeError("Authorization failed"), ACCOUNT
        self.login_message()
        self.assertEqual(self.attach_calls(), [((), {"timeout": 5000})])

    def test_a_bridge_bound_to_one_account_does_not_ask_metatrader_to_log_in_to_another(self):
        self.not_logged_in()
        self.bridge._LOCKED_LOGIN, self.bridge._LOCKED_SERVER = 654321, LOGIN["server"]
        message = self.login_message()
        self.assertIn("already bound to a different Exness account/server", message)
        self.assertEqual(self.terminal.count("initialize"), 0)
        self.assertEqual(self.terminal.count("login"), 0)

        self.setUp()  # the same account, another server: the same
        self.not_logged_in()
        self.bridge._LOCKED_LOGIN, self.bridge._LOCKED_SERVER = LOGIN["login"], "Exness-MT5Real"
        self.assertIn("already bound to a different Exness account/server", self.login_message())
        self.assertEqual(self.terminal.count("initialize"), 0)

        self.setUp()  # the account it is bound to (the server in other capitals) may bring MetaTrader 5 back
        self.not_logged_in()
        self.account_as_metatrader_reports_it()
        self.bridge._LOCKED_LOGIN, self.bridge._LOCKED_SERVER = LOGIN["login"], LOGIN["server"].upper()
        self.assertEqual(self.bridge.handle_login(dict(LOGIN))["type"], "logged")
        self.assertEqual(len(self.attach_calls()), 2)

    def test_the_password_is_in_no_message_and_no_log_line(self):
        logging.disable(logging.NOTSET)
        with self.assertLogs(self.bridge.log, level="DEBUG") as written:
            # MetaTrader 5 accepts the account
            self.not_logged_in()
            self.account_as_metatrader_reports_it()
            self.assertEqual(self.bridge.handle_login(dict(LOGIN))["type"], "logged")
            # it does not, and repeats the password in its answer
            self.setUp()
            logging.disable(logging.NOTSET)
            self.not_logged_in(accepts=None)
            self.terminal.account_error = (-6, "Terminal: Authorization failed for local-only")
            refused = self.login_message()
            # the connector raises, with the password in its text
            self.setUp()
            logging.disable(logging.NOTSET)
            self.not_logged_in(accepts=None)
            self.terminal.account_raises = RuntimeError("cannot log in 123456 with local-only")
            raised = self.login_message()
        lines = [record.getMessage() for record in written.records]
        self.assertTrue(any("with the account entered in the app" in line for line in lines), lines)
        for text in lines + [refused, raised]:
            self.assertNotIn("local-only", text)
            self.assertNotIn("123456", text)  # nor the account number
        self.assertIn("code -6: Terminal: Authorization failed for [password]", refused)
        self.assertIn("cannot log in [account number] with [password]", raised)
        self.assertIn("could not be contacted", raised)
        self.assert_reaches_the_user(refused)
        self.assert_reaches_the_user(raised)

    def test_a_login_that_arrives_during_the_attach_with_the_account_is_told_to_wait(self):
        self.not_logged_in()
        self.account_as_metatrader_reports_it()
        answers = []
        def another_login():
            if len(self.attach_calls()) == 2:  # the attach with the account is the one in progress
                answers.append(self.bridge.handle_login(dict(LOGIN))["message"])
        self.terminal.while_initializing = another_login
        self.assertEqual(self.bridge.handle_login(dict(LOGIN))["type"], "logged")
        self.assertEqual(len(answers), 1)
        self.assertIn("still contacting MetaTrader 5", answers[0])
        self.assertTrue(answers[0].endswith("Press Connect again in about 4 seconds."), answers[0])
        self.assertEqual(len(self.attach_calls()), 2)  # the waiting login made no attach of its own

    def test_a_connector_that_takes_no_waiting_time_is_not_given_the_account(self):
        # Such a connector waits its own 60 s. The attach with the account has to end within the time the app
        # waits, so it is not made: Connect answers as it did before the bridge could pass an account on.
        self.not_logged_in()
        self.account_as_metatrader_reports_it()
        self.terminal.takes_timeout = False
        message = self.login_message()
        self.assertEqual(self.attach_calls(), [((), {"timeout": 5000}), ((), {})])
        self.assertFalse(self.bridge._CONNECTOR_TAKES_TIMEOUT)
        self.assertIn("is open, but it is not logged in to a trading account", message)
        self.assertIn("Do this: 1) in MetaTrader 5 use File > Login to Trade Account (account number, password and the "
                      "exact server) and wait until the bottom-right corner shows a connection speed and not "
                      "'No connection'; 2) press Connect again.", message)
        self.assertNotIn("the bridge passes them to MetaTrader 5", message)
        self.assert_reaches_the_user(message)

        # nor later: the next login does not start with the account either
        self.bridge._ATTACH_FAILURE["at"] = time.time() - self.bridge._ATTACH_REPEAT_QUIET_S - 0.1
        self.login_message()
        self.assertEqual(self.attach_calls()[2:], [((), {"timeout": 5000}), ((), {})])

        # A TypeError about something else is no sign of such a connector, and with an account it is reported at once.
        self.setUp()
        self.terminal.init_raises = TypeError("path must be str")
        self.login_message()
        self.assertTrue(self.bridge._CONNECTOR_TAKES_TIMEOUT)
        self.setUp()
        self.not_logged_in(accepts=None)
        self.terminal.account_raises = TypeError("server must be str")
        message = self.login_message()
        self.assertEqual(len(self.attach_calls()), 2)  # the one without the account, the one with it; no third call
        self.assertIn("could not be contacted (step terminal, server must be str)", message)
        self.assertTrue(self.bridge._CONNECTOR_TAKES_TIMEOUT)

    def test_a_terminal_that_does_not_answer_in_time_is_given_the_way_to_a_full_minute(self):
        self.terminal.init_error = (-10005, "IPC timeout")
        message = self.login_message()
        self.assertIn("If it has only just started, wait until it shows your account and press Connect again. "
                      "If it is already open: 1) in MetaTrader 5 use File > Login to Trade Account", message)
        self.assertIn("; 2) start MetaTrader 5 with a normal double-click, not 'Run as administrator'; 3) if Tools > Options > "
                      "Community has a 'Python integration' box, tick it and restart MetaTrader 5; 4) run START_ALL_LOCAL.bat "
                      "again with MetaTrader 5 open and logged in: the bridge then waits a full minute for it. Terminal tried:",
                      message)
        self.assertEqual(self.bridge._START_ATTACH_WAIT_MS, 60000)  # the 'full minute' of the message
        self.assert_reaches_the_user(message)

    def test_no_terminal_found_says_what_to_do_whether_it_is_installed_or_not(self):
        self.terminal.init_error = (-10003, "IPC initialize failed, MetaTrader 5 x64 not found")
        message = self.login_message()
        self.assertIn("no MetaTrader 5 desktop program was found on this PC (step terminal, code -10003: "
                      "IPC initialize failed, MetaTrader 5 x64 not found). If MetaTrader 5 is installed, open it and log in, "
                      "then run START_ALL_LOCAL.bat again: the launcher saves where it is. If it is not installed, get the "
                      "MetaTrader 5 desktop program from your Exness Personal Area first (the Exness web terminal does not "
                      "count). Terminal tried:", message)
        self.assert_reaches_the_user(message)

    def test_the_code_alone_or_the_text_alone_is_enough_to_recognise_a_failure(self):
        cases = [
            ((-6, "something else"), "did not log in with the account number, password and server entered in the app"),
            ((-1, "Terminal: Authorization failed"), "did not log in with the account number, password and server entered in the app"),
            ((-10005, "something else"), "did not answer within 5 seconds"),
            ((-10000, "IPC timeout"), "did not answer within 5 seconds"),
            ((-10000, "IPC time-out"), "did not answer within 5 seconds"),
            ((-5, "something else"), "different versions"),
            ((-1, "Terminal: Invalid version"), "different versions"),
        ]
        for error, what in cases:
            with self.subTest(error=error):
                self.setUp()
                self.terminal.init_error = error
                self.assertIn(what, self.login_message())

    def test_a_32_bit_python_is_named_only_when_it_is_one(self):
        self.terminal.init_error = (-10003, "IPC initialize failed, MetaTrader 5 x64 not found")
        self.assertGreater(sys.maxsize, 2 ** 32)  # the test machine runs 64-bit Python
        self.assertNotIn("32-bit", self.login_message())
        self.setUp()
        self.terminal.init_error = (-10003, "IPC initialize failed, MetaTrader 5 x64 not found")
        with unittest.mock.patch.object(sys, "maxsize", 2 ** 31 - 1):
            message = self.login_message()
        self.assertIn("This Python is 32-bit and MetaTrader 5 needs the 64-bit one", message)
        self.assert_reaches_the_user(message)

    def test_the_app_shows_the_message_itself_even_for_a_time_out(self):
        # MetaTrader's own text for -10005 is 'IPC timeout'; the app replaces any message with that word
        self.assertIn("timeout", self.replaced)
        self.terminal.init_error = (-10005, "IPC timeout")
        message = self.login_message()
        self.assertIn("IPC time-out", message)
        self.assert_reaches_the_user(message)
        # the bridge's own list is the app's list, word for word
        self.assertEqual([word for word, _ in self.bridge._APP_REPLACES_WORDS], self.replaced)
        for _, other in self.bridge._APP_REPLACES_WORDS:
            self.assert_reaches_the_user(other)

    def test_an_exception_from_the_connector_is_reported_too(self):
        self.terminal.init_raises = RuntimeError("connector blocked by antivirus")
        message = self.login_message()
        self.assertIn("could not be contacted", message)
        self.assertIn("connector stopped by antivirus", message)
        self.assert_reaches_the_user(message)
        self.assertEqual(self.terminal.count("initialize"), 1)  # no second call for an error that is not about the keyword

    def test_capital_letters_do_not_let_a_replaced_word_through(self):
        self.assertRegex("Connection REFUSED", re.compile("|".join(self.replaced), re.IGNORECASE))  # the app ignores case
        self.terminal.init_raises = RuntimeError("Connection REFUSED, pipe Closed")
        self.assert_reaches_the_user(self.login_message())
        self.setUp()
        self.terminal.init_error = (-10005, "IPC Timeout")
        message = self.login_message()
        self.assertIn("did not answer within 5 seconds", message)
        self.assert_reaches_the_user(message)

    # ------------------------------------------------------------ which terminal was tried
    def test_the_saved_location_is_passed_to_metatrader_and_named_without_the_whole_path(self):
        path = self.use_terminal_file("Users", "someone", "MetaTrader 5 EXNESS", "terminal64.exe")
        message = self.login_message()
        name, args, kwargs = [call for call in self.terminal.calls if call[0] == "initialize"][0]
        self.assertEqual(args, (path,))
        self.assertEqual(kwargs, {"timeout": 5000})
        self.assertTrue(message.endswith('Terminal tried: "MetaTrader 5 EXNESS\\terminal64.exe". ' + self.version_note()), message)
        self.assertIn("did not answer within 5 seconds", message)
        self.assertNotIn("MetaTrader 4", message)
        self.assertNotIn("someone", message)
        self.assertNotIn(self.folder.name, message)

    def test_without_a_saved_location_the_message_says_so(self):
        message = self.login_message()
        name, args, kwargs = [call for call in self.terminal.calls if call[0] == "initialize"][0]
        self.assertEqual(args, ())
        self.assertIn("Terminal tried: the default MetaTrader 5 of this PC (no location is saved). Bridge version", message)

    def test_without_a_saved_location_the_bridge_attaches_to_the_metatrader_that_is_open(self):
        # Without a path the package takes the installation whose settings were saved last, open or not.
        exness = r"C:\Program Files\ExnessKE MT5 Terminal\terminal64.exe"
        self.running([exness])
        self.not_logged_in()
        self.account_as_metatrader_reports_it()
        self.bridge._ATTACH_STATE["wait_ms"] = self.bridge._START_ATTACH_WAIT_MS
        self.assertFalse(self.bridge.attach_terminal())  # the attach at bridge start
        self.bridge._ATTACH_STATE["wait_ms"] = self.bridge._LOGIN_ATTACH_WAIT_MS
        self.assertEqual(self.attach_calls(), [((exness,), {"timeout": 60000})])
        self.assertTrue(self.bridge._attach_failure_message().endswith(
            'Terminal tried: "ExnessKE MT5 Terminal\\terminal64.exe", the MetaTrader 5 that is open '
            "(no location is saved). " + self.version_note()))
        # Connect: the account goes to the same terminal
        self.assertEqual(self.bridge.handle_login(dict(LOGIN))["type"], "logged")
        self.assertEqual(self.attach_calls()[1:], [((exness,), {"timeout": 4000, "login": 123456, "password": "local-only", "server": "Exness-MT5Trial"})])

    def test_of_several_open_metatraders_the_one_exness_terminal_is_taken(self):
        other = r"C:\Program Files\MetaTrader 5\terminal64.exe"
        exness = r"C:\Program Files\ExnessKE MT5 Terminal\terminal64.exe"
        for open_now, taken, count in [
            ([other, exness], exness, 2),
            ([exness.upper(), exness], exness.upper(), 1),     # the same program listed twice is one
            ([other, "", exness], exness, 3),                  # one whose location Windows does not give
            ([other], other, 1),                               # the only one that is open, whatever its name
        ]:
            with self.subTest(open_now=open_now):
                self.running(open_now)
                self.assertEqual(self.bridge._open_terminal(), (taken, count))

    def test_when_the_bridge_cannot_tell_which_metatrader_is_meant_the_package_chooses_and_the_message_says_why(self):
        other = r"C:\Program Files\MetaTrader 5\terminal64.exe"
        second = r"D:\Other Broker MT5\terminal64.exe"
        exness = r"C:\Program Files\ExnessKE MT5 Terminal\terminal64.exe"
        cases = [
            ([other, second], "the default MetaTrader 5 of this PC (no location is saved and 2 MetaTrader 5 are open: "
                              "keep only the Exness one open, then run START_ALL_LOCAL.bat again). Bridge version"),
            ([exness, r"C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe"],
             "the default MetaTrader 5 of this PC (no location is saved and 2 MetaTrader 5 are open: "
             "keep only the Exness one open, then run START_ALL_LOCAL.bat again). Bridge version"),
            ([], "the default MetaTrader 5 of this PC (no location is saved and none was open). Bridge version"),
            ([""], "the default MetaTrader 5 of this PC (no location is saved). Bridge version"),
            (None, "the default MetaTrader 5 of this PC (no location is saved). Bridge version"),
        ]
        for open_now, label in cases:
            with self.subTest(open_now=open_now):
                self.setUp()
                self.running(open_now)
                message = self.login_message()
                self.assertEqual(self.attach_calls(), [((), {"timeout": 5000})])  # no path: the package chooses
                self.assertIn("Terminal tried: " + label, message)
                self.assert_reaches_the_user(message)

    def test_a_saved_location_is_used_whatever_is_open(self):
        path = self.use_terminal_file("ExnessKE MT5 Terminal", "terminal64.exe")
        asked = []
        self.bridge._running_terminals = lambda: asked.append(1) or [r"C:\Program Files\MetaTrader 5\terminal64.exe"]
        self.login_message()
        self.assertEqual(self.attach_calls(), [((path,), {"timeout": 5000})])
        self.assertEqual(asked, [])  # the bridge does not even look

    def test_the_look_up_of_running_metatraders_reads_windows_and_never_stands_in_the_way(self):
        import ctypes
        look_up = self.look_up
        # Not Windows, nothing to look with: "cannot look", and the attach goes on as before.
        if os.name != "nt":
            self.assertIsNone(look_up())

        # A stand-in for the Windows calls the look-up makes, with five processes of which three are MetaTrader 5.
        processes = [(4, "System", None), (812, "terminal64.exe", r"C:\Program Files\ExnessKE MT5 Terminal\terminal64.exe"),
                     (900, "chrome.exe", r"C:\chrome.exe"), (1200, "TERMINAL64.EXE", None),
                     (1300, "terminal.exe", r"C:\MetaTrader 4\terminal.exe"), (1400, "terminal64.exe", r"D:\MT5\terminal64.exe")]
        log = {"closed": [], "opened": [], "flags": None, "access": set(), "size": None}

        def give(reference, index):
            if index >= len(processes):
                return 0
            entry = reference._obj
            entry.th32ProcessID, entry.szExeFile = processes[index][0], processes[index][1]
            log["size"] = entry.dwSize
            return 1

        position = {"at": 0}

        def snapshot(flags, process_id):
            log["flags"] = (flags, process_id)
            return 77

        def first(handle, reference):
            position["at"] = 0
            return give(reference, 0)

        def following(handle, reference):
            position["at"] += 1
            return give(reference, position["at"])

        def open_process(access, inherit, process_id):
            log["access"].add((access, inherit))
            path = next(path for number, _, path in processes if number == process_id)
            if path is None:
                return None  # Windows does not let this process be opened
            log["opened"].append(process_id)
            return 1000 + process_id

        def image_name(handle, flags, buffer, size):
            path = next(path for number, _, path in processes if number == handle - 1000)
            self.assertGreaterEqual(size._obj.value, 260)
            buffer.value, size._obj.value = path, len(path)
            return 1

        windows = types.SimpleNamespace(
            CreateToolhelp32Snapshot=snapshot, Process32FirstW=first, Process32NextW=following,
            OpenProcess=open_process, QueryFullProcessImageNameW=image_name,
            CloseHandle=lambda handle: log["closed"].append(handle) or 1)
        self.assertEqual(look_up(windows), [r"C:\Program Files\ExnessKE MT5 Terminal\terminal64.exe", "", r"D:\MT5\terminal64.exe"])
        self.assertEqual(log["flags"], (2, 0))                 # TH32CS_SNAPPROCESS, every process
        self.assertEqual(log["access"], {(0x1000, False)})     # PROCESS_QUERY_LIMITED_INFORMATION: the path, nothing else
        self.assertEqual(log["opened"], [812, 1400])           # MetaTrader 4 and other programs are not opened
        self.assertEqual(log["closed"], [1812, 2400, 77])      # every handle is closed again, the snapshot last
        self.assertGreater(log["size"], 0)                     # the size Windows asks for is filled in
        # the types the calls are given, as Windows declares them
        self.assertIs(snapshot.restype, ctypes.wintypes.HANDLE)
        self.assertIs(open_process.restype, ctypes.wintypes.HANDLE)
        self.assertEqual(image_name.argtypes[2], ctypes.wintypes.LPWSTR)

        # The snapshot cannot be made, or a call raises: "cannot look", no exception.
        windows.CreateToolhelp32Snapshot = lambda flags, process_id: ctypes.c_void_p(-1).value
        self.assertIsNone(look_up(windows))
        windows.CreateToolhelp32Snapshot = lambda flags, process_id: 77
        windows.Process32FirstW = lambda handle, reference: (_ for _ in ()).throw(OSError("exception: access violation"))
        self.assertIsNone(look_up(windows))
        self.assertEqual(log["closed"][-1], 77)                # the snapshot is closed all the same

        # And the attach goes on without a path when the look-up itself fails.
        self.bridge._running_terminals = lambda: look_up(windows)
        self.login_message()
        self.assertEqual(self.attach_calls(), [((), {"timeout": 5000})])

    def test_the_record_windows_fills_in_has_the_layout_windows_gives_it(self):
        # PROCESSENTRY32W on 64-bit Windows: 568 bytes, the process number at 8, the program's name at 44. The
        # MetaTrader5 package passes the same record to the same calls with that size. Windows has 2-byte
        # characters and 4-byte DWORD and LONG, so the fields are laid out here with exactly those sizes.
        import ctypes
        record = self.bridge._PROCESS_RECORD
        self.assertEqual([name for name, _, _ in record],
                         ["dwSize", "cntUsage", "th32ProcessID", "th32DefaultHeapID", "th32ModuleID", "cntThreads",
                          "th32ParentProcessID", "pcPriClassBase", "dwFlags", "szExeFile"])
        for pointer, size, offsets in [(ctypes.c_uint64, 568, (8, 32, 44)), (ctypes.c_uint32, 556, (8, 24, 36))]:
            on_windows = {"DWORD": ctypes.c_uint32, "LONG": ctypes.c_int32, "ULONG_PTR": pointer, "WCHAR": ctypes.c_uint16}

            class Record(ctypes.Structure):
                _fields_ = [(name, on_windows[kind] * count if count > 1 else on_windows[kind]) for name, kind, count in record]

            self.assertEqual(ctypes.sizeof(Record), size)
            self.assertEqual((Record.th32ProcessID.offset, Record.th32ParentProcessID.offset, Record.szExeFile.offset), offsets)
        # the form the bridge makes of it has the same fields in the same order, and is made once
        made = self.bridge._process_entry()
        self.assertEqual([name for name, _ in made._fields_], [name for name, _, _ in record])
        self.assertIs(self.bridge._process_entry(), made)

    def test_a_saved_location_that_is_gone_is_named_and_metatrader_is_not_called(self):
        gone = str(Path(self.folder.name) / "Old Folder" / "terminal64.exe")
        self.bridge._CONFIGURED_MT5_PATH = gone
        self.bridge.CANDIDATE_PATHS = [gone]
        message = self.login_message()
        self.assertEqual(self.terminal.count("initialize"), 0)
        self.assertIn("the saved location of MetaTrader 5 does not exist any more", message)
        self.assertIn("Check AURUM_MT5_PATH (the location saved in bridge\\terminal_path.txt)", message)
        self.assertIn('Terminal tried: "Old Folder\\terminal64.exe".', message)
        self.assertNotIn("code ", message)
        self.assert_reaches_the_user(message)

    def test_metatrader_4_is_recognised_by_its_file_name(self):
        self.use_terminal_file("MetaTrader 4 EXNESS", "terminal.exe")
        self.terminal.init_error = (-10003, "IPC initialize failed, MetaTrader 5 x64 not found")
        message = self.login_message()
        self.assertIn("is MetaTrader 4, and this app needs MetaTrader 5", message)
        self.assertNotIn("no MetaTrader 5 desktop program was found", message)

    # ------------------------------------------------------------ how long, and how often
    def test_a_login_gives_metatrader_five_seconds_and_the_bridge_start_sixty(self):
        self.login_message()
        self.assertEqual(self.terminal.calls[-2][2], {"timeout": 5000})
        self.assertLess(self.bridge._LOGIN_ATTACH_WAIT_MS, 8000)  # the app waits 8 s for the answer

        self.setUp()
        self.bridge._ATTACH_STATE["wait_ms"] = self.bridge._START_ATTACH_WAIT_MS
        self.assertFalse(self.bridge.attach_terminal())
        self.assertEqual(self.terminal.calls[0][2], {"timeout": 60000})
        self.assertEqual(self.bridge._ATTACH_FAILURE["limit_s"], 60)
        self.assertIn("did not answer within 60 seconds", self.bridge._attach_failure_message())

        start = inspect.getsource(self.bridge.main)
        before, _, after = start.partition("attached = attach_terminal()")
        self.assertIn('_ATTACH_STATE["wait_ms"] = _START_ATTACH_WAIT_MS', before)
        self.assertIn('_ATTACH_STATE["wait_ms"] = _LOGIN_ATTACH_WAIT_MS', after.split("if attached:")[0])
        # a failed attach at the start is also explained in the bridge window, in the words the app shows
        not_attached = after.split("MT5 unavailable: local app remains available")[1].split("websockets.serve")[0]
        self.assertIn('log.error("%s", _attach_failure_message())', not_attached)

    def test_a_connector_without_the_timeout_keyword_is_called_the_way_it_was_before(self):
        path = self.use_terminal_file("MetaTrader 5 EXNESS", "terminal64.exe")
        self.terminal.takes_timeout = False
        message = self.login_message()
        attempts = [call for call in self.terminal.calls if call[0] == "initialize"]
        self.assertEqual([(args, kwargs) for _, args, kwargs in attempts], [((path,), {"timeout": 5000}), ((path,), {})])
        self.assertIn("code -10005", message)
        self.assertIn("did not answer within 60 seconds", message)  # the connector's own waiting time applied
        self.assertNotIn("invalid keyword", message)

        self.setUp()  # no saved location: the same, without a path
        self.terminal.takes_timeout = False
        self.terminal.init_ok = True
        self.assertTrue(self.bridge.attach_terminal())
        attempts = [call for call in self.terminal.calls if call[0] == "initialize"]
        self.assertEqual([(args, kwargs) for _, args, kwargs in attempts], [((), {"timeout": 5000}), ((), {})])
        self.assertIsNone(self.bridge._ATTACH_FAILURE)

        self.setUp()  # any other TypeError is reported, not hidden
        self.terminal.init_raises = TypeError("path must be str")
        message = self.login_message()
        self.assertEqual(self.terminal.count("initialize"), 2)
        self.assertIn("could not be contacted (step terminal, path must be str)", message)

    def test_a_login_that_finds_the_terminal_attached_by_another_request_carries_on_with_it(self):
        def attached_by_another_request(account=None):
            self.terminal.attached = True  # the other request's attach succeeded in the meantime
            return False  # ... and this request did not get the lock
        with unittest.mock.patch.object(self.bridge, "attach_terminal", attached_by_another_request):
            message = self.login_message()
        self.assertEqual(self.terminal.count("initialize"), 0)
        self.assertEqual(self.terminal.count("login"), 1)
        self.assertIn("(step login, code -6", message)
        self.assertNotIn("Cannot attach", message)

        self.setUp()  # no attach running, none failed, and still no terminal: said as it is
        with unittest.mock.patch.object(self.bridge, "attach_terminal", lambda account=None: False):
            message = self.login_message()
        self.assertEqual(self.terminal.count("login"), 0)
        self.assertIn("MT5 terminal not responding (step terminal, code -10004: No IPC connection)", message)

        self.setUp()  # the other request's attach began just after this login looked: answered, not left waiting
        def lock_taken_by_another_request(account=None):
            self.assertEqual(account, ACCOUNT)  # a login offers its account to the attach
            self.assertTrue(self.bridge._ATTACH_LOCK.acquire(blocking=False))
            return False
        try:
            with unittest.mock.patch.object(self.bridge, "attach_terminal", lock_taken_by_another_request):
                message = self.login_message()
        finally:
            self.bridge._ATTACH_LOCK.release()
        self.assertIn("still contacting MetaTrader 5", message)
        self.assertEqual([call[0] for call in self.terminal.calls], ["terminal_info"])

    def test_the_repeat_the_app_sends_at_once_gets_the_same_answer_without_a_second_attempt(self):
        first = self.login_message()
        second = self.login_message()
        self.assertEqual(first, second)
        self.assertEqual(self.terminal.count("initialize"), 1)
        # once the quiet time is over a login tries again
        self.bridge._ATTACH_FAILURE["at"] = time.time() - self.bridge._ATTACH_REPEAT_QUIET_S - 0.1
        self.terminal.init_error = (-5, "Terminal: Invalid version")
        third = self.login_message()
        self.assertEqual(self.terminal.count("initialize"), 2)
        self.assertIn("code -5", third)

    def test_a_login_during_an_attach_is_answered_at_once_and_leaves_metatrader_alone(self):
        self.bridge._ATTACH_STATE.update(since=time.time() - 10, limit_s=60.0)
        self.assertTrue(self.bridge._ATTACH_LOCK.acquire(blocking=False))
        try:
            message = self.login_message()
            self.assertFalse(self.bridge.attach_terminal())
        finally:
            self.bridge._ATTACH_LOCK.release()
        self.assertEqual(self.terminal.calls, [])
        self.assertIn("still contacting MetaTrader 5", message)
        self.assertRegex(message, r"Press Connect again in about (49|50|51) seconds\.")
        self.assert_reaches_the_user(message)
        self.assertIsNone(self.bridge._attach_busy_message())
        self.assertFalse(self.bridge._ATTACH_LOCK.locked())

    def test_a_second_login_while_metatrader_is_being_contacted_is_told_how_long_that_can_take(self):
        answers = []
        self.terminal.while_initializing = lambda: answers.append(self.bridge.handle_login(dict(LOGIN))["message"])
        outer = self.login_message()
        self.assertEqual(len(answers), 1)
        self.assertTrue(answers[0].endswith("Press Connect again in about 5 seconds."), answers[0])
        self.assertIn("did not answer within 5 seconds", outer)
        # the second request made no call of its own: one terminal_info, one initialize, one shutdown
        self.assertEqual([call[0] for call in self.terminal.calls], ["terminal_info", "initialize", "shutdown"])

        self.setUp()  # the attach at bridge start may take a minute
        self.bridge._ATTACH_STATE["wait_ms"] = self.bridge._START_ATTACH_WAIT_MS
        answers.clear()
        self.terminal.while_initializing = lambda: answers.append(self.bridge.handle_login(dict(LOGIN))["message"])
        self.assertFalse(self.bridge.attach_terminal())
        self.assertTrue(answers[0].endswith("Press Connect again in about 60 seconds."), answers[0])
        self.assertEqual([call[0] for call in self.terminal.calls], ["initialize", "shutdown"])

    def test_a_login_during_an_attach_without_a_known_end_says_in_a_moment(self):
        for state in ({"since": 0.0, "limit_s": 60.0}, {"since": time.time() - 90, "limit_s": 60.0}):
            with self.subTest(state=state):
                self.bridge._ATTACH_STATE.update(state)
                self.assertTrue(self.bridge._ATTACH_LOCK.acquire(blocking=False))
                try:
                    message = self.login_message()
                finally:
                    self.bridge._ATTACH_LOCK.release()
                self.assertTrue(message.endswith("Press Connect again in a moment."), message)

    def test_the_message_names_seconds_only_from_two_upwards(self):
        for gone, ending in ((2.0, "Press Connect again in about 3 seconds."), (3.0, "Press Connect again in about 2 seconds."),
                             (4.0, "Press Connect again in a moment."), (4.9, "Press Connect again in a moment.")):
            with self.subTest(gone=gone):
                self.bridge._ATTACH_STATE.update(since=time.time() - gone, limit_s=5.0)
                self.assertTrue(self.bridge._ATTACH_LOCK.acquire(blocking=False))
                try:
                    message = self.login_message()
                finally:
                    self.bridge._ATTACH_LOCK.release()
                self.assertTrue(message.endswith(ending), message)

    def test_the_lock_is_free_again_after_an_attach_whatever_its_result(self):
        self.assertFalse(self.bridge.attach_terminal())
        self.assertFalse(self.bridge._ATTACH_LOCK.locked())
        self.assertEqual(self.bridge._ATTACH_STATE["since"], 0.0)
        self.bridge._ATTACH_FAILURE = None
        self.terminal.init_ok = True
        self.assertTrue(self.bridge.attach_terminal())
        self.assertFalse(self.bridge._ATTACH_LOCK.locked())

    # ------------------------------------------------------------ after the attach
    def test_a_successful_attach_clears_the_old_reason_and_goes_on_to_the_login(self):
        self.login_message()
        self.assertIsNotNone(self.bridge._ATTACH_FAILURE)
        self.bridge._ATTACH_FAILURE["at"] = 0.0
        self.terminal.init_ok = True
        self.terminal.login_error = (-10005, "IPC timeout")
        message = self.login_message()
        self.assertIsNone(self.bridge._ATTACH_FAILURE)
        self.assertEqual(self.terminal.count("login"), 1)
        self.assertEqual(self.terminal.calls[-1][2], {"server": LOGIN["server"]})
        self.assertIn("MT5 rejected the credentials (step login, code -10005: IPC time-out)", message)
        self.assert_reaches_the_user(message)

    def local_config(self, port):
        """Ask the bridge's own page server for /local-config the way the PC page does."""
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        try:
            connection.putrequest("GET", "/local-config", skip_host=True)
            connection.putheader("Host", "127.0.0.1:8788")
            connection.endheaders()
            response = connection.getresponse()
            return response.status, json.loads(response.read().decode("utf-8"))
        finally:
            connection.close()

    def test_the_page_server_leaves_metatrader_alone_while_an_attach_is_running(self):
        self.bridge.HOST = "127.0.0.1"
        server = self.bridge._start_http_app(0)
        self.assertIsNotNone(server)
        try:
            port = server.server_address[1]
            self.terminal.account = types.SimpleNamespace(server="Exness-MT5Trial")
            status, body = self.local_config(port)
            self.assertEqual((status, body["exnessServer"]), (200, "Exness-MT5Trial"))
            self.assertEqual(self.terminal.count("account_info"), 1)

            self.assertTrue(self.bridge._ATTACH_LOCK.acquire(blocking=False))
            try:
                status, body = self.local_config(port)
            finally:
                self.bridge._ATTACH_LOCK.release()
            self.assertEqual((status, body["exnessServer"]), (200, ""))
            self.assertEqual(self.terminal.count("account_info"), 1)  # no second call
            self.assertIn("bridgeToken", body)
        finally:
            server.shutdown()
            server.server_close()

    def test_an_attached_terminal_is_reused_without_a_new_attach(self):
        self.terminal.attached = True
        message = self.login_message()
        self.assertEqual(self.terminal.count("initialize"), 0)
        self.assertIn("(step login, code -6", message)

    def test_a_terminal_that_falls_silent_after_the_attach_is_reported_in_words_the_app_shows(self):
        self.terminal.init_ok = True
        self.terminal.silent_after_attach = (-10005, "IPC timeout")
        message = self.login_message()
        self.assertEqual(self.terminal.count("initialize"), 1)
        self.assertEqual(self.terminal.count("login"), 0)
        self.assertIn("MT5 terminal not responding (step terminal, code -10005: IPC time-out)", message)
        self.assert_reaches_the_user(message)

    def test_missing_account_details_after_the_login_are_reported_in_words_the_app_shows(self):
        self.terminal.attached = True
        self.terminal.login_ok = True
        message = self.login_message()
        self.assertEqual(self.terminal.count("login"), 1)
        self.assertIn("Logged in but account info unavailable (step account, code -10005: IPC time-out)", message)
        self.assert_reaches_the_user(message)
        self.assertIsNone(self.bridge._LOCKED_LOGIN)


if __name__ == "__main__":
    unittest.main()
