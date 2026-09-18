-- 0184 — Meta at campaign and ad set grain. TWO fact tables, because Meta will not
-- serve both dimensions on one row.
--
-- ── THE MEASUREMENT THAT DECIDED THE SHAPE (2026-09-18, live account) ────────
-- `comscore_market` SUPPRESSES app-install actions entirely. Nine dimension
-- combinations over Sep 1-17:
--
--   account, whole period, no breakdown          installs 766
--   account, DAILY, no breakdown                 installs 766
--   CAMPAIGN, whole period, no breakdown         installs 766
--   ADSET, whole period, no breakdown            installs 766
--   ADSET, DAILY, no breakdown                   installs 766
--   account, whole period, country breakdown     installs 766
--   account, whole period, region breakdown      installs 766
--   account, whole period, comscore breakdown    installs   0   <-
--   ADSET,   whole period, comscore breakdown    installs   0   <-
--
-- The comscore rows are NOT empty — 67 and 121 of them carry link clicks and
-- video views. Installs specifically are withheld. So one table holds geography
-- and no installs, the other holds installs and no geography, and installs reach
-- a market through fin_meta_adset.market_key. There is no schema that gets both
-- on one row, and a table pretending otherwise would be a column of zeroes.
--
-- ── fin_meta_ad_spend_daily IS NOT TOUCHED ───────────────────────────────────
-- It is the account x market series the expenses ledger projects from. It
-- reconciles to Meta's account totals at $0.12 across Aug-Sep 2026 with every
-- single day inside two cents, and its unallocated rows exist because
-- reconcileDay pins each day to the ACCOUNT total. Ad-set rows cannot do that —
-- Meta withholds low-volume breakdown rows — so the two grains stay separate
-- objects rather than one table with a changed primary key.
--
-- ── THE FLOOR IS AUGUST, NOT DECEMBER ────────────────────────────────────────
-- The campaign and ad set structure was REBUILT in August 2026: eight months of
-- `ATL - Eng - Feb Advantage+` became `MD / Multiple Locations / App Promotion`,
-- and the market code in the name went from 100% of spend to 28.5%. Pre-August
-- campaign rows describe a structure that no longer exists. The spend history
-- back to 2025-12-01 is already in fin_meta_ad_spend_daily and is not lost.
--
-- NO NEW fin_sync_log SOURCE. This rides the existing 'meta-ad-spend' run, so
-- the CHECK allowlist is unchanged. A separate job would need its own migration
-- first, for the reason 0151's header records.
--
-- Apply via Supabase Dashboard -> SQL Editor -> paste & run.

-- ── the ad set dimension ─────────────────────────────────────────────────────
create table if not exists public.fin_meta_adset (
  ad_account_id     text not null,
  adset_id          text not null,
  campaign_id       text not null,
  -- A HISTORICAL LABEL, NEVER A KEY. The naming convention held at 100% of
  -- spend for eight months and fell to 28.5% in six weeks when the account was
  -- rebuilt. Names are kept so an old chart can be read; nothing is derived
  -- from them, ever.
  adset_name        text,
  campaign_name     text,
  optimization_goal text,
  -- STORED, NOT ASSUMED. Every ACTIVE ad set today is
  -- [{"event_type":"CLICK_THROUGH","window_days":1}] (one also carries 1-day
  -- VIEW_THROUGH and ENGAGED_VIDEO_VIEW). This is what decides how long an
  -- install can restate, so it is read from the API on every run and a change
  -- by the agency is visible here instead of being inferred from drift.
  attribution_spec  jsonb,
  -- THE PARENT MARKET, DERIVED FROM DELIVERY AND NEVER FROM THE NAME. Dominant
  -- served comscore market over the ad set's LIFETIME, voting on NAMED markets
  -- only. Measured over all 58 ad sets: 56 resolve to a city, dominant share of
  -- named spend min 80.1%, p10 98.1%, median 100.0%. The two that do not are
  -- both El Paso, a market we ran in and deliberately do not map.
  --
  -- UNKNOWN IS EXCLUDED FROM THE VOTE, NEVER FROM THE MONEY. This is the detail
  -- that makes the rule survive what actually happened: during the geo-automation
  -- episode the HTX ad set was only 58.3% NAMED overall, which defeats a naive
  -- majority test, but 98.6% of its NAMED spend was Houston.
  market_key        text,
  market_raw        text,
  market_confidence numeric(5,4),
  -- 'derived' today. A column rather than an assumption, so a future manual
  -- override is a visible row and not a fork in the code.
  market_method     text not null default 'derived',
  first_seen        date,
  last_seen         date,
  computed_at       timestamptz not null default now(),
  primary key (ad_account_id, adset_id)
);

