#!/usr/bin/env python3
"""
AURUM <-> MetaTrader 5 local bridge (reference implementation).

Runs on the user's Windows machine NEXT TO MetaTrader 5, listens on
this PC + LAN (remote devices need the bridge token), and speaks the JSON protocol defined in src/bridge.js:

  -> {id, type:'login',    login, password, server}
  <- {id, type:'logged',   balance, equity, currency, account}
  -> {id, type:'order', environment:'demo'|'real', symbol, side, volume, sl, tp, preview_id, intent_id, confirmed:true}
  <- {id, type:'filled',   ticket, price}
  -> {id, type:'close',    ticket}
  <- {id, type:'closed',   ticket, profit}
  -> {id, type:'positions'}
  <- {id, type:'positions', list:[...]}
  -> {id, type:'account'} (authenticated read-only refresh)
  <- {id, type:'account', balance, equity, margin_free, currency, leverage}
  -> {id, type:'symbols'} (authenticated local terminal catalogue)
  <- {id, type:'symbols', symbols:[{symbol,name,path,category,digits,visible,trade_mode}]}
  -> {id, type:'history', symbol, timeframe:'M1'|'M5'|'M15'|'H1', count}
  <- {id, type:'history', candles:[{time,open,high,low,close,volume}]}
  <- {id, type:'error',    message}

`volume` from AURUM is a USD amount; this bridge converts it to lots
using the symbol's contract size and current price, clamped to the
broker's min/max/step (logged so nothing is silent). Exness symbol suffixes
(.pro, pro, …) are resolved automatically.

Requirements:  pip install -r requirements.txt   (Windows: MetaTrader5)
Run:           python mt5_bridge.py
Security:      binds the LAN (AURUM_BRIDGE_HOST, default 0.0.0.0). Origin gate
"""

import asyncio
import datetime
import json
import logging
import math
import os
import re
import secrets
import sys
import threading
import time

from risklimits import validate_open_positions
from marketmeta import market_category
from localapiauth import api_proxy_authorized

HOST = os.environ.get("AURUM_BRIDGE_HOST", "0.0.0.0")
PORT = 8787
MAGIC = 234000  # our orders' magic number
# Exness real/demo manual-only execution. Automation and app-side closes remain
# blocked. The local bridge independently verifies the selected account mode,
# quote, SL/TP, volume, equity, daily loss and open positions before each send.
MT5_MANUAL_ORDER_EXECUTION_ENABLED = True
MT5_MAX_OPEN_POSITIONS = 1
MT5_MAX_RISK_PCT = 0.5
MT5_MAX_DAILY_LOSS_PCT = 2.0
MT5_MIN_REWARD_RISK = 1.2
MT5_MAX_TICK_AGE_SECONDS = 60
_ORDER_LOCK = threading.Lock()  # serialize fresh position-check + order_send across WS/HTTP clients
_MT5_PREVIEW_LOCK = threading.Lock()
_MT5_PREVIEWS = {}  # short-lived server-side order preview, keyed by an unguessable id
_MT5_ORDER_REPLIES = {}  # same intent id never sends twice during this bridge process
_MT5_ORDER_UNCERTAIN = False  # ambiguous/partial MT5 outcome halts further app orders until bridge restart
_LOGIN_LOCK = threading.RLock()  # one account/server identity shared by PC + phone clients
_LOCKED_LOGIN = None  # in-memory numeric login; never logged or returned
_LOCKED_SERVER = None

try:
    import MetaTrader5 as mt5
except ImportError:
    sys.exit("MetaTrader5 package missing — Windows only. Run: pip install MetaTrader5 websockets")

try:
    import websockets
except ImportError:
    sys.exit("websockets package missing. Run: pip install websockets")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("aurum-bridge")


# ----------------------------------------------------------------- helpers
def err(message):
    return {"type": "error", "message": str(message)}


def _mask_account(value):
    text = str(value or "")
    return "••••" + text[-4:] if len(text) > 4 else "••••"


def _account_environment(trade_mode):
    """Return only an MT5-verified account mode; unknown modes stay unknown."""
    demo_mode = getattr(mt5, "ACCOUNT_TRADE_MODE_DEMO", None)
    real_mode = getattr(mt5, "ACCOUNT_TRADE_MODE_REAL", None)
    if demo_mode is not None and trade_mode == demo_mode:
        return "demo"
    if real_mode is not None and trade_mode == real_mode:
        return "real"
    return None


_NEED_AUTH = ("order", "preview_order", "close", "positions", "account", "quote", "search", "symbols", "history")
_BRIDGE_TOKEN = os.environ.get("AURUM_BRIDGE_TOKEN", "").strip()
_LOCAL_API_AUTH = os.environ.get("AURUM_LOCAL_API_AUTH", "").strip() == "1"
_LOCAL_API_TOKEN = os.environ.get("AURUM_LOCAL_API_TOKEN", "").strip()
if _LOCAL_API_AUTH and not _LOCAL_API_TOKEN:
    sys.exit("Local API auth is required but its local token is missing. Re-run SETUP_AND_RUN_LOCAL.bat.")
BRIDGE_BUNDLE = "21a"  # Exness MT5-local adapter build


def _ip_is_local(ip):
    if not ip:
        return False
    ip = str(ip).lower()
    return ip in ("127.0.0.1", "::1", "localhost") or ip.startswith("127.")


def _token_ok(msg, remote=False):
    """Shared-secret gate. AURUM_BRIDGE_TOKEN when set is required from EVERYONE.
    With no token configured, loopback (this PC) stays one-click easy while
    REMOTE devices (phone/tablet over the LAN) are refused until a token exists
    - SETUP_AND_RUN.bat writes bridge_token.txt and exports it automatically."""
    if _BRIDGE_TOKEN:
        return str(msg.get("token") or "") == _BRIDGE_TOKEN
    if remote:
        return False  # remote access is NEVER allowed without a shared secret
    return True  # local bridge, no token configured: keep one-click on the PC


def _origin_allowed(origin):
    """Browsers always send Origin on WebSocket connects; non-browser clients
    do not. A cross-origin Origin means some WEBPAGE (any tab, any site) is
    trying to reach the local bridge - WebSocket has no CORS, so reject it."""
    if not origin:
        return True
    o = origin.strip().lower()
    if o == "null" or o.startswith("file://"):
        return True  # page opened from disk on this machine (app.html double-click)
    from urllib.parse import urlparse
    try:
        host = (urlparse(origin).hostname or "").lower()
    except Exception:
        return False
    if not host:
        return False
    if host in ("127.0.0.1", "localhost", "::1"):
        return True
    allow = [h.strip().lower() for h in os.environ.get("AURUM_BRIDGE_ALLOWED_ORIGINS", "").split(",") if h.strip()]

    def _as_host(x):
        # entries may be hostnames ("aurum-staging.up.railway.app") OR full URLs
        # ("https://4100-xxx.e2b.app") -- compare by host either way (20g).
        if "://" not in x:
            x = "http://" + x
        try:
            return (urlparse(x).hostname or "").lower()
        except Exception:
            return ""
    if host in [_as_host(a) for a in allow]:
        return True
    # pages served from the PC's own LAN address (http://192.168.x.x:8788/app)
    try:
        import ipaddress
        ip = ipaddress.ip_address(host)
        return bool(ip.is_private or ip.is_loopback or ip.is_link_local)
    except ValueError:
        return False


def _symbol_norm(name):
    return re.sub(r"[^a-z0-9]", "", str(name or "").lower())


def _symbol_match_candidates(requested):
    """Return exact-normalized matches first, else short broker prefix/suffix variants."""
    norm = _symbol_norm(requested)
    if not norm:
        return []
    try:
        rows = mt5.symbols_get() or []
    except Exception:
        return []
    names = list(dict.fromkeys(str(getattr(row, "name", "") or "") for row in rows))
    names = [name for name in names if name]
    exact = [name for name in names if _symbol_norm(name) == norm]
    if exact:
        return exact
    # Common MT5 decorations include suffixes (XAUUSDm, EURUSD.pro, US30_x10m)
    # and prefixes. Bound decoration length so a short code cannot match an unrelated symbol.
    decorated = []
    for name in names:
        sn = _symbol_norm(name)
        extra = len(sn) - len(norm)
        if 0 < extra <= 4 and (sn.startswith(norm) or sn.endswith(norm)):
            decorated.append(name)
    return decorated


def _symbol_match_error(requested, candidates=None):
    candidates = _symbol_match_candidates(requested) if candidates is None else candidates
    if len(candidates) > 1:
        return "MT5 symbol '" + str(requested) + "' matches multiple broker symbols: " + ", ".join(candidates[:8]) + ". Show only the intended match in Market Watch or use its exact name; no order was sent."
    if len(candidates) == 1:
        return "MT5 found '" + candidates[0] + "' for '" + str(requested) + "' but could not select it in the connected terminal. Check that this exact symbol is enabled in Market Watch; no order was sent."
    return "MT5 symbol '" + str(requested or "") + "' is not available in the connected terminal's symbol catalogue. Check the exact broker symbol and connected MT5 terminal; no order was sent."


def resolve_symbol(name):
    """Resolve a canonical or exact MT5 name without guessing between broker variants.

    Exact names win. A unique decorated match is accepted. If several variants exist,
    select the sole visible Market Watch candidate; if still ambiguous, fail closed.
    """
    requested = str(name or "").strip()
    if not requested:
        return None
    info = mt5.symbol_info(requested)
    if info is not None:
        resolved = str(getattr(info, "name", "") or requested)
    else:
        matches = _symbol_match_candidates(requested)
        if len(matches) == 1:
            resolved = matches[0]
        elif len(matches) > 1:
            visible = []
            for candidate in matches:
                candidate_info = mt5.symbol_info(candidate)
                if candidate_info is not None and bool(getattr(candidate_info, "visible", False)):
                    visible.append(candidate)
            if len(visible) != 1:
                return None
            resolved = visible[0]
        else:
            return None
        info = mt5.symbol_info(resolved)
    if info is None:
        return None
    if not bool(getattr(info, "visible", False)):
        try:
            if not mt5.symbol_select(resolved, True):
                return None
        except Exception:
            return None
    return resolved


def usd_to_lots(info, price, usd):
    """USD notional -> lots (contract-size heuristic), clamped to broker rules."""
    if not price or price <= 0 or usd <= 0:
        return 0.0
    lots = usd / (info.trade_contract_size * price)
    vmin, vmax, vstep = info.volume_min, info.volume_max, info.volume_step or 0.01
    lots = max(vmin, min(vmax, lots))
    if vstep > 0:
        lots = int(lots / vstep) * vstep  # round DOWN to step: never oversize
        lots = max(vmin, lots)
    return round(lots, 8)


def fillings_for(info):
    """Broker-dependent filling modes; try in a sensible order."""
    mode = getattr(info, "trade_filling_mode", 0) or 0
    out = []
    if mode & 1:
        out.append(mt5.ORDER_FILLING_RETURN)
    if mode & 2:
        out.append(mt5.ORDER_FILLING_IOC)
    if mode & 4:
        out.append(mt5.ORDER_FILLING_FOK)
    return out or [mt5.ORDER_FILLING_IOC]


