-- 0149 — allow the daily FULL users re-sync to log under its own source.
--
-- WHY A SEPARATE SOURCE. `mdapi-users` is the incremental walk: ~150 rows a day, new signups only.
-- The full re-sync touches ~30,700 and exists for a different reason (catching EDITS to rows older
-- than the watermark, which the incremental walk cannot see). Logged under one name, Recent Syncs
-- would show two rows a day whose row counts differ by two orders of magnitude with nothing saying
-- why, and a 30,700-row line would read as a runaway rather than as the design.
--
-- THIS MIGRATION MUST LAND BEFORE THE CODE THAT USES IT — the standing rule, and here it has teeth:
-- runWithLog inserts the log row FIRST and returns { ok:false } WITHOUT RUNNING THE SYNC if the
-- insert is rejected. So an unapplied migration means the re-sync silently does nothing at all
-- rather than running unlogged. The route surfaces that error rather than swallowing it, but the
-- run still would not happen.
--
-- Rewrites the whole list because a CHECK cannot be appended to. Copied forward from 0106 with one
-- value added; if you are reading this in a later migration, copy THIS list, not 0106's.

alter table public.fin_sync_log
  drop constraint if exists fin_sync_log_source_check;

alter table public.fin_sync_log add constraint fin_sync_log_source_check
  CHECK (source IN (
    'stripe-api','mdapi-reviews','mdapi-subscriptions','mdapi-promocodes','mdapi-matches',
    'mdapi-users','mdapi-users-full','mdapi-users-lens-snapshot','membership-snapshots',
    'membership-prices','manager-pay-recompute','firstmatch-ledger','telnyx-sms','play-installs',
    'app-store-installs','google-calendar'
  ));

-- VERDICT ROW. `accepts_new_source` must be true; the insert is rolled back either way so this
-- leaves nothing behind in Recent Syncs.
do $$
begin
  insert into public.fin_sync_log (source, triggered_by, started_at)
  values ('mdapi-users-full', 'manual', now());
  raise notice 'mdapi-users-full accepted';
  raise exception 'rollback probe';
exception
  when check_violation then raise exception 'MIGRATION DID NOT TAKE: mdapi-users-full still rejected';
  when others then
    if sqlerrm <> 'rollback probe' then raise; end if;
end $$;

select
  (select count(*) from pg_constraint
    where conname = 'fin_sync_log_source_check'
      and pg_get_constraintdef(oid) like '%mdapi-users-full%') = 1 as accepts_new_source,
  (select count(*) from public.fin_sync_log where source = 'mdapi-users-full') as rows_left_behind;
