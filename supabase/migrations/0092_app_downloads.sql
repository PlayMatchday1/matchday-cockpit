-- 0092: app_downloads — external store install counts for the Growth tab.
--
-- WHY A NEW TABLE. The Growth KPI row leads with "App downloads", but nothing
-- in the mdapi_* mirror carries it: those tables are a read-only copy of the
-- MatchDay product API (matches, players, users, subscriptions) and the app has
-- no download signal. Downloads live in two external systems instead:
--   * iOS  — App Store Connect Analytics API, metric "App Units" (first-time
--            installs; re-downloads/updates excluded). Pulled per calendar day.
--   * Android — Play Console "statistics" CSV export that Google drops into a
--            GCS bucket, read with a service account. Column = new user installs.
-- This table is the local landing spot for both so the dashboard reads ONE
-- place. It is NOT part of the mdapi_* mirror. The Play ingest job
-- (lib/playInstallsSync.ts, run daily for the current month + a manual backfill
-- route for history) upserts android rows; the growth reader only SELECTs. The
-- iOS side is not built yet — no rows land until the Apple key exists, and no
-- schema change is needed when it does.
--
-- GRAIN: one row per (platform, package, calendar day, metric). platform is
-- 'ios' | 'android' and rows are NEVER pre-summed across platforms — Android is
-- a small minority of players and a combined total would hide that. package is
-- carried explicitly (com.matchday_app today) so a second app can never be
-- silently summed in.
--
-- THE JOIN CAVEAT (documented so nobody wires it wrong later): these are device
-- / store-account counts. They cannot be joined to a mdapi_users.id — there is
-- no shared key and Apple/Google never expose the installing account. So
-- "downloads -> registrations" is a ratio of two independent aggregates, NOT a
-- traced same-people conversion. The dashboard must label it that way.
--
-- Credentials for the ingest job go in Vercel env, base64-encoded, and nowhere
-- else — never committed, logged, echoed, or placed in this file.
--
-- Apply in the Supabase SQL Editor. Not applied by the app. No data is deleted.

create table if not exists app_downloads (
  id            bigint generated always as identity primary key,
  platform      text        not null check (platform in ('ios','android')),
  -- App / package identifier this count belongs to (e.g. 'com.matchday_app').
  package       text        not null,
  -- App Store Connect metric name / Play Console column this count came from
  -- (android today: 'daily_user_installs' — the user-based first-install column,
  -- the closest counterpart to Apple's App Units).
  metric        text        not null default 'app_units',
  -- Calendar day the count is FOR (America/Chicago), or the 1st of the month
  -- when period_grain = 'month'. Store-provided period, not ingest time.
  period_date   date        not null,
  period_grain  text        not null default 'day' check (period_grain in ('day','month')),
  count         integer     not null check (count >= 0),
  -- Provenance: 'app_store_connect' | 'play_console_gcs'.
  source        text        not null,
  -- Original API/CSV row, kept for audit + reprocessing.
  raw           jsonb,
  ingested_at   timestamptz not null default now(),
  -- One row per platform+package+grain+day+metric, so a re-download of the
  -- current month (or a late restatement of an earlier day) UPSERTs, never dupes.
  unique (platform, package, metric, period_grain, period_date)
);

-- Growth reads are per-platform, date-ranged.
create index if not exists app_downloads_period_idx
  on app_downloads (platform, period_grain, period_date);
