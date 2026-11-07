-- 0258 — APP ACTIVITY ROLLUPS (Ryan, 2026-11-06, after the first measured hour: 11,996 production rows/hour,
-- 79% background, 24% with no user id, ~12% staff/webhook traffic; ~8 GB request log + ~5 GB batch rows at 90 days).
--
-- WHAT THE DRAIN STORES FROM NOW ON (src/app/api/drains/heroku/[env]/route.ts):
--   · staff and webhook routes (/admin/*, /api/v1/admin/*, /stripe/webhook*)  → app_request_route_hourly, kind 'staff'
--   · a line with no user id                                                    → app_request_route_hourly, kind 'anonymous'
--   · a background route that succeeded (status < 400)                          → app_request_bg_hourly
--   · everything else, including every FAILED background request                → app_request_log (90 days, unchanged)
--   · each Heroku POST                                                          → app_request_log_batches (raw, 7 days)
--                                                                                 + app_request_batch_hourly
--
-- ONE TRANSACTION PER BATCH: app_request_log_ingest() records the batch keyed on (env, Logplex-Frame-Id) FIRST and
-- returns early if that frame was already processed, so a Heroku resend (same frame id) can never count a rollup
-- twice. Any error rolls back the whole batch, the route answers 503, and the resend applies it once.
--
-- Apply in the Supabase SQL editor BEFORE the code that calls the function is deployed. The rows already stored are
-- moved into the rollups by 0259, run AFTER that deploy is READY.

-- 1) Per-player hourly background rollup. The card's "last seen in the app" and folded background counts read it.
create table if not exists public.app_request_bg_hourly (
  env          text        not null check (env in ('production', 'staging')),
  user_id      bigint      not null,
  hour         timestamptz not null,
  bg_count     integer     not null,
  last_seen_at timestamptz not null,
  primary key (env, user_id, hour)
);
create index if not exists app_request_bg_hourly_hour_idx on public.app_request_bg_hourly (hour);

-- 2) Hourly route rollup for what is not stored as rows: anonymous lines and staff/webhook traffic.
--    `route` is the Nest route pattern; for an unmatched route (route null) the drain stores '(no route) ' plus the
--    path with every all-digit segment replaced by :n, so unserved app calls stay countable without player ids.
create table if not exists public.app_request_route_hourly (
  env     text        not null check (env in ('production', 'staging')),
  hour    timestamptz not null,
  kind    text        not null check (kind in ('anonymous', 'staff')),
  method  text        not null,
  route   text        not null,
  status  integer     not null,
  n       integer     not null,
  primary key (env, hour, kind, method, route, status)
);
create index if not exists app_request_route_hourly_hour_idx on public.app_request_route_hourly (hour);

-- 3) Hourly drain counts per env (by received hour).
create table if not exists public.app_request_batch_hourly (
  env                 text        not null check (env in ('production', 'staging')),
  hour                timestamptz not null,
  batches             integer     not null default 0,
  messages            integer     not null default 0,  -- sum of Logplex-Msg-Count
  parsed              integer     not null default 0,
  stored              integer     not null default 0,  -- rows inserted into app_request_log
  rolled_background   integer     not null default 0,
  rolled_anonymous    integer     not null default 0,
  rolled_staff        integer     not null default 0,
  dropped_not_app     integer     not null default 0,
  dropped_not_json    integer     not null default 0,
  dropped_wrong_shape integer     not null default 0,
  dropped_bad_frame   integer     not null default 0,
  dropped_unpinned    integer     not null default 0,
  primary key (env, hour)
);

alter table public.app_request_bg_hourly    enable row level security;
alter table public.app_request_route_hourly enable row level security;
alter table public.app_request_batch_hourly enable row level security;
revoke all on public.app_request_bg_hourly, public.app_request_route_hourly, public.app_request_batch_hourly
  from anon, authenticated;

-- 4) Batch dedupe key. Remove any repeated (env, frame_id) first, keeping the earliest row; the WHERE satisfies
--    pg_safeupdate. Expected to delete 0 rows: no batch has been answered with a non-2xx so far.
delete from public.app_request_log_batches a
  using public.app_request_log_batches b
  where a.env = b.env and a.frame_id = b.frame_id and a.id > b.id;
create unique index if not exists app_request_log_batches_env_frame_key
  on public.app_request_log_batches (env, frame_id) where frame_id is not null;

-- 5) The ingest function. Service role only.
create or replace function public.app_request_log_ingest(p jsonb)
returns jsonb
language plpgsql
set search_path = public
as $function$
declare
  v_env    text  := p->>'env';
  v_frame  text  := nullif(p->>'frame_id', '');
  v_drop   jsonb := coalesce(p->'dropped', '{}'::jsonb);
  v_batch  bigint;
  v_stored integer := 0;
begin
  if v_env is null or v_env not in ('production', 'staging') then
    raise exception 'app_request_log_ingest: bad env %', v_env;
  end if;

  insert into app_request_log_batches (env, frame_id, drain_token, msg_count, parsed, stored, dropped)
  values (v_env, v_frame, p->>'drain_token', (p->>'msg_count')::int, coalesce((p->>'parsed')::int, 0), 0, v_drop)
  on conflict (env, frame_id) where frame_id is not null do nothing
  returning id into v_batch;
  if v_batch is null then
    return jsonb_build_object('duplicate', true, 'stored', 0);
  end if;

  with ins as (
    insert into app_request_log (env, ts, req_id, method, path, route, status, duration_ms, user_id, error_code, ip, match_id)
    select v_env, r.ts, r.req_id, r.method, r.path, r.route, r.status, r.duration_ms, r.user_id, r.error_code, r.ip, r.match_id
    from jsonb_to_recordset(coalesce(p->'rows', '[]'::jsonb)) as r(
      ts timestamptz, req_id text, method text, path text, route text, status integer, duration_ms integer,
      user_id bigint, error_code text, ip text, match_id bigint)
    on conflict (env, req_id) do nothing
    returning 1)
  select count(*) into v_stored from ins;

  -- The drain aggregates each array so a key appears at most once per call (ON CONFLICT cannot touch a row twice).
  insert into app_request_bg_hourly as t (env, user_id, hour, bg_count, last_seen_at)
  select v_env, b.user_id, b.hour, b.n, b.last_seen_at
  from jsonb_to_recordset(coalesce(p->'bg', '[]'::jsonb)) as b(user_id bigint, hour timestamptz, n integer, last_seen_at timestamptz)
  on conflict (env, user_id, hour) do update
    set bg_count = t.bg_count + excluded.bg_count,
        last_seen_at = greatest(t.last_seen_at, excluded.last_seen_at);

  insert into app_request_route_hourly as t (env, hour, kind, method, route, status, n)
  select v_env, x.hour, x.kind, x.method, x.route, x.status, x.n
  from jsonb_to_recordset(coalesce(p->'routes', '[]'::jsonb)) as x(hour timestamptz, kind text, method text, route text, status integer, n integer)
  on conflict (env, hour, kind, method, route, status) do update set n = t.n + excluded.n;

  update app_request_log_batches set stored = v_stored where id = v_batch;

  insert into app_request_batch_hourly as t (env, hour, batches, messages, parsed, stored,
    rolled_background, rolled_anonymous, rolled_staff,
    dropped_not_app, dropped_not_json, dropped_wrong_shape, dropped_bad_frame, dropped_unpinned)
  values (v_env, date_trunc('hour', now()), 1, coalesce((p->>'msg_count')::int, 0), coalesce((p->>'parsed')::int, 0), v_stored,
    coalesce((p->>'rolled_background')::int, 0), coalesce((p->>'rolled_anonymous')::int, 0), coalesce((p->>'rolled_staff')::int, 0),
    coalesce((v_drop->>'not_app')::int, 0), coalesce((v_drop->>'not_json')::int, 0), coalesce((v_drop->>'wrong_shape')::int, 0),
    coalesce((v_drop->>'bad_frame')::int, 0), coalesce((v_drop->>'unpinned_drain_token')::int, 0))
  on conflict (env, hour) do update set
    batches = t.batches + 1, messages = t.messages + excluded.messages, parsed = t.parsed + excluded.parsed,
    stored = t.stored + excluded.stored,
    rolled_background = t.rolled_background + excluded.rolled_background,
    rolled_anonymous = t.rolled_anonymous + excluded.rolled_anonymous,
    rolled_staff = t.rolled_staff + excluded.rolled_staff,
    dropped_not_app = t.dropped_not_app + excluded.dropped_not_app,
    dropped_not_json = t.dropped_not_json + excluded.dropped_not_json,
    dropped_wrong_shape = t.dropped_wrong_shape + excluded.dropped_wrong_shape,
    dropped_bad_frame = t.dropped_bad_frame + excluded.dropped_bad_frame,
    dropped_unpinned = t.dropped_unpinned + excluded.dropped_unpinned;

  return jsonb_build_object('duplicate', false, 'stored', v_stored);
end
$function$;

revoke all on function public.app_request_log_ingest(jsonb) from public, anon, authenticated;
grant execute on function public.app_request_log_ingest(jsonb) to service_role;

-- 6) Backfill the hourly batch counts from the raw batch rows that exist now (raw rows are kept 7 days from here
--    on). Historic hours have no rolled_* split: everything then was stored as rows.
insert into public.app_request_batch_hourly (env, hour, batches, messages, parsed, stored,
  dropped_not_app, dropped_not_json, dropped_wrong_shape, dropped_bad_frame, dropped_unpinned)
select env, date_trunc('hour', received_at), count(*), coalesce(sum(msg_count), 0), sum(parsed), sum(stored),
  coalesce(sum((dropped->>'not_app')::int), 0), coalesce(sum((dropped->>'not_json')::int), 0),
  coalesce(sum((dropped->>'wrong_shape')::int), 0), coalesce(sum((dropped->>'bad_frame')::int), 0),
  coalesce(sum((dropped->>'unpinned_drain_token')::int), 0)
from public.app_request_log_batches
group by 1, 2
on conflict (env, hour) do nothing;

-- RETENTION (Vercel cron /api/sync/app-request-log-retention, daily, each DELETE with a WHERE on its timestamp):
--   app_request_log            90 days  (unchanged)
--   app_request_bg_hourly      90 days  (matches the rows it sits beside on the card)
--   app_request_log_batches     7 days  (was 90)
--   app_request_route_hourly  365 days
--   app_request_batch_hourly  365 days

-- ── VERDICT — one row ───────────────────────────────────────────────────────────────────────────
--   tables 3, rls_on 3, frame_key 1, fn 1, fn_anon_exec false, hourly_backfilled > 0
select
  (select count(*) from information_schema.tables where table_schema = 'public'
     and table_name in ('app_request_bg_hourly', 'app_request_route_hourly', 'app_request_batch_hourly'))       as tables,
  (select count(*) from pg_class where relname in ('app_request_bg_hourly', 'app_request_route_hourly',
     'app_request_batch_hourly') and relrowsecurity)                                                          as rls_on,
  (select count(*) from pg_indexes where indexname = 'app_request_log_batches_env_frame_key')                 as frame_key,
  (select count(*) from pg_proc where proname = 'app_request_log_ingest')                                     as fn,
  has_function_privilege('anon', 'public.app_request_log_ingest(jsonb)', 'execute')                           as fn_anon_exec,
  (select count(*) from public.app_request_batch_hourly)                                                      as hourly_backfilled;
