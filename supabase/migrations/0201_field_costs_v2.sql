-- 0201 — FIELD COSTS v2: a pay schedule, day-of-week rates, per-field counting, two billing models,
-- and the combined-venue folds. Spec: scripts/mocks/field-costs-v2.html (Ryan, 2026-10-02).
--
-- NOT APPLIED. For review. Filled in from Ryan's answers of 2026-10-02 (sections 6–8).
--
-- ══ RLS: NOTHING CHANGES ════════════════════════════════════════════════════════════════════
-- Every new column is on a table that already has RLS (fin_venues, fin_venue_fields), so it is
-- governed by the policies those tables already carry. No policy is added, dropped or tightened.
--
-- ══ COST vs CASH ════════════════════════════════════════════════════════════════════════════
-- pay_schedule decides only WHEN cash leaves (OpEx; Cash Flow, hidden for now). What a month COSTS
-- stays in the month the matches happen (Cost, Cities). Nothing in this file moves a cost.
--
-- Apply in the Supabase SQL Editor. Not applied by the app.

begin;

-- ── 1. THE NEW COLUMNS ──────────────────────────────────────────────────────────────────────

-- WHEN WE PAY. One JSON value per venue:
--   {"mode":"dates","dates":[{"d":7},{"d":15,"v":500}],"prepaid":false}   pick dates; v = amount on
--        that date, absent = blank (blank dates split what is left evenly); prepaid = the month before
--   {"mode":"weekly","anchor":"2026-10-02"}      every week on anchor's weekday
--   {"mode":"biweekly","anchor":"2026-10-02"}    every other week, in step with anchor
--   {"mode":"match"}                              on each match date
-- NULL = not set yet; the page treats it as {"mode":"match"}.
-- anchor is a FULL DATE, not a day of the month: "every other Friday" needs to know WHICH Fridays.
alter table public.fin_venues add column if not exists pay_schedule jsonb;
alter table public.fin_venues drop constraint if exists fin_venues_pay_schedule_shape;
alter table public.fin_venues add constraint fin_venues_pay_schedule_shape check (
  pay_schedule is null or (
    jsonb_typeof(pay_schedule) = 'object'
    and pay_schedule->>'mode' in ('dates', 'weekly', 'biweekly', 'match')
    and (pay_schedule->>'mode' <> 'dates' or jsonb_typeof(pay_schedule->'dates') = 'array')
  )
);

-- DAY-OF-WEEK RATES. [{"v":140,"days":[4,5,6]},{"v":0,"days":[0,1,2,3]}], Monday = 0. Up to three
-- rates; every day belongs to exactly one (the page enforces it). NULL = one rate for all days,
-- which is per_match_rate, exactly as today.
alter table public.fin_venues add column if not exists rate_days jsonb;
alter table public.fin_venues drop constraint if exists fin_venues_rate_days_shape;
alter table public.fin_venues add constraint fin_venues_rate_days_shape check (
  rate_days is null or (jsonb_typeof(rate_days) = 'array' and jsonb_array_length(rate_days) between 1 and 3)
);

-- THE FIELDS CHECKBOXES NEED NO NEW COLUMN. fin_venue_fields.excluded_from_venue (0155) is exactly
-- "this field stays linked but does not count", already read by every finance surface. NOTE: it
-- leaves the field out of the venue's revenue and spots as well as its cost.

-- Notes: fin_venues.notes ALREADY EXISTS (18 venues carry real text). Nothing to add.

-- ── 2. WHEN WE PAY, FROM TODAY'S SETTINGS ───────────────────────────────────────────────────
-- A billing day → that date. No billing day on a per-match venue → each match date.
update public.fin_venues set pay_schedule = jsonb_build_object(
    'mode', 'dates', 'dates', jsonb_build_array(jsonb_build_object('d', billing_day)), 'prepaid', false)
  where pay_schedule is null and billing_cadence = 'monthly' and billing_day is not null;
update public.fin_venues set pay_schedule = '{"mode":"match"}'::jsonb
  where pay_schedule is null and billing_cadence = 'monthly' and billing_day is null and billing_type = 'per_match';

-- CUSTOM CADENCE (NEMP, Round Rock, Scissortail Park): per-month day lists have no equivalent.
-- Each takes the day it uses most recently, as a Pick-dates date (Ryan: corrected on the page if wrong).
update public.fin_venues set pay_schedule = '{"mode":"dates","dates":[{"d":5}],"prepaid":false}'::jsonb where id = 2;   -- NEMP: 2026-10 [5]
update public.fin_venues set pay_schedule = '{"mode":"dates","dates":[{"d":1}],"prepaid":false}'::jsonb where id = 4;   -- Round Rock: 2026-08 [1]
update public.fin_venues set pay_schedule = '{"mode":"dates","dates":[{"d":7}],"prepaid":false}'::jsonb where id = 21;  -- Scissortail Park: 2026-10 [7]

