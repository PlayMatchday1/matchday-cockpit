-- 0086: pace start date for goals.
--
-- Goal pace is computed as coalesce(start_date, created_at::date). Existing
-- rows have no start_date, so they fall back to created_at (a declared, not
-- hidden, fallback — see computeGoalPace in src/lib/goalPace.ts). Backfill real
-- start dates for any backdated goals as desired; the column is nullable.
--
-- Apply in the Supabase SQL Editor before/with the Home-rebuild deploy.

alter table goals add column if not exists start_date date;
