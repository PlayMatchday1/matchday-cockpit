-- Subscriptions from the MatchDay platform API. Replaces fin_members
-- eventually. 1 row per membership record from
-- GET /admin/subscriptions?cityIdentifier=&status=&sortColumn=&sortDirection=
--
-- Field naming: snake_case to match cockpit conventions (mdapi_reviews,
-- fin_*). Mapped from the API's camelCase at sync time. The column
-- `city_identifier` does NOT come from the response body — the list
-- endpoint returns only the slug (e.g. "ATX13"). The sync writes
-- `city_identifier` from the loop variable used in the request.
--
-- PK: membership_id. Verified globally unique across cities by sampling
-- 193 ACTIVE memberships from ATX/HOU/SATX (May 2026) — no collisions.
-- The platform's memberships table uses a single global sequence; the
-- per-city counter lives in city_member_slug (the "ATX13" form).
--
-- Apply via Supabase Dashboard → SQL Editor.

CREATE TABLE IF NOT EXISTS mdapi_subscriptions (
  -- API identity (PK = the platform's membership row id)
  membership_id            bigint        PRIMARY KEY,

  -- Player linkage. user_id is the platform's users table PK; one
  -- user can have multiple memberships over time (cancel + rejoin
  -- creates a new row with the same user_id, different membership_id).
  user_id                  bigint        NOT NULL,

  -- Synthetic — written from the request's cityIdentifier param.
  -- Not in the response body; available only on the slug.
  city_identifier          text          NOT NULL,

  -- Per-city display slug (e.g. "ATX13"). Useful for customer-service
  -- lookups; treated as a secondary identifier.
  city_member_slug         text,

  -- Member identity (denormalized from the platform's users table)
  member_email             text,
  first_name               text,
  last_name                text,
  phone_number             text,

  -- Membership state
  status                   text,         -- one of 9 enum values; not constrained at DB level
  price                    numeric(10, 2), -- cents-vs-dollars TBD on first sync
  membership_length        integer,
  comment                  text,

  -- Lifecycle timestamps
  activation_date          timestamptz,  -- ≈ fin_members.activation_date
  canceled_at              timestamptz,  -- ≈ fin_members.canceled_at
  cancel_reason            text,
  suspended_to             timestamptz,  -- nullable; mostly null based on probe

  -- Strike/absence bookkeeping (platform-internal, may not be used downstream)
  strike_points            integer,
  absent_owed              numeric(10, 2),

  -- Audit + future-proofing
  raw                      jsonb         NOT NULL,
  synced_at                timestamptz   NOT NULL DEFAULT now()
);

-- Hot-path indexes
CREATE INDEX IF NOT EXISTS mdapi_subscriptions_status_idx
  ON mdapi_subscriptions(status);
CREATE INDEX IF NOT EXISTS mdapi_subscriptions_city_idx
  ON mdapi_subscriptions(city_identifier);
CREATE INDEX IF NOT EXISTS mdapi_subscriptions_user_id_idx
  ON mdapi_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS mdapi_subscriptions_canceled_at_idx
  ON mdapi_subscriptions(canceled_at);
CREATE INDEX IF NOT EXISTS mdapi_subscriptions_synced_at_idx
  ON mdapi_subscriptions(synced_at DESC);

-- Composite: most queries will be "active in city X" or
-- "canceled in city X this month" — both filter by status + city.
CREATE INDEX IF NOT EXISTS mdapi_subscriptions_status_city_idx
  ON mdapi_subscriptions(status, city_identifier);

-- Email index supports cross-table joins to mdapi_reviews and to
-- the existing reviews table during the dual-write transition.
CREATE INDEX IF NOT EXISTS mdapi_subscriptions_email_idx
  ON mdapi_subscriptions(LOWER(member_email));

ALTER TABLE mdapi_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mdapi_subscriptions_auth_select ON mdapi_subscriptions;
CREATE POLICY mdapi_subscriptions_auth_select
  ON mdapi_subscriptions FOR SELECT TO authenticated USING (true);
-- No INSERT/UPDATE policy. Sync writes use the service role
-- (bypasses RLS); operators don't write directly.
