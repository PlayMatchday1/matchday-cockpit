-- Gusto alias: an optional EMAIL override, alongside the existing name override.
--
-- The alias panel on Manager Pay already overrides the CSV's First/Last name. The Email column
-- still came from the manager's MatchDay address, which is not always the address Gusto pays —
-- Adam's payroll record is a business account, not the address he signs into Clubhouse with.
--
-- NULLABLE AND UNCONSTRAINED, deliberately, and different from the name columns above it:
--   * The name columns are NOT NULL with a non-empty CHECK, because a name alias that exists must
--     say who it pays. An email alias is an OVERRIDE — absent is the ordinary case and means "use
--     the schedule email", so NULL has to be legal.
--   * No UNIQUE index. The name pair carries one (manager_gusto_aliases_name_uniq) because two
--     managers mapping to one Gusto worker is a payroll error. Two rows sharing a payout email is
--     not obviously wrong — a household, a single LLC billing for two people — and this migration
--     is not the place to decide it. If it should be unique, that is its own change with its own
--     evidence.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run BEFORE deploying the code that writes
-- it. The GET path reads with select("*") and tolerates the column's absence; the PUT path does
-- not, and will fail loudly rather than silently if this has not been applied.

ALTER TABLE manager_gusto_aliases
  ADD COLUMN IF NOT EXISTS gusto_email text
    CHECK (gusto_email IS NULL OR gusto_email = lower(btrim(gusto_email)));
