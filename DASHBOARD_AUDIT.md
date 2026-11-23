# Command Centre audit and consolidation

## Root cause found

There was no `src/commandcentre.js` and no single component owning the dashboard. `index.html` held a static Overview with four separate panels (movers, positions, AI signals, news), a second four-card portfolio KPI group, plus a global ticker and global feed/proxy pills. `src/main.js` independently refreshed those through `renderOverview()`/`updateKpis()`, `tickUI()`, and `updatePortfolioLive()`; Portfolio then repeated account totals in its own `pf*` KPIs. Separately, `renderOvDaily()` injected an additional `#ovDaily` card into the Overview at runtime while the best-pick renderer maintained both authentication and workspace panels. This split markup/runtime ownership and the repeated portfolio totals/status chrome were the concrete source of repeated and inconsistent at-a-glance presentation. The old structure also showed stale/unknown prices without a per-quote freshness label.

## Before / after

- **Before:** Overview greeting and “New order” CTA; top movers, open positions, AI signals and news panels; duplicated portfolio KPIs on both Overview and Portfolio; global ticker; provider pills in the shell; dynamically injected daily quote/best-pick card.
- **After:** one read-only Command Centre with Market Status, Market Overview, Analysis Summary, Portfolio Overview, and Workspace Navigation. Price cards use existing instrument ticks and include source, per-symbol timestamp, and `live`/`stale`/`unavailable` state. No placeholder price is synthesized. Provider pills and the single visible analysis summary are in their owning sections; Portfolio totals appear once in the Command Centre, while Portfolio retains its detailed positions and history. Overview has no order CTA and hides the mobile order bar while active.
- Existing specialist views and their side navigation remain. Markets, Watchlist, Charts, News, Signal Analyzer, Portfolio, Settings, Automation, and other specialist pages are not collapsed. Analysis History, Reports, Security, and Audit shortcuts point to existing Settings, Portfolio, or analysis-log sections; no unsupported routes were fabricated.
- After the PR was opened, `main` gained a legacy `src/commandcentre.js` initializer. It requires the removed `#ovKpis` contract, so on this consolidated markup it safely returns without mounting a second panel. The merge resolution preserves that upstream commit while keeping the new unified overview authoritative.

## Data validation

`src/bestpick.js` now checks complete directional plans before ranking: positive entry, stop-loss, and take-profit, with stop and target on the correct side for BUY/SELL. Directional readings without complete valid levels are copied as `INCOMPLETE` with reasons and excluded from ranking. Signal Analyzer cards also display `INCOMPLETE`, withhold confidence/levels as unavailable where missing, and disable the setup-use control for incomplete plans. Daily index readings remain context-only under the existing behavior. No market prices or account values were added as constants. Disconnected portfolio P&L is unavailable (`—`) when there is no connected account or recorded position, rather than a misleading zero.

## Files changed

- `index.html` — overview structure, specialist shortcuts, Settings/Connections placement, and responsive Command Centre styles.
- `src/main.js` — single-owner Command Centre render path, status/freshness rendering, navigation scroll targets, and compatibility guard for the removed greeting element.
- `src/bestpick.js` — complete-plan validation and incomplete status before ranking.
- `tests/platform/command-centre.test.mjs` — structure, duplicate-display, read-only, responsive-source and signal-validation tests.
- `tests/platform/best-pick.test.mjs` — complete directional fixtures.
- `tests/platform/hosted-markets.test.mjs` — specialist Signal Analyzer remains authoritative; overview no longer duplicates its full signal list.
- `tests/smoke.mjs` — assertions updated for the consolidated view.

## Verification

- **Node 22.22.3:** `npm run build` passed; full `npm test` passed — smoke 390/390, Node regression 887 passed, 0 failed, 1 skipped (888 total).
- **Node 24.22.3:** `npm run build` passed; full `npm test` passed — smoke 390/390, Node regression 887 passed, 0 failed, 1 skipped (888 total).
- **Focused dashboard/best-pick tests:** 28 passed; focused hosted-market best-pick scenarios: 5 passed; chart market-state regression: 1 passed.
- **Python bridge tests:** 59 passed (`python3 -m unittest discover -s tests -p 'test_mt5_bridge*.py'`).
- **Responsive checks:** static regression asserts the two-column tablet breakpoints and single-column mobile layout at 640px; no real-device/browser screenshot was available in this environment.
- **Wrangler:** `npx wrangler deploy --dry-run --config wrangler.jsonc` passed; 11 assets inspected, 77.12 KiB upload estimate. This is only a dry run; nothing was deployed.
- A live Vite preview is running on port 5175. Desktop/mobile screenshots were not captured because this environment has no browser screenshot facility.

No production deployment or pull request has been made.
