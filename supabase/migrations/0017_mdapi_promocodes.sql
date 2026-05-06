-- Promocodes mirror from /admin/promocodes. Replaces the gap that
-- caused the Top Promo Codes card to render raw IDs after Phase 5b.
-- Bug surfaced 2026-05-06: dashboard joined on promocode_id but had
-- no code-text source.
--
-- Field naming: snake_case. API returns camelCase; sync mapper renames
-- at write time. raw jsonb retains the full API payload for forward-
-- compat (same pattern as mdapi_matches, mdapi_subscriptions).
--
-- Apply via Supabase Dashboard → SQL Editor.

CREATE TABLE IF NOT EXISTS mdapi_promocodes (
  api_id                       bigint        PRIMARY KEY,
  code                         text          NOT NULL,
  discount_type                text,
  discount_value               numeric(10, 2),
  target_user_type             text,
  number_of_uses_per_user      integer,
  target_match_type            text,
  start_date_utc               timestamptz,
  end_date_utc                 timestamptz,
  match_time_period_start      timestamptz,
  match_time_period_end        timestamptz,
  created_at                   timestamptz,
  updated_at                   timestamptz,
  deleted_at                   timestamptz,
  raw                          jsonb         NOT NULL,
  synced_at                    timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mdapi_promocodes_code_idx ON mdapi_promocodes(code);
CREATE INDEX IF NOT EXISTS mdapi_promocodes_deleted_at_idx ON mdapi_promocodes(deleted_at);
CREATE INDEX IF NOT EXISTS mdapi_promocodes_synced_at_idx ON mdapi_promocodes(synced_at DESC);

ALTER TABLE mdapi_promocodes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mdapi_promocodes_auth_select ON mdapi_promocodes;
CREATE POLICY mdapi_promocodes_auth_select ON mdapi_promocodes FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS mdapi_promocodes_auth_insert ON mdapi_promocodes;
CREATE POLICY mdapi_promocodes_auth_insert ON mdapi_promocodes FOR INSERT TO authenticated WITH CHECK (true);
DROP POLICY IF EXISTS mdapi_promocodes_auth_update ON mdapi_promocodes;
CREATE POLICY mdapi_promocodes_auth_update ON mdapi_promocodes FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

ALTER TABLE fin_sync_log
  DROP CONSTRAINT IF EXISTS fin_sync_log_source_check;

ALTER TABLE fin_sync_log
  ADD CONSTRAINT fin_sync_log_source_check
  CHECK (source IN (
    'stripe-api',
    'mdapi-reviews',
    'mdapi-subscriptions',
    'membership-snapshots',
    'mdapi-promocodes'
  ));
