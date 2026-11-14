"""The PC bridge against a model of what the MetaTrader5 package really does.

tests/test_mt5_bridge_attach.py uses a stand-in that answers whatever a test
tells it to answer. The model in this file follows the package itself: the
Windows file MetaTrader5/_core.cp313-win_amd64.pyd of version 5.0.6231 (the
version bridge/requirements.txt names), read with a disassembler. What was
read there, and what the model therefore does:

initialize(path, login=, password=, server=, timeout=, portable=)
  1. Arguments. At most one unnamed argument, the path. The named ones are
     looked up by name: login (an int), server and password (text under 255
     characters), timeout (an int), path, portable. A wrong one gives False
     with last_error() (-2, 'Invalid "login" argument') and so on. Nothing is
     raised, and a name the package does not know is not looked at.
  2. Which terminal. With a path: that one. Without a path: every folder under
     %APPDATA%\\MetaQuotes\\Terminal is one installation; the one whose
     config\\accounts.dat or config\\terminal.ini was written last is taken.
     Whether it is running plays no part. None at all: (-10003, "IPC
     initialize failed, MetaTrader 5 x64 not found").
  3. The connection. The terminal's pipe is opened. When there is none the
     terminal is started and its pipe is tried every half second, 200 times,
     whatever 'timeout' says.
  4. With a login, password or server: MetaTrader 5 is sent a login for them.
     A refusal ends initialize() with MetaTrader's code; -7 has the text
     "Unsupported authorization mode, OTP or certificate password needed".
  5. The wait. Every tenth of a second MetaTrader 5 is asked for its state,
     for 'timeout' milliseconds (60 000 when 0 or not given). State 2 ends it
     with True, state 3 with (-6, "Terminal: Authorization failed"). When the
     time is up: (-10005, "IPC timeout"). MetaTrader 5 is not told to stop.
  6. A failure at 4 or 5 closes the connection.

login(login, password=, server=, timeout=) does 4 and 5 on the open connection
and leaves it open when it fails; without a connection it answers (-10004, "No
IPC connection"). shutdown() closes the connection and sets last_error() to
(1, "Success"), as every call does when it begins.

What the model cannot know is MetaTrader 5 itself: when its state is 2 or 3,
and how long a login takes. A terminal here is "not logged in" (state 3) until
it is given an account its broker accepts, and a login takes the time a test
gives it. A real terminal has not been run: it exists for Windows only.

Nothing here contacts a terminal, a broker or the network, and nothing asserts
what a trade analysis concludes.
"""
import importlib.util
import logging
import os
import sys
import tempfile
import time
import types
import unittest
import unittest.mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BRIDGE_DIR = ROOT / "bridge"
FOLDER = tempfile.TemporaryDirectory()  # stands for "Program Files": the terminals are files that exist


def installed(*parts):
    path = Path(FOLDER.name).joinpath(*parts)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"")
    return str(path)


EXNESS = installed("ExnessKE MT5 Terminal", "terminal64.exe")
OTHER = installed("MetaTrader 5", "terminal64.exe")
LOGIN = {"login": 123456, "password": "local-only", "server": "Exness-MT5Trial"}
ACCOUNT = (LOGIN["login"], LOGIN["password"], LOGIN["server"])

CONNECTING, AUTHORIZED, FAILED = 1, 2, 3  # the state MetaTrader 5 reports: only 2 and 3 end the package's wait


class Terminal:
    """One installed MetaTrader 5."""

    def __init__(self, path, running=True, accepts=None, login_takes=0.0, settings_saved=0, company="Exness (KE) Limited"):
        self.path = path
        self.running = running
        self.accepts = accepts              # the (login, password, server) its broker accepts
        self.login_takes = login_takes      # seconds from a login to MetaTrader's answer to it
        self.settings_saved = settings_saved  # when its settings were last written: the package's choice without a path
        self.company = company
        self.starts_in = 3.0                # seconds from being started to having a pipe
        self.state = FAILED                 # open, logged in to no account
        self.account = None                 # the (login, server) it is logged in to
        self.needs_one_time_password = False
        self.started = 0                    # how often the package started it
        self.logins = []                    # every login it was sent
        self.decision = None                # (when, state, account) of a login that is under way

    def log_in(self, login, password, server, now):
        """A login arrives. MetaTrader 5 answers that it has it, and works on it."""
        if self.needs_one_time_password:
            return -7
        self.logins.append((login, password, server))
        accepted = (login, password, server) == self.accepts
        self.state, self.account = CONNECTING, None
        self.decision = (now + self.login_takes, AUTHORIZED if accepted else FAILED, (login, server) if accepted else None)
        return 1

    def state_at(self, now):
        if self.decision is not None and now >= self.decision[0]:
            _, self.state, self.account = self.decision
            self.decision = None
        return self.state


