-- Refactor field_week_projections to model the per-spot planning view.
--
-- Background: the original schema (migration 0006) used
-- avg_price_planned to mean "avg price per match" — a quantity that
-- conflates price with match capacity (rev / matches). The actual
-- planning lever for revenue growth is per-spot price: when a venue
-- raises prices, that's what moves. Per-match is a derived
-- sanity-check, not an input.
--
-- Changes:
--   1. Rename avg_price_planned → avg_price_per_spot_planned. The
--      column's semantic meaning changes (per-match → per-spot). Any
--      pre-existing rows are reinterpreted under the new meaning;
--      operators should re-edit them on the projections tab to
--      correct.
--   2. Add dpp_spots_planned (integer, nullable) — third planning
--      input. Projected rev becomes dpp_spots_planned ×
--      avg_price_per_spot_planned, replacing the previous
--      matches_planned × avg_price_planned model.
--
-- The unique (venue_id, week_start_date) constraint and the updated_at
-- trigger from 0006 are unaffected.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

ALTER TABLE field_week_projections
  RENAME COLUMN avg_price_planned TO avg_price_per_spot_planned;

ALTER TABLE field_week_projections
  ADD COLUMN IF NOT EXISTS dpp_spots_planned integer;
