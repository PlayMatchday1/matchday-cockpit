-- 0171 — "NOT COUNTED": the one fact about a field that nothing in mdapi_matches can tell you.
--
-- Ryan: "there should be a way to hide to old rows we dont have games anymore also to remove count
-- fields like for instance warsaw is a partner on a different stripe so that one too".
--
-- TWO ASKS, TWO MECHANISMS, AND ONLY THIS ONE NEEDS A COLUMN.
--
--   DORMANT is computed, never stored. A field with no match in the month on screen has gone quiet,
--   and that is readable from the matches — nobody should tidy the table by hand for the same
--   reason nobody types the September column. It folds into one line at the foot of the table and
--   STILL COUNTS in the arithmetic: a field that ran matches in June contributed to June, and the
--   year chart must keep it. Dormancy is about the table's length, not the totals.
--
--   NOT COUNTED is a human fact. "Warsaw is a partner on a different stripe" appears nowhere in
--   mdapi_matches and never will; it is a decision, so it is a flag a person sets. The row stays
--   VISIBLE and greyed — hiding it would mean nobody ever reviews the decision — and it leaves every
--   total and the chart together, through one predicate both read.
--
-- IT IS A PROPERTY OF THE ROW, NOT OF A MONTH. A field excluded from the plan is excluded from all
-- of it; a per-month exclusion would be a different thing and nobody asked for one.
--
-- Apply in the Supabase SQL Editor. Not applied by the app.
--
-- THE CODE DOES NOT WAIT FOR THIS. The route selects field_goal_rows with "*" and reads
-- not_counted defensively (`=== true`), the way adminAuth reads app_users, because code deploys
-- before a migration is applied and a named column that does not exist yet 500s the whole route.
-- Before this lands, every row simply counts — which is today's behaviour.

begin;

ALTER TABLE public.field_goal_rows
  ADD COLUMN IF NOT EXISTS not_counted boolean NOT NULL DEFAULT false;

-- Who set it and when, because a decision with no author is a decision nobody can review.
ALTER TABLE public.field_goal_rows
  ADD COLUMN IF NOT EXISTS not_counted_by text,
  ADD COLUMN IF NOT EXISTS not_counted_at timestamptz;

COMMENT ON COLUMN public.field_goal_rows.not_counted IS
  'Set by a person: this field is deliberately outside the 2026 plan (e.g. a partner on a separate Stripe account). The row stays visible and greyed; it leaves every total and the year chart through one shared predicate. NOT the same as dormant, which is computed from the matches and still counts.';

commit;
