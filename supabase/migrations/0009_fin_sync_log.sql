-- Sync attempt log for Stripe API → fin_revenue jobs (and any future
-- sync sources). One row per attempt — success or failure. The
-- /admin/finance/upload "Recent Syncs" UI reads this; nothing else
-- depends on it operationally.
--
-- A row is inserted at the start of each sync (started_at set,
-- completed_at NULL, counts NULL). On finish the same row is
-- UPDATEd with completed_at + counts (success) or error_message
-- (failure). This way crashes mid-sync still leave a "started but
-- never completed" trace instead of vanishing.
--
-- RLS:
--   - Authenticated cockpit users can SELECT (UI reads it)
--   - INSERT/UPDATE happen via the API route. Manual-mode uses the
--     user's session (authenticated INSERT/UPDATE allowed). Cron-mode
--     uses the Supabase service role, which bypasses RLS by design.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

CREATE TABLE IF NOT EXISTS fin_sync_log (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  source             text          NOT NULL CHECK (source IN ('stripe-api')),
  triggered_by       text          NOT NULL CHECK (triggered_by IN ('manual', 'cron')),
  started_at         timestamptz   NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  rows_imported      integer,
  rows_replaced      integer,
  charges_fetched    integer,
  charges_succeeded  integer,
  charges_skipped    integer,
  error_message      text
);

CREATE INDEX IF NOT EXISTS fin_sync_log_started_at_idx
  ON fin_sync_log(started_at DESC);

ALTER TABLE fin_sync_log ENABLE ROW LEVEL SECURITY;

-- Authenticated cockpit users only. Anon never touches this.
DROP POLICY IF EXISTS fin_sync_log_auth_select ON fin_sync_log;
CREATE POLICY fin_sync_log_auth_select
  ON fin_sync_log FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS fin_sync_log_auth_insert ON fin_sync_log;
CREATE POLICY fin_sync_log_auth_insert
  ON fin_sync_log FOR INSERT TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS fin_sync_log_auth_update ON fin_sync_log;
CREATE POLICY fin_sync_log_auth_update
  ON fin_sync_log FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);
