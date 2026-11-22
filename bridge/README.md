# AURUM ↔ Exness MT5 local bridge — manual REAL/DEMO orders

This bridge runs on the Windows PC that has the official Exness MetaTrader 5 terminal. It gives the local AURUM app access to account details, positions, quotes, verified symbols, and candle history. It can also create a short-lived order preview and send one **manually confirmed** market order on a broker-verified REAL or DEMO account, subject to local risk checks. Every order requires a separate confirmation; app automation/Sniper entries and app-side closes remain disabled. No connection to an account has been made from this workspace, and this guide does not authorize any trade.

The bridge is PC-local: credentials are entered into the local app and passed to the local MT5 terminal, not to a cloud market-data route. A phone on the same private Wi-Fi/LAN can use the PC-hosted app/bridge; it shares the same single account and exact server as the PC connection. No cloud relay is used.

## Requirements

- Windows with the official Exness MT5 terminal installed.
- Python 3.8–3.13 (the MetaTrader5 Python connector does not currently support newer Python versions).
- The exact Exness MT5 server shown for this account in the Exness Personal Area. Do not guess or use a server name copied from another broker/account.

## Setup

1. Extract the bridge ZIP; do not run the batch file from inside the ZIP viewer.
2. Keep the Exness MT5 desktop terminal open. If the bridge's automatic terminal selection does not pick the Exness installation, edit `SETUP_AND_RUN.bat` and set `AURUM_MT5_PATH` to the full local path of that Exness `terminal64.exe`.
3. Run `SETUP_AND_RUN.bat` once. It installs the Python requirements, creates/reuses the local bridge token, starts the bridge, creates the desktop app shortcut, and installs a per-user Windows Startup shortcut.
4. The Startup shortcut launches the bridge minimized and opens `http://127.0.0.1:8788/app` at each Windows sign-in. The desktop shortcut also starts/reuses the bridge and opens the app if you close it. Keep the bridge folder in the same location after setup. Exness MT5 must be installed for MT5 data. When it is open but not logged in, **Connect** has it log in with the account number, password and exact server entered in the app; the bridge never stores your MT5 password.
5. On this PC, the app page is `http://127.0.0.1:8788/app`, but the **Bridge URL** field is the WebSocket endpoint `ws://127.0.0.1:8787` (not `http://...:8788`). From a phone on the same Wi-Fi, use the PC LAN WebSocket address printed in the bridge window, normally `ws://<PC-IP>:8787`, and the local bridge token.
6. Use **Test bridge** or connect. A successful connection must report the exact server and an MT5 company identity containing Exness. A different account/server or unverified broker identity is refused. A verified REAL or DEMO account may use the manual order path only after a separate risk preview and explicit confirmation. To disable automatic startup, run `REMOVE_AUTO_START.bat`; it does not delete the local token or stop a running bridge.

## Same account on PC and phone

The bridge keeps the first successfully verified Exness account number and server in memory for its lifetime. A second client (such as a phone) must use that same account and exact server; attempting to switch accounts is refused. If you intentionally need to change identity, disconnect clients and restart the bridge first. Do not start a second bridge against the same terminal.

For phone access, keep the phone on the same private Wi-Fi/LAN, open the PC address printed by the bridge window, and enter the locally stored token from `bridge_token.txt` in the app. Do not port-forward the bridge or expose it to the public internet. A phone's `127.0.0.1` refers to the phone itself, not the PC.

## Manual REAL/DEMO scope and safety

- Account balance/equity/free-margin, open positions, quotes, symbol catalogue, and M1/M5/H1 history come from the local MT5 terminal. The app's REAL/DEMO execution preview and send path also run through this local bridge, not the cloud risk API.
- The bridge requires the requested REAL/DEMO mode to exactly match MT5's verified trade mode, the already authenticated Exness account/server identity, a connected terminal with trade permission, and a USD account. Missing or unverifiable account mode, quote, broker spec, position, daily-history, sizing, or margin data blocks the action.
- A fresh preview is held by the bridge for 30 seconds. The app requires a manual confirmation; before its single send attempt the bridge rechecks account, quote movement, size, stop/target, estimated risk, margin, and open positions. A repeated intent replays its cached reply instead of sending again. An uncertain/partial/pending result halts further app orders until the user inspects MT5 positions/history and restarts the bridge after understanding the outcome. There is no automatic retry.
- Current hard limits apply to REAL and DEMO orders: at most one open MT5 position, no more than 0.5% buffered *estimated* stop risk per order, at least 1.2 reward/risk, at most 80% of free margin, and a 2% threshold on UTC-day broker-reported realized losses. These are guards and estimates, not guaranteed maximum losses; floating losses, gaps, slippage, and external MT5 actions can change outcomes.
- The app cannot close positions and cannot place automated/Sniper entries. Manage/close any REAL or DEMO position directly in MT5. REAL orders risk real money; stops, estimates, and bridge checks cannot guarantee a maximum loss.
- The bridge token is stored locally beside the batch file. Keep it private; do not paste it into chat or screenshots.

