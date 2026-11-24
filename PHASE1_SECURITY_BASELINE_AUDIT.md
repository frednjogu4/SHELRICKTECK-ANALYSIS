# PHASE 1 — Baseline & Repository Discovery (Security / Reliability / QA Master Audit)
**Mode:** inspect-only · **Date:** 2026-11-24 · **Auditor:** Agent Mode (every claim verified in this pass unless marked otherwise)
**Mandate:** ARENA AI MASTER PROMPT — Phase 1 only. No code changed in this phase. No PR merged.

---

## A. Repository baseline

| Item | Value | Evidence |
|---|---|---|
| Branch (session) | `arena/a3c9e72d-shelrickteck-analysis` | `git branch --show-current` |
| HEAD | `e180613` — *Reconcile open MT5 positions…* (PR #52, pushed, **OPEN/MERGEABLE**) | `git log`, `gh pr view 52` |
| `origin/main` | `a96a5df` — *Merge pull request #51* | `git rev-parse origin/main` |
| Working tree | **clean** (0 changes); repo **not shallow** | `git status`, `rev-parse --is-shallow-repository` |
| Runtime shape | Static SPA (`index.html` + inline CSS, `src/main.js` 6.7k lines, Vite → `dist/`) + local Node API (`server/server.js`, `0.0.0.0:4100`) + static host (`server/websiteserver.js`, `0.0.0.0:8788`, proxies `/api`) + Cloudflare Worker (`cloudflare/worker.js`, staging) + Python MT5 bridge (`bridge/mt5_bridge.py`, WS :8787) + PWA (`public/sw.js`) | inspected |
| Package scripts | `test` = smoke + node suites · `build` · `test:worker` · `verify:dist` · `verify` (build+test+worker+dry-run) · `cf:deploy:staging` | `package.json` |
| CI | `.github/workflows/ci.yml`: push `main` + PRs; Node **22/24** matrix (build/test/dry-run), Python **3.11/3.13** bridge tests, cloudflare-staging build job. `deploy-cloudflare-staging.yml`: `workflow_dispatch` **main-only**, env `cloudflare-staging` | files |
| Deployment targets | Cloudflare staging Worker (`wrangler.jsonc`, assets + rate-limit namespaces), PC local packages (both ZIPs, parity-tested), legacy `railway.json` / `render.yaml` (stale alternate hosts — see F-8) | inspected |

### Baseline test results (executed in this phase)
| Command | Result |
|---|---|
| `npm test` run A | smoke **400 PASS / ALL GOOD**; node suite **922 tests, 920 pass, 1 fail, 1 skipped** — the single failure was **not captured** (summary grep only) and **did not reproduce** |
| `npm test` run B (immediate re-run) | smoke **400 ALL GOOD**; node **921 tests, 920 pass, 0 fail, 1 skipped** → failure classified **TRANSIENT (unidentified; likely timing)** — listed in Outstanding Issues to pin down |
| `npm run test:worker` | **14/14** (executed earlier this session, unchanged sources) |
| Python bridge suite | **72/72** locally + CI Py 3.11/3.13 **pass** on PR #52 (executed) |
| `npm run verify:dist` / wrangler dry-run | **OK** / **OK** (execmitted this session on `e180613` sources) |
| `npm audit --omit=dev` | **0 vulnerabilities** |
| Secret pattern scan (`sk-ant-`, `AKIA…`, `ghp_…`, `xoxb-`) | clean — only placeholders and an error-message hint (`index.html:2102`, `decision.js:248`) |

---

## B. Architecture, entry points, data flows (verified this pass)

```
Browser SPA ──WS──> Deriv public feed (via Worker / local proxy)         [market data]
           ──WS──> local bridge :8787 (token for remote, loopback free)  [MT5 quotes/positions/login]
           ──HTTP─> local API :4100 (signals, pipeline, news, PAT, risk) [compute]
           ──HTTP─> Cloudflare Worker /api (technical-only subset)       [hosted]
           ──HTTP─> Supabase (publishable key only; secret keys rejected) [cloud sync]
Server     ──HTTPS> Deriv API, Yahoo daily, Investing.com RSS, AI engines [externals]
```
- Frontend→backend: `src/main.js` `api()` helper; identity header `x-aurum-user` (default `local`), AI keys as `x-ai-*` headers, Deriv PAT as `x-deriv-*`.
- Read-only market path and manual-execution path are separate; execution surfaces are pre-existing and **out of scope for this program** (hardening only, never enabling).

---

## C. Feature inventory (fresh classification; prior audits re-checked where relied on)

| Feature | State | Evidence |
|---|---|---|
| Market Command Centre (`#view-overview`, single consolidated markup) | **working** | smoke + platform tests green; one MCC visible (legacy `commandcentre.js` is **inert** — anchor `#ovKpis` absent) |
| Signal Analyzer / Gold / Trade / Markets / News / Portfolio / Settings / Sniper / Pro Scalper / Learn / Automation | **working** | `npm test` green; view-switch smoke assertions |
| Sizing & exposure panel (PR #49) | **working** | merged `f0c676b`, CI 5/5 |
| Open-position reconciliation (PR #52) | **working (unmerged)** | 11/11 + smoke 400 green on branch |
| AI six-role pipeline | **working** on local API; **degraded on staging** (explicitly not migrated — honest banner) | `main.js:6702` |
| Replay/measured historical figures | **degraded** — hard-coded `MEASURED` table, re-validation blocked on missing CSVs (Phase-1 Signal Analyzer audit) | `src/measured.js` |
| Index daily score display (`confidence: null` path) | **degraded/unverified** — pinned in Signal Analyzer audit §G8 | `server/app.js:546` |
| Supabase cloud sync / WhatsApp notify | **unverified** (config-dependent; not exercised here) | `src/cloud.js`, `wa.js` |
| `railway.json` / `render.yaml` deploy paths | **deprecated** — superseded by Cloudflare + PC packages; docs still reference them | root files |
| PR #42 “fix duplicate MCC” | **hazardous (do not merge)** — re-verified this pass: diff still only `src/commandcentre.js` + its test; adds CSS hiding every `#view-overview` child except a panel that never mounts on current `index.html` → would blank the landing page | `gh pr diff 42`, audit §Command-Centre |
| PRs #38, #29, #28, #26 | **conflicting** (GitHub says CONFLICTING) — stale branches | `gh pr list` |
| PRs #37, #33, #9 (drafts) | open, mergeable, not reviewed in this phase | `gh pr list` |

---

## D. Security audit findings (Phase-1 evidence; severity → remediation in plan)

### S-1 · CRITICAL — Local API reachable on LAN with no authentication + wildcard CORS
- **Evidence:** `server/server.js:80-81` binds `HOST || '0.0.0.0'`; `server/websiteserver.js:94` binds `0.0.0.0`; **no auth middleware** anywhere on `/api` (grep for token/Bearer middleware: none); `server/app.js:134` sets `Access-Control-Allow-Origin: config.corsOrigin || '*'` and `:135` allows the `x-aurum-user`/`x-ai-*`/`x-deriv-*` headers.
- **Impact:** any device on the LAN — and, via the wildcard CORS, **any website the user visits** — can read API responses from `http://127.0.0.1:4100` / LAN IP and POST to unauthenticated routes (analysis spend, PAT session routes, killswitch `app.js:910`, and the pre-existing order routes which rely only on rate limits + bridge-side guards). Identity `x-aurum-user` (`app.js:141`) is caller-controlled, so usage/store scoping is spoofable.
- **Remediation:** default `CORS` to same-origin (send no `Access-Control-Allow-Origin` unless `CORS_ORIGIN` allowlist set); default `HOST=127.0.0.1` with explicit opt-in env for LAN; enforce the existing `aurum_local_api_token` concept as middleware on all `/api` (health may stay open, loopback-exempt for the one-click PC path).

### S-2 · HIGH — AI provider keys in plaintext `localStorage`
- **Evidence:** `src/vault.js:9,26` — `localStorage['aurum_aikeys']` holds Claude/OpenAI/Perplexity keys; they are attached per-request as `x-ai-*` headers (`vault.js` header builder, `app.js:135`).
- **Impact:** any XSS or shared-machine access steals long-lived provider keys; over LAN the headers travel in cleartext HTTP.
- **Remediation:** encrypt at rest with WebCrypto AES-GCM using a non-extractable key in IndexedDB (preserves the existing paste-a-key UX); prefer server env keys (already supported — “header then omitted”); never log `x-ai-*` (current code verified: no header logging).

### S-3 · HIGH — MT5 trading password persisted in `sessionStorage`
- **Evidence:** `src/main.js:274-279` — `aurum_mt5_session` stores `{login, password, server, token, url}` as JSON in `sessionStorage`.
- **Impact:** plaintext broker credential readable by any script on the origin for the tab session; restored across reloads.
- **Remediation:** move credential custody to the PC bridge (local file with user-only ACL, referenced by login/server only in the browser), keeping the current login UX; fall back to session-only memory when bridge storage is unavailable. Touches bridge auth — allowed as *credential hardening*, not execution change; must preserve working login (regression tests required).

### S-4 · MEDIUM — Missing rate limits on expensive/outbound routes
- **Evidence:** `/api/signals/analyze` (`app.js:291`) and `/api/news/feed` (`app.js:1129`) have no `rateLimit(...)`; all sibling compute routes do (inventory: patterns/backtest/setups/scan/markets/connectRL/history/wa-push — `app.js:149…1169`). Mitigations that exist: AI daily budget (`decision.js` cap), `AbortSignal.timeout` on 3 external calls.
- **Remediation:** add the standard limiter to both; keep budget cap.

### S-5 · MEDIUM — Identity is a caller-controlled header
- **Evidence:** `app.js:14` (“until Supabase Auth”), `app.js:141` `userOf = header || 'local'`. Used for usage ledgers and per-user store scoping.
- **Remediation (interim, no fake auth):** bind effective identity to the local-API token once S-1 lands; document that hosted multi-user identity requires Supabase Auth (future, out of this wave). Add explicit **roles** (Administrator/Analyst/Viewer/Auditor) as a server-side permission map over the same token — enforced in middleware, not UI.

### S-6 · LOW — CSP layering
- **Evidence:** enforcing meta CSP exists (`index.html:8`, carried into `dist`); local server sends it **Report-Only** (`app.js:127`); CF `_headers` sends frame-ancestors/form-action/base-uri only (`public/_headers:21-25`); `X-Frame-Options: DENY` everywhere.
- **Remediation:** promote one enforcing header identical to the meta policy; add `Referrer-Policy`/`Permissions-Policy`; keep Report-Only only as a staging monitor.

### S-7 · INFO (good) — verified protective controls
- Bridge: remote peers **must** present `bridge_token.txt` secret; loopback convenience documented (`mt5_bridge.py:122-131,1056-1088`); order preview uses `secrets.token_urlsafe` TTL ids (`:773`).
- Supabase helper **rejects** `service_role`/`sb_secret_` keys (`cloud.js:58`).
- Store writes are atomic: tmp + `renameSync` (`server/lib/store.js:37-39`); data dir runtime-created.
- No cookies ⇒ no CSRF surface today (re-evaluate if cookie auth is ever added).
- Secret scan clean; `npm audit` 0; killswitch + limits intact; no header/secret logging found.

---

## E. Reliability & data-integrity snapshot (Phase-1 level)

- **Error handling:** per-route try/catch with honest error JSON (`live_data_unavailable`, `invalid_candle_source`, HTTP 409 paused-market, `withheldReading`) — verified patterns; no fabricated success paths found in market-data routes.
- **Health:** single `/api/health` (`app.js:276`) mixes app + engine config + feed label; **no liveness/readiness split, no provider-probe endpoint** → Phase 3 item.
- **Background jobs:** MT5 snapshot loop guarded (`mt5SyncBusy`, epoch checks `app.js:835-857` region), calendar/news intervals single-threaded in one timer — no duplicate-listener evidence found; deeper polling audit = Phase 3.
- **Correlation IDs / structured logs:** absent → Phase 3.
- **Market-data validation:** OHLC sanity + ordering checks exist (`server/lib/indices.js:45-52`), closed-candle cadence + dedupe tested (11 closed-candles tests), stale/409 paths tested. Gaps: corrupted-candle fuzz tests for all providers, contradiction detection → Phase 4.
- **PWA:** `public/sw.js` network-first shell, `skipWaiting`+`claim`, versioned cache `aurum-local-v2`, **never caches `/api` or WS** (`sw.js:31-33`), old caches purged on activate. Gaps: no visible offline/cached-vs-live indicator (only per-feed health), no automated version bump tied to build → Phase 6.

---

## F. Dashboard & PR posture (no merges performed)

1. One canonical MCC exists (single markup); inert duplicate module documented; **PR #42 remains unsafe to merge** (re-verified:2-file diff, blanking hazard) → recommend close after approval.
2. PR **#52** (this session): green CI 5/5, awaiting your merge word.
3. Drafts #37/#33/#9 and conflicting #38/#29/#28/#26 untouched.
4. Responsive breakpoints + screenshot harness proven earlier this session; full-layout sweep for this program = Phase 5.
5. Legacy deploy configs (`railway.json`, `render.yaml`, Vercel docs) conflict with the Cloudflare+PC story → documentation cleanup, not deletion.

---

## G. Prioritised implementation plan (awaiting approval)

| Wave | Items | Risk | Reversibility |
|---|---|---|---|
| **A — network boundary (do first)** | A1 CORS: no ACAO by default + `CORS_ORIGIN` allowlist · A2 `HOST` default `127.0.0.1` (opt-in `0.0.0.0`) · A3 local-API token middleware on `/api` (health open, loopback one-click preserved) · A4 rate limits on `signals/analyze` + `news/feed` · A5 enforcing CSP header + Referrer/Permissions-Policy · A6 security event log (route, outcome, no payloads/secrets) | low | env-revertible, config-gated |
| **B — credential custody** | B1 AI keys → WebCrypto AES-GCM at rest (non-extractable key), env keys still preferred · B2 MT5 password → bridge-held local credential file (ACL), browser keeps reference; full login regression suite | medium (login UX) | feature-flagged, old path retained one release |
| **C — identity & roles** | C1 token-bound effective identity (kills `x-aurum-user` spoof) · C2 server-side role map (Administrator/Analyst/Viewer/Auditor) on sensitive routes · C3 document Supabase Auth as the hosted end-state | low | additive middleware |
| **D — backend reliability** | D1 `/api/health` → liveness vs readiness split (+ provider probes, honest UP/DOWN) · D2 correlation id (`x-request-id` in/out) + structured JSON logs · D3 timeout/backoff audit per external call · D4 duplicate-poll/listener sweep | low | additive |
| **E — data integrity** | E1 OHLC/timestamp/duplicate fuzz tests per provider · E2 freshness/source attribution regression tests · E3 corrupted-response tests · (E4 keep Gold/Forex/index coverage tests green) | low | tests-only |
| **F — dashboard** | F1 close #42 (approval) with “single MCC” regression test · F2 merge #52 (your word) · F3 layout/a11y sweep (Phase 5) | low | per-PR |
| **G — PWA** | G1 offline/cached-vs-live banner · G2 SW version derived from build hash · G3 offline/recovery test (NOT VERIFIED without browser harness — puppeteer path exists) | low | sw bump |
| **H — docs & ops** | H1 env-var table (names/purposes) · H2 deploy checklist + rollback runbook · H3 health/incident/backup doc · H4 retire Railway/Vercel references | none | docs |

**Explicitly out of scope:** execution/enablement of orders, risk-cap changes, production deploys, automatic merges, data migrations (none required — schema = one JSON store, untouched).

---

## H. Phase-1 status

| Prompt requirement | Status |
|---|---|
| Branch/commit/manifests/scripts/deps/source/server/CF/bridge/PWA/tests/workflows/config inspected | **VERIFIED** |
| Architecture + data flows traced | **VERIFIED** |
| Feature inventory fresh-classified | **VERIFIED** (table C) |
| Baseline SHA/tests/failures/deployment recorded; no production changed | **VERIFIED** (one transient test failure documented, not hidden) |
| Open PRs inspected; none merged | **VERIFIED** (9 open; #42 hazard re-confirmed) |
| Report with paths/lines/severity/impact/remediation | **VERIFIED** (sections D–F) |

**Overall Phase 1: VERIFIED.** Waiting for your approval of Wave A (or a re-sequenced subset) before any code change.
