# PHASE 1 — Full Repository Audit & Root-Cause Report

**Project:** SHELRICKTECK AI MARKET COMMAND CENTRE (`frednjogu4/SHELRICKTECK-ANALYSIS`)  
**Audited commit:** `f550d5ff386662c41199314941fd9896e81e9beb` (`main`)  
**Local endpoint:** `http://127.0.0.1:8788/app`  
**Cloudflare staging:** `https://cloudflare-staging.frednjogu4.workers.dev/`

---

## 1. Canonical File & Pipeline Map

| Layer | Canonical Path(s) | Role |
|---|---|---|
| Dashboard markup & CSS | `index.html` | Single HTML template containing `#view-overview` (Market Command Centre), specialist views, and CSS variables/rules |
| Frontend modules | `src/main.js`, `src/buildinfo.js`, `src/provenance.js`, `src/tradingview.js`, `src/hostedscan.js`, `src/sizer.js`, `src/exposurereconcile.js`, `src/resilience.js` | Client logic bundled by Vite |
| Shared analysis & strength | `server/lib/analyzer.js`, `server/lib/strength.js`, `server/lib/closedcandles.js`, `server/lib/symbols.js` | Deterministic closed-candle indicator & Market Strength calculation shared by Express API, Cloudflare Worker, and browser scan |
| Static PWA & security headers | `public/sw.js`, `public/manifest.webmanifest`, `public/_headers`, `public/icons/*` | Copied into `dist/` during `vite build` |
| Build & sync scripts | `vite.config.js` (`viteSingleFile()`), `scripts/build-revision.mjs`, `scripts/postbuild.mjs`, `scripts/pc-page.mjs`, `scripts/verify-dist.mjs`, `scripts/dev-local.mjs`, `scripts/refresh_local_update_packages.py` | Compiles single-file bundle -> stamps release ID -> verifies `dist/` (11 files) -> syncs `bridge/app.html` + `bridge/pwa/*` (9 files) -> refreshes `FREDRICK_AURUM_*_UPDATE.zip` |
| Local Windows server | `bridge/mt5_bridge.py` (`_APP_FILE = bridge/app.html`, `_PWA_FILES = bridge/pwa/*`, port `8788` HTTP + WebSocket, port `8787` WebSocket) + `server/server.js` (loopback `127.0.0.1:4100`) | Serves `http://127.0.0.1:8788/app`, `/sw.js`, `/build.json`, and proxies `/api/*` to `127.0.0.1:4100` |
| Windows launchers & updater | `START_ALL_LOCAL.bat`, `SETUP_AND_RUN_LOCAL.bat`, `START_LOCAL_API.bat`, `RUN_LOCAL_API.bat`, `START_LOCAL_MARKET_COMMAND_CENTRE.bat`, `bridge/SETUP_AND_RUN.bat`, `bridge/AUTO_START.bat`, `bridge/START_MT5_IF_CLOSED.ps1`, `UPDATE_LOCAL_APP.bat` | Local startup, MT5 non-destructive attach, and GitHub `main` package sync |
| Cloudflare staging | `wrangler.jsonc` (`name: "cloudflare-staging"`, `assets.directory: "./dist"`), `cloudflare/worker.js`, `cloudflare/platform.js` | Serves `dist/` + read-only `/api/*` + `/build.json` on `cloudflare-staging.frednjogu4.workers.dev` |

---

## 2. Root Causes Identified

### Root Cause 1 — Separate Local Installation Directory on Windows + Hidden Port-4100 Server Reuse
- Merging to `main` automatically triggers Cloudflare Workers Builds for `cloudflare-staging.frednjogu4.workers.dev`, whereas the Windows PC serves `http://127.0.0.1:8788/app` from a local extracted package directory (`bridge\app.html` + `server\server.js`), often started at Windows login via `Startup\Fredrick TRADING AutoStart.lnk` (`bridge\AUTO_START.bat`).
- Even when files were copied manually, `START_LOCAL_API.bat` exits `0` immediately if `http://127.0.0.1:4100/api/health` is already responding (`Fredrick AURUM Local API` runs minimized), leaving the old `server/` process running in memory without newer server modules (such as `server/lib/strength.js`), and `bridge/AUTO_START.bat` similarly reuses an already-listening port `8788`.

