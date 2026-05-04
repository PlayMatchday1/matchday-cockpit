-- Per-match unit cost for P&L analysis. Independent of per_match_rate
-- (which drives billing_type='per_match' cash-flow auto-computation).
-- Used by the Match P&L subtab on /admin/finance/field-costs to
-- compute per-match unit economics (gross revenue − cost_per_match)
-- regardless of how the venue is actually billed.
--
-- Manually set per venue via the inline-editable "Cost/Match" column
-- on the Field Costs config page. Nullable until set; matches with
-- unset cost_per_match render as "$? — set in Field Costs" and link
-- back to the config tab.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

ALTER TABLE fin_venues
  ADD COLUMN IF NOT EXISTS cost_per_match numeric(10,2);

COMMENT ON COLUMN fin_venues.cost_per_match IS
  'Per-match unit cost for P&L analysis. Independent of per_match_rate (which drives cash-flow billing). Manually set per venue; nullable until set.';
