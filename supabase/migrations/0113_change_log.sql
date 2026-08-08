-- Phase 16 — the Change Log. Every production write Clubhouse makes is recorded here
-- by the shared write hook (src/lib/changeLog.ts recordWrite), one row per request.
-- The screen groups rows by save_id into one entry per save. Reads are never logged.
-- Denied keys are stripped before insert (a log is a second place a secret could leak).
--
-- Retention: NONE enforced yet — rows accumulate indefinitely. created_at is indexed so
-- a prune job (delete where created_at < now() - interval '180 days') can be added later
-- without a schema change. Stated, not left undecided (docs/matchday-api-facts.md).

create table if not exists change_log (
  id            uuid primary key default gen_random_uuid(),
  save_id       text        not null,            -- correlates the requests of one save
  created_at    timestamptz not null default now(),
  actor_name    text        not null default '', -- the Clubhouse user who saved
  actor_email   text,
  source        text        not null,            -- 'Gameday Ops' | 'Master Schedule' | 'Match editor' | 'Roster'
  env           text        not null,            -- 'production' | 'staging'
  match_id      bigint,
  match_name    text,
  method        text        not null,            -- PUT | POST | DELETE | PATCH
  endpoint      text        not null,            -- the API path
  request_body  jsonb       not null default '{}'::jsonb,  -- deny-key-stripped
  outcome       text        not null,            -- 'landed' | 'failed' | 'notapplied' | 'unknown'
  server_said   text,                            -- what the server returned on a failure
  changes       jsonb       not null default '[]'::jsonb,  -- [{key, field, before, after}]
  resolved      text,                            -- null | 'yes' | 'no' (a human's finding; never changes outcome)
  resolved_by   text,
  resolved_at   timestamptz,
  constraint change_log_outcome_chk check (outcome in ('landed','failed','notapplied','unknown')),
  constraint change_log_resolved_chk check (resolved is null or resolved in ('yes','no'))
);

create index if not exists change_log_created_idx on change_log (created_at desc);
create index if not exists change_log_save_idx on change_log (save_id);
create index if not exists change_log_open_idx on change_log (created_at desc) where outcome in ('unknown','notapplied') and resolved is null;

-- Writes come only from the service-role hook; the screen reads via a guarded admin
-- route. RLS on, no policies for anon/authenticated (service role bypasses RLS).
alter table change_log enable row level security;