### Root Cause 2 — Missing Git Commit SHA & Build Timestamp Parity Across Staging and ZIP Installations
- `scripts/postbuild.mjs` wrote only `{ id, version }` to `dist/build.json` and `bridge/pwa/build.json`, deliberately omitting `git` and `builtAt`.
- At runtime, Cloudflare Workers (`cloudflare/worker.js`) checked `env.CF_PAGES_COMMIT_SHA`, which Workers Builds (Workers Static Assets, unlike Pages) does not populate; meanwhile Windows ZIP installations lack a `.git/` directory, so `bridge/mt5_bridge.py`'s `_git_commit()` also returned `None`.
- Consequently, **both** Cloudflare staging and extracted Windows packages displayed `Git commit: — (not a git checkout)` and lacked a shared canonical source build timestamp.

### Root Cause 3 — Incomplete Safety Controls in PR #58's `UPDATE_LOCAL_APP.bat`
Auditing PR #58 (`UPDATE_LOCAL_APP.bat`) against Phase 3's 12 updater requirements revealed five concrete gaps:
1. **No timestamped pre-update backup (`backups\backup-YYYYMMDD-HHmmss\`):** Canonical files were overwritten directly without saving the previous working release.
2. **No automatic rollback on failure:** If file synchronization failed mid-way or if post-restart `http://127.0.0.1:8788/build.json` verification did not match the incoming Build ID, the updater exited with an error without restoring the previous working release.
3. **No persistent update log:** Output went only to stdout rather than a secret-free timestamped log under `logs\local-update-YYYYMMDD-HHmmss.log`.
4. **No `--dry-run` mode:** Only `--no-restart` existed, which still overwrote files; a read-only `--dry-run` flag was missing.
5. **Port-4100 process check needed strict command-line/title ownership:** When `/api/health` returned `deriv-public`, PR #58 fell back to matching generic `node.exe` on port 4100; tightening ownership checks and refusing to touch any unverified listener on `8788`, `8787`, or `4100` eliminates any risk to unrelated processes, and separating `bridge/UPDATE_LOCAL_APP.ps1` + testable `scripts/local-updater.mjs` allows real automated backup/rollback testing on a separate copy before touching any live installation.

### Root Cause 4 — Packaged Local App Had No Upstream Release Detection & No Mismatched-File Guard
- `src/buildinfo.js` compared `<meta name="aurum-build">` only against local `/build.json`. When a local package folder had not yet been updated from GitHub `main`, both had the same older ID, so the packaged local app never notified the user that a newer approved release existed upstream.
- Additionally, `bridge/mt5_bridge.py` did not verify that `bridge/app.html`'s `<meta name="aurum-build">` matched `bridge/pwa/build.json`'s `id`, so a partially copied local folder could go undetected.

### Root Cause 5 — Service Worker Install Precache Used Default HTTP Cache Mode
- `public/sw.js` already uses release-keyed `VERSION = 'aurum-local-<id>'` and `{ cache: 'no-store' }` on `navigate` fetches, **but** `install` called `c.addAll(SHELL)` with default browser cache semantics rather than `{ cache: 'no-cache' }` `Request` objects, and `/update-check` needed explicit exclusion alongside `/api/*`, `/bridge`, and `/build.json`.

### Root Cause 6 — Two Dashboard Verification Findings (Market Command Centre Guard & Strength Bar CSS)
1. **Market Command Centre (`src/commandcentre.js`):** `index.html` already unified `#view-overview` around a single `#commandTitle` (`Market Command Centre`) and removed legacy `#ovKpis`, so `initCommandCentre()` currently no-ops on `index.html`; however, `src/commandcentre.js` lacked an explicit `if (doc.getElementById('commandTitle')) return false;` guard to guarantee `#shelrick-command-centre` can never mount alongside `#commandTitle`.
2. **Strength Bar Colours (`index.html` lines 612–614):**
   - `#strengthNeutralBar` used `var(--amber)` instead of **grey** (`var(--text-3)`).
   - Secondary strength cards (`#azStrength` on Signal Analyzer and `#brokerStrength` on Markets) used `[data-s="buyBar"]`, `[data-s="sellBar"]`, `[data-s="neutralBar"]` without `#strengthBuyBar` IDs, leaving their bar fills uncoloured (`transparent`).
