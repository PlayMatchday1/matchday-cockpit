-- 0259 — MOVE THE ROWS ALREADY STORED INTO THE 0258 ROLLUPS. One time. Run AFTER the deploy that calls
-- app_request_log_ingest() is READY (until then the old drain keeps storing these lines as rows, and anything it
-- stores after this runs would be left behind). Safe to run again: each step moves what matches and deletes it.
--
-- The classification is the drain's (src/lib/appActivity.ts: isAlwaysRow, isStaffKey, isBackgroundRoute, rollupRoute),
-- in order. PUT /admin/user-matches is ALWAYS kept as a row (Ryan, 2026-11-06: the player app's moves), so it is
-- excluded from steps 1 and 2:
--   staff/webhook (route, or path when no route, under /admin/, /api/v1/admin/, /stripe/webhook)  → route rollup 'staff'
--   no user id                                                                                     → route rollup 'anonymous'
--   a background route with status < 400                                                           → bg rollup
-- THE BACKGROUND LIST BELOW IS GENERATED from ROUTE_WORDS (the entries with `bg`), 40 routes, 2026-11-06.
-- Every DELETE carries a WHERE (pg_safeupdate).

begin;

create temporary table _bg_routes (method text, route text) on commit drop;
insert into _bg_routes values
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
  ('GET', '/leaderboard/my-stats/global');

-- 1) staff / webhook
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

-- 2) anonymous
insert into public.app_request_route_hourly as t (env, hour, kind, method, route, status, n)
select env, date_trunc('hour', ts), 'anonymous', method,
       coalesce(route, '(no route) ' || regexp_replace(path, '/[0-9]+(?=/|$)', '/:n', 'g')), status, count(*)
from public.app_request_log
where user_id is null and not (method = 'PUT' and route is not distinct from '/admin/user-matches')
group by 1, 2, 3, 4, 5, 6
on conflict (env, hour, kind, method, route, status) do update set n = t.n + excluded.n;
delete from public.app_request_log where user_id is null
  and not (method = 'PUT' and route is not distinct from '/admin/user-matches');

-- 3) successful background requests
insert into public.app_request_bg_hourly as t (env, user_id, hour, bg_count, last_seen_at)
select l.env, l.user_id, date_trunc('hour', l.ts), count(*), max(l.ts)
from public.app_request_log l
join _bg_routes b on b.method = l.method and b.route = l.route
where l.status < 400 and l.user_id is not null
group by 1, 2, 3
on conflict (env, user_id, hour) do update
  set bg_count = t.bg_count + excluded.bg_count, last_seen_at = greatest(t.last_seen_at, excluded.last_seen_at);
delete from public.app_request_log l
using _bg_routes b
where b.method = l.method and b.route = l.route and l.status < 400 and l.user_id is not null;

commit;

-- ── VERDICT — one row: the first three must be 0 ─────────────────────────────────────────────────
select
  (select count(*) from public.app_request_log where (coalesce(route, path) like '/admin/%'
     or coalesce(route, path) like '/api/v1/admin/%' or coalesce(route, path) like '/stripe/webhook%')
     and not (method = 'PUT' and route is not distinct from '/admin/user-matches'))                  as staff_rows_left,
  (select count(*) from public.app_request_log where user_id is null
     and not (method = 'PUT' and route is not distinct from '/admin/user-matches'))                  as anonymous_rows_left,
  (select count(*) from public.app_request_log where method = 'PUT' and route = '/admin/user-matches') as user_matches_rows_kept,
  (select count(*) from public.app_request_log where status < 400 and (method, route) in (
     ('GET', '/player/profile'), ('GET', '/matches'), ('GET', '/matches/my-matches')))               as common_bg_rows_left,
  (select count(*) from public.app_request_log)                                                      as rows_kept,
  (select coalesce(sum(bg_count), 0) from public.app_request_bg_hourly)                              as bg_rolled,
  (select coalesce(sum(n), 0) from public.app_request_route_hourly)                                  as route_rolled;
