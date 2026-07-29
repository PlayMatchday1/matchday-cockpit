-- Manager → Gusto name alias for the payroll CSV export.
--
-- Optional, one row per manager (keyed by the stable manager_email that
-- /managers already keys on). When present, the Gusto CSV writes
-- gusto_first_name / gusto_last_name VERBATIM into the First/Last columns
-- (no re-splitting — that's the bug that produced "Troy,," with an empty
-- last name). No row → the export is unchanged for that manager.
--
-- Correctness guards enforced by the DB, not just the UI, because a wrong
-- mapping pays the wrong person and the CSV still looks fine:
--   • manager_email must be lowercase (CHECK) — the compute keys on
--     lower(manager_email); a mixed-case row would never match, so reject it.
--   • both name parts required and non-blank (CHECK) — the whole point is
--     to fix empty last names.
--   • (lower(first), lower(last)) is UNIQUE — two managers must not map to
--     the same Gusto worker, case-insensitively.
--
-- Side table only. Nothing here touches a synced mdapi_* table.
-- RLS mirrors manager_pay_adjustments: authenticated SELECT; all writes go
-- through the service role in the admin-gated API route (no write policy).
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run BEFORE deploying.

CREATE TABLE IF NOT EXISTS manager_gusto_aliases (
  manager_email     text        PRIMARY KEY
                                 CHECK (manager_email = lower(manager_email)),
  gusto_first_name  text        NOT NULL
                                 CHECK (length(btrim(gusto_first_name)) > 0),
  gusto_last_name   text        NOT NULL
                                 CHECK (length(btrim(gusto_last_name)) > 0),
  note              text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid        REFERENCES app_users(id)
);

-- Two managers must not map to the same Gusto worker (case-insensitive,
-- trimmed). DB-enforced, not UI-only.
CREATE UNIQUE INDEX IF NOT EXISTS manager_gusto_aliases_name_uniq
  ON manager_gusto_aliases (lower(btrim(gusto_first_name)), lower(btrim(gusto_last_name)));

ALTER TABLE manager_gusto_aliases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS manager_gusto_aliases_auth_select ON manager_gusto_aliases;
CREATE POLICY manager_gusto_aliases_auth_select
  ON manager_gusto_aliases FOR SELECT TO authenticated USING (true);
-- No INSERT/UPDATE/DELETE policy: writes are service-role only, from the
-- is_admin-gated /api/manager-pay/aliases route (mirrors manager_pay_adjustments).
