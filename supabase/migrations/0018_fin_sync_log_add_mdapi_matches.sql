-- Add 'mdapi-matches' to the fin_sync_log.source CHECK constraint.
-- The cron orchestrator now runs a 6th step (between mdapi-promocodes
-- and membership-snapshots) that syncs match + player rows from the
-- MatchDay API. Phase 5c wiring; same drop/recreate pattern as
-- migrations 0013, 0015, 0017.
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
    'membership-snapshots'
  ));
