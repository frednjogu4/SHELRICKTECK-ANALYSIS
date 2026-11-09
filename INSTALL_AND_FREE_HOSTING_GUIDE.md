# Install the Trading Workspace on laptop and mobile

**Status:** the current codebase already has PWA support. It includes an install manifest (`public/manifest.webmanifest`), install icons, a registered service worker, and a button for browsers that support the install prompt. The service worker caches only the app shell/icons; it deliberately does **not** cache `/api/`, live prices, WebSockets or bridge traffic. I checked the current preview: `/app`, manifest, service worker and icons all return HTTP 200 on port 4173.

This is a browser-installed PWA, not a native Android APK or Windows `.exe`. Its live functions need an internet connection and a working API/feed. Offline, the cached shell may open, but live prices, analysis requests and trading are not available.

## Hosting recommendation

### Best $0 option for an installable public app shell: Cloudflare Pages

Cloudflare Pages is my recommendation for the **static HTTPS PWA front end**: it supplies a stable HTTPS website suitable for browser installation, and the current Vite build produces a small, self-contained page. Cloudflare documents the Free plan with up to 500 builds/month, one concurrent build, 20,000 files per site, and a 25 MiB maximum per file: [Pages limits](https://developers.cloudflare.com/pages/platform/limits/).

**Important limitation:** Pages is static hosting; it does not run this project's Express API or its WebSocket server. The app uses relative `/api/...` routes, so putting `dist/` on Pages alone would leave the API-dependent features unavailable. The Vite `/api` proxy works only in local development. A separate, explicitly configured API origin/proxy and server-side security work are required before Pages can be used as a full app.

### Backend choices

| Option | Good for | Free-tier limitation / fit here |
|---|---|---|
| **Keep the API and Exness bridge on the Windows laptop** | Highest privacy and the existing local Exness read-only flow | $0 hosting. Laptop and bridge must remain on; phone access is only on the same private Wi-Fi/LAN. This is the safest match for the already-selected local setup. |
| **Render Free** | Temporary API staging or demonstrations | Free services sleep after 15 minutes without inbound activity, can take about a minute to wake, and lose local filesystem changes on sleep/restart/deploy. Do not use it for an always-on real-time or trading backend. [Render Free limits](https://render.com/docs/free) |
| **Oracle Cloud Always Free VM** | A technically capable user who insists on a $0 public Node/WebSocket server | Oracle currently documents up to 2 OCPUs and 12 GB memory for the Always Free Arm allocation, but it is a self-managed VM: you maintain TLS, firewall, OS patches, backups, monitoring, database durability and recovery. Oracle may reclaim idle Always Free instances, and free capacity depends on region. It is not a managed trading-hosting guarantee. [Oracle Free Tier](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm) · [Always Free compute details](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) |
| **Supabase Free** | Auth and a small PostgreSQL database, after server integration | Supabase is not the Node/WebSocket host. The existing Express API does not yet use Supabase as its primary database. Free-tier pause/backup constraints need to be considered; see [Supabase pricing](https://supabase.com/pricing). |

**Bottom line:** use Cloudflare Pages for an eventual public PWA shell, keep the Exness bridge local-only, and use Render Free only for staging. There is no managed $0 host in this architecture that I would recommend for dependable always-on real-money trading. A free VM can be made to run, but the reliability and security burden moves to you. The current API also needs JWT verification, restrictive CORS, durable state, and trading-safety tests before public multi-user access. No deployment has been made.

## Install on the Windows laptop — local/private setup

The existing local bundle is `/home/user/FREDRICK_AURUM_PC_LOCAL.zip`. Use the Windows machine that has the official Exness MT5 terminal.

1. Extract the ZIP to a permanent folder, for example `C:\FREDRICK_AURUM_PC_LOCAL`. Do not run the setup batch file from inside the ZIP preview or a temporary downloads folder.
2. Open/log in to Exness MT5 on that PC. The current bridge is **read-only**; it does not send or close Exness orders.
3. Run `SETUP_AND_RUN.bat` from the extracted folder. Keep the bridge folder in the same location after setup.
4. Open the desktop shortcut created by setup, or visit `http://127.0.0.1:8788/app` on the same laptop.
5. In Chrome, use the install icon in the address bar if it appears, or **More → Cast, save, and share → Install page as app**. Follow the browser prompt. Chrome documents these desktop install steps here: [Use web apps](https://support.google.com/chrome/answer/9658361).
6. If prompted, allow the app to create a Start menu/desktop shortcut. The existing setup also creates local shortcuts; no website deployment is needed for this PC-only route.

The `127.0.0.1` address is intentionally loopback-only: it means “this laptop,” not the public internet. It lets the local app and bridge stay private.

## Android phone — private LAN shortcut

This matches the existing privacy choice: **browser shortcut only**, no local certificate, tunnel, router port-forward or public bridge exposure.

1. Start the bridge on the Windows PC and connect the phone to the **same private Wi-Fi**.
2. In the bridge window, find the PC's LAN address. On the phone, open `http://<PC-LAN-IP>:8788/app` (not `127.0.0.1`, which would point back to the phone).
3. In Android Chrome, tap **More → Add to Home screen**. Depending on Chrome/device wording, select **Install** or **Create shortcut**. Google documents Android web-app installation in [Chrome Help](https://support.google.com/chrome/answer/9658361).
4. If using the local Exness read-only view, use only the bridge URL/token instructions shown in the private local setup guide. Never put the token in a screenshot, message or shared document.
5. The phone shortcut works only while the PC/bridge is on and the phone remains on that private LAN. Do not open router ports or expose the local bridge publicly.

Because this LAN address is plain HTTP, treat it as a **shortcut**, not a full HTTPS-installed/offline PWA. For a true installable PWA on a phone outside your home/office LAN, the site needs a stable public HTTPS deployment; that deployment does not yet exist. It also will not magically connect the remote phone to the PC-local Exness bridge.

## Install from a future public HTTPS URL

After a separately approved, secure staging deployment exists, use its final HTTPS URL on each device:

- **Windows laptop / Chrome:** open the HTTPS app URL → address-bar **Install** icon, or **More → Cast, save, and share → Install page as app**. Edge has a similar “Install this site as an app” menu.
- **Android / Chrome:** open the HTTPS URL → **More → Install app** (or **Add to Home screen**) → confirm. The exact text varies by browser/device.
- **iPhone / Safari:** open the HTTPS URL in Safari → **Share** → **Add to Home Screen** → optionally select **Open as Web App** → **Add**. [Apple's instructions](https://support.apple.com/guide/iphone/bookmark-a-website-iph42ab2f3a7/ios).

Install separately on each device. A PWA shortcut is not an app-store APK, and deleting browser/site data can sign you out or clear that device's local preferences.

## Live analysis and trading limitations

- The browser connects directly to Deriv's public WebSocket for live ticks. Those prices require internet connectivity; if the feed disconnects, treat quotes and dependent analysis as unavailable/stale, not as a signal to trade.
- Analysis/history features also call the Express `/api` routes. A static Pages deployment without a configured, secured API will not provide full functionality.
- The Exness MT5 bridge in this project is **local and read-only**. Exness order send/close are intentionally disabled. A mobile shortcut does not change that.
- Do not use a sleeping free API for time-critical decisions. Do not enable real-money trading based on this installation guide. Execution stays off unless the safety gates are validated and you separately approve it.
- The service worker never caches market/API/bridge traffic, intentionally. The installable shell is not a way to trade offline.

## Current live preview

The development preview is currently running on port **4173** with the local Express API on port **4100** proxied through Vite. This is a temporary development preview, **not** a permanent HTTPS address to install on other devices. Use the local Windows package for the PC workflow; use the LAN shortcut only under the constraints above. A permanent public installation URL requires an approved staging deployment and API configuration.
