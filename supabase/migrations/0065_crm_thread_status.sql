-- ============================================================
-- crm_threads status (open/closed) + status change audit log
-- ============================================================
-- Ticket-style workflow for the Chats inbox. status defaults to
-- 'open' so every existing thread backfills to the Open inbox.
-- closed_at / closed_by_user_id populate on close, clear on reopen
-- and on auto-reopen (inbound message on a closed thread).
--
-- Audit lives in a dedicated table (not crm_assignment_log): close
-- and reopen have no from/to-assignee semantics, need a nullable
-- actor for system auto_reopen, and carry an optional reason.
-- Mirrors the admin-read / service-role-write RLS model used by
-- crm_assignment_log.
--
-- Applied manually via the Supabase SQL Editor before the app code
-- shipped (196 existing rows backfilled to status='open').
-- ============================================================

-- 1. Status columns on crm_threads
ALTER TABLE crm_threads
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open';

ALTER TABLE crm_threads
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;

ALTER TABLE crm_threads
  ADD COLUMN IF NOT EXISTS closed_by_user_id uuid
    REFERENCES app_users(id) ON DELETE SET NULL;

ALTER TABLE crm_threads
  DROP CONSTRAINT IF EXISTS crm_threads_status_check;
ALTER TABLE crm_threads
  ADD CONSTRAINT crm_threads_status_check
  CHECK (status IN ('open', 'closed'));

-- Open inbox is the hot path: filter by status, newest first.
CREATE INDEX IF NOT EXISTS crm_threads_status_last_message_idx
  ON crm_threads(status, last_message_at DESC);

-- 2. Status change audit log
CREATE TABLE IF NOT EXISTS crm_thread_status_log (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id            uuid          NOT NULL REFERENCES crm_threads(id) ON DELETE CASCADE,
  action               text          NOT NULL CHECK (action IN ('close', 'reopen', 'auto_reopen')),
  performed_by_user_id uuid          REFERENCES app_users(id) ON DELETE SET NULL,
  performed_at         timestamptz   NOT NULL DEFAULT now(),
  reason               text
);

-- Per-thread chronological read, newest first.
CREATE INDEX IF NOT EXISTS crm_thread_status_log_thread_performed_idx
  ON crm_thread_status_log(thread_id, performed_at DESC);

ALTER TABLE crm_thread_status_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_thread_status_log_admin_select ON crm_thread_status_log;
CREATE POLICY crm_thread_status_log_admin_select
  ON crm_thread_status_log FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND app_users.is_admin = true
    )
  );
-- No INSERT/UPDATE/DELETE policies. All writes use the service role
-- via the close/reopen API route and the inbound webhooks (audit row
-- written alongside the crm_threads UPDATE), mirroring
-- crm_assignment_log.
