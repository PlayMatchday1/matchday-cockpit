-- 0216 — LOCATIONS: the US state a player's area is in (Ryan, 2026-10-08).
--
-- Applied by hand in the Supabase SQL Editor. One nullable column on 0215's table; no data change.
--
-- The MatchDay data carries no state (areaLabel is "City, United States"; raw.address is
-- {city, street, country} — docs/matchday-api-facts.md). The player-areas sync now works it out
-- from the player's lat/lng against US Census state boundaries (the us-atlas package, server-only)
-- and stores the two-letter code here, so the page shows "City, ST" without loading boundaries in
-- the browser. NULL = no coordinates, or coordinates outside every state; the page then shows the
-- city alone. Existing rows fill in on the next sync run (a changed state counts as a change).

BEGIN;

ALTER TABLE public.player_area_seen
  ADD COLUMN state text CHECK (state IS NULL OR state ~ '^[A-Z]{2}$');

COMMIT;
