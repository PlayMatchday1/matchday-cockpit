-- Relax fin_sync_log.source CHECK to allow new mdapi sources.
-- The original constraint (migration 0009) only allowed 'stripe-api';
-- the cron orchestrator now writes rows with source ∈ {'stripe-api',
-- 'mdapi-reviews', 'mdapi-subscriptions'}.
--
-- Postgres auto-named the original constraint fin_sync_log_source_check
-- (table_column_check convention from inline CHECK on column).
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

ALTER TABLE fin_sync_log
  DROP CONSTRAINT IF EXISTS fin_sync_log_source_check;

ALTER TABLE fin_sync_log
  ADD CONSTRAINT fin_sync_log_source_check
  CHECK (source IN ('stripe-api', 'mdapi-reviews', 'mdapi-subscriptions'));