def norm_price(info, price):
    digits = info.digits
    return round(float(price), digits)


# ---------------------------------------------------------------- handlers
def _last_error():
    try:
        code, desc = mt5.last_error()
    except Exception:
        return None, "unknown"
    return code, desc


# ---- terminal attach: the reason is kept when it happens -------------------
# mt5.last_error() is overwritten by every later MetaTrader5 call, and
# attach_terminal() calls mt5.shutdown() after a failed initialize(). Reading
# last_error() after attach_terminal() therefore reported "code 1: Success"
# for every failed attach. The reason is now stored at the moment of the
# failure (_ATTACH_FAILURE) and handle_login() reports that.
#
# The account. initialize() without an account attaches to the account
# MetaTrader 5 is logged in to, and MetaTrader 5 answers "Authorization failed"
# (-6) when it is logged in to none. initialize() also takes an account
# (login, password, server) and MetaTrader 5 then logs in to it as part of the
# attach (MetaQuotes' documentation of initialize()). A login brings exactly
# those three, so when the attach without an account is answered with -6,
# handle_login() has it made once more with the account entered in the app.
# At bridge start there is no account to give: that attach stays as it was.
_ATTACH_LOCK = threading.Lock()  # one initialize() at a time: bridge start, websocket and HTTP logins alike
_ATTACH_FAILURE = None  # why the last attach failed (dict); None after a successful attach
# The app waits 8 s for the answer to a login (src/bridge.js) and repeats a
# failed login once over HTTP straight away. An attach asked for by a login
# therefore gets 5 s, and the repeat gets the same answer without a second try.
#
# The attach with the account has to fit into the same answer, and when it
# succeeds MetaTrader's own login() still follows it. So it ends 4 s after the
# login began to attach. An attach without the account that came first in the
# same login has used part of that; when under 2 s are left, the attach with
# the account is not begun: the login is answered "not logged in", and the
# next login (the app's repeat, at once) starts with the account. That repeat
# is no second attempt at the same thing, so it is not held back.
_LOGIN_ATTACH_WAIT_MS = 5000
_START_ATTACH_WAIT_MS = 60000  # MetaTrader5.initialize() default; a terminal that was only just started needs it
_ACCOUNT_ATTACH_END_MS = 4000  # the attach with the account ends this long after the login began to attach
_ACCOUNT_ATTACH_MIN_MS = 2000  # with less than this left it is made by the next login
# False once initialize() has refused the 'timeout' keyword. Such a connector waits its own 60 s, so the attach
# with the account, which has to end in time for the app, is not made with it: everything stays as it was before.
_CONNECTOR_TAKES_TIMEOUT = True
_ATTACH_REPEAT_QUIET_S = 3.0
_ATTACH_STATE = {"wait_ms": _LOGIN_ATTACH_WAIT_MS, "since": 0.0, "limit_s": 0.0}


_BOUND_ELSEWHERE = ("This bridge is already bound to a different Exness account/server. PC and phone must use the same "
                    "account and exact server; restart the bridge only when safely disconnected to change identity.")


def _bound_to_another_account(login, server):
    """True when this bridge has verified one account and a login names another account or server."""
    with _LOGIN_LOCK:  # re-entrant: handle_login() asks again while it holds the lock
        return _LOCKED_LOGIN is not None and (_LOCKED_LOGIN != login or (_LOCKED_SERVER or "").casefold() != server.casefold())


def handle_login(msg):
    """Login with STEP-DIAGNOSTICS: every failure says exactly which step broke
    (terminal attach vs credentials) plus MT5's own error code, so the app can
    show a real fix instead of a generic 'bridge unreachable'."""
    global _LOCKED_LOGIN, _LOCKED_SERVER
    try:
        login = int(msg.get("login") or 0)
    except (TypeError, ValueError):
        return {**err("login must be a numeric account number")}
    password = msg.get("password") or ""
    server = (msg.get("server") or "").strip()
    if not password:
        return {**err("MT5 password required; an investor/read-only password permits viewing only, while manual order sending requires MT5 trade permission.")}
    if not login:
        return {**err("account number required")}
    if not server:
        return {**err("exact Exness MT5 server is required; get it from the Exness Personal Area and enter it locally")}
    # attach_terminal() initializes MT5 once at bridge startup. Re-initializing
    # the same terminal here can return RES_E_AUTH_FAILED (-6) even though the
    # bridge already has a valid IPC connection. Reuse it; only initialize if
    # the connection has actually gone away.
    busy = _attach_busy_message()
    if busy:
        return {**err(busy)}
    term = mt5.terminal_info()
    if term is None:
        # The attach may give MetaTrader 5 the account of this login. A bridge that is bound to
        # another account says so first, before MetaTrader 5 is asked to log in to this one.
        if _bound_to_another_account(login, server):
            return {**err(_BOUND_ELSEWHERE)}
        if not attach_terminal((login, password, server)):
            busy = _attach_busy_message()
            if busy or _ATTACH_FAILURE is not None:
                return {**err(busy or _attach_failure_message())}
            # no attach is running and none has failed: another request attached the terminal meanwhile
        term = mt5.terminal_info()
        if term is None:
            code, desc = _last_error()
            return {**err(_app_safe(f"MT5 terminal not responding (step terminal, code {code}: {desc}). Start MetaTrader 5 and keep it open."))}
    else:
        log.info("reusing the MT5 terminal already attached at bridge startup")
    if not term.trade_allowed:
        log.info("terminal reports read-only trade permissions; compatible with this verification build")
    with _LOGIN_LOCK:
        if _bound_to_another_account(login, server):
            return {**err(_BOUND_ELSEWHERE)}
        ok = mt5.login(login, password=password, server=server)
        if not ok:
            code, desc = _last_error()
            return {**err(_app_safe(f"MT5 rejected the credentials (step login, code {code}: {desc}). Check the account number, MT5 password, and exact Exness MT5 server in your Exness Personal Area."))}
        ai = mt5.account_info()
        if ai is None:
            code, desc = _last_error()
            return {**err(_app_safe(f"Logged in but account info unavailable (step account, code {code}: {desc})"))}
        actual_server = str(getattr(ai, "server", "")).strip()
        company = str(getattr(ai, "company", "")).strip()
        if actual_server.casefold() != server.casefold():
            log.error("MT5 login server mismatch; refusing to authorize this connection")
            return {**err("MT5 reported a different server than the exact Exness server entered. Connection refused; verify the server in your Exness Personal Area.")}
        if "exness" not in company.casefold():
            log.error("MT5 company identity is missing or not Exness; refusing to authorize this connection")
            return {**err("MT5 did not verify an Exness company identity for this account. Connection refused; confirm you selected the Exness terminal and account.")}
        if _LOCKED_LOGIN is None:
            _LOCKED_LOGIN, _LOCKED_SERVER = int(ai.login), actual_server
    log.info("logged in: account ending %s (%s)", _mask_account(ai.login)[-4:], ai.currency)
    return {
        "type": "logged",
        "balance": ai.balance,
        "equity": ai.equity,
        "margin_free": ai.margin_free,
        "currency": ai.currency,
        "account": _mask_account(ai.login),
        "server": ai.server,
        "leverage": ai.leverage,
        "demo": _account_environment(getattr(ai, "trade_mode", None)) == "demo",
        "environment": _account_environment(getattr(ai, "trade_mode", None)),
        "trade_mode": getattr(ai, "trade_mode", None),
        "terminal": term.name,
    }


# The Exness sign-in form of the app replaces a bridge message that contains
# one of these words by its own "Bridge not reachable" help text
# (src/main.js: /unreachable|timeout|refused|closed|blocked/i). A message about
# MetaTrader 5 has to arrive as written, so the words are reworded.
_APP_REPLACES_WORDS = (
    ("unreachable", "not reachable"),
    ("timeout", "time-out"),
    ("refused", "rejected"),
    ("closed", "shut"),
    ("blocked", "stopped"),
)


def _app_safe(text):
    out = str(text)
    for word, other in _APP_REPLACES_WORDS:
        out = re.sub(word, other, out, flags=re.IGNORECASE)
    return out


def _terminal_label(path):
    """Name the terminal that was tried: its folder and file, not the whole path."""
    if not path:
        return "the default MetaTrader 5 of this PC (no location is saved)"
    parts = [part for part in re.split(r"[\\/]+", str(path)) if part]
    return '"' + "\\".join(parts[-2:]) + '"'


def _attach_busy_message():
    """A login that arrives while MetaTrader 5 is being contacted is answered at once."""
    if not _ATTACH_LOCK.locked():
        return None
    since, limit_s = _ATTACH_STATE.get("since") or 0.0, _ATTACH_STATE.get("limit_s") or 0.0
    left = int(round(limit_s - (time.time() - since))) if since and limit_s else 0
    when = f"in about {left} seconds" if left > 1 else "in a moment"
    return _app_safe("The bridge is still contacting MetaTrader 5 and has no answer yet (step terminal). "
                     f"Press Connect again {when}.")


_SAVED_LOCATION_HINT = ("Check AURUM_MT5_PATH (the location saved in bridge\\terminal_path.txt) "
                        "and start the Exness MT5 terminal normally.")
_LOG_IN_STEP = ("in MetaTrader 5 use File > Login to Trade Account (account number, password and the exact server) "
                "and wait until the bottom-right corner shows a connection speed and not 'No connection'")
_NORMAL_START_STEP = "start MetaTrader 5 with a normal double-click, not 'Run as administrator'"
_ONLY_ONE_STEP = "keep only that one MetaTrader 5 open"
# The attach at bridge start waits 60 s, an attach asked for by Connect 5 s (the app waits 8 s for its answer).
_FULL_MINUTE_STEP = ("run START_ALL_LOCAL.bat again with MetaTrader 5 open and logged in: "
                     "the bridge then waits a full minute for it")
_PYTHON_BOX_STEP = "if Tools > Options > Community has a 'Python integration' box, tick it and restart MetaTrader 5"
_START_AGAIN = "run START_ALL_LOCAL.bat again"
# MetaTrader 5 was given the account entered in the app and answered "Authorization failed" all the same. Its own
# status in the bottom-right corner tells the three reasons apart; the bridge cannot.
_ACCOUNT_NOT_ACCEPTED = (
    "Look at the bottom-right corner of MetaTrader 5. If it shows a connection speed, MetaTrader 5 has logged in by "
    "now: press Connect again. If it says 'Invalid account', Exness did not accept the three: compare them with your "
    "Exness Personal Area (the account must be an MT5 account, the password is the one of that trading account and "
    "not the one of the Exness website, the server is written exactly as shown there) and press Connect again. If it "
    "says 'No connection', MetaTrader 5 cannot get through to Exness: check the internet connection of this PC.")


def _steps(*steps):
    """'1) ...; 2) ...; 3) ....' The app shows a message as one paragraph, so the steps are numbered."""
    return "; ".join(f"{number}) {step}" for number, step in enumerate(steps, 1)) + "."


