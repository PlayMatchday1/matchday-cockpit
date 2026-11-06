-- 0257 — APP ACTIVITY: the player app's API request log, and the VIEW ACTIVITY permission.
--
-- The backend writes one JSON line per request to stdout (backend fix/request-logging,
-- core/request-logger/request-log.ts). Heroku delivers those lines to an HTTPS log drain at
-- /api/drains/heroku/{staging|production} (src/app/api/drains/heroku/[env]/route.ts), which keeps
-- only lines that parse as that shape and inserts them here. Nothing else is stored: router lines,
-- Nest log lines and anything malformed are dropped and COUNTED in app_request_log_batches.
--
-- No bodies, headers, queries or secrets ever reach this table. `ip` is the player's IP and is
-- shown to admins only (src/app/api/lookup/[env]/activity/route.ts).
--
-- Apply in the Supabase SQL editor. Lands BEFORE the code that reads it.

-- 1) The lines.
create table if not exists public.app_request_log (
  id           bigint generated always as identity primary key,
  env          text        not null check (env in ('production', 'staging')),
  ts           timestamptz not null,
  req_id       text        not null,
  method       text        not null,
  path         text        not null,
  route        text,
  status       integer     not null,
  duration_ms  integer     not null,
  user_id      bigint,
  error_code   text,
  ip           text,
  match_id     bigint,                     -- backend adds "matchId" separately; null until then
  received_at  timestamptz not null default now()
);

-- A resent batch (same Logplex-Frame-Id) carries the same X-Request-ID values, so this makes a
-- resend a no-op: the drain inserts with ON CONFLICT DO NOTHING.
create unique index if not exists app_request_log_env_req_id_key on public.app_request_log (env, req_id);
create index if not exists app_request_log_user_ts_idx on public.app_request_log (user_id, ts desc);
create index if not exists app_request_log_ts_idx on public.app_request_log (ts);

-- 2) One row per drain POST: what arrived, what was kept, and why the rest was dropped.
--    This is where "dropped and counted" lives, and where rows per hour are measured.
create table if not exists public.app_request_log_batches (
  id           bigint generated always as identity primary key,
  env          text        not null check (env in ('production', 'staging')),
  received_at  timestamptz not null default now(),
  frame_id     text,
  drain_token  text,                       -- Logplex-Drain-Token (an identifier, not a secret)
  msg_count    integer,                    -- Logplex-Msg-Count as Heroku sent it
  parsed       integer     not null,       -- frames found in the body
  stored       integer     not null,       -- inserted (a resent line counts 0)
  dropped      jsonb       not null default '{}'::jsonb   -- { reason: count }
);
create index if not exists app_request_log_batches_received_idx on public.app_request_log_batches (received_at);

-- Service role only. No policy = no access for anon or authenticated; the routes read and write
-- with the service role after their own gate.
alter table public.app_request_log enable row level security;
alter table public.app_request_log_batches enable row level security;
revoke all on public.app_request_log, public.app_request_log_batches from anon, authenticated;

-- 3) VIEW ACTIVITY. Off for every row, Ryan included, until the grant below.
alter table public.app_users
  add column if not exists can_view_activity boolean not null default false;

comment on column public.app_users.can_view_activity is
  'VIEW ACTIVITY. See a player''s app activity (API request log) on Player Lookup and in Player
   Chats. Read only. Not implied by can_access_matchops; a service account or city manager can
   never hold it (app_users_view_activity_guard, 0257).';

-- 4) The guard. A NEW function and a NEW trigger, deliberately: app_users_edit_matches_guard is
--    NOT replaced, because its live body cannot be read from here and a whole-body replace from an
--    old migration is how 0122 dropped 0120's term. This one only knows about its own column.
--    Keyed on is_service_account, which 0116 set from EMAIL.
create or replace function public.app_users_view_activity_guard()
returns trigger
language plpgsql
as $function$
begin
  if NEW.can_view_activity = true and NEW.is_service_account = true then
    raise exception 'Service account (%) cannot hold VIEW ACTIVITY', NEW.email;
  end if;
  if NEW.can_view_activity = true and NEW.is_city_manager = true then
    raise exception 'City manager (%) cannot hold VIEW ACTIVITY', NEW.email;
  end if;
  return NEW;
end $function$;

drop trigger if exists app_users_view_activity_guard_trg on public.app_users;
create trigger app_users_view_activity_guard_trg
  before insert or update on public.app_users
  for each row execute function public.app_users_view_activity_guard();

-- 5) GRANT to Ryan only. The WHERE satisfies pg_safeupdate.
update public.app_users set can_view_activity = true
  where email = 'rmancuso@playmatchday.com';

-- ── VERDICT — one query, one row ────────────────────────────────────────────────────────────
--   log_table 1, batch_table 1, indexes 3, rls_on 2, guard_trg 1, holders 1, e2e_blocked 1
select
  (select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'app_request_log')         as log_table,
  (select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'app_request_log_batches') as batch_table,
  (select count(*) from pg_indexes where schemaname = 'public' and indexname in
     ('app_request_log_env_req_id_key', 'app_request_log_user_ts_idx', 'app_request_log_ts_idx'))                           as indexes,
  (select count(*) from pg_class where relname in ('app_request_log', 'app_request_log_batches') and relrowsecurity)          as rls_on,
  (select count(*) from pg_trigger where tgname = 'app_users_view_activity_guard_trg')                                        as guard_trg,
  (select count(*) from public.app_users where can_view_activity = true)                                                      as holders,
  (select count(*) from public.app_users
     where email = 'clubhouse-e2e@playmatchday.com' and is_service_account = true)                                            as e2e_blocked;

-- P0001 PROOF — run separately; it MUST raise
--   'Service account (clubhouse-e2e@playmatchday.com) cannot hold VIEW ACTIVITY'.
--   update public.app_users set can_view_activity = true
--     where email = 'clubhouse-e2e@playmatchday.com';

-- REVOKE — the WHERE is required (pg_safeupdate).
--   update public.app_users set can_view_activity = false where can_view_activity = true;

-- RETENTION is not here. A Vercel cron (/api/sync/app-request-log-retention, daily) deletes
-- app_request_log rows with ts older than 90 days and batch rows older than 90 days, each with a
-- WHERE on the timestamp. pg_cron's state on this project cannot be verified from the repo; the
-- Vercel cron is in vercel.json and its runs are visible.
