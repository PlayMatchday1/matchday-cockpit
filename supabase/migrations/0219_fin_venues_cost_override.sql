-- 0219 — COST PER MATCH OVERRIDE (Ryan, 2026-10-09). Optional, with a required note.
--
-- Applied by hand in the Supabase SQL Editor. One rate per field: Field Costs (per_match_rate,
-- rate_days) is the single source for cost per match, and fin_venues.cost_per_match is no longer read
-- (kept, not dropped). For the rare field whose cost per match is not its invoice rate, Field Costs
-- sets this override WITH a note; when set it wins on every page and the Field cost / match hover
-- shows the note. It does not change billing. RLS: unchanged — fin_venues' row policies cover the
-- new columns as they cover every other.

BEGIN;
ALTER TABLE public.fin_venues
  ADD COLUMN cost_override_per_match numeric(10,2),
  ADD COLUMN cost_override_note      text,
  ADD CONSTRAINT fin_venues_cost_override_pair CHECK (
    (cost_override_per_match IS NULL AND cost_override_note IS NULL)
    OR (cost_override_per_match IS NOT NULL AND cost_override_per_match >= 0
        AND cost_override_note IS NOT NULL AND btrim(cost_override_note) <> '')
  );
COMMIT;
