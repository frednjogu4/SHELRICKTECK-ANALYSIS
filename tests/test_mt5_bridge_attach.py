"""What the PC bridge tells the app when it cannot attach to MetaTrader 5.

The MetaTrader5 package exists for Windows only, so these tests load
bridge/mt5_bridge.py against a stand-in module. The stand-in keeps a "last
error" the way the package documents it: every call sets it, a successful call
sets (1, 'Success'). That is the behaviour that made the bridge report
"code 1: Success" for a failed attach: it read the error after mt5.shutdown().

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
        terminal.calls = []
        bridge._ATTACH_FAILURE = None
        bridge._ATTACH_STATE.update(wait_ms=bridge._LOGIN_ATTACH_WAIT_MS, since=0.0, limit_s=0.0)
        bridge._CONFIGURED_MT5_PATH = ""
        bridge.CANDIDATE_PATHS = [None]
        bridge._LOCKED_LOGIN = None
        bridge._LOCKED_SERVER = None

    def tearDown(self):
        logging.disable(logging.NOTSET)

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
            ((-6, "Terminal: Authorization failed"), "not logged in to a trading account", "File > Login to Trade Account"),
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

    def test_a_terminal_that_is_not_logged_in_gets_the_login_step_and_what_to_do_if_it_is_logged_in(self):
        self.terminal.init_error = (-6, "Terminal: Authorization failed")
        message = self.login_message()
        self.assertIn("Do this: 1) in MetaTrader 5 use File > Login to Trade Account (account number, password and the "
                      "exact server) and wait until the bottom-right corner shows a connection speed and not "
                      "'No connection'; 2) press Connect again.", message)
        self.assertIn("If MetaTrader 5 shows your account already: start MetaTrader 5 with a normal double-click, "
                      "not 'Run as administrator', keep only that one MetaTrader 5 open, then run START_ALL_LOCAL.bat again.",
                      message)
        self.assertTrue(message.endswith("Terminal tried: the default MetaTrader 5 of this PC (no location is saved)."))
        self.assert_reaches_the_user(message)

    def test_the_code_alone_or_the_text_alone_is_enough_to_recognise_a_failure(self):
        cases = [
            ((-6, "something else"), "not logged in to a trading account"),
            ((-1, "Terminal: Authorization failed"), "not logged in to a trading account"),
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
        self.assertTrue(message.endswith('Terminal tried: "MetaTrader 5 EXNESS\\terminal64.exe".'), message)
        self.assertIn("did not answer within 5 seconds", message)
        self.assertNotIn("MetaTrader 4", message)
        self.assertNotIn("someone", message)
        self.assertNotIn(self.folder.name, message)

    def test_without_a_saved_location_the_message_says_so(self):
        message = self.login_message()
        name, args, kwargs = [call for call in self.terminal.calls if call[0] == "initialize"][0]
        self.assertEqual(args, ())
        self.assertIn("Terminal tried: the default MetaTrader 5 of this PC (no location is saved).", message)

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
        def attached_by_another_request():
            self.terminal.attached = True  # the other request's attach succeeded in the meantime
            return False  # ... and this request did not get the lock
        with unittest.mock.patch.object(self.bridge, "attach_terminal", attached_by_another_request):
            message = self.login_message()
        self.assertEqual(self.terminal.count("initialize"), 0)
        self.assertEqual(self.terminal.count("login"), 1)
        self.assertIn("(step login, code -6", message)
        self.assertNotIn("Cannot attach", message)

        self.setUp()  # no attach running, none failed, and still no terminal: said as it is
        with unittest.mock.patch.object(self.bridge, "attach_terminal", lambda: False):
            message = self.login_message()
        self.assertEqual(self.terminal.count("login"), 0)
        self.assertIn("MT5 terminal not responding (step terminal, code -10004: No IPC connection)", message)

        self.setUp()  # the other request's attach began just after this login looked: answered, not left waiting
        def lock_taken_by_another_request():
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
        self.terminal.init_error = (-6, "Terminal: Authorization failed")
        third = self.login_message()
        self.assertEqual(self.terminal.count("initialize"), 2)
        self.assertIn("code -6", third)

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
