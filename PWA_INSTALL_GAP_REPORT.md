

## Implementation and verification (2026-11-09)
- Changed the manifest start route to `/app` so an installed desktop shortcut opens AURUM instead of the bridge status page.
- Updated the service worker shell paths/version. It caches the app shell and icons only; `/api/*` and `/bridge` are explicitly passed through and not cached.
- Added a fixed allowlist in the Python bridge for `/manifest.webmanifest`, `/sw.js`, and the known icon files. It does not expose arbitrary filesystem paths.
- Updated the Windows laptop and phone instructions. Rebuilt `/home/user/FREDRICK_AURUM_PC_LOCAL.zip` with the current Gold monitor, PWA assets and app code. ZIP integrity and contents check passed; no bridge token, environment file or runtime store is packaged.
- Verification: `npm test` passed (378 smoke assertions + 244 Node tests); `npm run build` passed; Python compilation and `git diff --check` passed.
- Not verified: running the Windows HTTP server, Chrome/Edge's actual install prompt on the laptop, Android/iOS installation, or Windows firewall behavior.
- Phone constraint is unchanged: the trusted-LAN URL is HTTP and is not a secure browser origin. The user chose Android and a browser home-screen shortcut only, declining a local certificate. The guide now gives the Android Chrome shortcut steps. A full phone PWA would require an HTTPS origin and local certificate trust (or changing the hosting model); no certificate, cloud deployment, tunnel, or port-forwarding was introduced.
