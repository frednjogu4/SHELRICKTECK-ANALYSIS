
> **Historical only:** The deployment notes below predate the 2026-10-29 Exness migration. Phase 1 is local verification/read-only only; no Exness deployment or live-money execution is authorized. Do not treat any earlier HFM staging entry as approval for this migration.

## Staging deploy a8380bdf-3ec1-48c3-9200-b8f048dcbc82 (round 18 — setups, ANALYSIS-ONLY)
- Chain: ba4eddce -> a8380bdf. Boot: 645de29c18a3ac0d. Branch feature/setups (commits 88d8f69 -> 9a82fef -> TEST_PASS). PRODUCTION UNTOUCHED.
- Live probes: /api/setups/analyze + /api/setups/backtest -> 503 setups_disabled + hint (flag OFF by default; set AURUM_SETUPS_ENABLED=true on staging to turn on); /api/wa/status honest; card markup in served bundle; health/usage/calendar normal.
- To enable for testing: Railway CLI -> aurum service -> staging env -> add AURUM_SETUPS_ENABLED=true (analysis-only; still no order paths).

## Staging deploy 960568a5 (round 18b — binary expiry clarity)
- Chain: a8380bdf -> 960568a5 (commit 8267ee3 on feature/setups). Suite 414/414 (smoke 242 + server 172).
- Fixes: human expiry countdown (45s/74m/25h 9m/1d 3h — bare '1510m' misread eliminated), 1s countdown ticker, per-row duration label + Deriv-locked state + profit-target state, upfront lock warning in close confirm. Real sell still always attempted first (Deriv InvalidToSell -> honest ride-to-expiry toast unchanged).

## Staging deploy bdb726b3 (round 18c — early-exit guidance, user choice B)
- Chain: 960568a5 -> bdb726b3 (commit b89f7cf on feature/setups). Suite 417/417 (smoke 245 + server 172).
- Ticket #resaleNote: per-family early-exit tag (forex rarely/locked live-tested; synthetics usually; metals+crypto unknown) + honesty suffix. Sniper "Prefer early-exit markets" switch default OFF -> ON hunts synthetics only (fallback if pool empty). No order-path changes; can_sell live polling unchanged (source of truth per contract).

## Staging deploy 6515acfa (round 18d — force close queue)
- Chain: bdb726b3 -> 6515acfa. Suite 420/420 (smoke 248 + server 172).
- Close press = real sell attempt; InvalidToSell refusal now ARMS closeOnUnlock (amber FORCE QUEUED badge, click cancels). 5s watcher executes the queued close the instant Deriv unlocks resale; target-hit-while-locked auto-arms (burned-shot bug fixed); RateLimit queues too.

## Staging deploy 197648f6 (round 18e — market open/closed badges)
- Chain: 6515acfa -> 197648f6. Suite 426/426 (smoke 250 + server 176).
- Markets table: per-instrument OPEN/BREAK/CLOSED badge + QUIET stale-feed state; ticket 'Market status' row; guidance note (typical Deriv UTC calendar; broker is final word). NEW shared server/lib/markethours.js + 4 unit tests.

## Staging deploy dbb91e58 (round 18f — portfolio reconciliation)
- Chain: 197648f6 -> dbb91e58. Suite 429/429 (smoke 251 + server 178).
- NEW: /api/deriv/pat/portfolio (Deriv {portfolio:1}) + client reconciliation each sync — every device shows EVERY open account contract ("3 vs 1" fixed); P&L identical (Deriv liveProfit). Synced rows labelled 'synced from your Deriv account'.

## Staging deploy 9f1ea4c9 (round 18g — hotfix: equity/open P&L '—')
- Chain: dbb91e58 -> 9f1ea4c9. Suite 431/431 (smoke 253 + server 178).
- Root cause: isBinaryPos missed external (synced) contracts -> CFD formula on entry:null -> NaN poisoned equity/open-P&L sums. Fixed (binary valuation + Number.isFinite guards in posPl/openPl/binSum) + Close routing for synced rows on pat_server brokers.

