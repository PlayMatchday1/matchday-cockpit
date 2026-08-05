-- refresh_growth_views() was timing out at the role statement_timeout (~8s) when
-- called via PostgREST rpc, because growth_player_profile now materialises the
-- per-player ev array (array_agg(DISTINCT ...)) + city_counts jsonb over ~145k
-- participation rows. A timed-out refresh means the backfill/stripe/cron caller
-- (best-effort) silently leaves the views STALE.
--
-- Fix: give the function its own statement_timeout so a plain REFRESH runs to
-- completion regardless of the caller's role default. This does NOT address the
-- lock a non-concurrent REFRESH holds on each view while it runs — for a zero-lock
-- refresh, schedule REFRESH ... CONCURRENTLY via pg_cron, which needs a
-- plain-column (non-expression) unique index on all five views. Only
-- growth_player_profile and growth_registration have one today; the other three
-- use COALESCE() expression indexes (see 0096) and need a follow-up migration
-- adding a stored key column before CONCURRENTLY will work. Until then this inline
-- refresh is the freshness path; measure its true wall-clock (it will be well over
-- 2s) and prefer pg_cron for production if the lock is disruptive.
CREATE OR REPLACE FUNCTION public.refresh_growth_views()
  RETURNS void
  LANGUAGE plpgsql
  SET statement_timeout = '300s'
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW public.growth_player_profile;
  REFRESH MATERIALIZED VIEW public.growth_player_month;
  REFRESH MATERIALIZED VIEW public.growth_cohort_matrix;
  REFRESH MATERIALIZED VIEW public.growth_play_dims;
  REFRESH MATERIALIZED VIEW public.growth_registration;
END $$;

REVOKE EXECUTE ON FUNCTION public.refresh_growth_views() FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.refresh_growth_views() TO service_role;
