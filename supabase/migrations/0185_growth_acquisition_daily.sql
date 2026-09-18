-- 0185 — acquisition by DAY and city. The daily series the ads views need, which
-- does not exist today: growth_registration exposes signup_month and nothing finer.
--
-- ── IT REUSES BOTH EXISTING DEFINITIONS VERBATIM ─────────────────────────────
-- "Registered"  = completed_sign_up_at IS NOT NULL, non-fake        (growth_registration)
-- "Played"      = has a first_match_date                            (growth_player_profile)
-- Only the GRAIN and the BUCKETING DATE change. There is no second definition of
-- either thing, and nothing here re-implements the participation filter.
--
-- ── ONE CLOCK: AMERICA/CHICAGO ───────────────────────────────────────────────
-- The same zone 0157 deliberately moved growth_registration to. Three clocks are
-- in play and this picks the one that costs least:
--
--   Meta buckets a day in the AD ACCOUNT's zone, America/Bogota — UTC-5, no DST.
--   America/Chicago is UTC-5 from March to November and UTC-6 the rest.
--
-- So Meta's day boundary and Chicago's are IDENTICAL for two thirds of the year
-- and one hour apart for the other third. On UTC they are five to six hours
-- apart every day, and 24.9% of signups since 2026-08-01 — 840 of 3,369 — fall
-- on a DIFFERENT DAY under UTC than under Chicago. At month grain that was
-- tolerable; at day grain, joined against ad spend, it is not.
--
-- ── WHY became_players IS DATED BY SIGNUP AND NOT BY THE MATCH ───────────────
-- growth_player_profile.first_match_date is the date of the MATCH, and it can be
-- in the FUTURE: on 2026-09-18 it carried new players on 09-19, 09-20 and 09-21
-- for matches that had not happened. That is correct for cohorts and retention,
-- where the cohort IS the first play, and WRONG for cost per acquisition, where
-- it puts a player in a bucket weeks away from the spend that bought them.
--
-- So a player is dated by WHEN THEY WERE ACQUIRED and qualified by WHETHER THEY
-- PLAYED. The match date is the qualifier, never the bucket.
--
-- ── became_players IS CENSORED ON RECENT DAYS, ON PURPOSE ───────────────────
-- Someone who registers today may play next week, so the last fortnight is
-- always understated and always improving. played_within_7d and _30d are here so
-- a SETTLED figure exists beside the moving one, and any page showing the moving
-- one must mark it the way Finance marks a month in progress.
--
-- ── EVERY MARKET STAYS IN, INCLUDING THE ONES WE DO NOT BUY ─────────────────
-- Warsaw carries 91 new players since August with no Meta spend at all; NYC and
-- El Paso appear in the registrations. The ads views filter to the paid markets
-- in the read layer. Filtering HERE would make the amount being excluded
-- uncomputable, and the page is required to state that gap rather than pad the
-- table to make it tie.
--
-- CITY IS RAW (preferable_city_name). Normalisation stays in Node, the same rule
-- 0096 states: the views do the GROUPING, the resolvers do not get a second
-- implementation in SQL.
--
-- A PLAIN VIEW, NOT MATERIALIZED. It reads live, so it needs no entry in
-- refresh_growth_views(). It does join growth_player_profile, which IS
-- materialized and refreshes nightly, so became_players lags by up to a day
-- while registrations do not.
--
-- Apply via Supabase Dashboard -> SQL Editor -> paste & run.

create or replace view public.growth_acquisition_daily as
select
  -- ::timestamptz then AT TIME ZONE, exactly as 0157 does it. IANA, so it is
  -- DST-aware; a fixed -06:00 would be an hour wrong from March to November,
  -- which is the mistake Retool makes on promo dates.
  to_char(u.completed_sign_up_at::timestamptz at time zone 'America/Chicago', 'YYYY-MM-DD')
                                                              as signup_date,
  u.preferable_city_name                                      as declared_city_raw,
  count(*)                                                    as registrations,
  count(*) filter (where pp.first_match_date is not null)      as became_players,
  count(*) filter (
    where pp.first_match_date is not null
      and pp.first_match_date::date
          <= (u.completed_sign_up_at::timestamptz at time zone 'America/Chicago')::date + 7
  )                                                            as played_within_7d,
  count(*) filter (
    where pp.first_match_date is not null
      and pp.first_match_date::date
          <= (u.completed_sign_up_at::timestamptz at time zone 'America/Chicago')::date + 30
  )                                                            as played_within_30d
from public.mdapi_users u
left join public.growth_player_profile pp on pp.user_id = u.id
where coalesce(u.is_fake_player, false) = false
  and u.completed_sign_up_at is not null
group by 1, 2;

-- Same posture as 0096: plain views without security_invoker are not covered by
-- RLS and this project grants public objects to anon/authenticated by default.
revoke all on public.growth_acquisition_daily from anon, authenticated;
grant select on public.growth_acquisition_daily to service_role;

-- ── VERDICT ──────────────────────────────────────────────────────────────────
-- Every check below has a positive control, because each one's passing value is
-- also what an empty or broken view would return.
select
  (to_regclass('public.growth_acquisition_daily') is not null)          as view_exists,
  -- CONTROL: it returns rows at all. A view that resolved but selected nothing
  -- would satisfy every invariant below trivially.
  (select count(*) from public.growth_acquisition_daily)                as day_city_rows,
  (select count(*) from public.growth_acquisition_daily
     where signup_date >= '2026-08-01')                                 as rows_since_august,
  -- THE INVARIANT: you cannot become a player without registering, and you
  -- cannot play within 7 days without having played.
  (select count(*) from public.growth_acquisition_daily
     where became_players > registrations
        or played_within_7d > became_players
        or played_within_30d > became_players
        or played_within_7d > played_within_30d)                        as impossible_rows_must_be_zero,
  -- CONTROL FOR THE CLOCK: the whole point of this migration is that Chicago and
  -- UTC disagree. If this is 0 the bucketing is not doing what the header says.
  (select count(*) from public.mdapi_users
     where coalesce(is_fake_player, false) = false
       and completed_sign_up_at is not null
       and completed_sign_up_at >= '2026-08-01'
       and (completed_sign_up_at::timestamptz at time zone 'America/Chicago')::date
           <> (completed_sign_up_at::timestamptz at time zone 'UTC')::date)
                                                                        as signups_that_move_day_utc_vs_chicago,
  -- The totals must still agree with the source. This creates and destroys nobody.
  (select coalesce(sum(registrations), 0) from public.growth_acquisition_daily) as registrations_total,
  (select count(*) from public.mdapi_users
     where coalesce(is_fake_player, false) = false
       and completed_sign_up_at is not null)                            as registrations_total_source;
