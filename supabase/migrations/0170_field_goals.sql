-- 0170 — 2026 DAILY MATCHES: the goal rows, their monthly targets, and their actions.
--
-- ══ WHAT IS STORED HERE IS ONLY WHAT CANNOT BE COMPUTED ══════════════════════════════════════
-- The September column, every month's daily average, the weekly equivalent, the gap, the band, the
-- totals and the October/November ramp are ALL derived from mdapi_matches on every load. The sheet
-- this replaces stores a "Total MD" of 16.7 while its own 29 rows sum to 16.6 — that is what a
-- derived number stored by hand looks like. Nothing derivable is written here.
--
-- Stored: a target per row per month, the not-yet-existing field slots, and the actions.
--
-- ══ THE ROW IS A VENUE, NOT AN mdapi FIELD, AND THAT IS MEASURED ═════════════════════════════
-- mdapi_matches carries 46 distinct field_ids in 2026 but the sheet has 29 rows, because a venue
-- runs several mdapi fields: ATH Pearland is field 22 AND "Tourney ATH Pearland", Soccer Central is
-- 102 and 199, NEMP is 17 and 10, ATH Katy is 1552 and 892, Round Rock is 12 and 25. One goal
-- belongs to the venue, so the row is keyed on fin_venues.id through fin_venue_fields — an ID join
-- the estate already maintains, never a name join. Measured 2026-09-12: 45 of those 46 field_ids
-- map to a fin_venue.
--
-- THE FORTY-SIXTH IS WARSAW. Hala Piłkarska Bemowo (mdapi field 1684) has 8 matches this September
-- and NO fin_venue_fields row, so a venue-only key would silently drop a city. Hence three
-- identities, exactly one of which is set per row:
--
--   venue_id   a mapped venue           (the normal case)
--   field_id   an mdapi field with no fin_venue mapping yet (Warsaw today)
--   slot_name  a field that does not exist yet — "New Field - Houston" has nothing to point at
--
-- A SLOT GRADUATES BY BEING POINTED AT A VENUE, not by being deleted and retyped: set venue_id and
-- clear slot_name, and every goal and action typed against the slot survives the transition.
--
-- ══ A MONTH WITH NO ROW IS NOT A ZERO ═══════════════════════════════════════════════════════
-- field_goal_targets holds a row only where somebody has set a target. An absent target is an
-- absent target: it renders as "no goal", it adds nothing to the December total, and the ramp fills
-- October and November on screen WITHOUT EVER BEING WRITTEN. `month` is the first of the month, so
-- 2027 needs no migration.
--
-- ══ RLS: GROWTH, FROM THE START ═════════════════════════════════════════════════════════════
-- 0166 had to retrofit this onto the kanban tables and its header explains why at length: the
-- browser holds the user's JWT and can query PostgREST directly, so a UI capability gate is not a
-- boundary. This page carries every field's volume and the whole 2026 expansion plan. The predicate
-- is 0166's, reused verbatim in shape: joined on EMAIL (app_users.id is not the auth uid — 16 of 17
-- rows differ), confinement beats is_admin, service accounts refused.
--
-- Apply in the Supabase SQL Editor. Not applied by the app.

begin;

-- ── the predicate ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.growth_pages_readable()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER                 -- reads app_users, which authenticated cannot select freely
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.app_users u
    WHERE lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      AND coalesce(u.city_identifier, '') = ''
      AND coalesce(u.is_service_account, false) = false
      AND (u.is_admin OR u.can_access_growth)
  );
$$;

REVOKE ALL ON FUNCTION public.growth_pages_readable() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.growth_pages_readable() TO authenticated, service_role;

