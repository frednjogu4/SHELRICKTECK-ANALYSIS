# AURUM → Vercel migration gap report

**Audit status:** source audit and current local verification complete. No application source changes or deployments were made for this report.

## Baseline verified

- The working tree already contains substantial, uncommitted AURUM changes and new files. Preserve these; do not reset or overwrite them.
- `npm test`: passed — 373 smoke assertions and 228 Node tests.
- `npm run build`: passed — Vite generated the self-contained `dist/index.html` and `dist/AURUM_Workspace.html`.
- `git diff --check`: passed.
- `npm audit --omit=dev`: reports two production dependency advisories, one high and one moderate (`body-parser` and `qs`). Resolve and retest before exposing a public API preview; do not apply an automatic dependency change without reviewing the lockfile diff.

## Blocking gaps for “everything on Vercel”

1. **The current backend is a persistent Express process, not a Vercel function app.** `server/server.js` calls `listen()`, attaches a WebSocket server, starts a Deriv connection, and runs a 15-minute WhatsApp feed timer. These require explicit serverless/function and scheduling adaptations; a static Vite build alone would omit important AURUM API features.
2. **State currently relies on local files and process memory.** The JSON store writes under `server/data`; risk reservations, kill-switch context, Deriv PAT sessions/tickets, dedupe/rate-limit counters, and caches also use in-memory Maps. Vercel instances can be recycled or run in parallel, so those mechanisms cannot be carried over as-is without shared durable storage and concurrency-safe operations. Risk limits must not be weakened during this move.
3. **Backend WebSocket relay needs a separate design.** `attachDerivWs()` is bound to the long-lived HTTP server. Browser-side Deriv public ticks are a separate direct WSS connection and can remain browser-side; that does not automatically migrate the server-side Deriv relay/session paths.
4. **The existing local MT5 bridge stays on the user’s Windows PC.** It cannot be packaged as a Vercel function, and this migration must not introduce a cloud relay.
5. **Production security/configuration needs adaptation.** The API currently supports wildcard CORS when no origin is configured, and several per-IP controls are in-process. Vercel deployment needs the exact production/staging origins, durable/shared security controls, and server-only environment variables configured by variable name—never secrets in source or chat.
6. **Scheduled WhatsApp feed must be migrated explicitly.** Its current timer runs inside the Express process. Any scheduled replacement must preserve the existing automatic-until-turned-off behavior and honestly report an unconfigured integration.

## Safe migration shape

- Keep the Vite UI static on Vercel.
- For a full Vercel move, convert API routes to Vercel Functions and move durable/shared state and rate/risk coordination to an approved persistent store (Supabase is a candidate, not yet configured for this in the current repo). Review every execution/risk path and add migration-specific tests before deployment.
- Keep the Exness MT5 bridge local-only.
- Deploy only a **Vercel Preview/staging URL** after the code and local tests pass; have the user test it before any production promotion. No production deployment is authorized here.