## Staging deploy 7d055d36 (round 18h — duration visibility)
- Chain: 9f1ea4c9 -> 7d055d36. Suite 433/433 (smoke 255 + server 178).
- Root cause of surprise 24h contracts: #orderDuration select silently persisted its session choice; confirm only showed raw '1 d'. Fixed: quick chips (15m/30m/1h/4h/1d) + live settle preview ('This order settles in … · <day> HH:MM device time') + human duration & settle wall-clock in the confirm modal + >=1h forex/metals lock warning.

## Staging deploy ba566eb1 (round 18i — index CFDs via HFM + login diagnostics)
- Chain: 7d055d36 -> ba566eb1. Suite 438/438 (smoke 260 + server 178).
- Index CFDs (US30/NAS100/SPX500/US100/GER40/UK100): HFM-bridge-only routing, live MT5 quotes via new bridge quote op, stop-anytime + server-side SL/TP, sniper excluded, Deriv feed skips. Bridge login returns STEP diagnostics; app shows numbered PC checklist + phone detection. FREDRICK_HFM_BRIDGE.zip rebuilt (user must run the NEW mt5_bridge.py).

## Staging deploy 3891c39d (round 18j — HFM account/server matching guidance)
- Chain: ba566eb1 -> 3891c39d. Suite 438/438 (smoke 260 + server 178).
- Context: user portal shows live 54998262 at 0.00 USD (wallet 15.52 KES) + new account 55007074. Login guidance now explains live-vs-demo server matching (mixed pairing is MT5-rejected) + trader password; hardcoded account line removed from error copy.

## Staging deploy 5b9968e4 (round 18k — Deriv PAT 401 diagnosis)
- Chain: 3891c39d -> 5b9968e4. Suite 440/440 (smoke 262 + server 178).
- PAT tab pre-flight: shape checks before the call (classic-token 401 warning, swap detection with one-click fix, Connect-anything override; App-ID shape never policed). Server 401 now appends shape booleans (pat_-prefixed? swapped?) next to Deriv's raw message. Root suspicion from screenshot: token-shaped string in the App-ID box.

## Staging deploy 4331d610 (round 18l — sniper on HFM verified + two fixes)
- Chain: 5b9968e4 -> 4331d610. Suite 441/441 (smoke 263 + server 178).
- Verified HFM sniper chain end-to-end (risk gate -> bridge order with SL/TP -> exit mgmt -> bridge close). Fixed: 3-loss stand-down now counts HFM/CFD closes (was Deriv-settlement-only); 'Prefer early-exit markets' applies to Deriv paths only (on HFM all CFDs are stop-anytime; armed status reflects it).

## Staging deploy 5b4d4d24 (round 18m — news signal validity window)
- Chain: 4331d610 -> 5b4d4d24. Suite 442/442 (smoke 264 + server 178).
- News directional signals show a live validity badge (25m sniper window from publish; STALE after; freshness-unknown honest). Execute stands down when stale (button + guard); WA share includes the window/stale warning; parseRss now extracts epoch pubDate (honest null when absent).

## Staging deploy f4bf9ffa (round 18n — Shelricktech identity)
- Chain: 5b4d4d24 -> f4bf9ffa. Suite 443/443 (smoke 265 + server 178).
- Login dashboard: user's logo + SHELricktech INVESTMENT wordmark + headline 'Shelricktech Investment Trading Analysis Tool' + trademark 'Designed by Fredrick K under Shelricktech Investment'. BRAND_DEFAULT.logo (5.3KB data URI) feeds login + topbar mark; Settings uploads still override. PWA titles -> Shelricktech.

## Staging deploy 2b8dac1d (round 18o — Shelricktech icon set)
- Chain: f4bf9ffa -> 2b8dac1d. Suite 444/444 (smoke 266 + server 178).
- PWA icons regenerated from the user logo: 192/512 rounded, maskable-512 (safe-zone zoom), apple-touch 180px, favicon-32 (inline SVG 'A' favicon removed). Note for user: installed PWA may need reinstall/re-launch to refresh the icon.

## Staging deploy d98c494f (round 18p — welcome + daily motivation + best market pick)
- Chain: 2b8dac1d -> d98c494f. Suite 446/446 (smoke 268 + server 178).
- Login dashboard: time-aware welcome (wordmark removed), Motivation of the day (deterministic per day, 10 attributed quotes), TODAY'S BEST MARKET TO FORECAST ON (live scan top directional pick, index picks labelled analysis-only, 10-min refresh). Overview banner mirrors both.