-- ── the rows ─────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.field_goal_rows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id    bigint REFERENCES public.fin_venues(id) ON DELETE CASCADE,
  field_id    bigint,                       -- an mdapi field with no fin_venue mapping
  slot_name   text,                         -- a field that does not exist yet
  city        text,                         -- typed for a slot; derived for the other two
  sort_order  double precision NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- EXACTLY ONE IDENTITY. A row that is two things at once is a row nothing can key on.
  CONSTRAINT field_goal_rows_one_identity CHECK (
    (venue_id IS NOT NULL)::int + (field_id IS NOT NULL)::int
      + (slot_name IS NOT NULL AND btrim(slot_name) <> '')::int = 1
  )
);
-- One row per venue and per unmapped field; slots are free-form and may repeat a name.
CREATE UNIQUE INDEX IF NOT EXISTS field_goal_rows_venue_uq ON public.field_goal_rows (venue_id) WHERE venue_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS field_goal_rows_field_uq ON public.field_goal_rows (field_id) WHERE field_id IS NOT NULL;

-- ── the monthly targets ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.field_goal_targets (
  row_id      uuid NOT NULL REFERENCES public.field_goal_rows(id) ON DELETE CASCADE,
  month       date NOT NULL,                -- always the first of the month
  goal_daily  numeric(6,2) NOT NULL CHECK (goal_daily >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (row_id, month),
  CONSTRAINT field_goal_targets_month_is_first CHECK (month = date_trunc('month', month)::date)
);

-- ── the actions ──────────────────────────────────────────────────────────────────────────────
-- NOT kanban_checklist_items. That table's rows hang off kanban_cards.card_id and inherit a BOARD's
-- gate; an action here hangs off a goal row, which is a venue or a slot and has no card. Reusing it
-- would have meant inventing a kanban card per field to hold a to-do, which is a worse join than a
-- second table. The SHAPE is deliberately the same (text, done, sort_order, owner) so the treatment
-- can be ported without a second concept on screen.
CREATE TABLE IF NOT EXISTS public.field_goal_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  row_id        uuid NOT NULL REFERENCES public.field_goal_rows(id) ON DELETE CASCADE,
  text          text NOT NULL CHECK (btrim(text) <> ''),
  done          boolean NOT NULL DEFAULT false,
  owner_user_id uuid,
  sort_order    double precision NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS field_goal_actions_row_idx ON public.field_goal_actions (row_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.field_goal_rows    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.field_goal_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.field_goal_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS field_goal_rows_rw ON public.field_goal_rows;
CREATE POLICY field_goal_rows_rw ON public.field_goal_rows
  FOR ALL TO authenticated
  USING (public.growth_pages_readable()) WITH CHECK (public.growth_pages_readable());

-- The targets and the actions ride on their row, the way 0166's checklist rides on its card.
DROP POLICY IF EXISTS field_goal_targets_rw ON public.field_goal_targets;
CREATE POLICY field_goal_targets_rw ON public.field_goal_targets
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.field_goal_rows r
                 WHERE r.id = field_goal_targets.row_id AND public.growth_pages_readable()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.field_goal_rows r
                 WHERE r.id = field_goal_targets.row_id AND public.growth_pages_readable()));

DROP POLICY IF EXISTS field_goal_actions_rw ON public.field_goal_actions;
CREATE POLICY field_goal_actions_rw ON public.field_goal_actions
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.field_goal_rows r
                 WHERE r.id = field_goal_actions.row_id AND public.growth_pages_readable()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.field_goal_rows r
                 WHERE r.id = field_goal_actions.row_id AND public.growth_pages_readable()));

-- updated_at, maintained rather than trusted to callers.
CREATE OR REPLACE FUNCTION public.field_goals_touch() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS field_goal_rows_touch ON public.field_goal_rows;
CREATE TRIGGER field_goal_rows_touch BEFORE UPDATE ON public.field_goal_rows
  FOR EACH ROW EXECUTE FUNCTION public.field_goals_touch();
DROP TRIGGER IF EXISTS field_goal_targets_touch ON public.field_goal_targets;
CREATE TRIGGER field_goal_targets_touch BEFORE UPDATE ON public.field_goal_targets
  FOR EACH ROW EXECUTE FUNCTION public.field_goals_touch();
DROP TRIGGER IF EXISTS field_goal_actions_touch ON public.field_goal_actions;
CREATE TRIGGER field_goal_actions_touch BEFORE UPDATE ON public.field_goal_actions
  FOR EACH ROW EXECUTE FUNCTION public.field_goals_touch();

commit;
