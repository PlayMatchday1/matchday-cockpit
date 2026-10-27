-- 0234 LOCATIONS PLAYED FIELDS, EXACT (2026-10-27). Two things 0233 lost on the way back from the
-- database, found by the before/after comparison (map.playFields, 2 fields of 77):
--
--   lat / lng  double precision comes back through the API at 15 significant digits
--              (38.62820231288918 read as 38.6282023128892). numeric returns exactly what was written.
--   ord        the order the history read first met each field. The live read kept that order and a
--              venue's position is the mean of its fields' positions, so the order reaches its last digit.
--
-- The hourly refresh rewrites every row, so the 77 rows converted here are replaced within the hour.

alter table public.locations_played_fields
  add column if not exists ord integer,
  alter column lat type numeric using lat::numeric,
  alter column lng type numeric using lng::numeric;
