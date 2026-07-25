-- Retire the field_name column added in 0074.
--
-- The Fields page dropped the "Field Name (full facility)" concept — we
-- keep a single name, "Field" = fin_venues.venue_name. No code references
-- field_name anymore (removed in the same change that ships this), so
-- this DROP is SAFE TO APPLY ANY TIME, or to leave un-applied: the column
-- just sits dormant and unread. Unlike the ADD migrations, there is no
-- ordering hazard here — the code was updated first to stop touching it.
--
-- field_name held no data worth keeping (added 0074, never populated
-- through the UI).
--
-- Apply via Supabase Dashboard → SQL Editor whenever convenient.

ALTER TABLE fin_venues
  DROP COLUMN IF EXISTS field_name;