## Staging deploy 30823d53 (round 18q — news timeline sections)
- Chain: d98c494f -> 30823d53. Suite 447/447 (smoke 269 + server 178).
- News calendar is now a timeline: JUST RELEASED (last 15 min = current news), UPCOMING TODAY (exact UTC times + live countdowns), PAST 2 HOURS, all-day/unscheduled separate. Countdowns update live and re-section automatically on bucket crossings. Forecast/previous shown; TV board remains the full-board fallback.

## Staging deploy 967bbf2a (round 18r — loss prevention guardrails)
- Chain: 30823d53 -> 967bbf2a. Suite 449/449 (smoke 271 + server 178).
- Daily loss guard (default $25/day): placeOrder / news Execute / sniper entries stand down when the day's closed P&L hits -limit until tomorrow. Confirm sheet shows break-even win rate from the live payout (payout asymmetry visible pre-buy) on all three Deriv paths.

## Staging deploy 27c825c1 (round 18s — bridge UX + PNA preflight)
- Chain: 967bbf2a -> 27c825c1. Suite 449/449.
- Bridge (PC side): plain-HTTP responder — http://127.0.0.1:8787 in a tab now answers "AURUM bridge is UP"; PNA/CORS headers on HTTP answers for HTTPS->local preflights. ZIP rebuilt.
- Site: unreachable guidance now THREE causes (bridge not running / local-network permission bubble / insecure-content block).

## Staging deploy db07dcbe (round 18t — bridge LOCAL MODE)
- Chain: 27c825c1 -> db07dcbe. Suite 449/449.
- Bridge (PC side): serves the full workspace at http://127.0.0.1:8787/app (app.html shipped in the ZIP) and proxies /api/* to the AURUM server — same-origin on localhost, immune to HTTPS→local browser policy. POST bodies read via the websockets-17 API. ZIP rebuilt (114 KB).

## Staging deploy c73ded4d (round 18u — local-mode POST fix, port 8788)
- Chain: db07dcbe -> c73ded4d. Suite 449/449.
- Root cause (reproduced): websockets' handshake port silently drops non-GET HTTP — bridge /api POSTs (signals scan, risk gate) could never work over 8787; browsers saw instant connection close ("Failed to fetch").
- Fix: threaded stdlib HTTP server on 127.0.0.1:8788 (full /api proxy GET+POST, /app, ignores Windows system proxies, no event-loop blocking, per-call logging); 8787/app 301s to 8788/app. Local-mode address is now http://127.0.0.1:8788/app.

## Staging deploy 38856c59 (round 18v — one-port local mode, WS on 8788)
- Chain: c73ded4d -> 38856c59. Suite 449/449.
- Bridge: RFC6455 WebSocket inside the 8788 HTTP server — local app now serves page + /api proxy + trading socket on ONE port (no cross-port WS hop, the hop that hung in the field). Client localBridgeWs() defaults the socket to the serving port. Verified with a websockets client: ping/pong, positions, dispatch errors.
- Field note: user's log confirmed POST /api/signals/scan 200 in 3.09s on 8788 (Signal Analyzer fixed in the field).

## Staging deploys 258fc134/ee8cee1f (round 18w — login screen redesign, one viewport)
- Chain: 38856c59 -> 258fc134 -> ee8cee1f. Suite 449/449 green before final deploy.
- Login dashboard: 76px logo, welcome shortened to "Good morning/afternoon/evening, trader" (brand stated once in the H1 + tiny trademark line), feature bullets + lede replaced by a one-line summary, connect panel tabbed (Deriv / MT5-HFM panes), remember-me + token notes condensed (full text on hover), Deriv MT5 card collapsed into a details block (buttons + guidance inside). Fits one viewport on desktop; mobile keeps the stacked layout.

