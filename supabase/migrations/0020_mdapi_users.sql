-- Registered users from the MatchDay platform API. Replaces the
-- match_players-derived cohort (which only saw users who had played at
-- least once). 1 row per user, keyed by the API's `id`. Sync source:
-- GET /admin/players (paginated, ~23k rows currently).
--
-- Field naming mirrors mdapi_subscriptions / mdapi_match_players:
-- snake_case columns + a raw jsonb of the full API row for audit. The
-- denormalized columns are what the cockpit reads; raw is the safety
-- net if a future field becomes load-bearing.
--
-- preferable_city_name vs preferable_city_normalized: the API returns
-- full English names ("Austin", "Oklahoma City", "St. Louis"). The
-- cockpit uses short codes (ATX, OKC, STL). We store both — raw value
-- for audit, normalized code for joins/aggregations. Normalization
-- happens in src/lib/cityNormalization.ts at sync write time.
--
-- RLS: authenticated SELECT only. emails are PII; never expose to the
-- anon role. Sync writes use service role.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

CREATE TABLE IF NOT EXISTS mdapi_users (
  -- API identity (PK = the user's id from /admin/players)
  id                          bigint        PRIMARY KEY,

  -- Identity
  email                       text          NOT NULL,
  first_name                  text,
  last_name                   text,
  phone_number                text,

  -- Lifecycle dates
  created_at                  timestamptz   NOT NULL,
  completed_sign_up_at        timestamptz,

  -- City (raw + normalized — see header)
  preferable_city_name        text,
  preferable_city_normalized  text,

  -- Flags from API
  is_fake_player              boolean       NOT NULL DEFAULT false,
  is_member                   boolean       NOT NULL DEFAULT false,

  -- Audit + future-proofing
  raw                         jsonb         NOT NULL,
  synced_at                   timestamptz   NOT NULL DEFAULT now()
);

-- created_at desc: drives "newest signups" listings + recent-cohort
-- aggregations (signups in last 7 / 30 days).
CREATE INDEX IF NOT EXISTS mdapi_users_created_at_idx
  ON mdapi_users(created_at DESC);

-- preferable_city_normalized: per-city groupings on the Users sub-tab.
-- Most filters/queries hit this column; the raw name is auditable but
-- not indexed.
CREATE INDEX IF NOT EXISTS mdapi_users_preferable_city_normalized_idx
  ON mdapi_users(preferable_city_normalized);

-- completed_sign_up_at: drives the "abandoned signup" cohort metric
-- (rows where this is null are users who created an account but never
-- finished onboarding).
CREATE INDEX IF NOT EXISTS mdapi_users_completed_sign_up_at_idx
  ON mdapi_users(completed_sign_up_at);

-- Email lookups (case-insensitive) for the staff/test-account filter
-- and for joining to mdapi_subscriptions.member_email.
CREATE INDEX IF NOT EXISTS mdapi_users_email_lower_idx
  ON mdapi_users(LOWER(email));

ALTER TABLE mdapi_users ENABLE ROW LEVEL SECURITY;

-- Authenticated SELECT only. emails are PII — never expose to anon.
DROP POLICY IF EXISTS mdapi_users_auth_select ON mdapi_users;
CREATE POLICY mdapi_users_auth_select
  ON mdapi_users FOR SELECT TO authenticated USING (true);
-- No INSERT/UPDATE policy. Sync writes use the service role
-- (bypasses RLS); operators don't write directly.

-- Add 'mdapi-users' to the fin_sync_log.source CHECK constraint.
-- Same drop/recreate pattern as migrations 0013, 0015, 0017, 0018.
ALTER TABLE fin_sync_log
  DROP CONSTRAINT IF EXISTS fin_sync_log_source_check;

ALTER TABLE fin_sync_log
  ADD CONSTRAINT fin_sync_log_source_check
  CHECK (source IN (
    'stripe-api',
    'mdapi-reviews',
    'mdapi-subscriptions',
    'mdapi-promocodes',
    'mdapi-matches',
    'mdapi-users',
    'membership-snapshots'
  ));
