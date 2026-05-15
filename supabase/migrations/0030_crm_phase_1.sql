-- Phase 1 of the CRM: thread assignment + audit log. Builds on the
-- Phase 0 tables from 0029_crm_mvp.sql.
--
-- Schema changes:
--   1. crm_threads
--        + assigned_to_user_id  uuid  references app_users(id)
--                               on delete set null. Nullable; null = unassigned.
--        + assigned_at          timestamptz nullable. Stamped by the PATCH
--                               /api/crm/threads/[id]/assign handler on every
--                               write to assigned_to_user_id. Not exposed in
--                               UI yet — reserved for Phase 3 SLA timers +
--                               "longest unanswered" sorting. Free to add
--                               now, painful to backfill later.
--
--   2. crm_assignment_log
--        Append-only audit row per assignment change. Captures the prior
--        assignee (from_user_id), the new assignee (to_user_id), and who
--        performed the change (changed_by_user_id). All three FKs are
--        nullable on DELETE SET NULL so an operator being deactivated
--        doesn't destroy historical attribution.
--
-- Realtime:
--   crm_threads is already in supabase_realtime (added by 0029) — UPDATEs
--   to assigned_to_user_id will broadcast automatically. We additionally
--   add crm_assignment_log so future UIs (audit drawer in Phase 2/3) can
--   subscribe to the log directly.
--
-- RLS: same corp-only SELECT pattern as crm_threads / crm_messages —
-- app_users.is_admin = true matched on JWT email.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

-- ============================================================
-- crm_threads: add assignment columns
-- ============================================================
ALTER TABLE crm_threads
  ADD COLUMN IF NOT EXISTS assigned_to_user_id uuid
    REFERENCES app_users(id) ON DELETE SET NULL;

ALTER TABLE crm_threads
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

-- Index for "show me everything assigned to X" queries (assignment
-- filter, "Mine" view). Partial because most threads are unassigned
-- and we don't want them bloating the index.
CREATE INDEX IF NOT EXISTS crm_threads_assigned_to_user_id_idx
  ON crm_threads(assigned_to_user_id)
  WHERE assigned_to_user_id IS NOT NULL;


-- ============================================================
-- crm_assignment_log
-- ============================================================
CREATE TABLE IF NOT EXISTS crm_assignment_log (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  thread_id             uuid          NOT NULL REFERENCES crm_threads(id) ON DELETE CASCADE,

  -- Prior assignee. NULL when transitioning from unassigned (i.e.
  -- this row records the first-ever assignment of the thread).
  from_user_id          uuid          REFERENCES app_users(id) ON DELETE SET NULL,

  -- New assignee. NULL when explicitly unassigning (the "Unassign"
  -- option at the bottom of the assignment dropdown).
  to_user_id            uuid          REFERENCES app_users(id) ON DELETE SET NULL,

  -- Who performed the change. Nullable on DELETE SET NULL so a
  -- deactivated operator doesn't take their audit trail with them.
  -- The session-token branch of the PATCH handler populates this;
  -- a hypothetical cron-secret path would write NULL.
  changed_by_user_id    uuid          REFERENCES app_users(id) ON DELETE SET NULL,

  changed_at            timestamptz   NOT NULL DEFAULT now()
);

-- Per-thread chronological read: "show me the assignment history for
-- this thread, newest first" (a Phase 3 audit drawer). Composite on
-- (thread_id, changed_at DESC) lets that query be a single index scan.
CREATE INDEX IF NOT EXISTS crm_assignment_log_thread_changed_idx
  ON crm_assignment_log(thread_id, changed_at DESC);

ALTER TABLE crm_assignment_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_assignment_log_admin_select ON crm_assignment_log;
CREATE POLICY crm_assignment_log_admin_select
  ON crm_assignment_log FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND app_users.is_admin = true
    )
  );
-- No INSERT/UPDATE/DELETE policies. All writes use the service role
-- via the assign API route (which records the row in the same txn
-- as the crm_threads UPDATE).


-- ============================================================
-- Realtime publication
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'crm_assignment_log'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE crm_assignment_log;
  END IF;
END $$;