## Staging deploy (round 18x — charts over HFM)
- Chain: ee8cee1f -> this. Suite 449/449.
- Root cause of "graph not working" on the HFM session: (1) watchlisted index CFDs were never quote-pumped (only charted/held) -> tiles starved on "building live chart…"; (2) those tiles were mislabelled "Deriv live"; (3) that session's WS hop to 8787 was dead (fixed in 18v with WS on 8788).
- Fix: pump now includes watchlist indices; tiles labelled HFM live · bridge / HFM — connect bridge / Deriv live; neutral placeholder per class; TradingView embed shows an honest "did not load" notice if blocked and clears it on late load. Local app rebuilt into the bridge ZIP.

## Staging deploy (round 18y — Markets SIGNAL column always alive)
- Chain: 18x -> this. Suite 449/449.
- Root cause: signal cells were written once (mute ellipsis) and the soft repaint updated only price/change/spark — scan results landed in state but were never displayed until a filter/sort change re-rendered the table.
- Fix: cells tagged data-msig and soft-repainted on HTML change; honest 'Scanning…' state; total failure -> 'Scan unavailable + Retry' (delegated click); scan fires immediately on entering Markets (90s throttle). Server scanner verified healthy (EUR/USD WAIT w/ votes, XAU/USD SELL_CONFIRMED in 0.46s).

## Staging deploy (round 18z — entry/SL/TP on all markets + graphs)
- Chain: 18y -> this. Suite 449/449.
- Scan levels (entry/SL/TP1/TP2) now surfaced everywhere: under every Markets SIGNAL badge (confirmed solid / unconfirmed faint "≈… (unconfirmed)"), a LIVE SIGNAL LEVELS strip under the Chart & Trade header, and dashed E/SL/TP1/TP2 lines with labels drawn on watchlist canvases (out-of-range lines skipped, unconfirmed tagged "?"). Watch view seeds the throttled scan; single-symbol scan stores into the shared mktScan so strip + badges agree.

## Staging deploy (round 19a — tick durations / total-rejection fix)
- Chain: 18z -> this. Suite 449 -> 453 (smoke 269 + server 184).
- Root cause of "tried 5m..1d, all rejected": tick-only lineups (BOOM/CRASH) were parsed to nothing (UNIT_SEC lacks 't' -> ranges dropped) and the ladder had no tick candidates, so Deriv refused all 9 time-based attempts.
- Fix: parseContractsFor keeps 't' ranges; clampDuration clamps ticks + falls back to min ticks; ladder += 5t/10t; rejection message includes Deriv's actual offered ranges (rangesSummary). Client already renders "n ticks" (durHuman).

## Staging deploy (round 19b — auto-trade loss prevention)
- Chain: 19a -> this. Suite 453/453 (smoke 271 + server 184).
- Field report: evening session ~W+38/L-60 => net ~-22; synthetics 0W/6L. Root causes addressed: synthetics excluded from the sniper pool by default (random-walks, toggle to re-include); confidence default 60->70 (migrated with toast); auto-trade health record (W/L/net + break-even %) shown in Automation; guard status (today closed P&L vs limit, OFF plainly) always visible; closes re-trip the guard instantly; Reset wipes the persisted history store too.

## Staging deploy (round 19c — security audit)
- Chain: 19b -> this. Suite 453/453. npm audit: 0 vulnerabilities.
- Fixed: /api/signals/scan rate-limited (12/min). Full sweep recorded in SECURITY_AUDIT.md (secrets, headers, CORS, rate limits, validation, trading caps, bridge localhost binding, dependency audit) + custom-domain runbook (CORS_ORIGIN, Railway CNAME, TLS automatic).

## Staging deploy (round 19d — leverage transparency)
- Chain: 19c -> this. Suite 453/453.
- Bridge login reply carried leverage; client keeps it and on HFM connect shows the real math: stake = notional exposure, margin = stake/leverage, leverage never multiplies P/L in this app (SL sets the loss). Answers "reduce leverage to protect profit": leverage only changes margin locked; losses come from stake size, SL distance, spread — not the 1:400 setting.

## Staging deploy (round 19e — one-click Local Mode from the cloud errors)
- Chain: 19d -> this. Suite 453/453.
- Field report: user retried HFM from the CLOUD site with bridge token filled -> same browser-policy wall. Fix: the Bridge URL hint now leads with a clickable "Open the local trading app" (127.0.0.1:8788/app) — hidden when already local; cloud-allow instructions demoted to the fallback.

