# Fredrick TRADING — PC-local analysis host

This package runs AURUM's Express analysis API on the Windows PC and keeps the Exness MT5 bridge on that same PC. It removes Railway from the app's analysis API path. It does not deploy to a public cloud.

## First-time setup

1. Extract the whole ZIP into a normal, writable folder, for example `H:\Exness\AURUM_LOCAL`. Do not run files from inside the ZIP viewer.
2. Install **Node.js 20 LTS or newer** from nodejs.org if it is not already installed. The first setup needs internet to install Node production dependencies.
3. Keep the official Exness MT5 desktop terminal open and logged in.
4. Run **`START_ALL_LOCAL.bat`** (or the alias `SETUP_AND_RUN_LOCAL.bat`) once. It runs the API and bridge setup in order and writes a timestamped startup transcript plus `logs\local-api.log`. Keep the window open. After it reports the local app/bridge listening, open the printed `http://127.0.0.1:8788/app` address. The setup creates/reuses the bridge token locally and installs the desktop shortcut and per-user auto-start. Do not share `bridge\bridge_token.txt`; review and redact a startup log before sharing it.
5. Open AURUM at `http://127.0.0.1:8788/app`. Its `/api` requests are proxied only to `http://127.0.0.1:4100` on this PC. The API binds to loopback and is not open to the LAN. If the API fails to start, the script stops; it does not silently fall back to Railway.
6. To use **Exness MT5** as Gold's analysis source, also connect Exness inside AURUM (read-only) from the app's connect screen. Merely having MT5 open or choosing Exness in the Gold source menu does not log the AURUM tab into the bridge. If Gold reports that the tab is not connected, use its **Connect Exness (read-only)** button, enter your MT5 login, exact server and password locally, and keep the terminal open.

## Install on the Windows laptop

Open `http://127.0.0.1:8788/app` in current Chrome or Edge while the local service is running. Use the **Install AURUM** button in the app header if it appears, or the browser's Install app menu. The installed app remains local to this PC and needs the bridge/API windows running for live data. Offline caching is only for the app shell; API data is never cached or represented as live while offline.

## Phone/tablet on the same private Wi-Fi

Use the PC's LAN address printed by the bridge, for example `http://<PC-IP>:8788/app`. In AURUM Settings → Exness/MT5 bridge, enter the bridge token from the PC's `bridge_token.txt`. The token is required on a remote device and stays only in that browser tab session. Use the same account/server already configured on the PC. Do **not** forward ports 8787/8788 through your router or expose the bridge to the public internet.

### Android home-screen shortcut (browser-based)

1. Start the app on the PC and keep the PC on the same private Wi-Fi.
2. On Android, open Chrome and enter the PC LAN URL printed by the bridge, ending in `:8788/app`.
3. In Chrome's ⋮ menu choose **Add to Home screen** (some versions call it **Create shortcut**) and confirm.
4. Open that shortcut while the PC server is running and the phone is on the same Wi-Fi. To call the local analysis API from the phone, enter the PC's bridge token in the app's Bridge token field; it is kept only in that browser session.

This is a browser shortcut, not a full offline PWA or a separately installed native app. The PC must stay on, and live analysis needs the phone to stay on that Wi-Fi. If Chrome does not offer the shortcut option, bookmark the URL instead.

A phone can use the app in its browser over this private Wi-Fi. A full phone PWA install (service worker/offline shell) needs HTTPS; browsers treat the PC's plain-HTTP LAN address as an insecure origin. I have not enabled public hosting or an HTTPS tunnel. Do not bypass certificate warnings. A true installed PWA on Android/iPhone would require trusting a local certificate on each device; no such certificate is included or installed.

## What runs where

- Node/Express analysis API: `127.0.0.1:4100` on the PC only.
- Python app/bridge: ports 8787/8788, available to the PC and trusted devices on the same private LAN.
- The phone reaches the API only through the bridge proxy, which requires the local bridge token from non-loopback devices.
- The local API state is stored in `server/data/store.json` inside this folder. Keep the folder and its data file; back it up privately if needed.
- The PC must stay on and have internet for live public feeds. Exness MT5 must be open for Exness quotes/history. This does not share the local MT5 session outside the PC/LAN.

## Safety / limitations

- This is local hosting, not a public website. No production deployment or external tunnel is configured.
- Technical analysis runs keyless. AI/news providers remain unconfigured unless the user separately sets their own keys locally; never put secrets in this package or share them in chat.
- Existing trade/execution settings are not changed by this hosting package. The Exness MT5 bridge remains read-only; this setup does not authorize live orders.
- Cloud Sync is optional and separate; no Supabase project is changed by installing this package.
- To stop: close the local API and bridge windows. The desktop/Startup shortcut restarts them on launch/sign-in.
