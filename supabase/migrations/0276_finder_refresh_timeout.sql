-- refresh_player_finder_views() is timing out at the role statement_timeout when called through
-- PostgREST rpc. Production log, 2026-11-19: every Refresh click on the player list and every
-- /api/sync/matches run logged "canceling statement due to statement timeout", so the set has not
-- been rebuilt since the night pass at 08:33 UTC. The same failure on refresh_growth_views() was
-- fixed in 0098 the same way, and that function has run clean since.
--
-- Only the function's own setting changes. Body, owner and grants are untouched (ALTER FUNCTION, not
-- CREATE OR REPLACE), so the 0148 body with its WHERE stays exactly as it is.
ALTER FUNCTION public.refresh_player_finder_views() SET statement_timeout = '120s';

-- Rebuild once now so the set is current the moment this lands.
SELECT public.refresh_player_finder_views();

-- VERDICT, one row. Expected: rebuilt_within_a_minute TRUE and a proconfig containing
-- statement_timeout=120s.
SELECT
  (SELECT refreshed_at > now() - interval '1 minute' FROM public.player_finder_refresh) AS rebuilt_within_a_minute,
  (SELECT refreshed_at FROM public.player_finder_refresh)                               AS refreshed_at,
  (SELECT proconfig FROM pg_proc WHERE proname = 'refresh_player_finder_views')         AS proconfig;

-- ROLLBACK: ALTER FUNCTION public.refresh_player_finder_views() RESET statement_timeout;
