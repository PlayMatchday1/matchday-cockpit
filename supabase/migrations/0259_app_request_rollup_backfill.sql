-- 0259 — MOVE THE ROWS ALREADY STORED INTO THE 0258 ROLLUPS. One time; safe to run again (each step moves what
-- still matches and deletes it, so a second run finds nothing to count twice).
--
-- REWRITTEN 2026-11-07. The first version built a TEMPORARY table (_bg_routes, ON COMMIT DROP) between an
-- explicit BEGIN and COMMIT. Run whole in the Supabase SQL Editor it reported 42P01 "_bg_routes does not exist",
-- yet the data shows all three moves committed (rollup rows for pre-deploy hours exist; no anonymous, staff or
-- successful background rows were left). How the editor sent the statements is not visible from here, so the
-- dependency is gone instead: ONE DO block (a single statement, atomic however it is sent), no temporary table,
-- no BEGIN/COMMIT, the background list inline in each statement that needs it.
--
-- Classification is the drain's (src/lib/appActivity.ts: isAlwaysRow, isStaffKey, isBackgroundRoute,
-- rollupRoute). PUT /admin/user-matches is ALWAYS kept as a row (Ryan, 2026-11-06). The background list is
-- GENERATED from ROUTE_WORDS (40 routes). Every DELETE carries a WHERE (pg_safeupdate).

