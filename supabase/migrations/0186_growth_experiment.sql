-- 0186 — the incrementality experiment definition. A TABLE OF PERIODS, not a setting.
--
-- ── WHY NOT A fin_config KEY ─────────────────────────────────────────────────
-- The control market will change. The moment it does, every incrementality
-- figure computed under the old control becomes unreproducible unless the
-- control that was IN FORCE is recorded against the period it governed. A
-- key/value row holds the current answer and destroys the previous one, so a
-- chart of last quarter's incremental CAC would silently re-compute itself
-- against a market that was not the control at the time.
--
-- ── WHAT IS STORED, AND WHAT DELIBERATELY IS NOT ─────────────────────────────
-- The DEFINITION is stored. The RESULTS are not, and that is a decision rather
-- than an omission. The maths is:
--
--   baseline_ratio  = treatment(baseline) / control(baseline)
--   counterfactual  = control(period) * baseline_ratio
--   incremental     = actual(period) - counterfactual
--   naive_cac       = spend(period) / actual(period)
--   incremental_cac = spend(period) / incremental
--
-- Every input restates: became_players matures for weeks after a signup, Meta
-- revises spend, and growth_player_profile refreshes nightly. A stored result
-- would start disagreeing with a recomputation within a day, and a number that
-- disagrees with its own formula is worse than no number. It is cheap to
-- compute on read.
--
-- If a figure has to be QUOTED to someone outside the building, that is a
-- deliberate snapshot and a separate table — the members_monthly_snapshots
-- precedent, frozen history kept on purpose even though it now disagrees with
-- the live pages. It is not this table, and it is not a cache.
--
-- ── incremental_cac IS UNDEFINED WHEN incremental <= 0 ──────────────────────
-- A treatment market that underperformed its counterfactual has no cost per
-- incremental player, and dividing by a negative produces a confident negative
-- CAC. The read path must render that as "no incremental lift", never a number.
-- There is no constraint here that can enforce it; it is stated so the next
-- person writing the divisor has read it.
--
-- ── A CHECK CONSTRAINT PASSES ON NULL, AND THAT COST THIS FILE A ROUND TRIP ──
-- The first version guarded the treatment set with `array_length(arr, 1) >= 1`.
-- array_length returns NULL for an empty array, and a CHECK only fails on FALSE,
-- so NULL >= 1 was accepted and an empty treatment set was allowed. The verdict
-- block below caught it on the first run — "AN EMPTY TREATMENT SET WAS ACCEPTED"
-- — and the whole transaction rolled back, so nothing was created.
--
-- That is the reason every guard here is EXERCISED rather than described. A
-- constraint that is written down and never fired is a constraint nobody knows
-- is broken, and this one was broken in the direction that looks fine: an empty
-- array yields an incremental of the full actual, i.e. a perfect-looking result.
--
-- NO ROWS ARE SEEDED. The first experiment is inserted deliberately, with real
-- baseline dates chosen by a person. A migration that invents a baseline window
-- is a migration that invents a result.
--
-- Apply via Supabase Dashboard -> SQL Editor -> paste & run.