def _attach_failure_message():
    """Why the terminal could not be attached and what to do, for the person at the PC."""
    failure = _ATTACH_FAILURE or {}
    path = failure.get("path")
    code, text = failure.get("code"), str(failure.get("text") or "").strip()
    low = text.lower()
    kind = failure.get("kind")
    limit = failure.get("limit_s") or 0
    seconds = f"{limit:g} seconds" if limit else "the waiting time"
    file_name = re.split(r"[\\/]+", str(path))[-1].lower() if path else ""
    if code is not None:
        detail = f", code {code}: {text or 'no text'}"
    elif kind == "missing":
        detail = ""  # MetaTrader 5 was not called: there is no code
    else:
        detail = f", {text or 'no reason given'}"

    if kind == "missing":
        what = "the saved location of MetaTrader 5 does not exist any more"
        do = (f"Open the Exness MetaTrader 5 yourself and log in, then {_START_AGAIN}: it finds the open "
              f"MetaTrader 5 and saves its location. {_SAVED_LOCATION_HINT}")
    elif file_name == "terminal.exe":
        what = "the program that was found is MetaTrader 4, and this app needs MetaTrader 5"
        do = ("Install the MetaTrader 5 desktop program from your Exness Personal Area, open it and log in, "
              f"quit MetaTrader 4, then {_START_AGAIN}.")
    elif (code == -6 or "authorization" in low) and failure.get("with_account"):
        what = ("MetaTrader 5 did not log in with the account number, password and server entered in the app, "
                "or it has no connection to Exness")
        do = (f"{_ACCOUNT_NOT_ACCEPTED} If Connect fails although the corner shows a speed: {_NORMAL_START_STEP}, "
              f"{_ONLY_ONE_STEP}, then {_START_AGAIN}.")
    elif code == -6 or "authorization" in low:
        # The attach at bridge start ends here: it has no account to give. So does a login whose attach
        # without the account left no time for the one with it; the app's repeat then makes that one.
        what = "MetaTrader 5 is open, but it is not logged in to a trading account or has no connection to Exness"
        if _CONNECTOR_TAKES_TIMEOUT:
            do = ("Press Connect in the app with the account number, the password and the exact server: the bridge "
                  "passes them to MetaTrader 5, which then logs in. To log in yourself instead: "
                  + _steps(_LOG_IN_STEP, "press Connect"))
        else:  # the bridge does not log MetaTrader 5 in with this connector: the way there was before
            do = "Do this: " + _steps(_LOG_IN_STEP, "press Connect again")
        do += f" If MetaTrader 5 shows your account already: {_NORMAL_START_STEP}, {_ONLY_ONE_STEP}, then {_START_AGAIN}."
    elif "not found" in low:
        what = "no MetaTrader 5 desktop program was found on this PC"
        do = (f"If MetaTrader 5 is installed, open it and log in, then {_START_AGAIN}: the launcher saves where it is. "
              "If it is not installed, get the MetaTrader 5 desktop program from your Exness Personal Area first "
              "(the Exness web terminal does not count).")
        if sys.maxsize <= 2 ** 32:
            do += " This Python is 32-bit and MetaTrader 5 needs the 64-bit one: install 64-bit Python 3.13 first."
    elif "process create" in low:
        what = "MetaTrader 5 could not be started from its saved location"
        do = (f"Open the Exness MetaTrader 5 yourself and log in, then {_START_AGAIN} so that its location is "
              f"found afresh. {_SAVED_LOCATION_HINT}")
    elif "pipe server" in low:
        what = "MetaTrader 5 did not open its connection for Python"
        do = "Do this: " + _steps(_PYTHON_BOX_STEP, _NORMAL_START_STEP, _LOG_IN_STEP, "press Connect again")
    elif code == -10005 or "timeout" in low or "time-out" in low:
        what = f"MetaTrader 5 did not answer within {seconds}"
        do = ("If it has only just started, wait until it shows your account and press Connect again. "
              "If it is already open: " + _steps(_LOG_IN_STEP, _NORMAL_START_STEP, _PYTHON_BOX_STEP, _FULL_MINUTE_STEP))
    elif code == -5 or "version" in low:
        what = "MetaTrader 5 and its Python connector have different versions"
        do = "Restart MetaTrader 5 so that it updates itself, log in, then press Connect again."
    else:
        what = "MetaTrader 5 could not be contacted"
        do = "Do this: " + _steps(_LOG_IN_STEP, _NORMAL_START_STEP, "press Connect again") + " " + _SAVED_LOCATION_HINT
    return _app_safe(f"Cannot attach to MetaTrader 5: {what} (step terminal{detail}). {do} "
                     f"Terminal tried: {_terminal_label(path)}.")


def _locked_identity_error():
    """Ensure shared PC/phone clients still see the one verified Exness account/server."""
    with _LOGIN_LOCK:
        if _LOCKED_LOGIN is None or not _LOCKED_SERVER:
            return "No verified Exness account is bound to this bridge yet; authenticate locally first."
        ai = mt5.account_info()
        if ai is None:
            return "MT5 account identity is unavailable; read-only access is blocked."
        if int(getattr(ai, "login", 0) or 0) != _LOCKED_LOGIN:
            return "The MT5 terminal account changed; restart the bridge and re-authenticate the same account on PC and phone."
        server = str(getattr(ai, "server", "")).strip()
        company = str(getattr(ai, "company", "")).strip()
        if server.casefold() != _LOCKED_SERVER.casefold() or "exness" not in company.casefold():
            return "The MT5 terminal server/company changed; read-only access is blocked until Exness identity is re-verified."
    return None


def handle_account(_msg):
    """Refresh broker-sourced account metrics without logging or returning the login id."""
    identity_error = _locked_identity_error()
    if identity_error:
        return {**err(identity_error)}
    ai = mt5.account_info()
    if ai is None:
        code, desc = _last_error()
        return {**err(f"MT5 account info unavailable (code {code}: {desc})")}
    return {
        "type": "account",
        "balance": ai.balance,
        "equity": ai.equity,
        "margin_free": ai.margin_free,
        "currency": ai.currency,
        "leverage": ai.leverage,
        "demo": _account_environment(getattr(ai, "trade_mode", None)) == "demo",
        "environment": _account_environment(getattr(ai, "trade_mode", None)),
        "trade_mode": getattr(ai, "trade_mode", None),
    }


def _mt5_manual_account_gate(expected_environment=None):
    """Verify account mode, exact identity, currency, terminal and permissions."""
    if not MT5_MANUAL_ORDER_EXECUTION_ENABLED:
        return None, "Exness manual order execution is turned off in this bridge."
    if expected_environment not in ("demo", "real"):
        return None, "Select DEMO or REAL explicitly before requesting an order preview; no order was sent."
    identity_error = _locked_identity_error()
    if identity_error:
        return None, identity_error
    try:
        account = mt5.account_info()
        terminal = mt5.terminal_info()
    except Exception:
        return None, "MT5 account/terminal state could not be verified; no order was sent."
    if account is None or terminal is None:
        return None, "MT5 account/terminal state is unavailable; no order was sent."
    demo_mode = getattr(mt5, "ACCOUNT_TRADE_MODE_DEMO", None)
    real_mode = getattr(mt5, "ACCOUNT_TRADE_MODE_REAL", None)
    mode = getattr(account, "trade_mode", None)
    if demo_mode is None or real_mode is None:
        return None, "MT5 did not expose verified REAL and DEMO account modes; no order was sent."
    actual_environment = "demo" if mode == demo_mode else "real" if mode == real_mode else None
    if actual_environment is None or actual_environment != expected_environment:
        return None, "Selected account mode does not match the currently verified MT5 account; no order was sent. Reconnect and review the account label."
    if str(getattr(account, "currency", "")).upper() != "USD":
        return None, "Manual MT5 order sizing currently requires a USD-denominated account; no order was sent."
    if not bool(getattr(terminal, "connected", False)):
        return None, "MT5 is not connected to Exness; no order was sent."
    if not bool(getattr(terminal, "trade_allowed", False)):
        return None, "MT5 terminal trading permission is off. Enable it only if you intend to place this manually confirmed order; app automation remains disabled. No order was sent."
    try:
        equity = float(account.equity)
        free_margin = float(account.margin_free)
        if not math.isfinite(equity) or equity <= 0 or not math.isfinite(free_margin) or free_margin <= 0:
            raise ValueError
    except (AttributeError, TypeError, ValueError, OverflowError):
        return None, "MT5 equity/free margin could not be verified; no order was sent."
    return account, None


def _mt5_daily_net():
    """Broker-reported realized P/L since UTC midnight; None means unverifiable."""
    now = datetime.datetime.now(datetime.timezone.utc)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    try:
        deals = mt5.history_deals_get(start, now)
    except Exception:
        return None
    if deals is None:
        return None
    try:
        return sum(float(getattr(deal, "profit", 0) or 0)
                   + float(getattr(deal, "commission", 0) or 0)
                   + float(getattr(deal, "swap", 0) or 0)
                   + float(getattr(deal, "fee", 0) or 0) for deal in deals)
    except (TypeError, ValueError, OverflowError):
        return None


