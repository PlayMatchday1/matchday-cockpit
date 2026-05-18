-- ============================================================
-- schedule_master — CRUD (audit log + write RLS)
-- ============================================================
-- Builds on 0038 (which created schedule_master and an admin-read
-- RLS policy). Adds:
--   * schedule_master_audit  — append-only ledger of all
--                              create/update/delete operations on
--                              schedule_master rows, keyed on the
--                              operator's session email plus the
--                              before/after JSON shape.
--   * schedule_master_admin_write  — RLS for INSERT / UPDATE /
--                              DELETE, mirroring the existing
--                              admin-read policy.
--
-- The audit table is never modified directly — its rows are
-- inserted by API routes after each successful write to
-- schedule_master. The row_id is nullable on DELETE rows since
-- the parent row is gone by the time the audit row lands.
-- ============================================================

CREATE TABLE IF NOT EXISTS schedule_master_audit (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  row_id       uuid,
  action       text          NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  user_email   text          NOT NULL,
  old_values   jsonb,
  new_values   jsonb,
  created_at   timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS schedule_master_audit_created_idx
  ON schedule_master_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS schedule_master_audit_row_idx
  ON schedule_master_audit(row_id);

DROP POLICY IF EXISTS schedule_master_admin_write ON schedule_master;
CREATE POLICY schedule_master_admin_write
  ON schedule_master FOR ALL TO authenticated
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
