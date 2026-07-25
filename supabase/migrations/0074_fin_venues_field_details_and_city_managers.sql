-- Fields management page (Cities → Fields sub-tab).
--
-- Extends the CANONICAL venue record (fin_venues — the same row Finance
-- bills via buildFieldCostRows, and that scheduling resolves to through
-- fin_venue_fields.mdapi_field_id). No new venue/fields table: the page
-- reads and writes fin_venues, and these columns are added onto it.
--
-- Column mapping (confirmed against live data):
--   Field (short internal name)  = EXISTING fin_venues.venue_name (unchanged)
--   Field Name (full facility)   = new field_name
--   Contact Name / Number        = new contact_name / contact_number
--   Min Players / Max Players    = new min_players / max_players — SEPARATE
--                                  from max_spots (booking capacity), which
--                                  stays untouched. These are the field
--                                  roster's own reference numbers.
--   Schedule link                = new schedule_url (validated http(s) on save)
--   City                         = EXISTING fin_venues.city (input constrained
--                                  to the app's canonical CITIES list)
--
-- min_players note: no "minimum to run a match" threshold exists in the
-- scheduling/cancellation code — run/cancel status comes from the upstream
-- mdapi_matches.is_cancelled flag. So min_players is a reference column
-- only; it is NOT wired into any cancellation/run-rate logic.
--
-- Apply via Supabase Dashboard → SQL Editor. Heads-up (same as 0071): the
-- Realtime schema cache can briefly lag an ALTER … ADD COLUMN. If the page
-- appears to write undefined over a good value in the seconds right after
-- you run this, that's the cache warming up, not the code — reload once.

ALTER TABLE fin_venues
  ADD COLUMN IF NOT EXISTS field_name     text,
  ADD COLUMN IF NOT EXISTS contact_name   text,
  ADD COLUMN IF NOT EXISTS contact_number text,
  ADD COLUMN IF NOT EXISTS min_players    integer,
  ADD COLUMN IF NOT EXISTS max_players    integer,
  ADD COLUMN IF NOT EXISTS schedule_url   text;

-- ============================================================
-- city_managers — authoritative city → City Manager roster
-- ============================================================
-- The City Manager is DERIVED from a venue's city, never stored on the
-- venue, so it can never drift from the roster. The Fields page joins
-- fin_venues.city → city_managers.city to show the CM chip. `city` uses
-- the SAME labels as fin_venues.city / lib/types CITIES.
CREATE TABLE IF NOT EXISTS city_managers (
  city         text        PRIMARY KEY,
  manager_name text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Seed the cities that have a manager, canonical spellings. Atlanta and
-- El Paso are intentionally ABSENT → the page shows "Unassigned".
INSERT INTO city_managers (city, manager_name) VALUES
  ('Houston',     'Yarra'),
  ('Austin',      'Garrett'),
  ('OKC',         'Rodrigo'),
  ('St. Louis',   'Willfried'),
  ('Dallas',      'Chris'),
  ('San Antonio', 'Abraham')
ON CONFLICT (city) DO NOTHING;

-- RLS: authenticated cockpit users read+write, same shape as the other
-- internal finance tables (fin_opex_entries). Admin gating is enforced at
-- the app layer by PagePermissionGuard, matching the other Cities sub-tabs.
ALTER TABLE city_managers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS city_managers_auth ON city_managers;
CREATE POLICY city_managers_auth
  ON city_managers FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION city_managers_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS city_managers_updated_at ON city_managers;
CREATE TRIGGER city_managers_updated_at
  BEFORE UPDATE ON city_managers
  FOR EACH ROW EXECUTE FUNCTION city_managers_set_updated_at();
