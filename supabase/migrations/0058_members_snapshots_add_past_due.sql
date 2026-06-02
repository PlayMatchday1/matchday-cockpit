-- Add past_due_count to members_monthly_snapshots. Surfaces the
-- PAST_DUE ("Past Due") member bucket alongside active_count in the
-- Membership tab, per month. PAST_DUE members are real ongoing members
-- whose card declined and is being retried in dunning — they are NOT
-- merged into active_count (which stays ACTIVE-only); they are counted
-- and displayed as their own bucket.
--
-- Nullable on purpose, NO default: existing rows predate this column
-- and must render "—" (not 0) in the UI, so historical months read as
-- "not captured" rather than "zero past due". Only snapshots written
-- after this migration (May 2026 onward, once re-refreshed) will carry
-- a value. The per-city values ride inside the existing by_city JSON
-- column (a `pastDue` key per city), so no migration is needed for them.
--
-- members_monthly_snapshots was created directly in the Supabase
-- dashboard (no prior CREATE migration in this repo), so this is the
-- first migration to touch it.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

ALTER TABLE members_monthly_snapshots
  ADD COLUMN IF NOT EXISTS past_due_count integer;
