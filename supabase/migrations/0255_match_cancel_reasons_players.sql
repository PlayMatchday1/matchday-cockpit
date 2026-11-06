-- 0255 NOT ENOUGH PLAYERS AS A STAFF CANCEL REASON (Ryan, 2026-11-06). Staff sometimes cancel early for
-- low turnout; until now only MatchDay's own auto-cancels read as "players", inferred at read time and
-- never stored. The reason check admits 'players' so a staff pick is stored under the same value and
-- Health counts both together; set_by says which it was (every row written so far is staff's, so the
-- default backfills them; 'auto' is for a future writer that stores MatchDay's own cancels).
--
-- Locking: ALTER TABLE on a small table (one row per Clubhouse cancel), momentary. Rollback: the two
-- statements in reverse with the old five-value list, and DROP COLUMN set_by.
--
-- Applied by hand in the Supabase SQL Editor (Ryan applies migrations himself).

BEGIN;

ALTER TABLE public.match_cancel_reasons
  DROP CONSTRAINT IF EXISTS match_cancel_reasons_reason_check;
ALTER TABLE public.match_cancel_reasons
  ADD CONSTRAINT match_cancel_reasons_reason_check
  CHECK (reason IN ('players', 'weather', 'manager', 'facility', 'slate_change', 'other'));

ALTER TABLE public.match_cancel_reasons
  ADD COLUMN IF NOT EXISTS set_by text NOT NULL DEFAULT 'staff'
  CHECK (set_by IN ('staff', 'auto'));

COMMIT;