-- ── GEOGRAPHY. No installs — see the header. ─────────────────────────────────
create table if not exists public.fin_meta_adset_market_daily (
  spend_date    date        not null,
  ad_account_id text        not null,
  adset_id      text        not null,
  campaign_id   text        not null,
  -- Verbatim from Meta and never normalised, same rule as fin_meta_ad_spend_daily:
  -- a rename must surface as a new unmapped market, not reclassify itself into
  -- the nearest-looking city.
  market_raw    text        not null,
  market_key    text,
  spend_cents   integer     not null,
  impressions   integer,
  clicks        integer,
  synced_at     timestamptz not null default now(),
  primary key (spend_date, ad_account_id, adset_id, market_raw)
);

-- ── INSTALLS. No geography. ──────────────────────────────────────────────────
create table if not exists public.fin_meta_adset_daily (
  spend_date       date        not null,
  ad_account_id    text        not null,
  adset_id         text        not null,
  campaign_id      text        not null,
  spend_cents      integer     not null,
  impressions      integer,
  clicks           integer,
  -- REACH IS DE-DUPLICATED AND MUST NOT BE SUMMED across days, ad sets or
  -- markets — the same person reached on two days is one reach at the account
  -- and two here. Stored at the grain it was fetched at and only ever read at
  -- that grain; anything that adds this column up is wrong.
  reach            integer,
  installs         integer,
  -- Meta's `complete_registration` action. NOT our registration count, which
  -- comes from mdapi_users — kept so the two can be compared rather than
  -- conflated.
  registrations    integer,
  -- WHAT META SAID ON THE DAY WE ASKED. Installs have never been stored, so
  -- their restatement has never been measured and cannot be, retrospectively.
  -- This column is what makes the first measurement possible in two weeks.
  reported_at      timestamptz not null default now(),
  primary key (spend_date, ad_account_id, adset_id)
);

-- ── floors ───────────────────────────────────────────────────────────────────
alter table public.fin_meta_adset_market_daily
  drop constraint if exists fin_meta_adset_market_daily_floor;
alter table public.fin_meta_adset_market_daily add constraint fin_meta_adset_market_daily_floor
  check (spend_date >= date '2026-08-01');

alter table public.fin_meta_adset_daily
  drop constraint if exists fin_meta_adset_daily_floor;
alter table public.fin_meta_adset_daily add constraint fin_meta_adset_daily_floor
  check (spend_date >= date '2026-08-01');

-- ── spend is never negative and counts are whole ─────────────────────────────
alter table public.fin_meta_adset_market_daily
  drop constraint if exists fin_meta_adset_market_daily_nonneg;
alter table public.fin_meta_adset_market_daily add constraint fin_meta_adset_market_daily_nonneg
  check (spend_cents >= 0
     and (impressions is null or impressions >= 0)
     and (clicks is null or clicks >= 0));

alter table public.fin_meta_adset_daily
  drop constraint if exists fin_meta_adset_daily_nonneg;
