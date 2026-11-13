# AURUM ↔ Exness MT5 local bridge — Phase 1 (read-only)

This bridge runs on the Windows PC that has the official Exness MetaTrader 5 terminal. It gives the local AURUM app read-only access to account details, positions, quotes, verified symbols, and candle history. **Order sends and closes are deliberately disabled in both the app client and the Python bridge for this phase.** No connection to an account has been made from this workspace, and this guide does not authorize any trade.

The bridge is PC-local: credentials are entered into the local app and passed to the local MT5 terminal, not to a cloud market-data route. A phone on the same private Wi-Fi/LAN can use the PC-hosted app/bridge; it shares the same single account and exact server as the PC connection. No cloud relay is used.

## Requirements

- Windows with the official Exness MT5 terminal installed.
- Python 3.8–3.13 (the MetaTrader5 Python connector does not currently support newer Python versions).
- The exact Exness MT5 server shown for this account in the Exness Personal Area. Do not guess or use a server name copied from another broker/account.

## Setup

1. Extract the bridge ZIP; do not run the batch file from inside the ZIP viewer.
2. Keep the Exness MT5 desktop terminal open. If the bridge's automatic terminal selection does not pick the Exness installation, edit `SETUP_AND_RUN.bat` and set `AURUM_MT5_PATH` to the full local path of that Exness `terminal64.exe`.
3. Run `SETUP_AND_RUN.bat` once. It installs the Python requirements, creates/reuses the local bridge token, starts the bridge, creates the desktop app shortcut, and installs a per-user Windows Startup shortcut.
4. The Startup shortcut launches the bridge minimized and opens `http://127.0.0.1:8788/app` at each Windows sign-in. The desktop shortcut also starts/reuses the bridge and opens the app if you close it. Keep the bridge folder in the same location after setup. Exness MT5 must be installed and logged in for MT5 data; the bridge never stores your MT5 password.
5. On this PC, the app page is `http://127.0.0.1:8788/app`, but the **Bridge URL** field is the WebSocket endpoint `ws://127.0.0.1:8787` (not `http://...:8788`). From a phone on the same Wi-Fi, use the PC LAN WebSocket address printed in the bridge window, normally `ws://<PC-IP>:8787`, and the local bridge token.
6. Use **Test bridge** or connect read-only. A successful connection must report the exact server and an MT5 company identity containing Exness. A different account/server or unverified broker identity is refused. To disable automatic startup, run `REMOVE_AUTO_START.bat`; it does not delete the local token or stop a running bridge.

## Same account on PC and phone

The bridge keeps the first successfully verified Exness account number and server in memory for its lifetime. A second client (such as a phone) must use that same account and exact server; attempting to switch accounts is refused. If you intentionally need to change identity, disconnect clients and restart the bridge first. Do not start a second bridge against the same terminal.

For phone access, keep the phone on the same private Wi-Fi/LAN, open the PC address printed by the bridge window, and enter the locally stored token from `bridge_token.txt` in the app. Do not port-forward the bridge or expose it to the public internet. A phone's `127.0.0.1` refers to the phone itself, not the PC.

## Read-only scope and safety

- Read-only calls: account balance/equity/free margin, open-position snapshot, quote, symbol catalogue, and M1/M5/H1 history. These use the local MT5 terminal and stay on the PC/LAN.
- `MT5_EXECUTION_ENABLED` is hard-coded `False` in the Python bridge and the app client. Order and close requests are refused before reaching MT5. Changing that requires a separate risk review and explicit approval.
- The existing 10-position cap, server-side risk checks, fail-closed unknowns, and duplicate-order protection remain in place; this phase does not relax them.
- The new index route remains Exness MT5 only, never Deriv, and indices remain excluded from sniper/automation. A symbol must resolve in the authenticated terminal; otherwise the request fails closed.
- This is not a reset of app position counters or reservations. Do not clear any stored state as part of testing.
- The bridge token is stored locally beside the batch file. Keep it private; do not paste it into chat or screenshots.

## Troubleshooting

- If **Connect** answers `Cannot attach to MetaTrader 5: ...`, the words after the colon are the reason and the steps follow them; the message ends with the terminal that was tried. The bridge window prints the same text when it starts without MetaTrader 5. `(step terminal, code 1: Success)` comes from an `mt5_bridge.py` older than 13 November 2026 and hides the reason: replace the file and restart the bridge.
- If terminal attach is ambiguous, set `AURUM_MT5_PATH` to the exact Exness `terminal64.exe` path in the batch file and restart.
- If login is rejected, confirm the account number, MT5 password, and exact Exness server in the Exness Personal Area. An investor/read-only password is sufficient for the read-only phase.
- If the app reports a server/company mismatch, stop. Do not try a different broker terminal as a fallback.
- If positions, quotes, symbols, or history are unavailable, the app should report unavailable and block dependent actions; it must not invent prices or symbols.

Bundle name: `FREDRICK_EXNESS_BRIDGE.zip` (Phase 1 local read-only build).
