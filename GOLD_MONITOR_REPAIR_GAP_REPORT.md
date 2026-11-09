# Gold / USD monitor repair — implementation & verification

## Screenshot diagnosis
- The screenshot's lower-left status says **Live markets · no trading** while Gold's source selector says **Exness MT5 local bridge**. That means the AURUM app is in guest/live-market mode, not connected to Exness in this AURUM tab. Selecting Exness as a data source does not perform the broker login.
- The top **Deriv live feed** pill is a separate public-feed/API health indicator. It does not mean the selected Exness MT5 source has a quote or history.
- Consequently the app cannot calculate Exness Gold candles/tick until Exness is connected inside AURUM and the terminal returns fresh data. No fallback or fabricated price is appropriate.

## Changes made
- Added a visible Gold status notice near the controls, with the actual failure reason and an **Connect Exness (read-only)** action when the selected Exness source has no active bridge session.
- The CTA opens the existing Exness connect tab; login/password/server are entered locally.
- Turning Auto-refresh on now starts an analysis immediately. After each attempt, it schedules the next check 60 seconds later and displays the retry/next-check countdown. Auto-refresh remains limited to one request per minute.
- Failed Exness analysis clears the displayed quote; the monitor continues to refuse stale data and never silently switches to Deriv.
- Updated local-host instructions to clarify that the Exness terminal being open and Gold source being selected are not a substitute for connecting Exness inside AURUM.

## Verification (2026-11-09)
- Baseline before edits: `npm test` passed (378 smoke assertions + 237 Node tests).
- After edits: `npm test` passed (378 smoke assertions + 240 Node tests); `npm run build` passed; `git diff --check` passed.
- Updated `/home/user/FREDRICK_AURUM_PC_LOCAL.zip`; ZIP integrity passed and inspection confirmed the updated Gold UI plus laptop PWA assets are bundled, the full local API source tree is included, and no bridge token/runtime store/environment file is included.
- Not verified: Windows batch execution, the user's actual Exness credentials/server, Windows MT5 terminal, or live XAUUSD quotes/history. The live signal can only be confirmed after the user installs the updated local bundle and connects Exness in the local AURUM tab.
