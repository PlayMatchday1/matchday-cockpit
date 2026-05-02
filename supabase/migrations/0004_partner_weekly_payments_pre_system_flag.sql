-- Phase C+: pre-system settlement rows.
--
-- Adds an is_pre_system_settlement flag to partner_weekly_payments so
-- a partner's payment history can include lump-sum settlements that
-- predate the weekly payment system. These rows are NOT generated
-- from match data — they live solely as historical records.
--
-- The dashboard prepends pre-system rows to the table with a
-- "Through <date>" label instead of a Sunday-anchored "Week of"
-- label. Their week_start_date stores the *through-date* (last day
-- of the period covered by the lump sum).
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

ALTER TABLE partner_weekly_payments
  ADD COLUMN IF NOT EXISTS is_pre_system_settlement boolean NOT NULL DEFAULT false;

-- Speeds up the partial-rows query computeWeeklyPayments runs to
-- prepend historical settlements.
CREATE INDEX IF NOT EXISTS partner_weekly_payments_pre_system_idx
  ON partner_weekly_payments(partner_dashboard_id)
  WHERE is_pre_system_settlement = true;

-- Seed PAC Global's pre-system settlement: $169.50 lump sum for all
-- March + April 2026 revenue, paid May 1, 2026 (one day before the
-- weekly payment system kicked in). Week_start_date stores the
-- through-date (last day covered).
INSERT INTO partner_weekly_payments (
  partner_dashboard_id,
  week_start_date,
  calculated_amount,
  status,
  paid_at,
  paid_notes,
  is_pre_system_settlement
)
SELECT
  pd.id,
  '2026-04-30'::date,
  169.50,
  'paid',
  '2026-05-01T12:00:00Z'::timestamptz,
  'Pre-system settlement: covers all March + April 2026 revenue ($339 all-time × 50%). Paid in single lump sum before weekly payment system started.',
  true
FROM partner_dashboards pd
WHERE pd.slug = 'pac-global-7vdybfv4'
ON CONFLICT (partner_dashboard_id, week_start_date) DO NOTHING;
