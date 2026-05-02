-- Weekly per-venue planning data. Read+write by /admin/finance
-- Projections tab. Internal admin only — no anon access.
--
-- The unique (venue_id, week_start_date) constraint backs the
-- upsert in saveProjection(); deleteProjection() is the "reset to
-- default" path. updated_at is auto-stamped on UPDATE.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

CREATE TABLE IF NOT EXISTS field_week_projections (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id            integer       NOT NULL REFERENCES fin_venues(id) ON DELETE CASCADE,
  week_start_date     date          NOT NULL,
  matches_planned     integer,
  avg_price_planned   numeric(10,2),
  notes               text,
  updated_at          timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (venue_id, week_start_date)
);

CREATE INDEX IF NOT EXISTS field_week_projections_venue_week_idx
  ON field_week_projections(venue_id, week_start_date);

CREATE OR REPLACE FUNCTION field_week_projections_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS field_week_projections_updated_at ON field_week_projections;
CREATE TRIGGER field_week_projections_updated_at
  BEFORE UPDATE ON field_week_projections
  FOR EACH ROW EXECUTE FUNCTION field_week_projections_set_updated_at();

ALTER TABLE field_week_projections ENABLE ROW LEVEL SECURITY;

-- Authenticated cockpit users only. No anon read/write — this is
-- internal planning data, not partner-facing.
DROP POLICY IF EXISTS field_week_projections_auth ON field_week_projections;
CREATE POLICY field_week_projections_auth
  ON field_week_projections FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
