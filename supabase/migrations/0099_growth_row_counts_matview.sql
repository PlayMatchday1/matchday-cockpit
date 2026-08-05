-- growth_row_counts() (0097) was the one query keeping /api/growth over the 2s
-- cold budget: count(*) FILTER over the 232k mdapi_match_players is a ~2s seq
-- scan (playersLive + fakeLiveRows), and mdapi_* is READ-ONLY so it can't be
-- indexed. These counts are footnote diagnostics that change only on backfill —
-- so materialise them: compute once during refresh_growth_views (which already
-- scans everything and takes ~30s, so +2s is noise) and let each request read a
-- single row instantly. Freshness = last refresh, which is exactly the snapshot
-- the rest of the Growth tab reflects.
--
-- Replaces the 0097 FUNCTION with a single-row MATERIALIZED VIEW of the same
-- numbers. Same service_role-only posture.
DROP FUNCTION IF EXISTS public.growth_row_counts();

CREATE MATERIALIZED VIEW public.growth_row_counts AS
SELECT
  (SELECT count(*) FROM public.mdapi_matches)                          AS matches_total,
  (SELECT count(*) FROM public.mdapi_matches WHERE deleted_at IS NULL) AS matches_live,
  p.total     AS players_total,
  p.live      AS players_live,
  p.fake_live AS fake_live_rows,
  p.waiting   AS waiting_live_nonfake,
  u.total     AS users_total,
  u.nonfake   AS users_nonfake,
  u.completed AS users_completed_nonfake,
  (SELECT count(*) FROM public.mdapi_subscriptions) AS subscriptions,
  (SELECT count(*) FROM public.fin_revenue)         AS fin_revenue
FROM
  (SELECT
     count(*)                                                                              AS total,
     count(*) FILTER (WHERE deleted_at IS NULL)                                            AS live,
     count(*) FILTER (WHERE deleted_at IS NULL AND user_is_fake_player)                    AS fake_live,
     count(*) FILTER (WHERE deleted_at IS NULL
                        AND COALESCE(user_is_fake_player, false) = false
                        AND paid_status = 'WAITING')                                       AS waiting
   FROM public.mdapi_match_players) p,
  (SELECT
     count(*)                                                                              AS total,
     count(*) FILTER (WHERE COALESCE(is_fake_player, false) = false)                       AS nonfake,
     count(*) FILTER (WHERE COALESCE(is_fake_player, false) = false
                        AND completed_sign_up_at IS NOT NULL)                              AS completed
   FROM public.mdapi_users) u;

REVOKE ALL ON public.growth_row_counts FROM anon, authenticated;
GRANT SELECT ON public.growth_row_counts TO service_role;

-- Refresh the counts alongside the other growth_* views. growth_row_counts reads
-- raw mdapi_* (not growth_participation), so it has no ordering dependency.
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
  REFRESH MATERIALIZED VIEW public.growth_row_counts;
END $$;

REVOKE EXECUTE ON FUNCTION public.refresh_growth_views() FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.refresh_growth_views() TO service_role;