do $migration$
begin
  -- 1) staff / webhook → route rollup 'staff'
  insert into public.app_request_route_hourly as t (env, hour, kind, method, route, status, n)
  select env, date_trunc('hour', ts), 'staff', method,
         coalesce(route, '(no route) ' || regexp_replace(path, '/[0-9]+(?=/|$)', '/:n', 'g')), status, count(*)
  from public.app_request_log
  where (coalesce(route, path) like '/admin/%' or coalesce(route, path) like '/api/v1/admin/%'
     or coalesce(route, path) like '/stripe/webhook%')
    and not (method = 'PUT' and route is not distinct from '/admin/user-matches')
  group by 1, 2, 3, 4, 5, 6
  on conflict (env, hour, kind, method, route, status) do update set n = t.n + excluded.n;

  delete from public.app_request_log
  where (coalesce(route, path) like '/admin/%' or coalesce(route, path) like '/api/v1/admin/%'
     or coalesce(route, path) like '/stripe/webhook%')
    and not (method = 'PUT' and route is not distinct from '/admin/user-matches');

  -- 2) no user id → route rollup 'anonymous'
  insert into public.app_request_route_hourly as t (env, hour, kind, method, route, status, n)
  select env, date_trunc('hour', ts), 'anonymous', method,
         coalesce(route, '(no route) ' || regexp_replace(path, '/[0-9]+(?=/|$)', '/:n', 'g')), status, count(*)
  from public.app_request_log
  where user_id is null
    and not (method = 'PUT' and route is not distinct from '/admin/user-matches')
  group by 1, 2, 3, 4, 5, 6
  on conflict (env, hour, kind, method, route, status) do update set n = t.n + excluded.n;

  delete from public.app_request_log
  where user_id is null
    and not (method = 'PUT' and route is not distinct from '/admin/user-matches');

  -- 3) successful background requests → per-player hourly rollup
  insert into public.app_request_bg_hourly as t (env, user_id, hour, bg_count, last_seen_at)
  select l.env, l.user_id, date_trunc('hour', l.ts), count(*), max(l.ts)
  from public.app_request_log l
  join (values
      ('GET', '/subscriptions'),
      ('GET', '/player/subscriptions'),
      ('GET', '/player/payment-methods'),
      ('GET', '/stripe'),
      ('GET', '/strikes'),
      ('GET', '/strikes/cities/:cityAbbr'),
      ('GET', '/special-events/captain-divisions/:captainDivisionId/payments'),
      ('POST', '/auth/refresh'),
      ('GET', '/player/profile'),
      ('POST', '/user-devices'),
      ('POST', '/v2/device-integrity'),
      ('GET', '/matches'),
      ('GET', '/matches/my-matches'),
      ('GET', '/matches/matches-for-review'),
      ('GET', '/events'),
      ('GET', '/special-events/events'),
      ('GET', '/special-events/events/:eventId/divisions'),
      ('GET', '/special-events/divisions/:divisionId/teams'),
      ('GET', '/special-events/divisions/:divisionId/matches'),
      ('GET', '/fields'),
      ('GET', '/cities'),
      ('GET', '/cities/nearby'),
      ('GET', '/cities/:id'),
      ('GET', '/states'),
      ('GET', '/time-zones'),
      ('GET', '/app-config'),
      ('GET', '/notifications'),
      ('PATCH', '/notifications/:id'),
      ('GET', '/offers/popup'),
      ('POST', '/offers/popup/preview/:previewId/seen'),
      ('GET', '/goals/my-goals'),
      ('GET', '/leaderboard/name'),
      ('GET', '/leaderboard/current/matches'),
      ('GET', '/leaderboard/current/goals'),
      ('GET', '/leaderboard/matches'),
      ('GET', '/leaderboard/matches/global'),
      ('GET', '/leaderboard/goals'),
      ('GET', '/leaderboard/goals/global'),
      ('GET', '/leaderboard/my-stats'),
      ('GET', '/leaderboard/my-stats/global')
  ) as b(method, route) on b.method = l.method and b.route = l.route
  where l.status < 400 and l.user_id is not null
  group by 1, 2, 3
  on conflict (env, user_id, hour) do update
    set bg_count = t.bg_count + excluded.bg_count, last_seen_at = greatest(t.last_seen_at, excluded.last_seen_at);

  delete from public.app_request_log l
  using (values
      ('GET', '/subscriptions'),
      ('GET', '/player/subscriptions'),
      ('GET', '/player/payment-methods'),
      ('GET', '/stripe'),
      ('GET', '/strikes'),
      ('GET', '/strikes/cities/:cityAbbr'),
      ('GET', '/special-events/captain-divisions/:captainDivisionId/payments'),
      ('POST', '/auth/refresh'),
      ('GET', '/player/profile'),
      ('POST', '/user-devices'),
      ('POST', '/v2/device-integrity'),
      ('GET', '/matches'),
      ('GET', '/matches/my-matches'),
      ('GET', '/matches/matches-for-review'),
      ('GET', '/events'),
      ('GET', '/special-events/events'),
      ('GET', '/special-events/events/:eventId/divisions'),
      ('GET', '/special-events/divisions/:divisionId/teams'),
      ('GET', '/special-events/divisions/:divisionId/matches'),
      ('GET', '/fields'),
      ('GET', '/cities'),
      ('GET', '/cities/nearby'),
      ('GET', '/cities/:id'),
      ('GET', '/states'),
      ('GET', '/time-zones'),
      ('GET', '/app-config'),
      ('GET', '/notifications'),
      ('PATCH', '/notifications/:id'),
      ('GET', '/offers/popup'),
      ('POST', '/offers/popup/preview/:previewId/seen'),
      ('GET', '/goals/my-goals'),
      ('GET', '/leaderboard/name'),
      ('GET', '/leaderboard/current/matches'),
      ('GET', '/leaderboard/current/goals'),
      ('GET', '/leaderboard/matches'),
      ('GET', '/leaderboard/matches/global'),
      ('GET', '/leaderboard/goals'),
      ('GET', '/leaderboard/goals/global'),
      ('GET', '/leaderboard/my-stats'),
      ('GET', '/leaderboard/my-stats/global')
  ) as b(method, route)
  where b.method = l.method and b.route = l.route and l.status < 400 and l.user_id is not null;
end
$migration$;

-- ── VERDICT — one row: the first three must be 0 ─────────────────────────────────────────────────
select
  (select count(*) from public.app_request_log where (coalesce(route, path) like '/admin/%'
     or coalesce(route, path) like '/api/v1/admin/%' or coalesce(route, path) like '/stripe/webhook%')
     and not (method = 'PUT' and route is not distinct from '/admin/user-matches'))                                                                                   as staff_rows_left,
  (select count(*) from public.app_request_log where user_id is null and not (method = 'PUT' and route is not distinct from '/admin/user-matches'))                  as anonymous_rows_left,
  (select count(*) from public.app_request_log where status < 400 and (method, route) in (
     ('GET', '/player/profile'), ('GET', '/matches'), ('GET', '/matches/my-matches')))       as common_bg_rows_left,
  (select count(*) from public.app_request_log where method = 'PUT' and route = '/admin/user-matches') as user_matches_rows_kept,
  (select count(*) from public.app_request_log)                                              as rows_kept,
  (select coalesce(sum(bg_count), 0) from public.app_request_bg_hourly)                      as bg_rolled,
  (select coalesce(sum(n), 0) from public.app_request_route_hourly)                          as route_rolled;
