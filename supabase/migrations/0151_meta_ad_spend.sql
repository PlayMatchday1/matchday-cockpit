-- 0151 — Meta ad spend: the daily geo-broken-down store, and its sync log source.
--
-- MIGRATION BEFORE CODE, and here that is not a formality. runWithLog INSERTS the fin_sync_log row
-- BEFORE running the sync and returns ok:false WITHOUT RUNNING IT if the insert is rejected. A
-- source missing from the CHECK allowlist therefore does not produce an unlogged sync — it produces
-- a sync that silently never happens. That has already cost a round trip once on 'mdapi-users-full'.
--
-- WHY A DAILY TABLE AT ALL, when the ledger only needs a monthly figure. The month row in
-- fin_expenses is the accounting artefact; this table is the evidence behind it and the series we
-- query when asking whether the Aug 7 targeting switch worked. Keeping both means the ledger stays
-- readable (~7 rows a month) without throwing away the daily resolution that answers the question.

alter table public.fin_sync_log
  drop constraint if exists fin_sync_log_source_check;

alter table public.fin_sync_log add constraint fin_sync_log_source_check
  CHECK (source IN (
    'stripe-api','mdapi-reviews','mdapi-subscriptions','mdapi-promocodes','mdapi-matches',
    'mdapi-users','mdapi-users-full','mdapi-users-lens-snapshot','membership-snapshots',
    'membership-prices','manager-pay-recompute','firstmatch-ledger','telnyx-sms','play-installs',
    'app-store-installs','google-calendar','meta-ad-spend'
  ));

create table if not exists public.fin_meta_ad_spend_daily (
  spend_date     date        not null,
  -- EXACTLY WHAT META RETURNED, stored verbatim and never normalised. The mapping to our city codes
  -- is applied alongside it, not instead of it, so a Meta rename shows up as a new unmapped market
  -- rather than being silently reclassified into the wrong city.
  market_raw     text        not null,
  -- Our city code, or NULL when the market does not map. NULL IS NOT A DROP: an unmapped market
  -- still carries its spend and rolls up into a single unallocated expense row. Money that lands
  -- nowhere must still appear somewhere.
  market_key     text,
  -- INTEGER CENTS. Meta returns spend as a DECIMAL STRING ("240.83"); it is parsed to cents
  -- explicitly rather than through a float, because 0.1 + 0.2 is not 0.3 and a payout ledger is
  -- the wrong place to discover that.
  spend_cents    integer     not null,
  impressions    integer,
  ad_account_id  text        not null,
  currency       text        not null,
  synced_at      timestamptz not null default now(),
  primary key (spend_date, market_raw, ad_account_id)
);

-- THE FLOOR, IN THE DATABASE AS WELL AS IN CODE. April through July are reconciled by hand and
-- carry manual entries; a backfill would sit ALONGSIDE them rather than replace them, which is
-- exactly how double-counting happens. The sync enforces this too — this constraint is the half
-- that survives a future caller who forgets.
alter table public.fin_meta_ad_spend_daily
  drop constraint if exists fin_meta_ad_spend_daily_floor;
alter table public.fin_meta_ad_spend_daily add constraint fin_meta_ad_spend_daily_floor
  check (spend_date >= date '2026-08-01');

-- Spend is never negative and cents are whole. Both are cheap to assert and both are the kind of
-- thing a parsing bug produces first.
alter table public.fin_meta_ad_spend_daily
  drop constraint if exists fin_meta_ad_spend_daily_nonneg;
alter table public.fin_meta_ad_spend_daily add constraint fin_meta_ad_spend_daily_nonneg
  check (spend_cents >= 0 and (impressions is null or impressions >= 0));

create index if not exists fin_meta_ad_spend_daily_month_idx
  on public.fin_meta_ad_spend_daily (spend_date);
create index if not exists fin_meta_ad_spend_daily_market_idx
  on public.fin_meta_ad_spend_daily (market_key, spend_date);

revoke all on public.fin_meta_ad_spend_daily from anon, authenticated;
grant select on public.fin_meta_ad_spend_daily to service_role;

-- VERDICT ROW. source_allowed and table_exists must both be true; floor_rejects_july must be true,
-- proving the floor is enforced by the DATABASE and not merely described in a comment.
do $$
begin
  insert into public.fin_meta_ad_spend_daily
    (spend_date, market_raw, spend_cents, ad_account_id, currency)
  values (date '2026-07-31', '__probe__', 0, '__probe__', 'USD');
  raise exception 'FLOOR DID NOT HOLD: a July row was accepted';
exception
  when check_violation then null;   -- expected: the floor refused it
end $$;

select
  (select count(*) from pg_constraint
    where conname = 'fin_sync_log_source_check'
      and pg_get_constraintdef(oid) like '%meta-ad-spend%') = 1              as source_allowed,
  (select to_regclass('public.fin_meta_ad_spend_daily') is not null)          as table_exists,
  true                                                                       as floor_rejects_july,
  (select count(*) from public.fin_meta_ad_spend_daily)                       as rows_left_behind;