## Staging deploy (round 20a — full codebase audit + critical fixes)
- Chain: 19e -> 20a. Suite: smoke ALL GOOD + server 184/184 (+2 new dedupe tests). npm audit --omit=dev: 0 vulnerabilities.
- Audit record: AUDIT_2026-10-17.md (3 critical / 3 high / 2 medium / 2 low, each verified with file:line before fixing).
- C1 /api/deriv/connect App-ID digits-only regex removed (accepts letters, matches PAT-session charset) — forbidden-check regression.
- C2 bridge: order/close/positions/quote/search now require a successful login ON THAT SOCKET (auth_required); cross-origin WS upgrades rejected on BOTH 8787 and 8788 (drive-by page protection; WS has no CORS); optional AURUM_BRIDGE_TOKEN env enforced; the app's Bridge-token field is finally wired into the login frame.
- C3 min-lot honesty: bridge order/quote replies carry volume_min/contract_size/effective_notional/clamped_min; client REFUSES silent oversize pre-buy ($1 on US30 min-lot would be ~$4-5k exposure) and the filled toast shows real lots + exposure. NOTE: the pending $1 US30 demo round-trip must use a stake at/above the broker minimum notional — the app now states the exact number when refusing.
- H1 remember-me wording honest (plain-text backup; was falsely 'encrypted'); H2 trust proxy 1; H3 once-key idempotency (same intent twice -> 409; no key -> never blocked); M1 bridge 8788 CORS echoes localhost origins only; M2 30s AbortSignal timeouts on all scan fetches.
- Bridge changed -> FREDRICK_HFM_BRIDGE.zip rebuilt; the trading PC MUST re-extract.

## Staging deploy (round 20b — cross-device bridge: phone -> PC MT5)
- Trigger: user tested from a phone and hit "Bridge not reachable" (127.0.0.1 on a phone IS the phone). Root cause: 4 layers kept the bridge PC-only — loopback bind, hard non-local peer reject, localhost-only origin gate, and the client's ws://-to-LAN guard.
- Bridge now binds the LAN (AURUM_BRIDGE_HOST, default 0.0.0.0; set 127.0.0.1 to lock down). Origin gate allows LAN-served app origins + AURUM_BRIDGE_ALLOWED_ORIGINS env; public web pages still rejected. REMOTE devices MUST present the bridge token (loopback stays one-click): SETUP_AND_RUN.bat auto-creates bridge_token.txt, exports AURUM_BRIDGE_TOKEN, prints the token + firewall note; bridge banner prints the exact http://<PC-IP>:8788/app link + token + "ALLOW python on Private networks".
- Client: Bridge URL field honored by the HFM connect path; auto-detects LAN-served app; cross-device error text names URL + token; cross-device connects require the token (isLoopback split in assertBridgeSafety).
- Tested: smoke ALL GOOD (7 new 20b asserts) + server 184/184 + standalone functional tests of _origin_allowed/_token_ok/_up_txt (LAN allowed, public rejected, env allowlist works, remote-without-token refused). npm audit --omit=dev: 0 vulnerabilities.
- Bridge changed AGAIN -> FREDRICK_HFM_BRIDGE.zip rebuilt (121,414 B) — re-extract on the trading PC.
- Same-wifi only (LAN). Remote-from-anywhere would need wss:// + a real TLS name — not built, not claimed.