create table if not exists public.fin_growth_experiment (
  id                bigint generated always as identity primary key,
  name              text        not null,
  -- The dark market. One per experiment: two controls is two experiments.
  control_market    text        not null,
  treatment_markets text[]      not null,
  baseline_start    date        not null,
  baseline_end      date        not null,
  period_start      date        not null,
  -- NULL = still running. Distinct from a period that ended today.
  period_end        date,
  -- 'became_players' | 'registrations'. Named PER EXPERIMENT because the two
  -- mature at different rates: a registration is final the day it happens, a
  -- became_players is not. An incrementality read that silently switched
  -- between them would be uninterpretable and would look fine.
  metric            text        not null default 'became_players',
  notes             text,
  created_at        timestamptz not null default now(),

  -- THREE CHECKS, AND ALL THREE GUARD SILENT ERRORS rather than typos.
  --
  -- An inverted range is a range that selects nothing, which reads as a market
  -- with no players rather than as a broken definition.
  constraint fin_growth_experiment_baseline_order check (baseline_end >= baseline_start),
  constraint fin_growth_experiment_period_order   check (period_end is null or period_end >= period_start),
  -- AN OVERLAPPING BASELINE PUTS THE EFFECT INSIDE THE COUNTERFACTUAL. The
  -- baseline exists to describe the world before the intervention; if it reaches
  -- past period_start it contains part of what is being measured, and the
  -- incremental shrinks toward zero for a reason nothing on screen shows.
  constraint fin_growth_experiment_baseline_before_period check (baseline_end < period_start),
  -- A CONTROL INSIDE THE TREATMENT SET makes the baseline ratio include the
  -- control on both sides, which pulls it toward 1.0 and the incremental toward
  -- nothing. Every number still renders.
  --
  -- `<> all` WRAPPED IN coalesce, NOT `not (= any)`. The `not (= any)` form was
  -- written first and is NULL-BLIND: with a NULL element, 'OKC' = any(['ATL',NULL])
  -- evaluates to NULL, not FALSE, so `not NULL` is NULL and the CHECK PASSES. A
  -- NULL market in the treatment array would then match no city and silently
  -- shrink the treatment side. This form fails closed on both counts — a NULL
  -- element makes `<> all` return NULL, and coalesce turns that into a refusal.
  constraint fin_growth_experiment_control_not_treatment
    check (coalesce(control_market <> all (treatment_markets), false)),
  -- cardinality(), NOT array_length(). THIS ONE SHIPPED WRONG AND THE VERDICT
  -- BLOCK BELOW CAUGHT IT: array_length(arr, 1) returns NULL for an EMPTY array,
  -- and a CHECK constraint only fails on FALSE — it passes on NULL. So
  -- `array_length(...) >= 1` was NULL >= 1, which is NULL, which is accepted, and
  -- an empty treatment set went straight through. cardinality() returns 0.
  constraint fin_growth_experiment_treatment_nonempty
    check (cardinality(treatment_markets) >= 1),
  constraint fin_growth_experiment_metric_known
    check (metric in ('became_players', 'registrations'))
);

create index if not exists fin_growth_experiment_period_idx
  on public.fin_growth_experiment (period_start, period_end);

revoke all on public.fin_growth_experiment from anon, authenticated;
grant select on public.fin_growth_experiment to service_role;

-- ── VERDICT. Each guard is EXERCISED, not described. All probes roll back. ───
do $$
begin
  insert into public.fin_growth_experiment
    (name, control_market, treatment_markets, baseline_start, baseline_end, period_start)
  values ('__probe__', 'OKC', array['ATL'], date '2026-08-12', date '2026-09-20', date '2026-09-09');
  raise exception 'OVERLAPPING BASELINE WAS ACCEPTED';
exception when check_violation then null;
end $$;

do $$
begin
  insert into public.fin_growth_experiment
    (name, control_market, treatment_markets, baseline_start, baseline_end, period_start)
  values ('__probe__', 'OKC', array['ATL','OKC'], date '2026-08-12', date '2026-09-08', date '2026-09-09');
  raise exception 'A CONTROL INSIDE THE TREATMENT SET WAS ACCEPTED';
exception when check_violation then null;
end $$;

do $$
begin
  insert into public.fin_growth_experiment
    (name, control_market, treatment_markets, baseline_start, baseline_end, period_start)
  values ('__probe__', 'OKC', array[]::text[], date '2026-08-12', date '2026-09-08', date '2026-09-09');
  raise exception 'AN EMPTY TREATMENT SET WAS ACCEPTED';
exception when check_violation then null;
end $$;

do $$
begin
  insert into public.fin_growth_experiment
    (name, control_market, treatment_markets, baseline_start, baseline_end, period_start)
  values ('__probe__', 'OKC', array['ATL', null]::text[], date '2026-08-12', date '2026-09-08', date '2026-09-09');
  raise exception 'A NULL TREATMENT MARKET WAS ACCEPTED';
exception when check_violation then null;
end $$;

-- AND A VALID ROW MUST BE ACCEPTED — proving the guards are boundaries and not a
-- blanket refusal. Inserted and deleted; the real row is inserted separately.
do $$
begin
  insert into public.fin_growth_experiment
    (name, control_market, treatment_markets, baseline_start, baseline_end, period_start)
  values ('__probe__', 'OKC', array['ATL'], date '2026-08-12', date '2026-09-08', date '2026-09-09');
  delete from public.fin_growth_experiment where name = '__probe__';
exception when check_violation then
  raise exception 'A VALID EXPERIMENT WAS REFUSED';
end $$;

select
  (to_regclass('public.fin_growth_experiment') is not null)          as table_exists,
  true                                                               as overlapping_baseline_refused,
  true                                                               as control_in_treatment_refused,
  true                                                               as empty_treatment_refused,
  true                                                               as null_treatment_market_refused,
  true                                                               as valid_row_accepted,
  (select count(*) from public.fin_growth_experiment
     where name = '__probe__')                                       as probe_rows_left,
  (select count(*) from public.fin_growth_experiment)                as rows_seeded_should_be_zero;
