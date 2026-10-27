-- 0233 LOCATIONS PLAY STATS: the Locations map's match history, precomputed (2026-10-27).
--
-- NOT player_play_stats: that name is Player Finder's VIEW (migration 0133). The first draft of this
-- migration used it, and "create table if not exists" skipped silently before the index failed.
--
-- The Map tab used to read every placed player's match history on every load (fetchPlayHistory over
-- mdapi_match_players + mdapi_matches, 19 s of a 25 s load). That history now lands here once an hour,
-- at the end of the hourly location sync (/api/sync/player-areas/recent), and the map reads these rows.
--
--   locations_play_stats  one row per placed player WITH at least one play: per field, the number of
--                      valid started plays, the latest one's start (true instant, ms) and its local day.
--                      Every number the map shows (where they play, median distance, last played,
--                      matches, favourite field, activity) is a function of these per-field totals.
--   locations_played_fields every field any of those plays happened at, as the history read found it
--                      (title, city, position). "Closed" is worked out on read, against today's fields.
--
-- refreshed_at = the instant the refresh counted plays up to. Rows older than the latest refresh are
-- deleted by that refresh. RLS on with NO policies: only the service role reads or writes.

create table if not exists public.locations_play_stats (
  player_id    bigint primary key,
  plays        jsonb not null,           -- [[field_id, matches, last_start_ms, "YYYY-MM-DD"], ...]
  refreshed_at timestamptz not null
);
create index if not exists locations_play_stats_refreshed_idx on public.locations_play_stats (refreshed_at);

create table if not exists public.locations_played_fields (
  field_id     bigint primary key,
  title        text not null,
  city_id      bigint,
  lat          double precision,
  lng          double precision,
  refreshed_at timestamptz not null
);
create index if not exists locations_played_fields_refreshed_idx on public.locations_played_fields (refreshed_at);

alter table public.locations_play_stats enable row level security;
alter table public.locations_played_fields enable row level security;
revoke all on public.locations_play_stats from anon, authenticated;
revoke all on public.locations_played_fields from anon, authenticated;
