# AURUM Cloudflare staging review package

This archive contains a snapshot of the current AURUM working tree (including its existing uncommitted project changes), but not Git history, local runtime data, dependencies, or build output.

## Static-preview settings
- Build command: `npm ci && npm run build`
- Build output: `dist`
- Use a separate staging project/branch only; do not attach a production domain.

## Important limitations and safety
This is a source package for review and a frontend-only Cloudflare Pages preview. It does not convert or deploy the existing Express API, local JSON store, local Exness bridge, or WebSocket server to Cloudflare. API-backed features will not work as on the local server. A static preview can still expose browser-side UI/code, so do not enter live broker credentials or use order controls. Keep Sniper analysis-only and do not use the preview for real-money execution.

No deployment or repository push was performed. Local `server/data/` storage and all `.env` files other than the example template were excluded. The `.env.example` file contains variable names and sample configuration only.
