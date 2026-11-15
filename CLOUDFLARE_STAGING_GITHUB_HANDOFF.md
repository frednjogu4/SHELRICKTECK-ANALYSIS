# AURUM Cloudflare staging handoff

This repository contains the project source and built static assets for the Cloudflare Worker named `cloudflare-staging`. The deployed site shown in the Cloudflare dashboard is this Worker; keep its deployment target distinct from any other AURUM service.

## Scope and safety

- Target only the Cloudflare Worker named `cloudflare-staging`. Do not change or promote any production AURUM service.
- Cloudflare mode stays analysis-only: Deriv authorization is browser-tab-only and read-only; the Worker must not receive or store a Deriv PAT/account response. Trading execution remains disabled.
- Exness bridge, credentials, and account data remain PC-local. Do not add an Exness token, password, local bridge URL, `.env`, or runtime token file to GitHub or Cloudflare.
- The local and Cloudflare signal code imports the same shared analysis modules. Local mode may prefer fresh Exness M1/M5/H1 data; Cloudflare cannot access Exness and uses the approved public feeds. Source/availability labels should remain truthful rather than pretending both environments have identical market data.

## Source repository and verification

Use this repository as the source of truth for the `cloudflare-staging` Worker. Preserve its folder structure; do not copy the build into another repository or manually edit generated output. Changes are reviewed through pull requests to `main`.

From the project root, with Node.js 20 or newer:

```sh
npm ci
npm test
npm run build
```

The Worker config at `wrangler.jsonc` points static assets to `./dist` and names the Worker `cloudflare-staging`. The build step regenerates `dist` from the shared app source.

## Deploy through GitHub Actions to the staging Worker only

The repository includes `.github/workflows/deploy-cloudflare-staging.yml`. It is a manual deployment, limited to the latest `main` branch, and targets the Worker name in `wrangler.jsonc` (`cloudflare-staging`). It does not deploy to another AURUM Worker or add a production route.

Before the workflow can deploy:

1. In GitHub, open **Settings → Environments** and create an environment named `cloudflare-staging`.
2. Add a secret named `CLOUDFLARE_API_TOKEN` to that environment. Create the token in Cloudflare with only the account permissions needed to deploy Workers, scoped to the account that owns `cloudflare-staging`. Never put the token in Git, workflow text, or chat.
3. Merge the reviewed changes into `main`.
4. In **Actions → Deploy Cloudflare staging**, choose **Run workflow** on `main`, then set the confirmation input to `deploy`. If the GitHub environment has required reviewers, approve the deployment there.

The linked Cloudflare dashboard may call the active environment `production` under the `cloudflare-staging` service. This action still deploys only the Worker named `cloudflare-staging`; it does not authorize promotion to a separate production service.

After deployment, verify the staging URL and `GET /api/health`. Expected safety fields include `runtime: cloudflare-readonly`, `execution: false`, and `exness: PC-local only; no Exness data is sent to Cloudflare`. As an alternative, an account owner can deploy from a trusted local terminal with `npx wrangler login` followed by `npm run cf:deploy:staging`.