def _mt5_order_plan(msg):
    """Recompute all order facts from the verified MT5 account, in either manual mode."""
    environment = str(msg.get("environment") or "").strip().lower()
    if environment not in ("demo", "real"):
        return None, "Select DEMO or REAL explicitly; no order was sent."
    env_label = environment.upper()
    account, problem = _mt5_manual_account_gate(environment)
    if problem:
        return None, problem
    requested_symbol = str(msg.get("symbol") or "").strip()
    symbol = resolve_symbol(requested_symbol)
    if not symbol:
        return None, _symbol_match_error(requested_symbol)
    info = mt5.symbol_info(symbol)
    if info is None:
        return None, "Symbol specifications are unavailable; no order was sent."
    side = str(msg.get("side") or "").upper()
    if side not in ("BUY", "SELL"):
        return None, "Side must be BUY or SELL."
    try:
        trade_mode = int(getattr(info, "trade_mode", 0))
    except (TypeError, ValueError, OverflowError):
        trade_mode = 0
    if not (trade_mode == 4 or (trade_mode == 1 and side == "BUY") or (trade_mode == 2 and side == "SELL")):
        return None, "This symbol/side is not verified as tradable by the broker."
    try:
        requested_usd = float(msg.get("volume"))
        sl = float(msg.get("sl"))
        tp = float(msg.get("tp"))
        if not all(math.isfinite(x) for x in (requested_usd, sl, tp)) or requested_usd <= 0 or sl <= 0 or tp <= 0:
            raise ValueError
        equity = float(account.equity)
        free_margin = float(account.margin_free)
        contract_size = float(info.trade_contract_size)
        price_point = float(info.point)
        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            raise ValueError
        bid, ask = float(tick.bid), float(tick.ask)
        tick_time = int(tick.time)
        price = ask if side == "BUY" else bid
        if not all(math.isfinite(x) and x > 0 for x in (equity, free_margin, contract_size, price_point, bid, ask, price)):
            raise ValueError
        age = time.time() - tick_time
        if age < -5 or age > MT5_MAX_TICK_AGE_SECONDS:
            return None, "No fresh Exness MT5 tick (maximum age 60 seconds); no order was sent."
        if side == "BUY" and not (sl < price < tp):
            return None, "For a BUY, stop-loss must be below the live ask and take-profit above it."
        if side == "SELL" and not (tp < price < sl):
            return None, "For a SELL, take-profit must be below the live bid and stop-loss above it."
        stops_level = int(getattr(info, "trade_stops_level", 0) or 0) * price_point
        if stops_level and (abs(price - sl) < stops_level or abs(tp - price) < stops_level):
            return None, "Stop-loss/take-profit is closer than the broker's minimum stop distance."
        raw_lots = requested_usd / (contract_size * price)
        lots = usd_to_lots(info, price, requested_usd)
        if lots <= 0:
            raise ValueError
        exposure = lots * contract_size * price
        # Refuse broker-minimum rounding that silently enlarges the requested notional.
        # The broker's own minimum lot is exempt: the floor cannot be reduced below, the
        # preview and confirmation show the real size, and the risk/reward/margin guards
        # below still bound the loss on any accepted size.
        notional_cap = max(requested_usd * 1.5, equity * 10)
        floor_exposure = float(info.volume_min) * contract_size * price
        if exposure > notional_cap and exposure > floor_exposure * (1.0 + 1e-9):
            return None, (
                f"Broker minimum size is about ${exposure:,.2f} notional, above this request's cap of ${notional_cap:,.2f}. "
                "No order was sent. Reducing the requested size cannot get below the broker minimum; choose a symbol with a smaller minimum exposure or stop here."
            )
        order_type = mt5.ORDER_TYPE_BUY if side == "BUY" else mt5.ORDER_TYPE_SELL
        loss_result = mt5.order_calc_profit(order_type, symbol, lots, price, sl)
        reward_result = mt5.order_calc_profit(order_type, symbol, lots, price, tp)
        margin_result = mt5.order_calc_margin(order_type, symbol, lots, price)
        if loss_result is None or reward_result is None or margin_result is None:
            raise ValueError
        loss = float(loss_result)
        reward = float(reward_result)
        margin = float(margin_result)
        if not all(math.isfinite(x) for x in (loss, reward, margin)) or loss >= 0 or reward <= 0 or margin < 0:
            raise ValueError
        # Add a fixed 25% buffer for spread/slippage/fees; use conservative hard limits.
        buffered_risk = abs(loss) * 1.25
        risk_pct = buffered_risk / equity * 100
        rr = reward / abs(loss)
        if risk_pct > MT5_MAX_RISK_PCT + 1e-9:
            return None, f"Estimated buffered stop risk is {risk_pct:.3f}% of {env_label} equity; this {env_label} path caps it at {MT5_MAX_RISK_PCT:.1f}%. No order was sent."
        if rr < MT5_MIN_REWARD_RISK:
            return None, f"Reward-to-risk is {rr:.2f}; the {env_label} path requires at least {MT5_MIN_REWARD_RISK:.1f}. No order was sent."
        if margin > free_margin * 0.8:
            return None, "Required margin would use more than 80% of free margin; no order was sent."
    except (TypeError, ValueError, OverflowError, AttributeError, ZeroDivisionError):
        return None, "Live quote, account equity, broker sizing, or stop-risk estimate could not be verified; no order was sent."

    positions = mt5.positions_get()
    open_gate = validate_open_positions(positions, MT5_MAX_OPEN_POSITIONS)
    if not open_gate["ok"]:
        return None, open_gate["reason"]
    daily_net = _mt5_daily_net()
    if daily_net is None:
        return None, "Today's broker-reported account P/L could not be verified; no order was sent."
    daily_limit = equity * MT5_MAX_DAILY_LOSS_PCT / 100
    if daily_net <= -daily_limit:
        return None, f"{env_label} daily-loss limit reached ({MT5_MAX_DAILY_LOSS_PCT:.1f}% of equity); no order was sent."
    return {
        "symbol": symbol, "side": side, "requested_usd": requested_usd,
        "lots": lots, "raw_lots": raw_lots, "exposure": exposure,
        "price": price, "sl": norm_price(info, sl), "tp": norm_price(info, tp),
        "risk_amount": buffered_risk, "risk_pct": risk_pct, "reward_amount": reward,
        "rr": rr, "margin": margin, "currency": str(account.currency),
        "equity": equity, "daily_net": daily_net, "daily_limit": daily_limit,
        "point": price_point, "trade_mode": trade_mode,
        "environment": environment, "demo": environment == "demo",
    }, None


def handle_order_preview(msg):
    """Create a 30-second, no-send preview for one explicitly selected account mode."""
    plan, problem = _mt5_order_plan(msg)
    if problem:
        return {**err(problem)}
    preview_id = secrets.token_urlsafe(18)
    now = time.time()
    with _MT5_PREVIEW_LOCK:
        for key in list(_MT5_PREVIEWS):
            if now - _MT5_PREVIEWS[key]["created"] > 30:
                _MT5_PREVIEWS.pop(key, None)
        _MT5_PREVIEWS[preview_id] = {"created": now, "plan": plan}
    return {"type": "order_preview", "preview_id": preview_id,
            **{key: plan[key] for key in ("symbol", "side", "requested_usd", "lots", "exposure", "price", "sl", "tp", "risk_amount", "risk_pct", "reward_amount", "rr", "margin", "currency", "equity", "environment", "demo")},
            "max_open_positions": MT5_MAX_OPEN_POSITIONS,
            "max_risk_pct": MT5_MAX_RISK_PCT,
            "max_daily_loss_pct": MT5_MAX_DAILY_LOSS_PCT,
            "min_reward_risk": MT5_MIN_REWARD_RISK,
            "manual_only": True}


def handle_order(msg):
    """One explicitly confirmed manual Exness order; no app automation or close path."""
    global _MT5_ORDER_UNCERTAIN
    environment = str(msg.get("environment") or "").strip().lower()
    env_label = environment.upper() if environment in ("demo", "real") else "MT5"
    if not MT5_MANUAL_ORDER_EXECUTION_ENABLED:
        return {**err("Exness manual order execution is disabled; no order was sent.")}
    if msg.get("confirmed") is not True:
        return {**err("Explicit per-order confirmation is required; no order was sent.")}
    preview_id = str(msg.get("preview_id") or "")
    intent_id = str(msg.get("intent_id") or "")
    if environment not in ("demo", "real") or not preview_id or not re.fullmatch(r"[A-Za-z0-9_-]{16,80}", intent_id):
        return {**err("A current mode-matched preview, explicit account mode, and unique intent id are required; no order was sent.")}
    with _ORDER_LOCK:
        if intent_id in _MT5_ORDER_REPLIES:
            return _MT5_ORDER_REPLIES[intent_id]
        if _MT5_ORDER_UNCERTAIN:
            return {**err("A previous MT5 order outcome is uncertain. Inspect MT5 positions/history; no further app order will be sent until the bridge is restarted after the outcome is understood.")}
        with _MT5_PREVIEW_LOCK:
            preview = _MT5_PREVIEWS.pop(preview_id, None)
        if not preview or time.time() - preview["created"] > 30:
            return {**err("Order preview expired; review a fresh quote and confirm again. No order was sent.")}
        request_msg = {key: msg.get(key) for key in ("symbol", "side", "volume", "sl", "tp", "environment")}
        plan, problem = _mt5_order_plan(request_msg)
        if problem:
            return {**err(problem)}
        old = preview["plan"]
        if (plan["environment"] != old["environment"] or plan["symbol"] != old["symbol"] or plan["side"] != old["side"]
                or plan["lots"] != old["lots"] or plan["sl"] != old["sl"] or plan["tp"] != old["tp"]
                or plan["requested_usd"] != old["requested_usd"]
                or abs(plan["price"] - old["price"]) > max(plan["point"] * 20, old["point"] * 20)
                or abs(plan["risk_amount"] - old["risk_amount"]) > max(old["risk_amount"] * 0.05, 0.01)):
            return {**err("Order mode, size, stop/target, quote, or risk changed since preview; review a fresh quote and confirm again. No order was sent.")}
        try:
            account, account_problem = _mt5_manual_account_gate(plan["environment"])
            if account_problem:
                return {**err(account_problem)}
            info = mt5.symbol_info(plan["symbol"])
            tick = mt5.symbol_info_tick(plan["symbol"])
            positions = mt5.positions_get()
            if info is None or tick is None or positions is None:
                raise RuntimeError("fresh broker state unavailable")
            open_gate = validate_open_positions(positions, MT5_MAX_OPEN_POSITIONS)
            if not open_gate["ok"]:
                return {**err(open_gate["reason"])}
            send_price = float(tick.ask if plan["side"] == "BUY" else tick.bid)
            if not math.isfinite(send_price) or send_price <= 0 or abs(send_price - plan["price"]) > float(info.point) * 20:
                return {**err(f"{env_label} quote moved beyond the confirmation tolerance; preview and confirm again. No order was sent.")}
            order_type = mt5.ORDER_TYPE_BUY if plan["side"] == "BUY" else mt5.ORDER_TYPE_SELL
            actual_loss = mt5.order_calc_profit(order_type, plan["symbol"], plan["lots"], send_price, plan["sl"])
            actual_margin = mt5.order_calc_margin(order_type, plan["symbol"], plan["lots"], send_price)
            if actual_loss is None or actual_margin is None:
                raise RuntimeError("fresh MT5 risk calculation unavailable")
            actual_risk = abs(float(actual_loss)) * 1.25
            if (not math.isfinite(actual_risk) or actual_loss >= 0
                    or actual_risk > float(account.equity) * MT5_MAX_RISK_PCT / 100
                    or not math.isfinite(float(actual_margin))
                    or float(actual_margin) > float(account.margin_free) * 0.8):
                return {**err(f"Fresh {env_label} stop risk or margin exceeds the confirmed limit; no order was sent.")}
            request = {
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": plan["symbol"],
                "volume": plan["lots"],
                "type": order_type,
                "price": send_price,
                "sl": plan["sl"], "tp": plan["tp"],
                "deviation": 20, "magic": MAGIC,
                "comment": "AURUM-" + env_label + "-" + intent_id[:10],
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": fillings_for(info)[0],
            }
            # A single send only. Ambiguous transport outcomes are not retried by this bridge.
            result = mt5.order_send(request)
        except Exception:
            log.exception("MT5 order send returned an ambiguous exception")
            _MT5_ORDER_UNCERTAIN = True
            reply = {**err(f"{env_label} order outcome is uncertain. Inspect MT5 positions/history; no further app order will be sent until the outcome is understood. No automatic retry was made.")}
            _MT5_ORDER_REPLIES[intent_id] = reply
            return reply
        if result is None:
            _MT5_ORDER_UNCERTAIN = True
            reply = {**err(f"{env_label} order outcome is uncertain (MT5 returned no result). Inspect positions/history; no further app order will be sent until the outcome is understood. No automatic retry was made.")}
        elif result.retcode in tuple(code for code in (
                getattr(mt5, "TRADE_RETCODE_DONE_PARTIAL", None),
                getattr(mt5, "TRADE_RETCODE_PLACED", None)) if code is not None):
            _MT5_ORDER_UNCERTAIN = True
            reply = {**err(f"MT5 reports a partial or pending {env_label} order. Inspect positions/history; no further app order will be sent until the outcome is understood. Do not retry.")}
        elif result.retcode == getattr(mt5, "TRADE_RETCODE_DONE", -1):
            log.info("%s fill: %s %s %.2f lots @ %s ticket=%s", env_label, plan["side"], plan["symbol"], plan["lots"], result.price, result.order)
            reply = {"type": "filled", "ticket": result.order, "price": result.price,
                     "lots": plan["lots"], "symbol": plan["symbol"], "demo": plan["demo"], "environment": plan["environment"],
                     "currency": plan["currency"], "requested_usd": plan["requested_usd"],
                     "effective_notional": round(plan["exposure"], 2),
                     "estimated_buffered_risk": round(plan["risk_amount"], 2),
                     "risk_pct": round(plan["risk_pct"], 4), "rr": round(plan["rr"], 3),
                     "open_positions_before": open_gate["count"], "max_open_positions": MT5_MAX_OPEN_POSITIONS}
        else:
            reply = {**err(f"{env_label} order rejected by MT5 (retcode={getattr(result, 'retcode', None)}): {getattr(result, 'comment', '')}. No retry was made.")}
        _MT5_ORDER_REPLIES[intent_id] = reply
        if len(_MT5_ORDER_REPLIES) > 256:
            _MT5_ORDER_REPLIES.pop(next(iter(_MT5_ORDER_REPLIES)))
        return reply

