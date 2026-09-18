-- 0187 — two decisions made permanent: how install restatement gets MEASURED, and
-- which maturity basis the incrementality estimator is allowed to use.
--
-- ══ 1. reported_at CANNOT ANSWER THE QUESTION IT WAS ADDED FOR ═══════════════
--
-- 0184 gave fin_meta_adset_daily `reported_at timestamptz default now()`, with the
-- stated purpose of making install restatement measurable rather than assumed
-- from the attribution spec. IT CANNOT DO THAT, and the flaw is mine.
--
-- The sync UPSERTS on (spend_date, ad_account_id, adset_id). A column in the
-- upsert payload is overwritten on every run, so reported_at would only ever say
-- when we LAST asked. Omitting it from the payload freezes it at first insert,
-- which gives a first-seen TIMESTAMP but still no first-seen VALUE — and
-- restatement is a change in the value. Either way a single mutable row cannot
-- hold a history of itself.
--
-- So: an APPEND-ONLY observation log, written only when the number MOVES. The
-- first sighting of a (day, ad set) is always recorded; after that a row appears
-- only if installs differ from the last recorded value. On a stable series that
-- is one row per day per ad set forever, roughly 250 rows for a 28-day window at
-- seven active ad sets, and the restatement curve falls straight out of it.
--
-- WHY IT IS NOT A TRIGGER ON THE MAIN TABLE. A trigger preserving OLD values
-- would give first-vs-now and nothing between. The attribution spec says installs
-- settle in ONE DAY; that claim has never been tested against data, and "it moved
-- by 3" and "it moved by 3 over six days in four steps" are different answers.
-- This table can tell them apart. It is also a pure INSERT, so no upsert
-- semantics have to be reasoned about.
--
-- ══ 2. MATCHED MATURITY, AND became_players IS REMOVED ══════════════════════
--
-- The same experiment read two ways on 2026-09-18 gave incremental 27.1
-- (became_players) and 17.5 (played_within_7d). A 55% fork that resolves by
-- whichever query someone happens to run is not a metric, so one of them goes.
--
-- WHAT DECIDED IT. An incrementality estimator needs the baseline and the period
-- to MEASURE THE SAME THING; it does not need either of them to be complete.
--
--   became_players    counts everyone who ever played, so it is complete and
--                     INCOMPARABLE ACROSS AGES: a settled baseline is matched
--                     against a period that is still filling, and the two
--                     censoring errors run in OPPOSITE directions — a censored
--                     treatment understates the incremental, a censored control
--                     understates the counterfactual and so overstates it. The
--                     same experiment gives a different answer every day, and
--                     nothing on screen says which day was right.
--
--   played_within_7d  gives every signup on both sides exactly seven days. A
--                     signup on day D is FULLY DETERMINED on D+7, so with the
--                     period cut at today-7 both windows are closed and the
--                     ratio is stable from the moment each day matures.
--
-- WHY SEVEN DAYS. Measured on settled cohorts — Jun-Jul 2026 signups in the seven
-- paid markets, 3,716 registrations, 1,886 who ever played:
--
--     1d  71.2% of eventual players      14d  91.5%
--     3d  80.7%                          30d  96.1%
--     7d  87.2%                          60d  98.8%
--
-- Seven days holds 87.2%. Fourteen buys 4.3 points and costs another week of lag
-- on every read; thirty buys 8.9 and costs a month. And the 12.8% seven days
-- misses is missed IDENTICALLY on both sides, so it cancels in the ratio — which
-- is the only thing the estimator consumes.
--
-- THE ROW IS UPDATED BEFORE THE CHECK IS TIGHTENED. Adding a CHECK validates
-- existing rows, and experiment 12 currently carries 'became_players'.
--
-- Apply via Supabase Dashboard -> SQL Editor -> paste & run.

-- ── 1. the observation log ───────────────────────────────────────────────────
create table if not exists public.fin_meta_install_observations (
  spend_date    date        not null,
  ad_account_id text        not null,
  adset_id      text        not null,
  -- The instant we asked. Part of the key: two observations of one day are the
  -- whole point, so this table must never collapse them.
  observed_at   timestamptz not null default now(),
  installs      integer     not null,
  -- Carried so a restatement can be read against what was spent, without a join
  -- back to a row that has since moved.
  spend_cents   integer,
  primary key (spend_date, ad_account_id, adset_id, observed_at)
);

