# AURUM / Shelricktech — Full System Audit (2026-10-16; historical baseline)

## Current override — Exness Phase 1, local verification only (2026-10-29)

This audit predates the Exness migration. Its HFM-only routing statements below are historical and do **not** authorize a deployment or order. The current local Phase 1 adapter requires the exact account server, verifies that MT5 reports an Exness company identity, pins one account/server in bridge memory for PC and phone clients, and exposes read-only account/position/quote/symbol/history checks. App-side and Python order/close sends are hard-disabled. No Exness account was connected or tested from this workspace; no order was sent; no deployment occurred. Treat all Windows-terminal and account compatibility as **UNVERIFIED** until the owner tests locally.

Scope: server API, client app, MT5 bridge, secrets handling, dependencies.
Suite at audit time: 453/453 (smoke 269 + server 184). `npm audit --omit=dev`: 0 vulnerabilities.

## Verified SOLID
1. **Secrets**
   - AI keys (Claude/OpenAI/Perplexity): server env only. Client may pass its own via headers; daily budget cap ($5 default) enforced device-wide server-side; keys never logged.
   - Deriv PAT (new API): server session is in memory only (sessions die on API restart); the browser keeps the PAT/App ID in the current tab's `sessionStorage` for refresh reconnection. No server-disk or localStorage secret copy; cleared on disconnect/sign-out.
   - Deriv classic token: browser tab `sessionStorage` only for refresh reconnection; no persistent localStorage remember-me backup.
   - WhatsApp Cloud API creds: server env only (WA_PHONE_NUMBER_ID / WA_TOKEN / WA_TO); status endpoint never returns the token; push is rate-limited 12/min + throttled.
   - No hardcoded secrets anywhere (verified by grep); env by NAME only.
2. **Transport & headers**: HSTS, X-Content-Type-Options, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy, CSP (report-only pending a strict inline audit of the single-file build).
3. **Rate limits** (per-IP, in-process): Deriv proxy 60/min, connect 12/min, backtest/patterns/history/scan 12/min, setups 12/min (503 unless AURUM_SETUPS_ENABLED=true), WA push 12/min. [FIXED THIS AUDIT] /api/signals/scan was unlimited — now 12/min.
4. **Input validation**: symbols regex-gated; body limit 512kb; granularities/amounts/durations parsed+clamped; order body allow-list only ({contract_type, underlying_symbol, amount, basis, currency, duration, duration_unit}).
5. **Trading safety**: server-side caps on EVERY Deriv execution path (max stake, max open trades, daily loss limit, trading OFF by default + confirm gate); client adds daily loss guard + 3-loss brake + synthetics exclusion. Exness MT5 is read-only in Phase 1: orders/closes are hard-disabled; indices are never Deriv-orderable and remain outside sniper/automation.
6. **Bridge**: binds 127.0.0.1 only (both 8787 WS and 8788 HTTP); rejects non-local connections; optional shared token for non-local use; /api proxy targets a FIXED upstream (no SSRF). For refresh recovery, the active browser tab holds Exness account/server/password/bridge token and Deriv token/App ID in `sessionStorage` only; these are not written to localStorage or server disk and are cleared on disconnect/sign-out or when the tab session ends. A Forget button clears the session credentials and identity.
7. **Dependencies**: `npm audit --omit=dev` → 0 vulnerabilities. (Dev tooling not exposed in prod build.)
8. **XSS surfaces**: user/broker-controlled strings escaped via escHtml on all reviewed sinks (signals, history, watchlist, news, calendar). Some trusted-constant HTML remains (own UI strings) — acceptable.
9. **CORS**: defaults to `*` for the local single-file export; set `CORS_ORIGIN` to lock to your domain (recommended before custom-domain hosting).

## Findings & dispositions this audit
- [FIXED] /api/signals/scan had no rate limit → added 12/min limiter.
- [ADVISORY] CSP stays report-only until the inline single-file build gets a strict audit — scheduled work, not a blocker (X-Frame+nosniff already on).
- [ADVISORY] CORS `*` default is intentional for file:// single-user use; set CORS_ORIGIN in production.
- [ADVISORY] in-memory sessions/ledgers reset on deploy (documented; Railway restarts) — balances re-pull from broker; no persistence of secrets.
- [ACCEPTED] remember-me plaintext backup — honestly disclosed in UI; use "Forget this computer" on shared machines.

## Custom domain hosting — YES, supported
1. Railway → your service → Settings → Domains → add your domain (CNAME to the Railway endpoint). TLS is automatic.
2. Set env `CORS_ORIGIN=https://your.domain` (locks the API to your site).
3. PWA manifest/icons/paths are relative — work unchanged on any domain. TradingView widgets need only HTTPS (given). Deriv classic-token flow runs browser-side; PAT flow is server-side — no redirects to re-register.
4. The local bridge/Local Mode are unaffected (they only talk to 127.0.0.1 and the app server).
5. Optional hardening on your domain: enable a strict CSP after the inline audit, and keep staging (aurum-staging) as the canary before pointing production.
