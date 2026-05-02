-- Partner-facing dashboards. The `slug` is the access secret — anyone
-- holding a slug URL can view that dashboard. Internal users manage
-- rows from /admin/partners.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

CREATE TABLE IF NOT EXISTS partner_dashboards (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text        UNIQUE NOT NULL,
  venue_id      integer     NOT NULL REFERENCES fin_venues(id) ON DELETE RESTRICT,
  partner_name  text        NOT NULL,
  enabled       boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partner_dashboards_slug_idx
  ON partner_dashboards(slug);

CREATE INDEX IF NOT EXISTS partner_dashboards_venue_idx
  ON partner_dashboards(venue_id);

-- updated_at maintenance.
CREATE OR REPLACE FUNCTION partner_dashboards_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS partner_dashboards_updated_at ON partner_dashboards;
CREATE TRIGGER partner_dashboards_updated_at
  BEFORE UPDATE ON partner_dashboards
  FOR EACH ROW EXECUTE FUNCTION partner_dashboards_set_updated_at();

ALTER TABLE partner_dashboards ENABLE ROW LEVEL SECURITY;

-- Anonymous (public) reads only see enabled rows. Knowing the slug is
-- the access grant — RLS restricts to enabled to prevent disabled
-- dashboards from being readable.
DROP POLICY IF EXISTS partner_dashboards_anon_read ON partner_dashboards;
CREATE POLICY partner_dashboards_anon_read
  ON partner_dashboards FOR SELECT TO anon
  USING (enabled = true);

-- Authenticated cockpit users read everything (admin list view).
DROP POLICY IF EXISTS partner_dashboards_auth_read ON partner_dashboards;
CREATE POLICY partner_dashboards_auth_read
  ON partner_dashboards FOR SELECT TO authenticated
  USING (true);

-- Authenticated users manage rows (CRUD on /admin/partners).
DROP POLICY IF EXISTS partner_dashboards_auth_write ON partner_dashboards;
CREATE POLICY partner_dashboards_auth_write
  ON partner_dashboards FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Seed: PAC Global. fin_venues.id=10. Slug printed back for the
-- partner-facing URL.
INSERT INTO partner_dashboards (slug, venue_id, partner_name, enabled)
VALUES ('pac-global-7vdybfv4', 10, 'PAC Global', true)
ON CONFLICT (slug) DO NOTHING;
