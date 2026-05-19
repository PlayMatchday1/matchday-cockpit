-- ============================================================
-- Backfill fin_schedule.fin_venue_id (PR-F)
-- ============================================================
-- Run in Supabase SQL Editor AFTER migration 0043 has been applied.
-- Resolves each existing fin_schedule row's (city, venue) to a
-- fin_venues.id via fin_venue_aliases when needed. Rows that
-- can't resolve unambiguously stay NULL — the verification
-- queries at the bottom surface the unresolved count + samples.
--
-- Idempotent: only touches rows where fin_venue_id IS NULL, so
-- re-running after partial application or after operators have
-- linked some rows via the UI is safe.
-- ============================================================

-- Backfill: deterministic match via array_agg.
-- Only updates rows where the (alias-or-direct) → fin_venues
-- join produces exactly one candidate venue id. If a venue
-- string somehow matches multiple fin_venues rows (shouldn't
-- happen due to UNIQUE (city, venue_name) on fin_venues, but
-- defensive against alias-table drift), the row stays NULL for
-- manual review.
WITH candidate_match AS (
  SELECT
    s.id AS schedule_id,
    array_agg(DISTINCT v.id) AS venue_ids
  FROM fin_schedule s
  LEFT JOIN fin_venue_aliases a ON a.alias = s.venue
  JOIN fin_venues v
    ON v.city = s.city
    AND v.venue_name = COALESCE(a.canonical_venue, s.venue)
  WHERE s.fin_venue_id IS NULL
  GROUP BY s.id
)
UPDATE fin_schedule s
SET fin_venue_id = c.venue_ids[1]
FROM candidate_match c
WHERE s.id = c.schedule_id
  AND array_length(c.venue_ids, 1) = 1;

-- ============================================================
-- Verification queries — run after the UPDATE above.
-- ============================================================

-- Q1: total fin_schedule rows.
SELECT COUNT(*) AS total_rows FROM fin_schedule;

-- Q2: backfill outcome breakdown.
SELECT
  COUNT(*) FILTER (WHERE fin_venue_id IS NOT NULL) AS backfilled,
  COUNT(*) FILTER (WHERE fin_venue_id IS NULL)     AS not_backfilled
FROM fin_schedule;

-- Q3: per-(city, venue) rollup of unresolved rows. Surfaces
-- which venue strings need manual resolution via the UI.
SELECT
  city,
  venue,
  COUNT(*) AS unresolved_rows,
  MIN(date) AS earliest_date,
  MAX(date) AS latest_date
FROM fin_schedule
WHERE fin_venue_id IS NULL
GROUP BY city, venue
ORDER BY COUNT(*) DESC, city, venue;
