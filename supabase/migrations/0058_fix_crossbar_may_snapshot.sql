-- Fix the Crossbar Rowlett May 2026 payment snapshot.
--
-- Crossbar is on the per_match_minus_manager model (migration 0057):
-- owed = Σ max(0, match_revenue - manager_pay). Under $1 launch pricing
-- every match floors to $0, so May 2026 owes $0.
--
-- The admin Finance page was computing owed as a flat 50% revenue share
-- (it never loaded revenue_model, so periodOwed fell through to
-- flat_percentage). Marking May "Paid" on that page froze a bad
-- calculated_amount of $24.50 into partner_weekly_payments, which then
-- surfaced on the partner-facing dashboard (paid rows display the
-- snapshot, not the live recompute).
--
-- The admin page is fixed in code to use the per-match model. This
-- corrects the already-frozen snapshot. We keep status = 'paid' and the
-- existing paid_notes so the May reconciliation stays on the record;
-- only the amount is set to its correct $0.
--
-- Apply via Supabase Dashboard -> SQL Editor -> paste & run.

UPDATE partner_weekly_payments p
   SET calculated_amount = 0
  FROM partner_dashboards d
 WHERE p.partner_dashboard_id = d.id
   AND d.slug LIKE 'crossbar-rowlett-%'
   AND p.week_start_date = '2026-05-01';