alter table public.fin_meta_install_observations
  drop constraint if exists fin_meta_install_observations_nonneg;
alter table public.fin_meta_install_observations add constraint fin_meta_install_observations_nonneg
  check (installs >= 0 and (spend_cents is null or spend_cents >= 0));

-- Same floor as the table it observes.
alter table public.fin_meta_install_observations
  drop constraint if exists fin_meta_install_observations_floor;
alter table public.fin_meta_install_observations add constraint fin_meta_install_observations_floor
  check (spend_date >= date '2026-08-01');

create index if not exists fin_meta_install_observations_key_idx
  on public.fin_meta_install_observations (spend_date, adset_id, observed_at);

revoke all on public.fin_meta_install_observations from anon, authenticated;
grant select on public.fin_meta_install_observations to service_role;

-- ── 2. the metric allowlist ──────────────────────────────────────────────────
-- UPDATE FIRST. The CHECK below validates existing rows and experiment 12 holds
-- 'became_players'; tightening before updating would refuse its own table.
update public.fin_growth_experiment
   set metric = 'played_within_7d'
 where metric = 'became_players';

alter table public.fin_growth_experiment
  drop constraint if exists fin_growth_experiment_metric_known;
-- became_players IS GONE, NOT DEPRECATED. A value the CHECK still accepts is a
-- value somebody will set, and the whole point is that the fork cannot be
-- reopened by a query. 'registrations' stays: it is a different question
-- (top of funnel), not the ambiguity being closed.
alter table public.fin_growth_experiment add constraint fin_growth_experiment_metric_known
  check (metric in ('played_within_7d', 'registrations'));

-- ── VERDICT. Exercised, not described. Probes roll back. ────────────────────
do $$
begin
  insert into public.fin_growth_experiment
    (name, control_market, treatment_markets, baseline_start, baseline_end, period_start, metric)
  values ('__probe187__', 'OKC', array['ATL'], date '2026-08-12', date '2026-09-08', date '2026-09-09', 'became_players');
  raise exception 'became_players IS STILL ACCEPTED';
exception when check_violation then null;
end $$;

do $$
begin
  insert into public.fin_growth_experiment
    (name, control_market, treatment_markets, baseline_start, baseline_end, period_start, metric)
  values ('__probe187__', 'OKC', array['ATL'], date '2026-08-12', date '2026-09-08', date '2026-09-09', 'played_within_7d');
  delete from public.fin_growth_experiment where name = '__probe187__';
exception when check_violation then
  raise exception 'played_within_7d WAS REFUSED';
end $$;

-- Two observations of ONE (day, ad set) must BOTH survive. If this table ever
-- collapses them it cannot measure anything.
do $$
begin
  insert into public.fin_meta_install_observations
    (spend_date, ad_account_id, adset_id, observed_at, installs)
  values (date '2026-08-01', '__probe187__', 'p', now() - interval '1 day', 5),
         (date '2026-08-01', '__probe187__', 'p', now(),                    8);
  if (select count(*) from public.fin_meta_install_observations where ad_account_id = '__probe187__') <> 2 then
    raise exception 'TWO OBSERVATIONS OF ONE DAY DID NOT BOTH SURVIVE';
  end if;
  delete from public.fin_meta_install_observations where ad_account_id = '__probe187__';
end $$;

do $$
begin
  insert into public.fin_meta_install_observations
    (spend_date, ad_account_id, adset_id, installs)
  values (date '2026-07-31', '__probe187__', 'p', 1);
  raise exception 'THE OBSERVATION FLOOR DID NOT HOLD';
exception when check_violation then null;
end $$;

select
  (to_regclass('public.fin_meta_install_observations') is not null)          as observations_table_exists,
  true                                                                       as two_observations_of_one_day_survive,
  true                                                                       as observation_floor_holds,
  true                                                                       as became_players_refused,
  true                                                                       as played_within_7d_accepted,
  (select count(*) from public.fin_meta_install_observations)                as observation_rows_should_be_zero,
  (select count(*) from public.fin_growth_experiment where name like '__probe%') as probe_rows_left,
  (select count(*) from public.fin_growth_experiment where metric = 'became_players') as stale_metric_rows_should_be_zero,
  (select metric from public.fin_growth_experiment where id = 12)            as experiment_12_metric;
