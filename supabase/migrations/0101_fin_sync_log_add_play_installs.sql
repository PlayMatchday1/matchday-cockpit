-- 0101: allow 'play-installs' (and 'telnyx-sms') in fin_sync_log.source.
--
-- WHY. The Google Play install ingest runs inside /api/sync/cron but its result
-- was never persisted — it only console.error'd on failure. With the service
-- account key empty on Production, the step has thrown every night for days while
-- the KPI sat on a static "awaiting Play sync" with no trace of what went wrong.
-- Routing the step through runWithLog (like every other source) needs its source
-- value to pass the CHECK constraint.
--
-- 'telnyx-sms' is added in the same breath: it is already in the code's
-- SourceName union and the cron's anyFailed gate, but was never added to the DB
-- constraint, so its log inserts were being rejected too. This realigns the
-- constraint with every source the code actually emits.
--
-- Idempotent: DROP IF EXISTS then ADD, matching the pattern of 0015/0018/0052/0053.

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
    'play-installs'
  ));