## Staging deploy (round 20c — "no answer in 4s" root-caused + fixed)
- User test (screenshots): bridge running + listening, yet BOTH the double-clicked app.html and the installed https app failed with "no answer in 4s" and the console showed ZERO "client connected" lines.
- Reproduced live (websockets 17.2, stubbed MT5): the server answers handshakes/pings instantly — but my own origin gate rejected file:// and null origins (the double-clicked app.html) AND the hosted app origin (https://aurum-staging.up.railway.app). Separately, "no answer in 4s" with no server log = the browser never delivered the connection (https->localhost is mixed content / Local-Network-Access pending in Edge/Chrome).
- Fixes: (1) origin gate accepts local disk pages (file:// + null) — token/login/limits gates unchanged, plus a 5-failed-logins-per-connection kick on both ports; (2) AURUM_BRIDGE_ALLOWED_ORIGINS=aurum-staging.up.railway.app exported by the bat; (3) startup SELF-TEST (bridge dials itself on 127.0.0.1 + localhost, prints SELF-TEST PASSED or FAILED) so the next screenshot is a definitive diagnosis; (4) healthBridge retries the localhost twin and connect uses the URL that answered (proxy bypass quirks); (5) the 4s error now tells the user to check the bridge window for "client connected" and to use http://127.0.0.1:8788/app — not the file, not the installed https app; (6) stale "(localhost only)" log corrected.
- Verified: probe matrix green (no-origin/file://null/LAN/local :8788 all OK; staging OK with the bat's env); smoke ALL GOOD (7 new 20c asserts) + 184/184.
- NOTE for the round-trip: the user's MT5 shows 'Algo Trading' OFF (10027) — must click the Algo Trading button (green/PLAY) before any order will execute.
- Bridge changed -> FREDRICK_HFM_BRIDGE.zip rebuilt — re-extract.

## Staging deploy (round 20d — Phase-2 safety slice: RISK/BOSS modules + kill switch)
- server/lib/riskgate.js: evaluateRisk() tri-state (PASSED/FAILED/UNKNOWN; missing data blocks; fixed-risk venues: max loss = stake; CFD: rr derived from entry/SL/TP) + bossVerdict() (WAIT default; REJECTED whenever Risk is not APPROVED; READY FOR MANUAL REVIEW only otherwise — never auto-executes). Wired into /api/risk/gate (checks[] + boss in every response).
- server/lib/killswitch.js: AURUM_KILL_SWITCH env + GET/POST /api/ctl/killswitch (disable always; re-enable needs AURUM_DIAG_KEY when set). 503 kill_switch on every buy route (order/confirm/buy) incl. the env-token router; closes/quotes stay open.
- UI: Settings kill-switch toggle; Signal Analyzer now shows the exact confidence-score formulas labelled "NOT a probability of profit".
- HFM manual order: live quote BEFORE the gate (market-hours evidence) + plan (entry/SL/TP) in the gate request.
- Suite: 194/194 (+10 new: riskgate 8, killswitch 2), smoke ALL GOOD (9 new 20d asserts). Gap report statuses updated in AUDIT_2026-10-17.md — only earned items marked FIXED.
- Bridge unchanged — ZIP from round 20c still current.

## Staging deploy (round 20e — position sizer + trade planner, spec §11)
- src/sizer.js planPosition(): risk-budget sizing with visible formula; INCOMPLETE (never assumes) when equity/risk%/entry/SL/contract specs are missing; KES accounts require a user-supplied KES→USD rate (nothing fetched or invented); lots rounded DOWN to volume step; below broker minimum -> BLOCKED with the real min-lot exposure numbers (turns the C3 $1-US30 story into exact math); SMALL/MEDIUM/FULL tiers can only shrink; slippage/gap + unknown-costs warnings always shown.
- Trade ticket gains a live "Position sizer" panel (recalculates on amount/SL/TP/risk-% change; specs from the bridge quote).
- Suite: 202/202 (+8 sizer tests), smoke ALL GOOD (+4 asserts). AUDIT statuses updated — §11/§4.7 earned.

## Staging deploy (round 20f — six-role pipeline as real modules + workflow panel, spec §5)
- server/lib/pipeline/{scout,news,charts,strategy,index}.js: typed timestamped role reports with dependency states; orchestrator composes SCOUT→NEWS→CHARTS→STRATEGY→RISK→BOSS (riskgate.js) and NEVER executes. Invariants tested: news authorizes=false always; missing data → UNKNOWN → BOSS WAIT/REJECTED; quality-score label (not probability); explicit versioned strategy conditions; Boss never overrides Risk.
- POST /api/pipeline/analyze (real candle feed + deterministic analyzer + localDecision under the hood); Signal Analyzer renders the six-step workflow with the Boss verdict + expandable timestamped role reports.
- Suite: 209/209 (+7 pipeline tests), smoke ALL GOOD (+8 asserts). AUDIT §5 marked FIXED (earned).
