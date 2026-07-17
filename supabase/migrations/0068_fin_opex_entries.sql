-- OpEx Calendar: cash-outflow entries for the new Finance tab.
-- One row per scheduled expense; recurring entries (weekly/monthly/
-- quarterly/annually) are expanded into individual instances in the
-- app at render time, so the table stores only the base entry + its
-- recurrence rule, never the expanded occurrences.
--
-- Phase 1: manual entry + display. Phase 2 will auto-populate from
-- other sources (manager pay, field costs, etc.).
--
-- RLS + updated_at trigger follow the finance_actions convention
-- (authenticated cockpit users read+write; page guard enforces admin).
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

CREATE TABLE IF NOT EXISTS fin_opex_entries (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  category          text          NOT NULL
                                  CHECK (category IN (
                                    'city_manager','match_manager','field_cost',
                                    'marketing','personnel','equipment','other'
                                  )),
  subcategory       text,                        -- e.g. 'PRUMC', 'Meta Ads', 'George Pazos', 'VEO Cam'
  amount            numeric       NOT NULL,
  scheduled_date    date          NOT NULL,
  recurrence        text          NOT NULL DEFAULT 'one_time'
                                  CHECK (recurrence IN (
                                    'one_time','weekly','monthly','quarterly','annually'
                                  )),
  recurrence_end    date,                        -- when recurring stops; NULL = indefinite
  notes             text,
  created_by        uuid          REFERENCES app_users(id) ON DELETE SET NULL,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fin_opex_entries_scheduled_date_idx
  ON fin_opex_entries(scheduled_date);
CREATE INDEX IF NOT EXISTS fin_opex_entries_category_idx
  ON fin_opex_entries(category);

-- RLS: authenticated cockpit users read+write. Same shape as
-- finance_actions and the other internal-only finance tables.
ALTER TABLE fin_opex_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fin_opex_entries_auth ON fin_opex_entries;
CREATE POLICY fin_opex_entries_auth
  ON fin_opex_entries FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- updated_at maintenance.
CREATE OR REPLACE FUNCTION fin_opex_entries_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fin_opex_entries_updated_at ON fin_opex_entries;
CREATE TRIGGER fin_opex_entries_updated_at
  BEFORE UPDATE ON fin_opex_entries
  FOR EACH ROW EXECUTE FUNCTION fin_opex_entries_set_updated_at();
