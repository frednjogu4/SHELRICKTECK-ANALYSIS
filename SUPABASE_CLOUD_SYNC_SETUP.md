# AURUM Cloud Sync — safe setup guide

Cloud Sync stores **analysis history, pattern scans, signals, and alerts** in your Supabase project so the same account can read them on desktop and phone. It does **not** share MT5 credentials, the Exness bridge token, the local MT5 session, or broker positions. Existing history on a device is not automatically backfilled; new records are written after you sign in.

## 1. Prepare Supabase

1. Open your Supabase project (or create one).
2. In **Authentication → Providers → Email**, enable email/password sign-in. Keep email confirmation enabled if you want confirmation before first sign-in.
3. Open **SQL Editor** and run these files in order, copying each file's contents from the local AURUM folder and selecting **Run**:
   - `supabase/migrations/0001_init.sql`
   - `supabase/migrations/0002_signals.sql`
   - `supabase/migrations/0003_cloud_sync.sql`
4. Do not add public/anonymous read or write policies. The migration grants history access only to authenticated users and applies owner-only RLS.

## 2. Copy the browser-safe project settings

From **Project Settings → API** (or the API Keys page in the updated dashboard), copy:
- **Project URL** — the base URL only, like `https://your-project.supabase.co` (not `/rest/v1`).
- **Publishable key** (`sb_publishable_…`) or legacy **anon public** key.

Never use or share `service_role` or `sb_secret_` keys. Do not paste any key into chat or screenshots.

## 3. Connect AURUM on the PC

1. Open AURUM from its local bridge-served URL, not `file://`.
2. Go to **Settings → Cloud sync — Supabase**.
3. Enter the Project URL and publishable/anon key.
4. Enter your email and password, then select **Create account** (first time) or **Sign in** (existing account). Confirm your email if prompted, then sign in.
5. Select **Save & test**. The expected result is **cloud · connected** and a message confirming all four history tables passed the authenticated RLS test.

The app saves the project URL/key in this browser's local storage. It never saves your password; the short-lived Auth session stays in this browser tab session.

## 4. Connect another device

On the phone/tablet, open the PC-hosted AURUM page over the same private Wi-Fi/LAN using the PC's LAN URL. In Settings, enter the same Project URL and publishable/anon key, then sign in with the **same Supabase account** and run **Save & test**. The AURUM page and MT5 bridge remain PC-local; do not port-forward the bridge or expose it to the public internet.

## If the test fails

- **Missing tables:** confirm the three migrations ran in order; run `0003_cloud_sync.sql` if the history tables were not present, then test again.
- **401/403 or access denied:** verify the Project URL/key pair, confirm the email if required, sign into the same project, and ensure the migrations created the owner-only policies.
- **Connected but empty history:** new records sync after sign-in; old device-local history is not automatically copied. Run a new analysis and use **Load history**.

No Supabase project was modified from this workspace; this setup is user-run and remains Preview/local until separately reviewed. AURUM remains analysis-only for Exness; Cloud Sync does not enable orders.
