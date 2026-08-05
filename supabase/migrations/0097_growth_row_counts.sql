-- Growth-tab rowCounts in ONE round-trip. The dashboard footnote shows
-- matchesLive, playersLive, fakeLiveRows, fakeLivePct and usersFake. Counting
-- those over PostgREST needs one exact count() PER metric, and the filtered
-- counts over mdapi_match_players (232k rows) are full scans — 4 of them in
-- parallel measured ~3.9s, which alone blew the /api/growth cold budget.
--
-- This function computes every count the route needs with count(*) FILTER (...)
-- so mdapi_match_players and mdapi_users are each scanned exactly ONCE (not once
-- per metric). Read-only; mdapi_* is untouched. service_role only (same posture
-- as 0096 — these are not RLS-covered and anon/authenticated are revoked).
--
-- NOTE: this is a SEPARATE migration from 0096 because 0096 was already applied;
-- it is the query fix for the cold-load gate (not a cache), exactly as required.
CREATE OR REPLACE FUNCTION public.growth_row_counts()
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'matchesTotal',          (SELECT count(*) FROM public.mdapi_matches),
    'matchesLive',           (SELECT count(*) FROM public.mdapi_matches WHERE deleted_at IS NULL),
    'playersTotal',          p.total,
    'playersLive',           p.live,
    'fakeLiveRows',          p.fake_live,
    'waitingLiveNonFake',    p.waiting,
    'usersTotal',            u.total,
    'usersNonFake',          u.nonfake,
    'usersCompletedNonFake', u.completed,
    'subscriptions',         (SELECT count(*) FROM public.mdapi_subscriptions),
    'finRevenue',            (SELECT count(*) FROM public.fin_revenue)
  )
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
$$;

REVOKE EXECUTE ON FUNCTION public.growth_row_counts() FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.growth_row_counts() TO service_role;
