-- Expand projection identity from (venue, week) to (venue, week, slot).
--
-- Background: a "slot" is a recurring (venue, day-of-week, time) combination
-- that operationally maps to one match cadence — e.g., "NEMP Mon 7:30pm"
-- is a different operational unit from "NEMP Tue 7:30pm" and from
-- "NEMP Mon 8:30pm". Planning at the venue level (the prior model) was
-- under-specified; planning at the slot level matches how operators
-- actually schedule and forecast.
--
-- Pre-existing rows in field_week_projections at the time of this
-- migration: 0 (verified). The table is truncated to allow adding the
-- new identity columns as NOT NULL without a backfill rule that would
-- be wrong for any meaningful data.
--
-- Schema changes:
--   1. ADD slot_day_of_week smallint NOT NULL — 0=Sun .. 6=Sat
--   2. ADD slot_time text NOT NULL — "HH:MM" 24-hour, e.g. "19:30"
--   3. DROP UNIQUE(venue_id, week_start_date)
--   4. ADD UNIQUE(venue_id, week_start_date, slot_day_of_week, slot_time)
--   5. Replace the supporting index to match the new unique key.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

TRUNCATE field_week_projections;

ALTER TABLE field_week_projections
  DROP CONSTRAINT field_week_projections_venue_id_week_start_date_key;

ALTER TABLE field_week_projections
  ADD COLUMN slot_day_of_week smallint NOT NULL
    CHECK (slot_day_of_week BETWEEN 0 AND 6),
  ADD COLUMN slot_time text NOT NULL
    CHECK (slot_time ~ '^[0-2][0-9]:[0-5][0-9]$');

ALTER TABLE field_week_projections
  ADD CONSTRAINT field_week_projections_venue_week_slot_key
  UNIQUE (venue_id, week_start_date, slot_day_of_week, slot_time);

DROP INDEX IF EXISTS field_week_projections_venue_week_idx;
CREATE INDEX field_week_projections_venue_week_slot_idx
  ON field_week_projections(venue_id, week_start_date, slot_day_of_week, slot_time);