def handle_close(_msg):
    return {**err("App-side Exness position closing is disabled. Manage or close REAL/DEMO positions directly in MetaTrader 5.")}


def handle_positions(_msg):
    identity_error = _locked_identity_error()
    if identity_error:
        return {**err(identity_error)}
    out = []
    for p in mt5.positions_get() or ():
        out.append(
            {
                "ticket": p.ticket,
                "symbol": p.symbol,
                "side": "BUY" if p.type == mt5.POSITION_TYPE_BUY else "SELL",
                "volume": p.volume,
                "price": p.price_open,
                "profit": p.profit,
                "sl": p.sl,
                "tp": p.tp,
            }
        )
    return {"type": "positions", "list": out}


def handle_quote(msg):
    """Live ticks for the app's charts/ticket/P&L: {type:'quote', symbols:['US30',…]}
    -> {type:'quotes', quotes:[{symbol(resolved), bid, ask, time}]}"""
    identity_error = _locked_identity_error()
    if identity_error:
        return {**err(identity_error)}
    syms = msg.get("symbols") or []
    if not isinstance(syms, list) or not syms:
        return {**err("symbols must be a non-empty list")}
    out = []
    unresolved = []
    for raw in syms[:20]:
        requested = str(raw or "").strip()
        sym = resolve_symbol(requested)
        if not sym:
            unresolved.append({"requested": requested, "message": _symbol_match_error(requested)})
            continue
        t = mt5.symbol_info_tick(sym)
        if t is None:
            unresolved.append({"requested": requested, "resolved": sym, "message": "No current tick for MT5 symbol '" + sym + "'."})
            continue
        _inf = mt5.symbol_info(sym)
        _path = str(getattr(_inf, "path", "") or "")
        _desc = str(getattr(_inf, "description", "") or "")
        out.append({"symbol": sym, "bid": float(t.bid or 0), "ask": float(t.ask or 0), "time": int(t.time or 0),
                    "volume_min": getattr(_inf, "volume_min", None),
                    "volume_max": getattr(_inf, "volume_max", None),
                    "volume_step": getattr(_inf, "volume_step", None),
                    "volume_limit": getattr(_inf, "volume_limit", None),
                    "contract_size": getattr(_inf, "trade_contract_size", None),
                    "currency_base": getattr(_inf, "currency_base", None),
                    "currency_profit": getattr(_inf, "currency_profit", None),
                    "currency_margin": getattr(_inf, "currency_margin", None),
                    "trade_mode": getattr(_inf, "trade_mode", None), "digits": getattr(_inf, "digits", None),
                    "point": getattr(_inf, "point", None),
                    "tick_size": getattr(_inf, "tick_size", None),
                    "tick_value": getattr(_inf, "tick_value", None),
                    "trade_stops_level": getattr(_inf, "trade_stops_level", None),
                    "path": _path, "description": _desc,
                    "category": market_category(_path, _desc, sym),
                    "spec_source": "local MT5 terminal",
                    "spec_at": int(time.time())})
    return {"type": "quotes", "quotes": out, "unresolved": unresolved}


def handle_search(msg):
    """Symbol discovery for the picker: {type:'search', query:'US30'} -> matching broker names."""
    identity_error = _locked_identity_error()
    if identity_error:
        return {**err(identity_error)}
    q = re.sub(r"[^a-z0-9]", "", str(msg.get("query") or "").lower())
    if not q:
        return {**err("query required")}
    names = []
    for s in mt5.symbols_get() or []:
        sn = re.sub(r"[^a-z0-9]", "", s.name.lower())
        if q in sn and len(names) < 25:
            names.append(s.name)
    return {"type": "search", "names": names}


def handle_symbols(_msg):
    """Read-only list of the symbols available in this connected local MT5 terminal."""
    identity_error = _locked_identity_error()
    if identity_error:
        return {**err(identity_error)}
    try:
        rows = mt5.symbols_get()
    except Exception:
        rows = None
    if rows is None:
        return {**err("MT5 symbol catalogue is unavailable.")}
    rows = list(rows)
    out = []
    for row in rows[:5000]:
        info = mt5.symbol_info(row.name)
        if info is None:
            continue
        path = str(getattr(info, "path", "") or "")
        description = str(getattr(info, "description", "") or "")
        out.append({
            "symbol": str(info.name),
            "name": description or str(info.name),
            "path": path,
            "category": market_category(path, description, info.name),
            "digits": int(getattr(info, "digits", 5) or 0),
            "visible": bool(getattr(info, "visible", False)),
            "trade_mode": int(getattr(info, "trade_mode", 0) or 0),
        })
    return {"type": "symbols", "symbols": out, "count": len(out), "truncated": len(rows) > 5000, "source": "local MT5 terminal"}


def handle_history(msg):
    """Read-only OHLC history from the connected local MT5 terminal."""
    identity_error = _locked_identity_error()
    if identity_error:
        return {**err(identity_error)}
    requested_symbol = str(msg.get("symbol") or "").strip()
    sym = resolve_symbol(requested_symbol)
    if not sym:
        return {**err(_symbol_match_error(requested_symbol))}
    frame = str(msg.get("timeframe") or "").upper()
    frames = {"M1": mt5.TIMEFRAME_M1, "M5": mt5.TIMEFRAME_M5, "M15": mt5.TIMEFRAME_M15, "H1": mt5.TIMEFRAME_H1}
    if frame not in frames:
        return {**err("Timeframe must be M1, M5, M15, or H1.")}
    try:
        count = max(50, min(300, int(msg.get("count") or 120)))
    except (TypeError, ValueError, OverflowError):
        count = 120
    try:
        rates = mt5.copy_rates_from_pos(sym, frames[frame], 0, count)
    except Exception:
        rates = None
    if rates is None or len(rates) < 50:
        return {**err("MT5 did not return enough candle history for " + sym + ".")}
    candles = []
    for r in rates:
        try:
            candle = {"time": int(r["time"]), "open": float(r["open"]), "high": float(r["high"]),
                      "low": float(r["low"]), "close": float(r["close"]), "volume": int(r["tick_volume"])}
        except (TypeError, ValueError, OverflowError, KeyError):
            continue
        if all(math.isfinite(candle[k]) for k in ("open", "high", "low", "close")) and min(candle["open"], candle["high"], candle["low"], candle["close"]) > 0:
            candles.append(candle)
    if len(candles) < 50:
        return {**err("MT5 did not return 50 valid candles for " + sym + ".")}
    candles.sort(key=lambda row: row["time"])
    return {"type": "history", "symbol": sym, "timeframe": frame, "candles": candles,
            "source": "local MT5 terminal", "ts": int(time.time())}


HANDLERS = {"login": handle_login, "preview_order": handle_order_preview, "order": handle_order, "close": handle_close, "positions": handle_positions, "account": handle_account, "quote": handle_quote, "search": handle_search, "symbols": handle_symbols, "history": handle_history}


# ---------------------------------------------------------------- server
async def handler(ws, path=None):
    remote = getattr(ws, "remote_address", None)
    is_remote = bool(remote) and not _ip_is_local(remote[0])
    if is_remote:
        log.info("remote client connected (%s) - bridge token required", remote)
    log.info("client connected (%s)", remote)
    _req = getattr(ws, "request", None)
    _hdrs = getattr(_req, "headers", None) or getattr(ws, "request_headers", None)
    _origin = _hdrs.get("Origin") if _hdrs else None
    if _origin and not _origin_allowed(_origin):
        log.warning("rejecting cross-origin ws upgrade (Origin %s)", _origin)
        try:
            await ws.close(code=1008, reason="cross-origin websocket not allowed")
        except TypeError:
            await ws.close()
        return
    authed = False  # per-connection: trading commands need a login FIRST
    login_fails = 0
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except (ValueError, TypeError):
                await ws.send(json.dumps({**err("invalid JSON")}))
                continue
            mid = msg.get("id")
            kind = msg.get("type")
            if kind == "ping":  # health check from the web app
                await ws.send(json.dumps({"id": mid, "type": "pong", "t": msg.get("t"), "bridge": BRIDGE_BUNDLE}))
                continue
            if kind == "auth":  # 20g: the web app pre-checks the bridge token before login
                if _token_ok(msg, is_remote):
                    await ws.send(json.dumps({"id": mid, "type": "auth_ok"}))
                else:
                    await ws.send(json.dumps({**err("bridge token rejected - copy the local secret from bridge_token.txt into the Bridge token field on your device"), "id": mid}))
                continue
            if kind == "login" and not _token_ok(msg, is_remote):
                reply = {**err("bridge token rejected - use the same local secret from bridge_token.txt (or the AURUM_BRIDGE_TOKEN environment setting) in the Bridge token field")}
            elif kind in _NEED_AUTH and not authed:
                reply = {"type": "error", "code": "auth_required",
                         "message": "login required on this connection first - send type=login with the account number and TRADER password before " + str(kind)}
                log.warning("unauthenticated %s rejected (drive-by protection)", kind)
            else:
                fn = HANDLERS.get(kind)
                if fn is None:
                    reply = {**err(f"unknown request type: {kind!r}")}
                else:
                    try:
                        reply = fn(msg)
                        if kind == "login":
                            authed = reply.get("type") == "logged"
                            if not authed:
                                login_fails += 1
                                if login_fails >= 5:
                                    reply = {**err("too many failed logins on this connection - closing")}
                                    try:
                                        await ws.send(json.dumps({**reply, "id": mid}))
                                    except Exception:
                                        pass
                                    await ws.close(code=1008, reason="too many failed logins")
                                    return
                        if reply.get("type") == "error":
                            log.warning("%s -> error: %s", kind, reply.get("message"))
                    except Exception as e:  # never crash the socket on one bad frame
                        log.exception("handler failed")
                        reply = {**err(f"internal error: {e}")}
            reply["id"] = mid
            await ws.send(json.dumps(reply))
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        log.info("client disconnected")


