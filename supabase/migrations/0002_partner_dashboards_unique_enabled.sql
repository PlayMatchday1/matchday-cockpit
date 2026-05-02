-- One-active-dashboard-per-venue invariant. Defense in depth alongside
-- the application-level pre-insert check in PartnerAddDialog: the DB
-- backstops races and any future code path that bypasses the app
-- check.
--
-- Partial: a venue may have many disabled (historical) rows, but only
-- one row with enabled = true at any time.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

CREATE UNIQUE INDEX IF NOT EXISTS partner_dashboards_one_enabled_per_venue
  ON partner_dashboards(venue_id)
  WHERE enabled = true;