class ConnectorModel(types.ModuleType):
    """MetaTrader5 5.0.6231: initialize(), login(), shutdown() and what the bridge reads after them."""

    def __init__(self):
        super().__init__("MetaTrader5")
        self.terminals = []
        self.now = 1000.0        # seconds; the package's waiting moves it on
        self.connection = None   # the terminal whose pipe is open
        self.error = (1, "Success")
        self.calls = []

    # ---- the PC
    def install(self, terminal):
        self.terminals.append(terminal)
        return terminal

    def running(self):
        """What Windows lists: the path of every MetaTrader 5 that is running."""
        return [terminal.path for terminal in self.terminals if terminal.running]

    # ---- the package
    def _fail(self, code, text, close=False):
        if close:
            self.connection = None
        self.error = (code, text)
        return False

    @staticmethod
    def _text(value, limit):
        return isinstance(value, str) and len(value) < limit

    def initialize(self, *args, **kwargs):
        self.calls.append(("initialize", args, dict(kwargs)))
        self.error, self.connection = (1, "Success"), None
        if len(args) > 1:
            return self._fail(-2, "Invalid number of arguments")
        path = ""
        if args:
            if not self._text(args[0], 259):
                return self._fail(-2, "Invalid 1st unnamed argument")
            path = args[0]
        login, server, password, timeout = 0, "", "", 0
        if "login" in kwargs:
            if not isinstance(kwargs["login"], int) or kwargs["login"] < 0:
                return self._fail(-2, 'Invalid "login" argument')
            login = kwargs["login"]
        if "server" in kwargs:
            if not self._text(kwargs["server"], 255):
                return self._fail(-2, 'Invalid "server" argument')
            server = kwargs["server"]
        if "password" in kwargs:
            if not self._text(kwargs["password"], 255):
                return self._fail(-2, 'Invalid "password" argument')
            password = kwargs["password"]
        if "timeout" in kwargs:
            if not isinstance(kwargs["timeout"], int) or kwargs["timeout"] < 0:
                return self._fail(-2, 'Invalid "timeout" argument')
            timeout = kwargs["timeout"]
        if "path" in kwargs:
            if not self._text(kwargs["path"], 259):
                return self._fail(-2, 'Invalid "path" argument')
            path = kwargs["path"]

        if path:
            terminal = next((t for t in self.terminals if t.path.lower() == path.lower()), None)
            if terminal is None:
                return self._fail(-10003, f"IPC initialize failed, Process create failed '{path}'")
        else:
            if not self.terminals:
                return self._fail(-10003, "IPC initialize failed, MetaTrader 5 x64 not found")
            terminal = max(self.terminals, key=lambda t: t.settings_saved)  # running or not

        if not terminal.running:  # started, and waited for without regard to 'timeout'
            terminal.running, terminal.started = True, terminal.started + 1
            if terminal.starts_in > 100:
                self.now += 100
                return self._fail(-10003, "IPC initialize failed, Pipe server didn't answer in 60 sec")
            self.now += terminal.starts_in
        self.connection = terminal

        if login or password or server:
            answer = terminal.log_in(login, password, server, self.now)
            if answer < 0:
                return self._refused(answer)
        return self._wait(timeout, close=True)

    def _refused(self, answer, close=True):
        if answer == -7:
            return self._fail(-7, "Unsupported authorization mode, OTP or certificate password needed", close)
        return self._fail(answer, "Terminal: Call failed", close)

    def _wait(self, timeout, close):
        waited, limit = 0, timeout or 60000
        while waited < limit:
            state = self.connection.state_at(self.now)
            if state == AUTHORIZED:
                self.error = (1, "Success")
                return True
            if state == FAILED:
                return self._fail(-6, "Terminal: Authorization failed", close)
            self.now += 0.1
            waited += 100
        return self._fail(-10005, "IPC timeout", close)

    def login(self, *args, **kwargs):
        self.calls.append(("login", args, {"server": kwargs.get("server")}))
        self.error = (1, "Success")
        if self.connection is None:
            return self._fail(-10004, "No IPC connection")
        answer = self.connection.log_in(args[0], kwargs.get("password", ""), kwargs.get("server", ""), self.now)
        if answer < 0:
            return self._refused(answer, close=False)
        return self._wait(kwargs.get("timeout", 0), close=False)

    def shutdown(self):
        self.calls.append(("shutdown", (), {}))
        self.error, self.connection = (1, "Success"), None
        return True

    def last_error(self):
        return self.error

    def terminal_info(self):
        if self.connection is None:
            self.error = (-10004, "No IPC connection")
            return None
        self.error = (1, "Success")
        return types.SimpleNamespace(trade_allowed=False, name="MetaTrader 5", path=os.path.dirname(self.connection.path))

    def account_info(self):
        terminal = self.connection
        if terminal is None or terminal.state_at(self.now) != AUTHORIZED:
            self.error = (-10004, "No IPC connection") if terminal is None else (-1, "Terminal: Call failed")
            return None
        self.error = (1, "Success")
        number, server = terminal.account
        return types.SimpleNamespace(login=number, server=server, company=terminal.company, currency="USD",
                                     balance=250.0, equity=250.0, margin_free=250.0, leverage=200)

    def initializes(self):
        return [(args, kwargs) for name, args, kwargs in self.calls if name == "initialize"]

    def count(self, name):
        return sum(1 for call in self.calls if call[0] == name)


class BridgeAgainstTheConnectorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original_modules = {name: sys.modules.get(name) for name in ("MetaTrader5", "websockets")}
        cls.original_env = os.environ.pop("AURUM_MT5_PATH", None)
        sys.path.insert(0, str(BRIDGE_DIR))
        cls.connector = ConnectorModel()
        fake_websockets = types.ModuleType("websockets")
        fake_websockets.exceptions = types.SimpleNamespace(ConnectionClosed=type("ConnectionClosed", (Exception,), {}))
        sys.modules["MetaTrader5"] = cls.connector
        sys.modules["websockets"] = fake_websockets
        spec = importlib.util.spec_from_file_location("mt5_bridge_connector_under_test", BRIDGE_DIR / "mt5_bridge.py")
        cls.bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.bridge)
        cls.look_up = staticmethod(cls.bridge._running_terminals)

    @classmethod
    def tearDownClass(cls):
        sys.path.remove(str(BRIDGE_DIR))
        for name, old in cls.original_modules.items():
            if old is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = old
        sys.modules.pop("mt5_bridge_connector_under_test", None)
        if cls.original_env is not None:
            os.environ["AURUM_MT5_PATH"] = cls.original_env
        FOLDER.cleanup()

    def setUp(self):
        logging.disable(logging.CRITICAL)
        connector, bridge = self.connector, self.bridge
        connector.terminals, connector.now, connector.connection = [], 1000.0, None
        connector.error, connector.calls = (1, "Success"), []
        bridge._ATTACH_FAILURE = None
        bridge._CONNECTOR_TAKES_TIMEOUT = True
        bridge._ATTACH_STATE.update(wait_ms=bridge._LOGIN_ATTACH_WAIT_MS, since=0.0, limit_s=0.0)
        bridge._CONFIGURED_MT5_PATH = ""
        bridge.CANDIDATE_PATHS = [None]
        bridge._LOCKED_LOGIN = None
        bridge._LOCKED_SERVER = None
        bridge._running_terminals = connector.running  # the bridge sees what is running on the model's PC
        clock = unittest.mock.patch.object(bridge, "_now", lambda: connector.now)  # and has the model's clock
        clock.start()
        self.addCleanup(clock.stop)

    def tearDown(self):
        logging.disable(logging.NOTSET)
        self.bridge._running_terminals = self.look_up

    # ------------------------------------------------------------ helpers
    def exness(self, **how):
        """The Exness terminal: installed, open, logged in to no account, and its broker accepts ACCOUNT."""
        how.setdefault("accepts", ACCOUNT)
        return self.connector.install(Terminal(EXNESS, **how))

    def save_location(self, path):
        """What the launcher does when it finds one MetaTrader 5 running: bridge\\terminal_path.txt."""
        self.bridge._CONFIGURED_MT5_PATH = path
        self.bridge.CANDIDATE_PATHS = [path]

    def bridge_starts(self):
        bridge = self.bridge
        bridge._ATTACH_STATE["wait_ms"] = bridge._START_ATTACH_WAIT_MS
        attached = bridge.attach_terminal()
        bridge._ATTACH_STATE["wait_ms"] = bridge._LOGIN_ATTACH_WAIT_MS
        return attached

    def connect(self, **other):
        """Connect is pressed. Returns the bridge's answer and how long the bridge took over it."""
        began = self.connector.now
        reply = self.bridge.handle_login({**LOGIN, **other})
        return reply, round(self.connector.now - began, 3)

    def a_few_seconds_later(self, seconds=5.0):
        """The person waits before pressing Connect again: MetaTrader 5 goes on, and the quiet time is over."""
        self.connector.now += seconds
        if self.bridge._ATTACH_FAILURE is not None:
            self.bridge._ATTACH_FAILURE["at"] = time.time() - self.bridge._ATTACH_REPEAT_QUIET_S - 0.1

    # ------------------------------------------------------------ the case on the PC
    def test_connect_logs_in_a_metatrader_that_is_open_and_logged_in_to_no_account(self):
        terminal = self.exness(login_takes=2.5)
        self.save_location(EXNESS)
        self.assertFalse(self.bridge_starts())
        self.assertEqual(self.bridge._ATTACH_FAILURE["code"], -6)  # MetaTrader's own answer, at once
        self.assertEqual(self.connector.initializes(), [((EXNESS,), {"timeout": 60000})])
        self.assertIn("Press Connect in the app with the account number, the password and the exact server",
                      self.bridge._attach_failure_message())

        reply, took = self.connect()
        self.assertEqual(reply["type"], "logged", reply)
        self.assertEqual(self.connector.initializes()[1:], [((EXNESS,), {"timeout": 4000, **LOGIN})])
        self.assertEqual(terminal.logins, [ACCOUNT])  # MetaTrader 5 was sent one login, not two
        self.assertEqual(self.connector.count("login"), 0)
        # one login's time: inside the 6 seconds the app gives the answer to a login over its socket
        self.assertAlmostEqual(took, 2.5, places=1)
        self.assertLess(took, 6.0)
        self.assertEqual(reply["server"], "Exness-MT5Trial")
        self.assertEqual((self.bridge._LOCKED_LOGIN, self.bridge._LOCKED_SERVER), (123456, "Exness-MT5Trial"))
        self.assertEqual(terminal.started, 0)  # it was open: nothing was started

    def test_what_the_bridge_passes_is_what_the_package_takes(self):
        # the account number as a number, the other two as text, the waiting time as a whole number of milliseconds
        self.exness()
        self.save_location(EXNESS)
        self.bridge_starts()
        reply, _ = self.connect(login="123456")  # the app sends what was typed
        self.assertEqual(reply["type"], "logged", reply)
        args, named = self.connector.initializes()[-1]
        self.assertEqual((type(named["login"]), type(named["password"]), type(named["server"]), type(named["timeout"])),
                         (int, str, str, int))
        # the package itself: a name it does not know is not looked at, a wrong value is refused without an exception
        self.connector.shutdown()
        self.assertFalse(self.connector.initialize(EXNESS, login="123456", password="x", server="y"))
        self.assertEqual(self.connector.last_error(), (-2, 'Invalid "login" argument'))
        self.assertFalse(self.connector.initialize(EXNESS, "second"))
        self.assertEqual(self.connector.last_error(), (-2, "Invalid number of arguments"))
        self.assertTrue(self.connector.initialize(EXNESS, not_a_name_of_the_package=1, **LOGIN))

    def test_a_login_that_takes_longer_than_four_seconds_succeeds_at_the_next_press(self):
        terminal = self.exness(login_takes=7.0)
        self.save_location(EXNESS)
        self.bridge_starts()
        reply, took = self.connect()
        self.assertEqual(reply["type"], "error")
        self.assertAlmostEqual(took, 4.0, places=1)
        self.assertIn("was given the account number, password and server entered in the app and had not finished "
                      "logging in after 4 seconds (step terminal, code -10005: IPC time-out). Give it a few more seconds.",
                      reply["message"])
        # the repeat the app sends at once gets the same words and leaves MetaTrader 5 alone
        again, took = self.connect()
        self.assertEqual((again["message"], took), (reply["message"], 0))
        self.assertEqual(terminal.logins, [ACCOUNT])

        # MetaTrader 5 goes on logging in. The next press finds it logged in: an attach without an account.
        self.a_few_seconds_later(5.0)
        reply, took = self.connect()
        self.assertEqual(reply["type"], "logged", reply)
        self.assertEqual(self.connector.initializes()[-1], ((EXNESS,), {"timeout": 5000}))
        # that attach did not carry the account, so MetaTrader's own login() follows it, as it always did
        self.assertEqual(self.connector.count("login"), 1)
        self.assertEqual(terminal.logins, [ACCOUNT, ACCOUNT])

    def test_a_press_while_metatrader_is_still_logging_in_sends_nothing_new_and_says_the_same(self):
        # Pressed again too early: MetaTrader 5 is neither logged in nor refused, so the attach without an
        # account ends with a time-out too. Only "not logged in" leads to the account: nothing new is sent,
        # and the message is still the one about the login that is under way.
        terminal = self.exness(login_takes=30.0)
        self.save_location(EXNESS)
        self.bridge_starts()
        first, _ = self.connect()
        for _ in range(2):
            self.a_few_seconds_later(2.0)
            reply, took = self.connect()
            self.assertEqual(reply["type"], "error")
            self.assertEqual(reply["message"], first["message"].replace("after 4 seconds", "after 5 seconds"))
            self.assertAlmostEqual(took, 5.0, places=1)
        self.assertEqual(terminal.logins, [ACCOUNT])
        self.assertEqual(self.connector.initializes()[-1], ((EXNESS,), {"timeout": 5000}))

        # MetaTrader 5 refuses the account in the end: the next press hears "not logged in" and gives it once more
        terminal.decision = (self.connector.now, FAILED, None)
        self.a_few_seconds_later(1.0)
        terminal.accepts, terminal.login_takes = ACCOUNT, 1.0
        reply, _ = self.connect()
        self.assertEqual(reply["type"], "logged", reply)
        self.assertEqual(terminal.logins, [ACCOUNT, ACCOUNT])

    def test_a_wrong_password_is_reported_as_not_accepted(self):
        terminal = self.exness(login_takes=1.5)
        self.save_location(EXNESS)
        self.bridge_starts()
        reply, took = self.connect(password="not the password")
        self.assertEqual(reply["type"], "error")
        self.assertIn("did not log in with the account number, password and server entered in the app", reply["message"])
        self.assertIn("code -6: Terminal: Authorization failed", reply["message"])
        self.assertNotIn("not the password", reply["message"])
        self.assertAlmostEqual(took, 1.5, places=1)
        self.assertIsNone(self.bridge._LOCKED_LOGIN)

        # put right: the account goes to MetaTrader 5 again, and this time it logs in
        self.a_few_seconds_later()
        reply, _ = self.connect()
        self.assertEqual(reply["type"], "logged", reply)
        self.assertEqual(terminal.logins, [(123456, "not the password", "Exness-MT5Trial"), ACCOUNT])

    def test_a_server_name_metatrader_does_not_know_is_not_accepted_either(self):
        self.exness()
        self.save_location(EXNESS)
        self.bridge_starts()
        reply, _ = self.connect(server="Exness-MT5Real")
        self.assertIn("did not log in with the account number, password and server entered in the app", reply["message"])

    def test_an_account_with_a_one_time_password_cannot_be_logged_in_by_the_app(self):
        terminal = self.exness()
        terminal.needs_one_time_password = True
        self.save_location(EXNESS)
        self.bridge_starts()
        reply, _ = self.connect()
        self.assertIn("asks for a one-time password or a certificate", reply["message"])
        self.assertIn("code -7: Unsupported authorization mode, OTP or certificate password needed", reply["message"])
        self.assertIn("Log in inside MetaTrader 5 yourself", reply["message"])

    def test_a_metatrader_that_is_logged_in_already_is_attached_at_the_start_and_connect_logs_in_as_always(self):
        terminal = self.exness(login_takes=1.0)
        terminal.state, terminal.account = AUTHORIZED, (123456, "Exness-MT5Trial")
        self.save_location(EXNESS)
        self.assertTrue(self.bridge_starts())
        reply, took = self.connect()
        self.assertEqual(reply["type"], "logged", reply)
        self.assertEqual(len(self.connector.initializes()), 1)  # the terminal attached at the start is reused
        self.assertEqual(self.connector.count("login"), 1)      # MetaTrader's own login(), as before
        self.assertAlmostEqual(took, 1.0, places=1)

    # ------------------------------------------------------------ no saved location
    def test_without_a_saved_location_the_package_would_take_the_metatrader_used_last_and_the_bridge_takes_the_open_one(self):
        # Two MetaTrader 5 on the PC. The Exness one is open; the other one was used last and is not running.
        exness = self.exness(login_takes=2.0, settings_saved=10)
        other = self.connector.install(Terminal(OTHER, running=False, settings_saved=20, company="Another Broker Ltd"))

        # the package on its own: it starts the other one and waits for it
        self.assertFalse(self.connector.initialize(timeout=4000, **LOGIN))
        self.assertEqual((other.started, other.logins, exness.logins), (1, [ACCOUNT], []))

        # the bridge: the one that is open
        self.setUp()
        exness = self.exness(login_takes=2.0, settings_saved=10)
        other = self.connector.install(Terminal(OTHER, running=False, settings_saved=20, company="Another Broker Ltd"))
        self.assertFalse(self.bridge_starts())
        self.assertEqual(self.connector.initializes(), [((EXNESS,), {"timeout": 60000})])
        self.assertIn('Terminal tried: "ExnessKE MT5 Terminal\\terminal64.exe", the MetaTrader 5 that is open '
                      "(no location is saved).", self.bridge._attach_failure_message())
        reply, took = self.connect()
        self.assertEqual(reply["type"], "logged", reply)
        self.assertEqual((other.started, other.logins, exness.logins), (0, [], [ACCOUNT]))
        self.assertAlmostEqual(took, 2.0, places=1)

    def test_two_open_metatraders_of_which_one_is_the_exness_terminal(self):
        exness = self.exness(settings_saved=10)
        other = self.connector.install(Terminal(OTHER, running=True, settings_saved=20, company="Another Broker Ltd"))
        self.bridge_starts()
        reply, _ = self.connect()
        self.assertEqual(reply["type"], "logged", reply)
        self.assertEqual((other.logins, exness.logins), ([], [ACCOUNT]))

    def test_when_the_bridge_cannot_look_the_package_chooses_as_before(self):
        exness = self.exness(settings_saved=30)
        self.bridge._running_terminals = lambda: None
        self.bridge_starts()
        reply, _ = self.connect()
        self.assertEqual(reply["type"], "logged", reply)
        self.assertEqual(self.connector.initializes(), [((), {"timeout": 60000}), ((), {"timeout": 4000, **LOGIN})])
        self.assertEqual(exness.logins, [ACCOUNT])

    def test_a_login_at_another_broker_s_terminal_is_not_let_through(self):
        # The only MetaTrader 5 that is open belongs to another broker, and it accepts the three.
        self.connector.install(Terminal(OTHER, accepts=ACCOUNT, company="Another Broker Ltd"))
        self.bridge_starts()
        reply, _ = self.connect()
        self.assertEqual(reply["type"], "error")
        self.assertIn("did not verify an Exness company identity", reply["message"])
        self.assertIsNone(self.bridge._LOCKED_LOGIN)

    def test_a_metatrader_that_is_closed_is_started_by_the_package_and_waited_for(self):
        # No saved location and nothing open: the package starts the installation used last. Its waiting for
        # the terminal to come up is not limited by the 5 seconds the bridge gives the attach of a login.
        terminal = self.exness(running=False)
        terminal.starts_in = 12.0
        reply, took = self.connect()
        self.assertEqual(terminal.started, 1)
        self.assertAlmostEqual(took, 12.0, places=1)
        # It came up logged in to no account, and the time of this answer was used up: the account follows
        # with the next login, which the app sends at once and which is not held back.
        self.assertEqual(reply["type"], "error")
        self.assertIn("Press Connect in the app with the account number, the password and the exact server", reply["message"])
        self.assertEqual(terminal.logins, [])
        reply, took = self.connect()
        self.assertEqual(reply["type"], "logged", reply)
        self.assertEqual(terminal.logins, [ACCOUNT])
        self.assertEqual(terminal.started, 1)  # and it is the terminal that is open now

if __name__ == "__main__":
    unittest.main()