_CONFIGURED_MT5_PATH = os.environ.get("AURUM_MT5_PATH", "").strip()
CANDIDATE_PATHS = [_CONFIGURED_MT5_PATH] if _CONFIGURED_MT5_PATH else [None]

def _wants_account(failure):
    """True when MetaTrader 5 itself answered an attach with 'Authorization failed' (-6): no account is logged in."""
    if not failure or failure.get("kind") != "mt5":
        return False
    return failure.get("code") == -6 or "authorization" in str(failure.get("text") or "").lower()


def _now():
    """Seconds on a clock that only runs forward: for how long an attach has taken."""
    return time.monotonic()


def attach_terminal(account=None):
    """Attach to the MetaTrader 5 terminal; False when that fails or another attach is running.

    How long MetaTrader 5 may take is in _ATTACH_STATE["wait_ms"]: 5 s for an
    attach asked for by a login, 60 s at bridge start (main() sets that).
    The reason for a failure is left in _ATTACH_FAILURE.

    `account` is (login, password, server) as entered in the app; the attach
    at bridge start has none. The attach is first made without it, as it
    always was. Only when MetaTrader 5 answers that it is not logged in (-6)
    is the attach made with the account, and MetaTrader 5 logs in to it:
    in the same call when there is time left for it, by the next login
    otherwise. When the attach before this one ended with that answer, the
    one without the account is not repeated: MetaTrader 5 gets the account
    at once. A connector that takes no waiting time gets no attach with the
    account (_CONNECTOR_TAKES_TIMEOUT).
    """
    wait_ms = _ATTACH_STATE["wait_ms"]
    recent = _ATTACH_FAILURE
    account_at_once = account is not None and _CONNECTOR_TAKES_TIMEOUT and _wants_account(recent)
    if recent is not None and time.time() - (recent.get("at") or 0.0) < _ATTACH_REPEAT_QUIET_S:
        # The app repeats a failed login at once over HTTP: same answer, no second attempt. One case is
        # no repeat: MetaTrader 5 has just said "not logged in" to an attach without an account, and this
        # login brings the account for the attach that has not been made yet.
        if not account_at_once or recent.get("with_account"):
            return False
    if not _ATTACH_LOCK.acquire(blocking=False):
        return False  # an attach is in progress; handle_login() says so
    try:
        began = _now()
        if not account_at_once:
            _ATTACH_STATE["since"], _ATTACH_STATE["limit_s"] = time.time(), wait_ms / 1000.0
            if _attach_terminal_once(wait_ms, account_follows=account is not None and _CONNECTOR_TAKES_TIMEOUT):
                return True
            if account is None or not _CONNECTOR_TAKES_TIMEOUT or not _wants_account(_ATTACH_FAILURE):
                return False
        left_ms = min(wait_ms, _ACCOUNT_ATTACH_END_MS) - (_now() - began) * 1000.0
        if left_ms < _ACCOUNT_ATTACH_MIN_MS:
            return False  # the answer "not logged in" stands; the next login starts with the account
        account_wait_ms = int(round(left_ms / 100.0)) * 100  # in tenths of a second: the message names the time
        _ATTACH_STATE["since"], _ATTACH_STATE["limit_s"] = time.time(), account_wait_ms / 1000.0
        return _attach_terminal_once(account_wait_ms, account)
    finally:
        _ATTACH_STATE["since"] = 0.0
        _ATTACH_LOCK.release()


def _initialize(path, wait_ms, account=None):
    """mt5.initialize() with a waiting time. Returns (ok, the waiting time in seconds).

    'timeout' is a documented keyword of MetaTrader5.initialize(). Should a
    connector not take it, the call is made the way it was made before, and
    then the connector's own 60 seconds apply. `account` is (login, password,
    server): MetaTrader 5 then logs in to that account as part of the attach.
    That attach is never made without a waiting time: with an account, the
    error is the caller's to report.
    """
    global _CONNECTOR_TAKES_TIMEOUT
    where = (path,) if path else ()
    named = {}
    if account is not None:
        login, password, server = account
        named = {"login": int(login), "password": str(password), "server": str(server)}
    try:
        return mt5.initialize(*where, timeout=int(wait_ms), **named), wait_ms / 1000.0
    except TypeError:
        if account is not None:
            raise
        ok = mt5.initialize(*where)  # a TypeError here as well was about something else: it goes to the caller
        _CONNECTOR_TAKES_TIMEOUT = False
        return ok, 60.0


def _without_account(text, account):
    """What MetaTrader 5 or its connector said, without the password and the account number,
    should either ever repeat them: the text goes to the app and into the bridge window."""
    said = str(text)
    if account:
        login, password = str(account[0]), str(account[1])
        if password:
            said = said.replace(password, "[password]")
        if login:
            said = said.replace(login, "[account number]")
    return said


def _attach_terminal_once(wait_ms, account=None, account_follows=False):
    """One round of initialize(). With `account`, MetaTrader 5 is given the account to log in to.

    `account_follows`: the caller makes the attach with the account next when MetaTrader 5 answers
    "not logged in" to this one, so that answer is noted in the bridge window and not reported as a failure.
    """
    global _ATTACH_FAILURE
    last = None
    failure = None
    limit_s = wait_ms / 1000.0
    with_account = account is not None
    if not _CONFIGURED_MT5_PATH:
        log.warning("AURUM_MT5_PATH is not set; using the MetaTrader5 default terminal. Verify the connected server is Exness before login.")
    for p in CANDIDATE_PATHS:
        if p and not os.path.isfile(p):
            last = "Configured AURUM_MT5_PATH does not exist: " + p
            log.error(last)
            failure = {"kind": "missing", "path": p, "code": None, "text": "", "limit_s": limit_s}
            continue
        try:
            ok, limit_s = _initialize(p, wait_ms, account)
        except Exception as e:
            text = _without_account(e, account)
            ok, last = False, text
            failure = {"kind": "exception", "path": p, "code": None, "text": text, "limit_s": limit_s, "with_account": with_account}
            continue
        if ok:
            if p:
                log.info("attached to terminal: %s", p)
            if with_account:
                log.info("attached with the account entered in the app: MetaTrader 5 has logged in to it")
            _ATTACH_FAILURE = None
            return True
        code, text = _last_error()  # read it now: mt5.shutdown() below sets it back to (1, 'Success')
        text = _without_account(text, account)
        last = str((code, text))
        failure = {"kind": "mt5", "path": p, "code": code, "text": text, "limit_s": limit_s, "with_account": with_account}
        log.warning("initialize(%s%s) failed: %s", p or "default terminal",
                    ", with the account entered in the app" if with_account else "", last)
        try:
            mt5.shutdown()
        except Exception:
            pass
    if failure is not None:
        failure["at"] = time.time()
    _ATTACH_FAILURE = failure
    if account_follows and _wants_account(failure):
        log.info("MetaTrader 5 is not logged in: the account entered in the app is tried next")
        return False
    if last:
        log.error("MetaTrader5.initialize() failed: %s", last)
    if last and ("Authorization failed" in last or "(-6" in last):
        log.error("  The terminal was seen but NOT fully logged in / attachable. Checklist:")
        log.error("   1. In MT5: File > Login to Trade Account -- use the account number,")
        log.error("      matching DEMO/REAL Exness server, and MT5 trading password.")
        log.error("   2. Connected = GREEN bars bottom-right of MT5 + ticking prices in Market Watch.")
        log.error("   3. Just re-run this bridge -- if MT5 was mid-reconnect, the retry attaches.")
        log.error("   4. If MT5 was started with 'Run as administrator': close it and start it")
        log.error("      NORMALLY (plain double-click) -- Python cannot attach to an elevated MT5.")
        log.error("   5. Close any OTHER MetaTrader 5 windows -- only the logged-in one should run.")
    elif last:
        log.error("  -- is the MT5 terminal running? Open it, log in once, then run this again.")
    return False

try:
    from websockets.datastructures import Headers
    from websockets.http11 import Response
except Exception:
    Headers = Response = None

def _lan_ip():
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "?"


def _up_txt():
    ip = _lan_ip()
    lines = [
        "AURUM bridge is UP (bundle %s) -- websocket endpoint: ws://%s:8787" % (BRIDGE_BUNDLE, ip),
        "On THIS PC open:   http://127.0.0.1:8788/app",
        "On a PHONE/tablet (same wifi):  http://%s:8788/app" % ip,
        "   - or the https app with Bridge URL ws://%s:8787" % ip,
    ]
    if _BRIDGE_TOKEN:
        lines.append("Bridge token is configured; its value is intentionally not printed. If created by SETUP_AND_RUN.bat, read it locally from bridge_token.txt.")
    else:
        lines.append("No bridge token configured; remote devices are blocked. Run SETUP_AND_RUN.bat to create a local token.")
    lines.append("Windows firewall: if asked, ALLOW python on Private networks.")
    lines.append("If the app says 'no answer in 4s' and this window shows NO 'client connected' line,")
    lines.append("the browser never reached the bridge: use http://127.0.0.1:8788/app in Chrome/Edge")
    lines.append("(not the app.html file, not the installed https app), click any 'Allow local network'")
    lines.append("bubble, and pause VPN/proxy/antivirus web-shield while testing.")
    return "\n".join(lines)
UPSTREAM = os.environ.get("AURUM_UPSTREAM", "https://aurum-staging.up.railway.app")
_BRIDGE_DIR = os.path.dirname(os.path.abspath(__file__))
_APP_FILE = os.path.join(_BRIDGE_DIR, "app.html")
_PWA_FILES = {
    "/manifest.webmanifest": (os.path.join(_BRIDGE_DIR, "pwa", "manifest.webmanifest"), "application/manifest+json; charset=utf-8"),
    "/sw.js": (os.path.join(_BRIDGE_DIR, "pwa", "sw.js"), "application/javascript; charset=utf-8"),
    "/icons/icon-192.png": (os.path.join(_BRIDGE_DIR, "pwa", "icons", "icon-192.png"), "image/png"),
    "/icons/icon-512.png": (os.path.join(_BRIDGE_DIR, "pwa", "icons", "icon-512.png"), "image/png"),
    "/icons/icon-maskable-512.png": (os.path.join(_BRIDGE_DIR, "pwa", "icons", "icon-maskable-512.png"), "image/png"),
    "/icons/apple-touch-icon.png": (os.path.join(_BRIDGE_DIR, "pwa", "icons", "apple-touch-icon.png"), "image/png"),
    "/icons/favicon-32.png": (os.path.join(_BRIDGE_DIR, "pwa", "icons", "favicon-32.png"), "image/png"),
}

