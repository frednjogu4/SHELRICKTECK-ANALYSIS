

## Implementation and verification status (2026-11-08)
- Implemented the local Express host setting; packaged runner pins `HOST=127.0.0.1`, `PORT=4100` while cloud host default remains unchanged.
- Implemented a bridge proxy token gate for `/api/*` from non-loopback peers, with constant-time token comparison. The PC loopback path does not require re-entry; phone/LAN requests do. Browser-side token use is tab/session-only, and the bridge token is never printed by the scripts.
- Added the local API start/health scripts and adjusted bridge setup/autostart to select loopback API mode and stop rather than fall back to Railway. A local-only marker also makes incomplete local packages fail closed.
- Added phone/LAN instructions and clarified the Settings label. Included a new local-host Windows ZIP; no Supabase/Vercel/Railway/cloud settings were changed and no secret/runtime data was packaged.
- Verification: `npm test` passed (378 smoke assertions + 237 Node tests); `npm run build` passed; `git diff --check` passed; Python local-API auth tests (4), bridge read-only tests (6), and risk-limit tests (6) passed. Extracted ZIP production dependencies installed successfully and its API health endpoint passed when bound to loopback. Static checks confirmed bundled browser token wiring and no stored bridge token/runtime store in the ZIP.
- Not verified here: execution of Windows `.bat` scripts, Windows Firewall/network behavior, phone access over the user's Wi-Fi, or any live MT5 terminal behavior. The PC must stay on for local service availability.
