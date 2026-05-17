-- ============================================================
-- crm_thread_reads — per-user, per-thread read state for /chats
-- ============================================================
-- Replaces the localStorage-only "crm:lastViewed:v1" mechanism with
-- server-side, assignment-aware read state.
--
-- Read-state resolution rule the application implements at render:
--   thread.assigned_to_user_id IS NULL       → effective_last_read_at
--                                              = MAX(reads.last_read_at)
--                                              across all admins
--   thread.assigned_to_user_id  = viewer     → effective_last_read_at
--                                              = the assignee's row
--   thread.assigned_to_user_id != viewer     → never unread for them
--                                              (out of responsibility)
--   is_unread = (effective IS NULL OR last_message_at > effective)
--               AND last_message_preview IS NOT NULL
--
-- Realtime convergence: the trigger below touches a new
-- crm_threads.reads_updated_at column on every read upsert. That
-- column change broadcasts as a crm_threads UPDATE event to every
-- admin's existing realtime subscription, which prompts a cheap
-- inbox refetch. Cross-admin unassigned-read convergence is instant
-- via this path; same-user multi-device also subscribes directly to
-- crm_thread_reads filtered by user_id.

CREATE TABLE IF NOT EXISTS crm_thread_reads (
  thread_id    uuid          NOT NULL REFERENCES crm_threads(id) ON DELETE CASCADE,
  user_id      uuid          NOT NULL REFERENCES app_users(id)   ON DELETE CASCADE,
  last_read_at timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);

-- "What did user X read across all threads?" — required for the
-- per-user realtime filter (user_id=eq.<uid>) the client subscribes
-- on. Also useful for the MAX-across-users computation when the
-- planner picks an index scan.
CREATE INDEX IF NOT EXISTS crm_thread_reads_user_id_idx
  ON crm_thread_reads(user_id);

-- New column on crm_threads. NULL by default. The trigger below
-- bumps it on every read upsert so the broadcast fires. Distinct
-- name from last_message_at so message-timing semantics stay clean.
-- This column is only meaningful as a "something changed about
-- read state" signal for realtime; nothing reads its value directly.
ALTER TABLE crm_threads
  ADD COLUMN IF NOT EXISTS reads_updated_at timestamptz;


-- ============================================================
-- RLS — admin-only SELECT, same shape as crm_threads
-- ============================================================
ALTER TABLE crm_thread_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_thread_reads_admin_select ON crm_thread_reads;
CREATE POLICY crm_thread_reads_admin_select
  ON crm_thread_reads FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND app_users.is_admin = true
    )
  );
-- No INSERT/UPDATE/DELETE policy. Writes go through the service role
-- via /api/crm/threads/[id]/mark-read.


-- ============================================================
-- Realtime publication
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'crm_thread_reads'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE crm_thread_reads;
  END IF;
END $$;


-- ============================================================
-- Backfill — BEFORE the trigger is created, so the trigger does not
-- fire N×M times during initial population. New (admin, thread)
-- pairs after deploy trigger one-at-a-time as operators read them.
-- ============================================================
INSERT INTO crm_thread_reads (thread_id, user_id, last_read_at)
SELECT t.id, u.id, now()
FROM crm_threads t
CROSS JOIN app_users u
WHERE u.is_admin = true
ON CONFLICT (thread_id, user_id) DO NOTHING;


-- ============================================================
-- Trigger — broadcast read state via crm_threads.reads_updated_at
-- ============================================================
-- Touching crm_threads on every read upsert generates a row UPDATE
-- event on the existing supabase_realtime publication. The /chats
-- client's existing crm_threads UPDATE subscription receives it
-- across all admin sessions and refetches the inbox. This is what
-- delivers cross-admin unassigned-read convergence on top of the
-- per-user filter that already covers same-user multi-device.

CREATE OR REPLACE FUNCTION crm_thread_reads_touch_thread()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE crm_threads
    SET reads_updated_at = now()
    WHERE id = NEW.thread_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS crm_thread_reads_touch_thread_trigger ON crm_thread_reads;
CREATE TRIGGER crm_thread_reads_touch_thread_trigger
AFTER INSERT OR UPDATE ON crm_thread_reads
FOR EACH ROW
EXECUTE FUNCTION crm_thread_reads_touch_thread();
