-- Phase C++: payment cadence per partner.
--
-- Adds payment_cadence ('weekly' | 'monthly') to partner_dashboards so
-- different partners can be paid on different schedules. Hattrick is
-- monthly (5th of the following month); PAC Global stays weekly
-- (Mondays).
--
-- For monthly partners, the partner_weekly_payments.week_start_date
-- column stores the FIRST DAY of the calendar month (e.g.,
-- 2026-04-01 for April 2026). Period = full calendar month. Payments
-- sent on the 5th of the following month.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

ALTER TABLE partner_dashboards
  ADD COLUMN IF NOT EXISTS payment_cadence text NOT NULL DEFAULT 'weekly';

ALTER TABLE partner_dashboards
  DROP CONSTRAINT IF EXISTS partner_dashboards_cadence_range;
ALTER TABLE partner_dashboards
  ADD CONSTRAINT partner_dashboards_cadence_range
  CHECK (payment_cadence IN ('weekly', 'monthly'));

-- Seed: Hattrick is monthly. revenue_share_pct (50.00) is unchanged
-- from prior configuration. payment_start_date moves from 2026-05-05
-- to 2026-04-01 so April qualifies as the first month under the
-- "first calendar month that starts on or after payment_start_date"
-- rule. (At 2026-05-05, April wouldn't have qualified.)
-- PAC Global stays weekly via the column default.
UPDATE partner_dashboards
   SET payment_cadence = 'monthly'
 WHERE slug LIKE 'hattrick-%';

UPDATE partner_dashboards
   SET payment_start_date = '2026-04-01'
 WHERE slug LIKE 'hattrick-%';
