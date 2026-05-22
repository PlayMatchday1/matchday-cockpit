-- Schema prereqs for the Match Manager Pay recompute cron step.
--
--   1. Partial unique index on fin_expenses(city, date) WHERE
--      category='Match Manager Pay'. Lets the new cron step do a
--      clean supabase.upsert({ onConflict: "city,date" }) keyed by
--      the (city, payDate Thursday) cell, without constraining
--      other expense categories (e.g. Field Costs can legitimately
--      have multiple rows per (city, date)).
--
--   2. Adds 'manager-pay-recompute' to the fin_sync_log.source
--      CHECK constraint so the cron orchestrator's per-step log
--      insert succeeds. Same drop/recreate pattern as migrations
--      0013, 0015, 0017, 0018, 0020, 0023.
--
-- Apply via Supabase Dashboard → SQL Editor.

CREATE UNIQUE INDEX IF NOT EXISTS fin_expenses_manager_pay_uniq
  ON fin_expenses(city, date)
  WHERE category = 'Match Manager Pay';

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
    'manager-pay-recompute'
  ));