## Troubleshooting

- If **Connect** answers `Cannot attach to MetaTrader 5: ...`, the words after the colon are the reason and the steps follow them; the message ends with the terminal that was tried. The bridge window prints the same text when it starts without MetaTrader 5. `(step terminal, code 1: Success)` comes from an `mt5_bridge.py` older than 13 November 2026 and hides the reason: replace the file and restart the bridge.
- If **Connect** answers that MetaTrader 5 `did not log in with the account number, password and server entered in the app`, look at the bottom-right corner of MetaTrader 5: a connection speed means it has logged in meanwhile (press Connect again), `Invalid account` means Exness did not accept the three, `No connection` means MetaTrader 5 cannot get through to Exness. An account name in the title bar alone does not prove the terminal is online; wait for connection bars/speed and updating Market Watch prices. Logging in inside MetaTrader 5 (File > Login to Trade Account) and pressing Connect afterwards works as well.
- The local launcher now saves the executable path of an already-running MT5 terminal. If several MT5 windows are open, select the Exness installation at the prompt; auto-start reuses a previously saved path only when it matches a running instance. If Windows cannot reveal the path or selection is skipped, set `AURUM_MT5_PATH` to the exact Exness `terminal64.exe` path in `SETUP_AND_RUN.bat`, then rerun setup.
- Use the MT5 trading password for manual REAL or DEMO orders. An investor/read-only password may connect for account viewing, but the bridge refuses order preview/send unless MT5 confirms trade permission and the selected REAL/DEMO mode. Automated entry stays blocked.
- If the app reports a server/company mismatch, stop. Do not try a different broker terminal as a fallback.
- MT5 symbol lookup prefers an exact name, then a unique broker prefix/suffix (such as `XAUUSDm` for the app's `XAUUSD`), or the sole visible Market Watch variant. If several variants remain visible it fails closed and lists the candidates; it never picks an arbitrary contract. The Gold monitor reads the connected MT5 catalogue and then requests candles/quotes using the exact discovered symbol.
- If the app reports that the broker minimum lot exceeds the notional cap, **no order was sent**. The amount field is USD notional; it cannot make a broker's minimum lot smaller. The current bridge message includes the estimated minimum exposure and cap. Do not raise the cap or inflate the amount to get around the refusal; stop or use a symbol whose actual minimum exposure fits the configured limits.
- The current Exness sizer should show MT5 equity and the broker's contract size, minimum/maximum volume, and exact step. If an Exness REAL/DEMO ticket still shows only a generic fixed-stake plan or `$0.00` risk budget, the local package/app tab is old or its account snapshot failed. Replace the whole package, close the **Fredrick AURUM Local API** and bridge windows, run `START_ALL_LOCAL.bat`, then press Ctrl+F5. Do not treat a stale or incomplete sizer as approval to place an order.
- If positions, quotes, symbols, or history are unavailable, the app should report unavailable and block dependent actions; it must not invent prices or symbols.
- If the app on this PC looks different from the website, the files in this folder are older than the website. `app.html` and the `pwa` folder are the page itself (a copy of the website's build, made by `npm run build`; do not edit them here). See "Bringing the PC app up to date" in the main `README.md`: replace the whole package folder, close the **Fredrick AURUM Local API** window, run `START_ALL_LOCAL.bat` again and press Ctrl+F5 in the app.

Bundle name: `FREDRICK_EXNESS_BRIDGE.zip` (local Exness bridge; manually confirmed REAL/DEMO order path).