_OPENER = None
def _opener():
    """urllib opener that IGNORES system/browser proxy settings (Windows picks
    up registry proxies, which often cannot reach the app server)."""
    global _OPENER
    if _OPENER is None:
        import urllib.request as u
        _OPENER = u.build_opener(u.ProxyHandler({}))
    return _OPENER

def _proxy_api(method, path, body, ctype):
    """Forward /api/* to the AURUM server (fixed upstream, direct, sync)."""
    import time
    import urllib.error as ue
    t = time.time()
    try:
        import urllib.request as u
        req = u.Request(UPSTREAM.rstrip("/") + path, data=body if body else None, method=method)
        req.add_header("Content-Type", ctype or "application/json")
        req.add_header("Accept", "application/json")
        try:
            with _opener().open(req, timeout=15) as r:
                st, ct, data = r.status, r.headers.get("Content-Type", "application/json"), r.read()
        except ue.HTTPError as e:
            st, ct = e.code, e.headers.get("Content-Type", "application/json")
            try:
                data = e.read()
            except Exception:
                data = b'{"error":"upstream error"}'
        log.info("api %s %s -> %s in %.2fs", method, path, st, time.time() - t)
        return st, ct, data
    except Exception as e:
        log.error("api %s %s FAILED in %.2fs: %s", method, path, time.time() - t, e)
        return 502, "application/json", ('{"error":"bridge proxy: %s"}' % e).encode()

def _load_app():
    try:
        with open(_APP_FILE, "rb") as f:
            return f.read()
    except Exception:
        return None

def _http_answer(path, hdrs):
    """Non-websocket HTTP: local app, /api proxy, or the UP text."""
    common = [("Access-Control-Allow-Origin", "*"),
              ("Access-Control-Allow-Private-Network", "true"),
              ("Access-Control-Allow-Headers", "*"),
              ("Access-Control-Allow-Methods", "GET, POST, OPTIONS")]
    if path.rstrip("/") == "/bridge" and (hdrs.get("method") or "GET").upper() == "POST":
        reply = _http_bridge_command(hdrs.get("__body"), hdrs.get("__peer"), hdrs.get("__sid") or "")
        return 200, common + [("Content-Type", "application/json; charset=utf-8")], json.dumps(reply).encode()
    if path.startswith("/api/"):
        if not api_proxy_authorized(_LOCAL_API_TOKEN, hdrs.get("x-aurum-local-api-token"), (hdrs.get("__peer") or ("",))[0]):
            return 403, common + [("Content-Type", "application/json; charset=utf-8")], b'{"error":"local API access requires the bridge token"}'
        method = hdrs.get("method") or "GET"
        body = hdrs.get("__body")
        st, ct, data = _proxy_api(method, path, body, hdrs.get("content-type"))
        return st, common + [("Content-Type", ct)], data
    if path in ("/app", "/app/", "/index.html"):
        # 8787 cannot proxy POSTs (websockets drops non-GET HTTP) -> the app
        # must be used from the threaded HTTP server on 8788. Send them there.
        return 301, common + [("Content-Type", "text/plain; charset=utf-8"),
                              ("Location", "http://127.0.0.1:8788/app")], b"opening http://127.0.0.1:8788/app"
    return 200, common + [("Content-Type", "text/plain; charset=utf-8")], _up_txt().encode()

_HTTP_SESSIONS = {}  # 20j: sid -> {"authed": bool, "fails": int, "t": float}

def _http_bridge_command(body, peer, sid=""):
    """20j: run one bridge command over plain HTTP (POST /bridge) so the app
    keeps working when a VPN/proxy/antivirus intercepts the websocket upgrade.
    Same protocol, same gates (token, login-first) — just a different pipe."""
    import time as _t
    try:
        msg = json.loads(body or b"{}")
    except Exception:
        return {"type": "error", "message": "invalid JSON"}
    mid = msg.get("id")
    kind = msg.get("type")
    remote = not _ip_is_local((peer or ("",))[0])
    sid = str(sid or msg.get("_sid") or "")[:64] or "anon"
    st = _HTTP_SESSIONS.setdefault(sid, {"authed": False, "fails": 0, "t": _t.time()})
    if len(_HTTP_SESSIONS) > 512:
        for k in [k for k, v in _HTTP_SESSIONS.items() if _t.time() - v.get("t", 0) > 43200]:
            _HTTP_SESSIONS.pop(k, None)
    st["t"] = _t.time()
    if kind == "ping":
        return {"id": mid, "type": "pong", "t": msg.get("t"), "bridge": BRIDGE_BUNDLE}
    if kind == "auth":
        return ({"id": mid, "type": "auth_ok"} if _token_ok(msg, remote)
                else {**err("bridge token rejected - copy the local secret from bridge_token.txt into the Bridge token field on your device"), "id": mid})
    if kind == "login" and not _token_ok(msg, remote):
        return {**err("bridge token rejected - copy the local secret from bridge_token.txt into the Bridge token field on your device"), "id": mid}
    if kind in _NEED_AUTH and not st.get("authed"):
        return {"id": mid, "type": "error", "code": "auth_required",
                "message": "login required first - send type=login before " + str(kind)}
    fn = HANDLERS.get(kind)
    if fn is None:
        reply = {**err("unknown request type: %r" % (kind,))}
    else:
        try:
            reply = fn(msg)
            if kind == "login":
                st["authed"] = reply.get("type") == "logged"
                if not st["authed"]:
                    st["fails"] = st.get("fails", 0) + 1
        except Exception as e:
            reply = {**err("internal error: %s" % e)}
    reply["id"] = mid
    return reply

async def _bridge_http(*args):
    """Answer plain HTTP (browser tab test / PNA preflights / local app / api proxy).

    websockets >= 13: process_request(connection, request) -- request body IS read.
    websockets 10-12: process_request(path, request_headers) -- GET-only proxy
    (that API cannot access the body; the installed 17.x uses the new API).
    """
    if len(args) == 2 and hasattr(args[1], "headers"):  # new API
        conn, req = args
        up = (req.headers.get("Upgrade") or "").lower()
        if up != "websocket":
            path = getattr(req, "path", "/") or "/"
            body = None
            if (getattr(req, "method", "GET") or "GET").upper() in ("POST", "PUT", "PATCH"):
                try:
                    body = await req.body
                except Exception:
                    body = None
            st, hdrs, data = _http_answer(path, {"method": getattr(req, "method", "GET"),
                                                 "content-type": req.headers.get("Content-Type"),
                                                 "x-aurum-local-api-token": req.headers.get("X-Aurum-Local-Api-Token") or "",
                                                 "__body": body,
                                                 "__peer": getattr(conn, "remote_address", None),
                                                 "__sid": req.headers.get("X-Aurum-Session") or ""})
            if Response is not None:
                return Response(st, "OK" if st < 400 else "ERR", Headers(hdrs), data)
            return conn.respond(st, data.decode("utf-8", "replace"), Headers(hdrs))
        try:  # 20g handshake audit: every WS attempt shows in the window, even half-finished ones
            log.info("incoming ws upgrade from %s origin=%s",
                     getattr(conn, "remote_address", "?"), req.headers.get("Origin") or "-")
        except Exception:
            pass
        return None  # websocket handshake -> proceed
    path, request_headers = args  # legacy API
    up = (request_headers.get("Upgrade") or "").lower()
    if up != "websocket":
        st, hdrs, data = _http_answer(path, {"method": "GET", "content-type": request_headers.get("Content-Type"), "__body": None})
        return st, hdrs, data
    try:
        log.info("incoming ws upgrade (legacy api) origin=%s", request_headers.get("Origin") or "-")
    except Exception:
        pass
    return None

