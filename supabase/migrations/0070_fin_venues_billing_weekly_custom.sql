-- OpEx Calendar: two more billing cadences for field-cost timing.
--
-- 0069 gave flat/quarterly venues a hit-date (billing_day + cadence). This
-- adds WEEKLY and CUSTOM to the cadence set, plus the two fields they need:
--
--   WEEKLY  → billing_weekday: a day of week (0=Sun .. 6=Sat). The month's
--             cost is placed on that weekday's occurrences. Per-match venues
--             accrue each week's matches onto that weekday (same rhythm as
--             Match Manager Pay); flat venues split the month total evenly
--             across the weekly hits (remainder on the last).
--
--   CUSTOM  → billing_custom_days: a per-MONTH map of day-of-month arrays,
--             keyed by ISO year-month, e.g. {"2026-08":[20],"2026-11":[15]}.
--             The real driver is NEMP: 4 irregular payments a year, not a
--             repeating quarterly pattern, so timing is captured month by
--             month. For a flat/profit_share venue the AMOUNT for a custom
--             payment month still lives in fin_venue_cost_overrides (the
--             single source of truth buildFieldCostRows reads) — this map
--             only carries the day(s). Per-match custom venues keep their
--             auto matches × rate amount; only the day is captured here.
--
-- Amounts and billing_type are unchanged. These fields only decide WHICH
-- DAY(S) the existing month total is placed on, so the Field Costs subtotal
-- is unaffected. Reads degrade cleanly before this runs: missing columns
-- hydrate to null / monthly and no venue can carry the new cadences until
-- the CHECK below is widened.
--
-- Apply via Supabase Dashboard -> SQL Editor -> paste & run.

-- Widen the cadence CHECK (0069 created it inline, auto-named
-- fin_venues_billing_cadence_check).
ALTER TABLE fin_venues
  DROP CONSTRAINT IF EXISTS fin_venues_billing_cadence_check;
ALTER TABLE fin_venues
  ADD CONSTRAINT fin_venues_billing_cadence_check
  CHECK (billing_cadence IN
    ('monthly', 'quarterly', 'annual', 'weekly', 'custom'));

ALTER TABLE fin_venues
  ADD COLUMN IF NOT EXISTS billing_weekday int
    CHECK (billing_weekday IS NULL OR (billing_weekday >= 0 AND billing_weekday <= 6)),
  ADD COLUMN IF NOT EXISTS billing_custom_days jsonb;

COMMENT ON COLUMN fin_venues.billing_weekday IS
  'Day of week (0=Sun..6=Sat) a WEEKLY-cadence venue bills on. NULL until captured; the OpEx calendar shows the amount as an undated remainder rather than faking a date.';
COMMENT ON COLUMN fin_venues.billing_custom_days IS
  'CUSTOM cadence only: per-month day-of-month map keyed by ISO year-month, e.g. {"2026-08":[20]}. Carries only the day(s); a flat venue''s amount stays in fin_venue_cost_overrides. A month with a cost but no entry here lands in the undated remainder (never day 1).';
