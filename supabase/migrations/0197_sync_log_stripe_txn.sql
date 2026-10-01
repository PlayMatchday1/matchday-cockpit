-- 0197 — allow 'stripe-txn' in fin_sync_log.source.
--
-- 0196 added 'stripe-txn-backfill' for the one-off historical walk. The RECURRING fin_txn sync —
-- hourly over 3 days, daily over 60, and the Sync now button — is a different job with a different
-- cadence and a different meaning on the page: "Last synced" reads the recurring one, never the
-- backfill. Reusing the backfill's name would make a finished backfill look like a fresh sync.
--
-- fin_sync_log.source is an explicit CHECK allowlist and runWithLog's insert for a value outside it
-- returns ok:false WITHOUT THROWING, so the sync would run, upsert every row, and simply never
-- appear in Recent Syncs — and the "Last synced" label would sit frozen while the data moved.
alter table public.fin_sync_log drop constraint if exists fin_sync_log_source_check;
alter table public.fin_sync_log add constraint fin_sync_log_source_check
  CHECK (source IN (
    'stripe-api','mdapi-reviews','mdapi-subscriptions','mdapi-promocodes','mdapi-matches',
    'mdapi-users','mdapi-users-full','mdapi-users-lens-snapshot','membership-snapshots',
    'membership-prices','manager-pay-recompute','firstmatch-ledger','telnyx-sms','play-installs',
    'app-store-installs','google-calendar','meta-ad-spend','wp-submissions',
    'stripe-txn-backfill','stripe-txn'
  ));