def _start_http_app(port=8788):
    """Real threaded HTTP server for the local app (GET+POST /api proxy, /app).

    Runs on its own threads, so slow upstream calls never stall the websocket
    loop, and POST works (websockets' handshake port only serves GETs).
    """
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def _send(self, st, ctype, data, extra=None):
            try:
                self.send_response(st)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                _ao = self.headers.get("Origin") or ""
                if _ao and _origin_allowed(_ao):
                    self.send_header("Access-Control-Allow-Origin", _ao)
                self.send_header("Access-Control-Allow-Private-Network", "true")
                self.send_header("Access-Control-Allow-Headers", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                for k, v in (extra or []):
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(data)
            except Exception:
                pass
        def _ws(self):
            """RFC6455 server on 8788: one port for app + api + trading socket."""
            import base64, hashlib, struct
            key = self.headers.get("Sec-WebSocket-Key")
            if not key:
                self._send(400, "text/plain; charset=utf-8", b"websocket handshake missing key")
                return
            _origin = self.headers.get("Origin") or ""
            if _origin and not _origin_allowed(_origin):
                self._send(403, "text/plain; charset=utf-8", b"cross-origin websocket not allowed")
                return
            accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            self.send_response(101, "Switching Protocols")
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            self._authed = False  # per-connection: trading commands need a login FIRST
            log.info("trading socket connected (8788, same port as the app)")
            try:
                self._ws_loop(struct)
            except (ConnectionError, OSError):
                pass
            except Exception as e:
                log.warning("ws 8788 ended: %s", e)
            finally:
                log.info("trading socket closed")
        def _recv_exact(self, n):
            buf = b""
            while len(buf) < n:
                chunk = self.rfile.read(n - len(buf))
                if not chunk:
                    raise ConnectionError("socket closed")
                buf += chunk
            return buf
        def _ws_send(self, obj):
            self.wfile.write(self._ws_frame(json.dumps(obj).encode("utf-8")))
            self.wfile.flush()
        def _ws_frame(self, data):
            import struct
            h = b"\x81"
            n = len(data)
            if n < 126:
                h += bytes([n])
            elif n < 65536:
                h += bytes([126]) + struct.pack(">H", n)
            else:
                h += bytes([127]) + struct.pack(">Q", n)
            return h + data
        def _ws_loop(self, struct):
            while True:
                hdr = self._recv_exact(2)
                op = hdr[0] & 0x0F
                ln = hdr[1] & 0x7F
                masked = bool(hdr[1] & 0x80)
                if ln == 126:
                    ln = struct.unpack(">H", self._recv_exact(2))[0]
                elif ln == 127:
                    ln = struct.unpack(">Q", self._recv_exact(8))[0]
                mask = self._recv_exact(4) if masked else b""
                payload = self._recv_exact(ln) if ln else b""
                if mask and payload:
                    payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
                if op == 0x8:  # close
                    try:
                        self.wfile.write(b"\x88\x00")
                        self.wfile.flush()
                    except Exception:
                        pass
                    return
                if op == 0x9:  # ping -> pong
                    self.wfile.write(b"\x8A" + bytes([len(payload)]) + payload)
                    self.wfile.flush()
                    continue
                if op != 0x1:
                    continue
                try:
                    msg = json.loads(payload.decode("utf-8"))
                except Exception:
                    self._ws_send({"type": "error", "message": "invalid JSON"})
                    continue
                mid = msg.get("id")
                kind = msg.get("type")
                if kind == "ping":  # health check
                    self._ws_send({"id": mid, "type": "pong", "t": msg.get("t"), "bridge": BRIDGE_BUNDLE})
                    continue
                if kind == "auth":  # 20g: token pre-check (same contract as the 8787 socket)
                    if _token_ok(msg, not _ip_is_local((getattr(self, "client_address", ("",)) or ("",))[0])):
                        self._ws_send({"id": mid, "type": "auth_ok"})
                    else:
                        self._ws_send({**err("bridge token rejected - copy the local secret from bridge_token.txt into the Bridge token field on your device"), "id": mid})
                    continue
                if kind == "login" and not _token_ok(msg, not _ip_is_local((getattr(self, "client_address", ("",)) or ("",))[0])):
                    self._login_fails = getattr(self, "_login_fails", 0) + 1
                    if self._login_fails >= 5:
                        self._ws_send({**err("too many failed logins on this connection - closing")})
                        return
                    self._ws_send({**err("bridge token rejected - use the same local secret from bridge_token.txt (or the AURUM_BRIDGE_TOKEN environment setting) in the Bridge token field")})
                    continue
                if kind in _NEED_AUTH and not getattr(self, "_authed", False):
                    self._ws_send({"type": "error", "code": "auth_required",
                                   "message": "login required on this connection first - send type=login with the account number and TRADER password before " + str(kind)})
                    log.warning("unauthenticated %s rejected on 8788 (drive-by protection)", kind)
                    continue
                fn = HANDLERS.get(kind)
                if fn is None:
                    reply = {**err("unknown request type: %r" % (kind,))}
                else:
                    try:
                        reply = fn(msg)
                        if kind == "login":
                            self._authed = reply.get("type") == "logged"
                            if not self._authed:
                                self._login_fails = getattr(self, "_login_fails", 0) + 1
                                if self._login_fails >= 5:
                                    self._ws_send({**err("too many failed logins on this connection - closing")})
                                    return
                        if reply.get("type") == "error":
                            log.warning("%s -> error: %s", kind, reply.get("message"))
                    except Exception as e:
                        log.exception("handler failed")
                        reply = {**err("internal error: %s" % e)}
                reply["id"] = mid
                self._ws_send(reply)
        def _do(self):
            try:
                if (self.headers.get("Upgrade") or "").lower() == "websocket":
                    self._ws()
                    return
                path = (self.path or "/").split("?", 1)[0]
                if path == "/ready" and (self.command or "GET").upper() == "GET":
                    self._send(200, "text/plain; charset=utf-8", b"AURUM local app bridge ready", [("Cache-Control", "no-store")])
                    return
                if path == "/local-config" and (self.command or "GET").upper() == "GET":
                    # Auto-fill the local bridge token only in a same-origin
                    # loopback browser tab. Never disclose it to LAN clients.
                    import ipaddress
                    try:
                        peer_ip = ipaddress.ip_address(str(self.client_address[0]))
                        peer_loopback = peer_ip.is_loopback or bool(getattr(peer_ip, "ipv4_mapped", None) and peer_ip.ipv4_mapped.is_loopback)
                    except ValueError:
                        peer_loopback = False
                    host = str(self.headers.get("Host") or "").lower()
                    origin = str(self.headers.get("Origin") or "").rstrip("/").lower()
                    fetch_site = str(self.headers.get("Sec-Fetch-Site") or "").lower()
                    allowed_hosts = {"127.0.0.1:8788", "localhost:8788", "[::1]:8788"}
                    expected_origin = "http://" + host
                    allowed = peer_loopback and host in allowed_hosts and (not origin or origin == expected_origin) and fetch_site in ("", "same-origin")
                    if not allowed:
                        self._send(403, "application/json; charset=utf-8", b'{"error":"local token is available only to this PC browser tab"}', [("Cache-Control", "no-store")])
                        return
                    exness_server = ""
                    try:
                        # No MetaTrader5 call while an attach is running: the page then fills in the token only.
                        account = None if _ATTACH_LOCK.locked() else mt5.account_info()
                        if account is not None:
                            exness_server = str(getattr(account, "server", "") or "")
                    except Exception:
                        pass
                    payload = json.dumps({"bridgeToken": _BRIDGE_TOKEN, "exnessServer": exness_server}).encode("utf-8")
                    self._send(200, "application/json; charset=utf-8", payload, [("Cache-Control", "no-store"), ("Vary", "Origin")])
                    return
                if path.rstrip("/") == "/bridge" and (self.command or "GET").upper() == "POST":
                    n = int(self.headers.get("Content-Length") or 0)
                    body = self.rfile.read(n) if n else b""
                    reply = _http_bridge_command(body, self.client_address, self.headers.get("X-Aurum-Session") or "")
                    self._send(200, "application/json; charset=utf-8", json.dumps(reply).encode())
                    return
                if path.startswith("/api/"):
                    supplied = self.headers.get("X-Aurum-Local-Api-Token") or ""
                    if not api_proxy_authorized(_LOCAL_API_TOKEN, supplied, self.client_address[0]):
                        self._send(403, "application/json; charset=utf-8", b'{"error":"local API access requires the bridge token"}')
                        return
                    n = int(self.headers.get("Content-Length") or 0)
                    body = self.rfile.read(n) if n else None
                    st, ct, data = _proxy_api(self.command, path, body, self.headers.get("Content-Type"))
                    self._send(st, ct, data)
                    return
                if self.command == "GET" and path in _PWA_FILES:
                    asset_path, asset_type = _PWA_FILES[path]
                    try:
                        with open(asset_path, "rb") as asset_file:
                            asset = asset_file.read()
                        cache = "no-cache" if path in ("/sw.js", "/manifest.webmanifest") else "public, max-age=86400"
                        self._send(200, asset_type, asset, [("Cache-Control", cache), ("X-Content-Type-Options", "nosniff")])
                    except OSError:
                        self._send(404, "text/plain; charset=utf-8", b"PWA asset missing - re-extract the latest local app package")
                    return
                if path in ("/app", "/app/", "/index.html"):
                    app = _load_app()
                    if app:
                        self._send(200, "text/html; charset=utf-8", app)
                    else:
                        self._send(404, "text/plain; charset=utf-8", b"app.html missing - re-extract the latest zip")
                    return
                self._send(200, "text/plain; charset=utf-8", _up_txt().encode())
            except Exception as e:
                try:
                    self._send(500, "text/plain; charset=utf-8", str(e).encode())
                except Exception:
                    pass
        def do_GET(self): self._do()
        def do_POST(self): self._do()
        def do_OPTIONS(self): self._send(204, "text/plain", b"")
        def log_message(self, fmt, *args):
            log.info("http " + (fmt % args))
    try:
        srv = ThreadingHTTPServer((HOST, port), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        log.info("local app server: http://127.0.0.1:%d/app (this PC)  |  http://%s:%d/app (phone, same wifi)", port, _lan_ip(), port)
        return srv
    except OSError as e:
        if "10048" in str(e) or getattr(e, "errno", None) == 98:
            log.error("Port %d busy -- an older bridge is still running. Close other black bridge windows and re-run.", port)
        else:
            log.error("local app server failed: %s", e)
        return None

async def _self_test():
    """Prove from THIS machine that the bridge answers its own websocket.
    If this passes but the browser still gets 'no answer in 4s', the blockage
    is browser-side (proxy/VPN/antivirus/mixed content), not the bridge."""
    await asyncio.sleep(0.3)
    try:
        from websockets.asyncio.client import connect as _conn
    except Exception:
        from websockets import connect as _conn
    for host in ("127.0.0.1", "localhost"):
        try:
            async with _conn("ws://%s:%d" % (host, PORT), open_timeout=4, close_timeout=1) as ws:
                await ws.send(json.dumps({"id": "self", "type": "ping"}))
                r = json.loads(await asyncio.wait_for(ws.recv(), 3))
                if r.get("type") == "pong":
                    log.info("SELF-TEST PASSED: this PC reaches the bridge on ws://%s:%d -- if the app still says 'no answer in 4s', the BROWSER is blocking it (see the lines at the bottom of this window)", host, PORT)
                    return
        except Exception as e:
            log.warning("self-test on ws://%s:%d failed: %s", host, PORT, e)
    log.error("SELF-TEST FAILED: even this PC cannot reach the bridge -- check antivirus/firewall rules for python on port %d", PORT)


async def main():
    # Keep the local workspace available even if MT5 is closed or the IPC
    # attachment fails. MT5 read-only requests return an explicit terminal error;
    # the static app and other analysis do not depend on a broker login.
    _start_http_app()
    _ATTACH_STATE["wait_ms"] = _START_ATTACH_WAIT_MS  # a terminal the launcher has only just started needs the time
    attached = attach_terminal()
    _ATTACH_STATE["wait_ms"] = _LOGIN_ATTACH_WAIT_MS
    if attached:
        log.info("MT5 terminal attached (build %s)", mt5.version())
        try:
            acc = mt5.account_info()
            if acc is not None:
                log.info("MT5 account ending %s @ %s (currency %s)", _mask_account(acc.login)[-4:], acc.server, acc.currency)
                if not acc.trade_allowed:
                    log.info("MT5 reports read-only account permissions; this verification build is read-only either way.")
        except Exception:
            pass
        try:
            term = mt5.terminal_info()
            if term is not None and not term.trade_allowed:
                log.info("MetaTrader Algo Trading is disabled; that is acceptable for Phase 1 read-only verification.")
        except Exception:
            pass
    else:
        log.error("MT5 unavailable: local app remains available at http://127.0.0.1:8788/app; Exness read-only data is unavailable until MT5 attaches.")
        log.error("%s", _attach_failure_message())  # the same plain words the app shows when Connect is pressed
    try:
        async with websockets.serve(handler, HOST, PORT, ping_interval=20, ping_timeout=20, process_request=_bridge_http):
            log.info("AURUM bridge listening on ws://%s:%d (this PC + LAN)", HOST, PORT)
            log.info("LEAVE THIS WINDOW OPEN.\n%s", _up_txt())
            asyncio.ensure_future(_self_test())
            await asyncio.Future()  # run forever
    except OSError as e:
        if getattr(e, "errno", None) == 10048 or "10048" in str(e):
            log.error("Port %d is ALREADY IN USE -- another bridge window/process is still running.", PORT)
            log.error("  Fix: close every OTHER black 'Exness MT5 Bridge' window (check the taskbar),")
            log.error("  then run this file again. If you cannot find it, in a cmd window:")
            log.error("    netstat -ano | findstr :%d      (the last number is the PID)", PORT)
            log.error("    taskkill /PID <that number> /F")
            sys.exit(1)
        raise


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("bridge stopped")
        mt5.shutdown()
