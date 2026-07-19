-- OpEx Calendar: per-venue billing TIMING for field costs.
--
-- Field costs need a real hit-date to sit on the OpEx calendar. Per-match
-- venues are already dated by their schedule_master matches, but
-- monthly_flat / profit_share venues only carry a per-month amount (via
-- fin_venue_cost_overrides) with no day and no cadence. These columns
-- capture the missing timing so a flat/quarterly venue lands on its true
-- payment date instead of being smeared or defaulted to day 1.
--
-- Semantics:
--   billing_cadence      how often the flat amount recurs. Ignored for
--                        per_match venues (they date off the schedule).
--   billing_day          day-of-month the bill hits (1..31, clamped to
--                        the month's length by the app). NULL = timing
--                        not yet captured -> the OpEx calendar shows the
--                        amount in an "undated remainder" line rather
--                        than faking a date. We deliberately do NOT
--                        default this to 1.
--   billing_anchor_month reference month (1..12) for non-monthly cadence.
--                        quarterly hits anchor_month, +3, +6, +9 (mod 12);
--                        annual hits anchor_month only. NULL for monthly.
--
-- Cost AMOUNTS are unchanged — they still come from buildFieldCostRows /
-- fin_venue_cost_overrides. These columns only decide WHICH DAY the
-- existing monthly amount is placed on. The Field Costs subtotal is
-- unaffected.
--
-- Apply via Supabase Dashboard -> SQL Editor -> paste & run.

ALTER TABLE fin_venues
  ADD COLUMN IF NOT EXISTS billing_cadence text NOT NULL DEFAULT 'monthly'
    CHECK (billing_cadence IN ('monthly', 'quarterly', 'annual')),
  ADD COLUMN IF NOT EXISTS billing_day int
    CHECK (billing_day IS NULL OR (billing_day >= 1 AND billing_day <= 31)),
  ADD COLUMN IF NOT EXISTS billing_anchor_month int
    CHECK (billing_anchor_month IS NULL
           OR (billing_anchor_month >= 1 AND billing_anchor_month <= 12));

COMMENT ON COLUMN fin_venues.billing_cadence IS
  'How often a monthly_flat/profit_share venue bills (monthly|quarterly|annual). Ignored for per_match venues, which are dated by schedule_master matches.';
COMMENT ON COLUMN fin_venues.billing_day IS
  'Day-of-month the flat/quarterly bill hits (1..31). NULL = timing not captured; OpEx calendar shows it as an undated remainder rather than defaulting to day 1.';
COMMENT ON COLUMN fin_venues.billing_anchor_month IS
  'Reference month (1..12) for non-monthly cadence. quarterly hits anchor,+3,+6,+9; annual hits anchor only.';
