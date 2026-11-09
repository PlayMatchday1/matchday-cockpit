-- 0268 — growth_participation counts only matches that have STARTED (Ryan, 2026-11-09).
--
-- WHY. The view (0208) dropped cancelled matches but had no time cutoff, so a booking on an UPCOMING
-- match counted as play in the current month. Read on 2026-11-09: 104 bookings on 37 matches dated
-- Nov 10 or later (ATX 41, SATX 41, HOU 8, WAW 5, DFW 4, ATL 3, PHL 1, STL 1), and 11 people whose
-- "first match" (growth_player_profile.first_match_date) was a match not yet played. Philadelphia
-- read 1 spot booked in November before its first match (21243, Sat Nov 14) had been played.
--
-- THE RULE. A match counts once its start time has passed. start_date is LOCAL WALL CLOCK carrying a
-- Z it does not mean (CLAUDE.md), so it is compared as a wall-clock timestamp against the wall clock
-- in America/Chicago. An Eastern match (Atlanta, Philadelphia) therefore counts up to an hour after
-- it starts, never before.
--
-- WHAT READS IT. growth_play_dims, growth_player_profile and the other growth materialized views
-- (rebuilt below by refresh_growth_views), Churn's refresh_churn_player_field (nightly, 13:20 UTC)
-- and the Data Room functions (live). Materialized views only see a match from their next rebuild
-- after it starts: refresh_growth_views runs from /api/sync/cron (11:00 UTC) and the night pass, so
-- a match played tonight shows from tomorrow morning's rebuild. Before this, it showed as a booking
-- from the rebuild after it was booked.
--
-- The definition is 0208's, unchanged except for the one marked line. Same columns, same order, so
-- CREATE OR REPLACE keeps every dependent view valid.
--
-- Apply in the Supabase SQL Editor. Not applied by the app.

BEGIN;

CREATE OR REPLACE VIEW public.growth_participation AS
SELECT
  p.api_id                                                AS player_api_id,
  COALESCE(l.person_id, p.user_id)                        AS user_id,
  to_char(m.start_date AT TIME ZONE 'UTC', 'YYYY-MM-DD')  AS match_date,
  to_char(m.start_date AT TIME ZONE 'UTC', 'YYYY-MM')     AS match_month,
  m.city_identifier                                       AS city_identifier,
  m.field_title                                           AS field_title,
  m.field_id                                              AS field_id,
  COALESCE(p.amount, 0)                                   AS total_amount,
  COALESCE(p.amount, 0)                                   AS amount_cents,
  p.match_api_id                                          AS match_api_id,
  p.user_id                                               AS account_id
FROM public.mdapi_match_players p
JOIN public.mdapi_matches m ON m.api_id = p.match_api_id
LEFT JOIN public.growth_person_link l ON l.account_id = p.user_id
WHERE p.deleted_at IS NULL
  AND COALESCE(p.user_is_fake_player, false) = false   -- the BOOKING was a fake fill; see 0208
  AND p.paid_status IS DISTINCT FROM 'WAITING'
  AND p.canceled_at IS NULL
  AND p.user_id IS NOT NULL
  AND m.deleted_at IS NULL
  AND COALESCE(m.is_cancelled, false) = false
  AND m.start_date IS NOT NULL
  AND (m.start_date AT TIME ZONE 'UTC') <= (now() AT TIME ZONE 'America/Chicago')   -- 0268: started only
  AND NOT EXISTS (SELECT 1 FROM public.growth_internal_account i WHERE i.user_id = p.user_id);

COMMIT;

-- Rebuild every growth materialized view on the new definition (takes up to a few minutes).
SELECT public.refresh_growth_views();

-- VERDICT. Expect: future_rows = 0, future_first_matches = 0.
SELECT
  (SELECT count(*) FROM public.growth_participation
     WHERE match_date > to_char(now() AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD'))         AS future_rows,
  (SELECT count(*) FROM public.growth_player_profile
     WHERE first_match_date > to_char(now() AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD'))   AS future_first_matches;
