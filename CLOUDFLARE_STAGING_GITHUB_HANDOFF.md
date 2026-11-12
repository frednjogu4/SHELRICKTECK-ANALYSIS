# AURUM Cloudflare staging handoff

This handoff contains the current project source and built static assets for the **private** `frednjogu4/cloudflare-staging` repository / Cloudflare Worker named `cloudflare-staging`.

## Scope and safety

- Target only the Cloudflare Worker named `cloudflare-staging`. Do not change or promote any production AURUM service.
- Cloudflare mode stays analysis-only: Deriv authorization is browser-tab-only and read-only; the Worker must not receive or store a Deriv PAT/account response. Trading execution remains disabled.
- Exness bridge, credentials, and account data remain PC-local. Do not add an Exness token, password, local bridge URL, `.env`, or runtime token file to GitHub or Cloudflare.
- The local and Cloudflare signal code imports the same shared analysis modules. Local mode may prefer fresh Exness M1/M5/H1 data; Cloudflare cannot access Exness and uses the approved public feeds. Source/availability labels should remain truthful rather than pretending both environments have identical market data.

## Upload the source to the private GitHub repository

The GitHub connector is not available in this chat, so no push was made. Extract this archive and copy its project files into the existing private repository `frednjogu4/cloudflare-staging`, preserving the folder structure. Review the changed-file list before committing. Do not make the repository public.

## Verify and build

From the project root, with Node.js 20 or newer:

```sh
npm ci
npm test
npm run build
```

The Worker config at `wrangler.jsonc` points static assets to `./dist` and names the Worker `cloudflare-staging`. The build step regenerates `dist` from the shared app source.

## Deploy to the staging Worker only

No deployment has been made from this handoff. Wrangler authentication must first be completed by the account owner through the normal interactive flow:

```sh
npx wrangler login
npx wrangler whoami
npx wrangler deploy
```

Before confirming deployment, inspect `wrangler.jsonc` and verify that the target is exactly `cloudflare-staging` in the intended Cloudflare account. The dashboard may call the active environment `production` under that service; that does not authorize a deploy to a separate production Worker. Do not change `name`, add a production route, or promote this code elsewhere.

After deployment, verify the staging URL and `GET /api/health`. Expected safety fields include `runtime: cloudflare-readonly`, `execution: false`, and `exness: PC-local only; no Exness data is sent to Cloudflare`.