-- Bob Jones Park: the 10th, PREPAID (paid the month before the matches).
update public.fin_venues set pay_schedule = '{"mode":"dates","dates":[{"d":10}],"prepaid":true}'::jsonb where id = 67;

-- PARMER Stadium: Pick dates, the day its payment goes out. Its billing day on file is the 5th;
-- the October payment has not gone out yet (today is Oct 2) and the bank load stops at August, so
-- there is no actual date to read. The mock shows the 3rd. CHECK BEFORE APPLYING.
update public.fin_venues set pay_schedule = '{"mode":"dates","dates":[{"d":5}],"prepaid":false}'::jsonb where id = 63;

-- ── 3. TWO BILLING MODELS ───────────────────────────────────────────────────────────────────
-- PARMER Stadium is a rental profit-share partner stored as per_match with no rate. Profit share
-- keeps the "This month" box: auto is the partner payout, a typed amount overrides it. Its
-- October $4,334.40 (the invoice total: last month's share + next month's floor) is already a
-- fin_venue_cost_overrides row and stays as the hand-set October amount. Nothing to move.
update public.fin_venues set billing_type = 'profit_share' where id = 63;
-- Monthly flat: the only row is ATH Katy Sunday (23), inactive, with no flat amount. It folds
-- into ATH Katy below; nothing to carry. The CHECK constraint keeps allowing 'monthly_flat' (no
-- tightening); the page simply stops offering it.

-- ── 4. THE FOLD. "Lowest rate wins" goes; the main row is the venue. ─────────────────────────
--   ATH Katy Sunday (23, inactive) → ATH Katy (7)
-- Row 23 has no field links, schedule rows, transactions or partner links. It holds eight
-- bank-reconciliation rows at $0 (Jan–Aug 2026), which add nothing to any total, and the $1,280
-- October override, which moves to row 7 (section 7). Its Sunday split becomes row 7's $160
-- Sunday rate (section 6).
delete from public.fin_venue_cost_overrides
  where venue_id = 23 and created_by = 'field-cost-2026-reconciliation' and override_amount = 0;
-- SOCCER CENTRAL (53 → 11) IS NOT FOLDED HERE. Its split is by CAPACITY, not by day: matches over
-- 22 go to the Tournament row and bill $0 (55 of October's 59 so far). Folded at $90 they would
-- add $4,950 to October; unticking field 199 instead would also drop its revenue and spots. Held
-- for Ryan's decision; row 53 and the capacity routing stay exactly as they are.
-- The code-side half for ATH Katy: its COMBINE_BY_NAME entry and Sunday routing go, in the same push.

-- ── 5. REVERT ROW 23's OCT 1–2 EDITS (they were aimed at ATH Katy and landed here) ──────────
-- From fin_change_log: billing_day null→1; dpp_price null→12; member_price null→66.5;
-- billing_type per_match→monthly_flat→per_match→monthly_flat; per_match_rate 0→null.
update public.fin_venues
   set billing_day = null, dpp_price = null, member_price = null,
       billing_type = 'per_match', per_match_rate = 0, pay_schedule = null
 where id = 23;

-- ── 6. ATH KATY: one row (7), day-of-week rates, the 15th ────────────────────────────────────
-- What is on file: $140 Mon–Sat, $160 Sun (Monday = 0, so Sunday = 6). Pays on the 15th (row 7's
-- billing day).
update public.fin_venues
   set rate_days = '[{"v":140,"days":[0,1,2,3,4,5]},{"v":160,"days":[6]}]'::jsonb,
       pay_schedule = '{"mode":"dates","dates":[{"d":15}],"prepaid":false}'::jsonb
 where id = 7;

-- ── 7. THE $1,280 OCTOBER OVERRIDE: ATH Katy's whole October cost, so it moves to row 7 ──────
-- Row 7 has no October override, so nothing collides with the (venue_id, month) key. October for
-- ATH Katy then reads $1,280, hand-set — not $2,380 auto + $1,280 as it does today.
update public.fin_venue_cost_overrides set venue_id = 7 where venue_id = 23 and month = 'Oct 2026';

-- ── 8. KESWICK PARK: $80 a match from November, paid on the 5th ──────────────────────────────
-- October stays hand-set at $1,360 (an existing override; untouched). "Paid upfront" is read as
-- paid on the 5th of the SAME month — NOT the "prepaid, month before" option. CHECK BEFORE APPLYING.
update public.fin_venues
   set per_match_rate = 80,
       pay_schedule = '{"mode":"dates","dates":[{"d":5}],"prepaid":false}'::jsonb
 where id = 66;

-- Stony Point (83), The Sports Yard (85) and Turf on (87): no rate, so $0 — the page flags them
-- "no rate" under the cost. No data change.

commit;
