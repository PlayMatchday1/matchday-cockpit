-- 0215 — LOCATIONS PAGE: when we first saw each player with a home area (Ryan, 2026-10-08).
--
-- Applied by hand in the Supabase SQL Editor. Server-only tables (RLS on, no anon/authenticated
-- grants), written by /api/sync/player-areas and read by /api/matchops/locations, both with the
-- service role.
--
-- WHY THIS TABLE EXISTS. GET /admin/players carries zipCode, lat, lng, areaLabel, areaSource but NO
-- timestamp for when the area was set (docs/matchday-api-facts.md, "Player location / home area").
-- first_seen_at is the time OUR sync first observed the area, so it is accurate to within one sync
-- interval, never better. Rows present on the very first run are seeded = true: their area was set
-- before tracking began and first_seen_at is NOT a set time.
--
-- The verdict (in market / waitlist / unidentified) is computed by the sync from the player's
-- lat/lng against /admin/cities lat/lng/radiusMiles and stored here, not computed per page load.
-- verdict_geometry is a fingerprint of the city geometry it was computed against.
--
-- Its own runs table instead of a new fin_sync_log source: that allowlist is a CHECK whose live
-- definition cannot be read from the repo, and rewriting it from a guess could drop a value.

BEGIN;

CREATE TABLE public.player_area_seen (
  player_id          bigint PRIMARY KEY,
  first_seen_at      timestamptz NOT NULL,
  seeded             boolean NOT NULL DEFAULT false,
  -- false when a later sync saw this player with no area again (cleared). The row is kept so
  -- first_seen_at survives; the page counts has_area = true only.
  has_area           boolean NOT NULL DEFAULT true,
  -- latest observed values, refreshed every sync
  zip                text,                    -- a string: leading zeros matter
  lat                double precision,
  lng                double precision,
  area_label         text,
  area_source        text,                    -- raw API value ("zip", the GPS spelling is unknown)
  is_internal        boolean NOT NULL DEFAULT false,  -- @matchday.com / @playmatchday.com
  verdict            text NOT NULL CHECK (verdict IN ('in_market', 'waitlist', 'unidentified')),
  verdict_city_id    integer,                 -- set only when in_market
  nearest_city_id    integer,                 -- null when unidentified
  nearest_city_mi    double precision,
  verdict_geometry   text NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()   -- last time any value on the row changed
);

CREATE INDEX player_area_seen_first_seen_idx ON public.player_area_seen (first_seen_at DESC);

CREATE TABLE public.player_area_sync_runs (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  ok                 boolean,
  triggered_by       text NOT NULL CHECK (triggered_by IN ('cron', 'manual')),
  players_total      integer,                 -- every row /admin/players returned
  players_internal   integer,                 -- of which @matchday.com / @playmatchday.com
  complete           boolean,                 -- rows received = totalItems
  areas_seen         integer,
  rows_inserted      integer,
  rows_updated       integer,
  api_calls          integer,
  cities             jsonb,                   -- the US city geometry the verdicts used
  error              text
);

CREATE INDEX player_area_sync_runs_started_idx ON public.player_area_sync_runs (started_at DESC);

ALTER TABLE public.player_area_seen ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_area_sync_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.player_area_seen FROM anon, authenticated;
REVOKE ALL ON public.player_area_sync_runs FROM anon, authenticated;

COMMIT;