alter table public.fin_meta_adset_daily add constraint fin_meta_adset_daily_nonneg
  check (spend_cents >= 0
     and (impressions is null or impressions >= 0)
     and (clicks is null or clicks >= 0)
     and (reach is null or reach >= 0)
     and (installs is null or installs >= 0)
     and (registrations is null or registrations >= 0));

-- market_confidence is a share, so it cannot exceed 1. A value above it means the
-- denominator excluded something it should not have.
alter table public.fin_meta_adset
  drop constraint if exists fin_meta_adset_confidence_range;
alter table public.fin_meta_adset add constraint fin_meta_adset_confidence_range
  check (market_confidence is null or (market_confidence >= 0 and market_confidence <= 1));

create index if not exists fin_meta_adset_market_daily_date_idx
  on public.fin_meta_adset_market_daily (spend_date);
create index if not exists fin_meta_adset_market_daily_mk_idx
  on public.fin_meta_adset_market_daily (market_key, spend_date);
create index if not exists fin_meta_adset_daily_date_idx
  on public.fin_meta_adset_daily (spend_date);
create index if not exists fin_meta_adset_daily_adset_idx
  on public.fin_meta_adset_daily (adset_id, spend_date);

revoke all on public.fin_meta_adset               from anon, authenticated;
revoke all on public.fin_meta_adset_market_daily  from anon, authenticated;
revoke all on public.fin_meta_adset_daily         from anon, authenticated;
grant select on public.fin_meta_adset              to service_role;
grant select on public.fin_meta_adset_market_daily to service_role;
grant select on public.fin_meta_adset_daily        to service_role;

-- ── VERDICT. The floors are exercised, not described. Both probes roll back. ──
do $$
begin
  insert into public.fin_meta_adset_market_daily
    (spend_date, ad_account_id, adset_id, campaign_id, market_raw, spend_cents)
  values (date '2026-07-31', '__probe__', '__probe__', '__probe__', '__probe__', 0);
  raise exception 'FLOOR DID NOT HOLD: a July row was accepted into fin_meta_adset_market_daily';
exception when check_violation then null;
end $$;

do $$
begin
  insert into public.fin_meta_adset_daily
    (spend_date, ad_account_id, adset_id, campaign_id, spend_cents)
  values (date '2026-07-31', '__probe__', '__probe__', '__probe__', 0);
  raise exception 'FLOOR DID NOT HOLD: a July row was accepted into fin_meta_adset_daily';
exception when check_violation then null;
end $$;

-- August MUST be accepted — proving the floor is a boundary and not a blanket refusal.
do $$
begin
  insert into public.fin_meta_adset_daily
    (spend_date, ad_account_id, adset_id, campaign_id, spend_cents)
  values (date '2026-08-01', '__probe__', '__probe__', '__probe__', 0);
  delete from public.fin_meta_adset_daily where ad_account_id = '__probe__';
exception when check_violation then
  raise exception 'FLOOR TOO HIGH: 2026-08-01 was refused';
end $$;

select
  (to_regclass('public.fin_meta_adset')              is not null) as dim_table_exists,
  (to_regclass('public.fin_meta_adset_market_daily') is not null) as geo_table_exists,
  (to_regclass('public.fin_meta_adset_daily')        is not null) as install_table_exists,
  true                                                            as floors_reject_july,
  true                                                            as floors_accept_august,
  (select count(*) from public.fin_meta_adset_daily
     where ad_account_id = '__probe__')                           as probe_rows_left,
  -- fin_meta_ad_spend_daily is untouched by this migration. Both figures are
  -- printed so the next reader can see that rather than take it on trust.
  (select count(*) from public.fin_meta_ad_spend_daily)           as old_table_rowcount_untouched,
  (select coalesce(sum(spend_cents), 0) / 100.0
     from public.fin_meta_ad_spend_daily
     where spend_date >= date '2026-08-01'
       and spend_date <  date '2026-09-01')                       as old_table_august_untouched;
