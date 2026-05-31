-- Per-partner revenue model.
--
-- Adds a revenue_model to partner_dashboards so a partner can be paid
-- "per match minus manager pay" instead of the flat percentage share
-- that Hattrick and PAC Global use. Crossbar Rowlett is the first
-- partner on the new model.
--
--   flat_percentage         → owed = qualifying_revenue * revenue_share_pct/100
--                             (existing behavior; the column default, so
--                             every current partner is unchanged).
--   per_match_minus_manager → for each match in the period:
--                               partner_share = max(0, match_revenue - manager_pay)
--                             summed across the period. match_revenue is
--                             DPP only (DAILY PAID match payments).
--
-- manager_pay per match:
--   manager_pay_high  when the match clears manager_pay_threshold,
--   manager_pay_base  otherwise.
--
-- IMPORTANT — manager_pay_threshold keys on the match's CAPACITY
-- (mdapi_matches.max_player_count), NOT on how many players showed up.
-- This is deliberate: it reconciles the partner-side subtraction with
-- what the match manager is ACTUALLY paid. managerPayCompute.ts pays
-- $30 when max_player_count >= 25 (TOURNAMENT_THRESHOLD) and $20
-- otherwise; the per-match partner-share math subtracts the same
-- figure. The calculator compares max_player_count >= manager_pay_
-- threshold, so threshold = 25 reproduces the ">= 25 capacity = $30"
-- rule ("more than 24"). Using showed-up headcount instead would let
-- the subtracted manager pay diverge from the real payout once pricing
-- normalizes — a partner-trust problem.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

ALTER TABLE partner_dashboards
  ADD COLUMN IF NOT EXISTS revenue_model         text         NOT NULL DEFAULT 'flat_percentage',
  ADD COLUMN IF NOT EXISTS manager_pay_base      numeric(10,2),
  ADD COLUMN IF NOT EXISTS manager_pay_high      numeric(10,2),
  ADD COLUMN IF NOT EXISTS manager_pay_threshold integer;

ALTER TABLE partner_dashboards
  DROP CONSTRAINT IF EXISTS partner_dashboards_revenue_model_range;
ALTER TABLE partner_dashboards
  ADD CONSTRAINT partner_dashboards_revenue_model_range
  CHECK (revenue_model IN ('flat_percentage', 'per_match_minus_manager'));

-- Crossbar Rowlett: $20 base, $30 when capacity >= 25, monthly cadence.
-- payment_start_date moves from NULL → 2026-05-01 so May 2026 is the
-- first qualifying month (and the Monthly Payments section renders;
-- a NULL start date keeps the whole section hidden). revenue_share_pct
-- is left as-is — it is unused under the per-match model.
UPDATE partner_dashboards
   SET revenue_model         = 'per_match_minus_manager',
       manager_pay_base      = 20.00,
       manager_pay_high      = 30.00,
       manager_pay_threshold = 25,
       payment_start_date    = '2026-05-01'
 WHERE slug LIKE 'crossbar-rowlett-%';
