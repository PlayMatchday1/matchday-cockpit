-- 0174 — a launch plan that was deliberately removed stays removed.
--
-- ══ WHY A COLUMN AND NOT JUST DELETING THE ROWS ══════════════════════════════════════════════
-- LaunchPlanView seeds on open as a REPAIR, so a venue bound before 0173 applied gets its rows the
-- first time somebody looks at it. That repair cannot tell "this plan was never made" from "this
-- plan was deliberately thrown away": delete the 24 rows and the next page load writes them
-- straight back. A removal that undoes itself is worse than no removal at all.
--
-- 0173's isLive() guard does not cover this. Keswick ATL Field 2 is week 6 of 20, so isLive is
-- true and the repair fires. The two refusals are about different things: one is "this field is
-- too old to have a plan", this one is "somebody decided this field should not have one".
--
-- ══ WHY IT LIVES ON fin_venues ═══════════════════════════════════════════════════════════════
-- Same reason launch_date does: it is a fact about the FIELD, not about the card that happens to
-- point at it. A card can be archived, retitled or rebound; the decision not to run a launch plan
-- for this field outlives all of that.
--
-- ══ WHAT IT DOES NOT DO ══════════════════════════════════════════════════════════════════════
-- Nothing is backfilled. Every existing row is null, and null is the "a plan is allowed" state, so
-- applying this changes no behaviour on its own. It only starts mattering once somebody presses
-- Remove this plan.
--
-- SAFE TO APPLY AFTER THE CODE DEPLOYS. The reads are defensive (select *), so an app that ships
-- before this runs simply sees the column as undefined, which reads as "not disabled" — exactly
-- what it means today.
--
-- Apply in the Supabase SQL Editor. Not applied by the app.

alter table public.fin_venues
  add column if not exists launch_plan_disabled_at timestamptz;

comment on column public.fin_venues.launch_plan_disabled_at is
  'Set when somebody removes this field''s launch plan. seedLaunchPlan refuses while it is set, so '
  'the repair pass on plan open cannot resurrect it. Cleared by starting a plan again.';
