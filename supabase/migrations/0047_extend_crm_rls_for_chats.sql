-- Extend RLS on the chats-touched tables so users with
-- can_access_chats = true (without is_admin = true) can read what
-- they need to run the Chats UI. Without this, a chats-only user
-- would pass the application-layer gate (canAccess, crmAuth) but
-- still get an empty inbox because the row-level filter would
-- match zero rows.
--
-- crm_canned_responses splits intentionally: a chats-only user can
-- READ the shared template library (so they can use templates in
-- replies) but cannot INSERT / UPDATE / DELETE — those stay
-- is_admin-only so the library doesn't drift from CS edits. The
-- API routes layer an explicit is_admin re-check on top of the
-- service-role client used for writes, so RLS + API both enforce
-- the same boundary.
--
-- All other tables only need their SELECT policy widened — writes
-- on crm_threads / crm_messages / crm_thread_reads / etc. already
-- go through the service-role client in /api/crm/* routes, so
-- the existing "no INSERT/UPDATE/DELETE policy" stance is fine.
--
-- Idempotent — DROP POLICY IF EXISTS before each CREATE.
--
-- Apply AFTER 0046_add_can_access_chats.sql.

-- ============================================================
-- crm_threads (originally 0029_crm_mvp.sql)
-- ============================================================
DROP POLICY IF EXISTS crm_threads_admin_select ON crm_threads;
CREATE POLICY crm_threads_admin_select
  ON crm_threads FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND (app_users.is_admin = true OR app_users.can_access_chats = true)
    )
  );

-- ============================================================
-- crm_messages (originally 0029_crm_mvp.sql)
-- ============================================================
DROP POLICY IF EXISTS crm_messages_admin_select ON crm_messages;
CREATE POLICY crm_messages_admin_select
  ON crm_messages FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND (app_users.is_admin = true OR app_users.can_access_chats = true)
    )
  );

-- ============================================================
-- crm_assignment_log (originally 0030_crm_phase_1.sql)
-- ============================================================
DROP POLICY IF EXISTS crm_assignment_log_admin_select ON crm_assignment_log;
CREATE POLICY crm_assignment_log_admin_select
  ON crm_assignment_log FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND (app_users.is_admin = true OR app_users.can_access_chats = true)
    )
  );

-- ============================================================
-- crm_thread_reads (originally 0035_crm_thread_reads.sql)
-- ============================================================
DROP POLICY IF EXISTS crm_thread_reads_admin_select ON crm_thread_reads;
CREATE POLICY crm_thread_reads_admin_select
  ON crm_thread_reads FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND (app_users.is_admin = true OR app_users.can_access_chats = true)
    )
  );

-- ============================================================
-- match_chat_audit_log (originally 0031_match_chat_audit_log.sql)
-- ============================================================
DROP POLICY IF EXISTS match_chat_audit_log_admin_select ON match_chat_audit_log;
CREATE POLICY match_chat_audit_log_admin_select
  ON match_chat_audit_log FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND (app_users.is_admin = true OR app_users.can_access_chats = true)
    )
  );

-- ============================================================
-- push_subscriptions (originally 0036_push_subscriptions.sql)
-- ============================================================
-- Same "user can only see their own row" constraint as before;
-- the OR just lets chats-only users qualify alongside admins.
DROP POLICY IF EXISTS push_subscriptions_admin_self ON push_subscriptions;
CREATE POLICY push_subscriptions_admin_self
  ON push_subscriptions FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND (app_users.is_admin = true OR app_users.can_access_chats = true)
        AND app_users.id = push_subscriptions.user_id
    )
  );

-- ============================================================
-- crm_canned_responses (originally 0044_crm_canned_responses.sql)
-- ============================================================
-- The original FOR ALL policy collapsed both read + write into one
-- is_admin gate. Now we need read open to can_access_chats too (so
-- a CS user can pick a template from the library) but writes
-- locked to admins (so the shared library doesn't drift). Split
-- into separate SELECT + INSERT + UPDATE + DELETE policies — same
-- net result for admins, new read-only path for chats-only users.
DROP POLICY IF EXISTS crm_canned_responses_admin_all ON crm_canned_responses;

CREATE POLICY crm_canned_responses_chats_select
  ON crm_canned_responses FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND (app_users.is_admin = true OR app_users.can_access_chats = true)
    )
  );

CREATE POLICY crm_canned_responses_admin_insert
  ON crm_canned_responses FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND app_users.is_admin = true
    )
  );

CREATE POLICY crm_canned_responses_admin_update
  ON crm_canned_responses FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND app_users.is_admin = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND app_users.is_admin = true
    )
  );

CREATE POLICY crm_canned_responses_admin_delete
  ON crm_canned_responses FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND app_users.is_admin = true
    )
  );
