-- 0104: allow 'app-store-installs' in fin_sync_log.source (the iOS install ingest,
-- mirror of 'play-installs'). Same allowlist pattern as 0101; full list re-stated.
-- Touches only the fin_sync_log source CHECK constraint. Atomic.

BEGIN;

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
    'manager-pay-recompute',
    'firstmatch-ledger',
    'telnyx-sms',
    'play-installs',
    'app-store-installs'
  ));

COMMIT;
