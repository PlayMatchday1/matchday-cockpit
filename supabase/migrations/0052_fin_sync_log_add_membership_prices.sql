-- Add 'membership-prices' to the fin_sync_log.source CHECK constraint.
-- The cron orchestrator gains an 8th step (between mdapi-subscriptions
-- and membership-snapshots) that runs the per-city max-active-price
-- snapshot refresh. Without this expansion, the per-step log insert
-- for the new source would be rejected by the CHECK at runtime and
-- the whole step would fail.
--
-- Same drop/recreate pattern as migrations 0013, 0015, 0017, 0018,
-- 0020, 0023, 0045.
--
-- Apply via Supabase Dashboard → SQL Editor.

ALTER TABLE fin_sync_log
  DROP CONSTRAINT IF EXISTS fin_sync_log_source_check;

ALTER TABLE fin_sync_log
  ADD CONSTRAINT fin_sync_log_source_check
  CHECK (source IN (
    'stripe-api',
    'mdapi-reviews',
    'mdapi-subscriptions',
    'mdapi-promocodes',
    'mdapi-matches',
    'mdapi-users',
    'mdapi-users-lens-snapshot',
    'membership-snapshots',
    'membership-prices',
    'manager-pay-recompute'
  ));
