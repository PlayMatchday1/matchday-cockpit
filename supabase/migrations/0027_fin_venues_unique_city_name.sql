-- ============================================================
-- Migration 0027 — Unique (city, venue_name) on fin_venues
--
-- Defends against duplicate venue inserts from the new Add Venue
-- dialog (and any future import path). The dashboard's read-side
-- helpers — especially venueNormalization.byCanonical (first-write-
-- wins on (city, venue_name)) and groupVenues — assume one row per
-- (city, venue_name) pair. A duplicate quietly hides revenue/cost
-- on the loser row.
--
-- Pre-merge safety: prod scan returned ZERO collisions across 23
-- rows, so the unique index applies cleanly on first run.
--
-- Idempotent — IF NOT EXISTS makes a re-run a no-op.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS fin_venues_city_name_uidx
  ON fin_venues(city, venue_name);

-- ============================================================
-- ROLLBACK (only if the constraint has to be removed)
-- ============================================================
-- DROP INDEX IF EXISTS fin_venues_city_name_uidx;
