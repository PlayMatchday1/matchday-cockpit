-- ============================================================
-- crm_thread_follow_ups — per-user, per-thread "follow up" star
-- ============================================================
-- A single per-viewer star: a row exists ⇔ that user has flagged that
-- thread to return to. Presence = starred, absence = not. Toggling is
-- therefore inherently idempotent — star = INSERT ... ON CONFLICT DO
-- NOTHING, unstar = DELETE (both no-ops when already in the target
-- state).
--
-- Sibling of crm_thread_reads (same (thread_id, user_id) shape, same RLS
-- and service-role-write pattern), deliberately NOT a column on
-- crm_thread_reads:
--   * crm_thread_reads carries a trigger that touches
--     crm_threads.reads_updated_at on every upsert to broadcast a
--     realtime UPDATE to all admins. Follow-up is PRIVATE per-user — we
--     do not want starring a thread to churn every other admin's inbox.
--     A separate table with no trigger keeps it side-effect-free.
--   * The two states are independent; a presence/absence row models a
--     toggle far more cleanly than a boolean wedged onto the read row
--     (whose last_read_at would be meaningless for a star-only row).
--
-- No realtime publication entry and no backfill: follow-ups start empty
-- and the toggle is optimistic client-side; multi-device sync isn't a
-- requirement here.
--
-- Apply via Supabase Dashboard -> SQL Editor -> paste & run.
-- ============================================================

CREATE TABLE IF NOT EXISTS crm_thread_follow_ups (
  thread_id  uuid          NOT NULL REFERENCES crm_threads(id) ON DELETE CASCADE,
  user_id    uuid          NOT NULL REFERENCES app_users(id)   ON DELETE CASCADE,
  marked_at  timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);

-- "Which threads has user X flagged?" — drives the per-viewer follow-up
-- filter + count. Mirrors crm_thread_reads_user_id_idx. (Lookups by
-- thread_id alone use the PK's leading column.)
CREATE INDEX IF NOT EXISTS crm_thread_follow_ups_user_id_idx
  ON crm_thread_follow_ups(user_id);

-- ============================================================
-- RLS — admin-only SELECT, same shape as crm_thread_reads
-- ============================================================
ALTER TABLE crm_thread_follow_ups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_thread_follow_ups_admin_select ON crm_thread_follow_ups;
CREATE POLICY crm_thread_follow_ups_admin_select
  ON crm_thread_follow_ups FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND app_users.is_admin = true
    )
  );
-- No INSERT/UPDATE/DELETE policy. Writes go through the service role via
-- POST /api/crm/threads/[id]/follow-up.
