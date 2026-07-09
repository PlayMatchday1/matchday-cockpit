-- Extend fin_venues_billing_type_check to allow 'profit_share' so
-- Hattrick + PAC Global (and future profit-share venues) can flip
-- billing_type without violating the CHECK constraint. The
-- constraint was originally created outside the migration tracking
-- (the fin_venues table itself predates the migrations directory
-- in this repo — 0001 references it but doesn't CREATE it). Same
-- drop/recreate pattern as the fin_sync_log.source CHECK extensions
-- in migrations 0013, 0015, 0017, 0018, 0020, 0023.
--
-- Allowed values mirror the TypeScript billing_type union on
-- src/lib/useFinanceData.ts:FinVenue:
--   - per_match     (currently in production)
--   - monthly_flat  (currently in production)
--   - profit_share  (new — autoCost honors this as of commit 7f200dc,
--                    reading the partner-dashboard payout
--                    (qualifying revenue × revenueSharePct) and
--                    falling back to "needs override" when no
--                    enabled dashboard exists for the venue)
--
-- DELIBERATELY DROPPED: 'per_hour' was in the prior CHECK list but
-- is a retired billing model — diagnostic verified zero venues
-- carry billing_type='per_hour' in production, and the cost calc no
-- longer has a per_hour code path (financeCosts.ts:autoCost only
-- branches on per_match / monthly_flat / profit_share). Removing it
-- from the constraint keeps the allowed list in lockstep with the
-- TS union so a stale per_hour value can't sneak back in.
--
-- Apply via Supabase Dashboard → SQL Editor.

ALTER TABLE fin_venues
  DROP CONSTRAINT IF EXISTS fin_venues_billing_type_check;

ALTER TABLE fin_venues
  ADD CONSTRAINT fin_venues_billing_type_check
  CHECK (billing_type IN (
    'per_match',
    'monthly_flat',
    'profit_share'
  ));
