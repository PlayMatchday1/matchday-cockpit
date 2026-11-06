-- 0254 — HIDDEN: a field that is off the 2026 Daily Matches page entirely (Ryan, 2026-11-05, v2 frame).
--
-- NOT COUNTED (0171) keeps the row visible and greyed so the decision stays reviewable. HIDDEN is
-- the ask that followed: "a way to hide a field completely" — it drops out of the list and out of
-- every total (city row, chart, KPI tiles, All MatchDay), and comes back from "Show N hidden"
-- inside its city with Unhide. Same shape as growth_cities.hidden (0253): the flag, who, when.
--
-- IT IS A PROPERTY OF THIS PAGE'S ROW AND NOTHING ELSE. It touches no venue, no match, nothing
-- outside Growth. Existing venues get a field_goal_rows row the first time something is stored
-- against them (ensureRow), exactly as a target or not_counted does.
--
-- THE CODE DOES NOT WAIT FOR THIS, and it does not pretend either. The route selects "*" and
-- reports hideSupported = the column exists; until it does, the field menu offers no Hide item at
-- all (deploy-before-migration, 0171's rule, with the control held back rather than tolerated).
--
-- Apply in the Supabase SQL Editor. Not applied by the app.

begin;

ALTER TABLE public.field_goal_rows
  ADD COLUMN IF NOT EXISTS hidden    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hidden_at timestamptz,
  ADD COLUMN IF NOT EXISTS hidden_by text;

COMMENT ON COLUMN public.field_goal_rows.hidden IS
  'Set by a person on 2026 Daily Matches: this field is off the page — out of the list and out of every total — until unhidden from "Show N hidden" in its city. Affects only that page; nothing outside Growth reads it. Not the same as not_counted (listed, greyed, out of totals) nor dormant (computed from the matches, still counts).';

commit;
