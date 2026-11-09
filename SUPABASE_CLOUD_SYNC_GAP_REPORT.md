# AURUM Supabase Cloud Sync — audit and local repair status

## Initial finding
- The user's Settings screenshot showed Cloud Sync off and no project URL/key saved.
- The original browser client used the publishable/anon key as the sole bearer identity and expected four tables, but the checked-in SQL did not create three of them. The existing `signals` table required an authenticated `user_id` while the client did not sign in or provide one. Making those tables public would have exposed cross-user history.

## Local repair made (no Supabase project accessed)
- Added per-user Supabase Auth sign-up/sign-in/sign-out and short-lived browser-tab session storage. Passwords are sent only to Auth, cleared from the form after submission, and never persisted by AURUM.
- All cloud reads/writes now require a signed-in user; REST calls use that user's access token, and insert helpers overwrite `user_id` from the authenticated session. Expired sessions refresh or fail closed.
- Added `supabase/migrations/0003_cloud_sync.sql`, creating the missing history tables and owner-only RLS policies. Anonymous access is revoked; only authenticated owners can select/append rows. It also makes signal history compatible with user-owned browser inserts.
- Added account controls in Settings and a setup guide at `SUPABASE_CLOUD_SYNC_SETUP.md`.

## Safety / limitations
- Only the publishable/anon key belongs in the browser. Never use `service_role` or `sb_secret_`.
- URL/key are stored in localStorage per device; the auth session is stored in sessionStorage for that browser tab. The same Supabase account must sign in on every device.
- This shares analysis history, pattern events, signals, and alerts only. It does not share Exness credentials, the local MT5 bridge/session, or positions. Existing device-local history is not automatically backfilled.
- No credentials were entered, no Supabase project was queried or modified, no cloud writes were made, and no deployment was performed.
