-- Matches and match-player registrations from the MatchDay API.
-- Replaces the manually-uploaded user_analysis CSV (match_registrations
-- table). One row per match; one row per player registration. Soft FK
-- via mdapi_match_players.match_api_id → mdapi_matches.api_id (no
-- enforced constraint to keep backfill order-flexible — sync writes
-- matches before players, but a transient mismatch shouldn't block
-- the run).
--
-- Field naming: snake_case to match cockpit conventions. API returns
-- camelCase; sync mapper renames at write time. raw jsonb retains
-- the full API payload for forward-compat (same pattern as
-- mdapi_subscriptions, mdapi_reviews).
--
-- Apply via Supabase Dashboard → SQL Editor.

CREATE TABLE IF NOT EXISTS mdapi_matches (
  api_id                  bigint        PRIMARY KEY,
  field_id                bigint        NOT NULL,
  field_title             text,
  field_address           text,
  field_zipcode           text,
  city_identifier         text,
  city_name               text,
  manager_id              bigint,
  manager_email           text,
  manager_first_name      text,
  manager_last_name       text,
  second_manager_id       bigint,
  name                    text,
  description             text,
  type                    text,
  category                text,
  start_date              timestamptz,
  start_date_utc          timestamptz,
  end_date                timestamptz,
  end_date_utc            timestamptz,
  min_player_count        integer,
  max_player_count        integer,
  registration_price      numeric(10, 2),
  additional_spot_price   numeric(10, 2),
  is_free_member          boolean,
  is_auto_bump            boolean,
  has_organizer           boolean,
  max_team_size_2team     integer,
  max_team_size_4team     integer,
  guest_count             integer,
  is_cancelled            boolean,
  auto_canceled           boolean,
  auto_canceled_minutes   integer,
  star_rating             numeric(3, 2),
  star_rating_count       integer,
  player_count            integer,
  fake_player_count       integer,
  created_at              timestamptz,
  updated_at              timestamptz,
  raw                     jsonb         NOT NULL,
  synced_at               timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mdapi_matches_start_date_idx ON mdapi_matches(start_date);
CREATE INDEX IF NOT EXISTS mdapi_matches_city_idx ON mdapi_matches(city_identifier);
CREATE INDEX IF NOT EXISTS mdapi_matches_field_id_idx ON mdapi_matches(field_id);
CREATE INDEX IF NOT EXISTS mdapi_matches_manager_id_idx ON mdapi_matches(manager_id);
CREATE INDEX IF NOT EXISTS mdapi_matches_is_cancelled_idx ON mdapi_matches(is_cancelled);
CREATE INDEX IF NOT EXISTS mdapi_matches_updated_at_idx ON mdapi_matches(updated_at DESC);
CREATE INDEX IF NOT EXISTS mdapi_matches_city_date_idx ON mdapi_matches(city_identifier, start_date);

ALTER TABLE mdapi_matches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mdapi_matches_auth_select ON mdapi_matches;
CREATE POLICY mdapi_matches_auth_select ON mdapi_matches FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS mdapi_matches_auth_insert ON mdapi_matches;
CREATE POLICY mdapi_matches_auth_insert ON mdapi_matches FOR INSERT TO authenticated WITH CHECK (true);
DROP POLICY IF EXISTS mdapi_matches_auth_update ON mdapi_matches;
CREATE POLICY mdapi_matches_auth_update ON mdapi_matches FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


CREATE TABLE IF NOT EXISTS mdapi_match_players (
  api_id                  bigint        PRIMARY KEY,
  match_api_id            bigint        NOT NULL,
  user_id                 bigint        NOT NULL,
  user_email              text,
  user_first_name         text,
  user_last_name          text,
  user_phone_number       text,
  user_is_member          boolean,
  user_is_fake_player     boolean,
  paid_status             text,
  user_type               text,
  user_status             text,
  team                    integer,
  player_number           integer,
  is_reserved             boolean,
  is_first_match          boolean,
  is_absent               boolean,
  amount                  numeric(10, 2),
  total_amount            numeric(10, 2),
  credit_amount           numeric(10, 2),
  payment_intent_id       text,
  refunded                boolean,
  is_migrated_stripe_pi   boolean,
  promocode_id            bigint,
  is_cancelled            boolean,
  canceled_at             timestamptz,
  cancelled_before_24h    boolean,
  created_at              timestamptz,
  updated_at              timestamptz,
  raw                     jsonb         NOT NULL,
  synced_at               timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mdapi_match_players_match_idx ON mdapi_match_players(match_api_id);
CREATE INDEX IF NOT EXISTS mdapi_match_players_user_idx ON mdapi_match_players(user_id);
CREATE INDEX IF NOT EXISTS mdapi_match_players_email_idx ON mdapi_match_players(LOWER(user_email));
CREATE INDEX IF NOT EXISTS mdapi_match_players_canceled_idx ON mdapi_match_players(canceled_at);
CREATE INDEX IF NOT EXISTS mdapi_match_players_user_type_idx ON mdapi_match_players(user_type);
CREATE INDEX IF NOT EXISTS mdapi_match_players_created_at_idx ON mdapi_match_players(created_at);

ALTER TABLE mdapi_match_players ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mdapi_match_players_auth_select ON mdapi_match_players;
CREATE POLICY mdapi_match_players_auth_select ON mdapi_match_players FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS mdapi_match_players_auth_insert ON mdapi_match_players;
CREATE POLICY mdapi_match_players_auth_insert ON mdapi_match_players FOR INSERT TO authenticated WITH CHECK (true);
DROP POLICY IF EXISTS mdapi_match_players_auth_update ON mdapi_match_players;
CREATE POLICY mdapi_match_players_auth_update ON mdapi_match_players FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
