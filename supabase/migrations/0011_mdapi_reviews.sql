-- Reviews from the MatchDay platform API. Replaces the Reviews CSV
-- upload (manually exported from Retool). 1 row per match-player
-- review, keyed by the API's `id`. Sync source: GET /admin/matches/reviews.
--
-- Field naming: matches the API exactly (snake_case) so the sync
-- mapper is a 1:1 copy with no rename layer. Differs from
-- mdapi_players / mdapi_subscriptions which will use camelCase
-- because their source endpoints use camelCase. Each table mirrors
-- its source — easier to debug "is the API field X showing up?"
-- without translating in your head.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

CREATE TABLE IF NOT EXISTS mdapi_reviews (
  -- API identity (PK = the review's id from /admin/matches/reviews)
  api_id              bigint        PRIMARY KEY,

  -- Player who left the review
  user_id             bigint,
  user_first_name     text,
  user_last_name      text,
  user_phone_number   text,
  user_email          text,

  -- Manager being reviewed (no manager_id surfaced by the endpoint)
  manager_first_name  text,
  manager_last_name   text,

  -- Match context (no match_id surfaced — endpoint joins flat)
  start_date          timestamptz,
  field_title         text,
  city_name           text,

  -- The review itself
  star_rating         smallint,
  tags_rating         jsonb,
  comment             text,
  updated_at_rating   timestamptz,

  -- Audit + future-proofing
  raw                 jsonb         NOT NULL,
  synced_at           timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mdapi_reviews_user_email_idx
  ON mdapi_reviews(LOWER(user_email));
CREATE INDEX IF NOT EXISTS mdapi_reviews_user_id_idx
  ON mdapi_reviews(user_id);
CREATE INDEX IF NOT EXISTS mdapi_reviews_start_date_idx
  ON mdapi_reviews(start_date);
CREATE INDEX IF NOT EXISTS mdapi_reviews_synced_at_idx
  ON mdapi_reviews(synced_at DESC);

ALTER TABLE mdapi_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mdapi_reviews_auth_select ON mdapi_reviews;
CREATE POLICY mdapi_reviews_auth_select
  ON mdapi_reviews FOR SELECT TO authenticated USING (true);
-- No INSERT/UPDATE policy. Sync writes use the service role
-- (bypasses RLS); operators don't write directly.
