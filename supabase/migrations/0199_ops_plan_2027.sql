-- 0199 — 2027 OPERATIONS PLAN: regions, plan cities, per-year field plan facts, spot estimates,
-- hires, and the anchor threshold.
--
-- ══ IT EXTENDS THE 2026 GOAL TABLES, IT DOES NOT SIT BESIDE THEM ═════════════════════════════
-- A field is still a field_goal_rows row (venue / unmapped mdapi field / slot, exactly one) and a
-- monthly estimate is still a field_goal_targets row keyed (row_id, month). What is new is only
-- what those tables cannot say: which region a city is in, when a city launches, how many anchors
-- it has room for, and — per plan year — whether a field is live, planned or removed, when it
-- opens and what it is meant to be.
--
-- ══ THERE IS NO CITY-LEVEL ESTIMATE, AND THAT IS THE DESIGN ══════════════════════════════════
-- Ryan, 2026-10-02: "Keep the 2026 rule: every total is the sum of its parts." The forecast's city
-- figures are carried by ROWS: each planned 2027 field holds its ramp, and one row per city —
-- role 'forecast_base', labelled "Existing fields (forecast base)" — holds the city's seeded spots
-- minus those ramps. The city total is the sum of its rows and equals the forecast by construction.
--
-- ══ ESTIMATES ARE STORED IN SPOTS, NOT goal_daily ════════════════════════════════════════════
-- goal_daily is numeric(6,2) matches a day. Richmond's December is 29 spots = 0.054 a day, which
-- stores as 0.05 = 27 spots: 7% of a launch city lost to a column type. 2027 estimates go in
-- goal_spots (monthly spots, one decimal — the ramp's own precision). A target row carries
-- exactly one of the two. goal_spots has NO sign check: Ryan ruled that a negative forecast-base
-- remainder is shown, not clamped. The page refuses a negative on an ordinary field row.
--
-- ══ A 2027 ROW MUST NEVER REACH THE 2026 PAGE ════════════════════════════════════════════════
-- field_goal_rows.plan_year is the year a row was CREATED FOR. NULL is every row that exists today
-- and every row the 2026 page creates. /api/growth/field-goals drops rows whose plan_year is set
-- and is not 2026, and drops target rows outside 2026 or without goal_daily. Venue and unmapped-
-- field rows are SHARED across years (field_goal_rows_venue_uq allows one row per venue), so their
-- plan_year stays NULL and their 2027 facts live in field_goal_plan, keyed by year.
--
-- ══ ORDER OF OPERATIONS ═══════════════════════════════════════════════════════════════════════
--   1. Apply this file.            (adds columns and tables; the 2026 page is unaffected)
--   2. Deploy the code.            (the 2026 route filter ships with it)
--   3. Apply the seed file.        (only now do 2027 rows and goal_spots targets exist)
-- Seeding before step 2 would put 2027 slots on the 2026 page.
--
-- Apply in the Supabase SQL Editor. Not applied by the app.

begin;

-- ── regions ──────────────────────────────────────────────────────────────────────────────────
-- Org structure, not a plan fact, so no plan_year. The regional manager's hire and running months
-- are NOT stored here: they are the plan_hires row of kind 'regional_manager' for the region, so
-- the region card and the hires table cannot disagree.
CREATE TABLE IF NOT EXISTS public.plan_regions (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z0-9-]+$'),
  name        text NOT NULL CHECK (btrim(name) <> ''),
  short_name  text NOT NULL CHECK (btrim(short_name) <> ''),
  note        text,                          -- e.g. "No regional manager. City manager stays."
  sort_order  double precision NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── plan cities ──────────────────────────────────────────────────────────────────────────────
-- The city entity the estate never had. Display name is the plan's ("Dallas / Fort Worth"); the
-- ALIASES are what join it to the data, which spells the same city three ways ("Dallas" on
-- fin_venues, "DFW" on mdapi_matches, typed text on a 2026 slot). An alias belongs to at most one
-- active city per year; the route refuses to render an overlap rather than double-count a venue.
CREATE TABLE IF NOT EXISTS public.plan_cities (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_year           smallint NOT NULL CHECK (plan_year BETWEEN 2027 AND 2100),
  name                text NOT NULL CHECK (btrim(name) <> ''),
  region_key          text NOT NULL REFERENCES public.plan_regions(key),
  launch_month        date,                  -- NULL = an existing city
  anchor_slots        integer NOT NULL DEFAULT 0 CHECK (anchor_slots >= 0),
  -- Spots per field per month from a field's 12th month on; months 1-11 follow the forecast's
  -- ramp (lib/opsPlan RAMP_SPOTS). Per city, so a field added later defaults to its city's rate.
  mature_spots_per_field numeric(7,1) NOT NULL CHECK (mature_spots_per_field >= 0),
  venue_city_aliases  text[] NOT NULL DEFAULT '{}',   -- fin_venues.city / field_goal_rows.city values
  city_identifiers    text[] NOT NULL DEFAULT '{}',   -- mdapi_matches.city_identifier codes
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  removed_at          timestamptz,
  removed_by          text,
  sort_order          double precision NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_cities_launch_first CHECK (launch_month IS NULL OR launch_month = date_trunc('month', launch_month)::date),
  CONSTRAINT plan_cities_year_name_uq UNIQUE (plan_year, name)
);

-- ── field_goal_rows: the year a row was created for ──────────────────────────────────────────
ALTER TABLE public.field_goal_rows
  ADD COLUMN IF NOT EXISTS plan_year smallint CHECK (plan_year IS NULL OR plan_year BETWEEN 2026 AND 2100);
CREATE INDEX IF NOT EXISTS field_goal_rows_plan_year_idx ON public.field_goal_rows (plan_year) WHERE plan_year IS NOT NULL;

COMMENT ON COLUMN public.field_goal_rows.plan_year IS
  'The plan year this row was created for. NULL = a 2026 Daily Matches row (and every venue / unmapped-field row, which are shared across years). The 2026 route excludes rows where this is set and is not 2026.';

-- ── field_goal_plan: a field's facts FOR ONE PLAN YEAR ──────────────────────────────────────
-- Per year, not per row, because a venue row is shared: "removed from the 2027 plan" must never
-- touch the 2026 page, and a column on the shared row would be 2027's forever.
--
-- A row with no field_goal_plan entry for 2027 is NOT IN the 2027 plan. Status is live / planned /
-- removed and removal is this column, never a DELETE, so history survives.
--
-- role 'forecast_base' is the per-city remainder row. It has no type and no opening month.
CREATE TABLE IF NOT EXISTS public.field_goal_plan (
  row_id              uuid NOT NULL REFERENCES public.field_goal_rows(id) ON DELETE CASCADE,
  plan_year           smallint NOT NULL CHECK (plan_year BETWEEN 2027 AND 2100),
  plan_city_id        uuid NOT NULL REFERENCES public.plan_cities(id),
  role                text NOT NULL DEFAULT 'field' CHECK (role IN ('field', 'forecast_base')),
  status              text NOT NULL CHECK (status IN ('live', 'planned', 'removed')),
  planned_type        text CHECK (planned_type IN ('anchor', 'satellite')),
  planned_open_month  date,                  -- NULL = already open (or date unknown for a 2026 slot)
  removed_at          timestamptz,
  removed_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (row_id, plan_year),
  CONSTRAINT field_goal_plan_open_first CHECK (planned_open_month IS NULL OR planned_open_month = date_trunc('month', planned_open_month)::date),
  CONSTRAINT field_goal_plan_base_is_bare CHECK (role = 'field' OR (planned_type IS NULL AND planned_open_month IS NULL))
);
CREATE INDEX IF NOT EXISTS field_goal_plan_city_idx ON public.field_goal_plan (plan_city_id);
-- One forecast-base row per city. A second would split the remainder and nobody could say which.
CREATE UNIQUE INDEX IF NOT EXISTS field_goal_plan_one_base_uq ON public.field_goal_plan (plan_city_id) WHERE role = 'forecast_base';

-- ── field_goal_targets: spots ────────────────────────────────────────────────────────────────
ALTER TABLE public.field_goal_targets ALTER COLUMN goal_daily DROP NOT NULL;
ALTER TABLE public.field_goal_targets ADD COLUMN IF NOT EXISTS goal_spots numeric(9,1);
ALTER TABLE public.field_goal_targets DROP CONSTRAINT IF EXISTS field_goal_targets_one_unit;
ALTER TABLE public.field_goal_targets ADD CONSTRAINT field_goal_targets_one_unit
  CHECK ((goal_daily IS NULL) <> (goal_spots IS NULL));

COMMENT ON COLUMN public.field_goal_targets.goal_spots IS
  'Monthly spots (2027 Operations Plan). Exactly one of goal_daily / goal_spots is set. No sign check: a forecast-base remainder may be negative and is shown, not clamped.';

-- ── hires ────────────────────────────────────────────────────────────────────────────────────
-- Edited on the page (add / edit / remove). Removal here is a DELETE: the soft-delete rule is about
-- fields and cities, whose history feeds the arithmetic; a hire row feeds nothing but itself.
CREATE TABLE IF NOT EXISTS public.plan_hires (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_year      smallint NOT NULL CHECK (plan_year BETWEEN 2027 AND 2100),
  hire_month     date NOT NULL,
  running_month  date,
  role           text NOT NULL CHECK (btrim(role) <> ''),
  kind           text NOT NULL DEFAULT 'other' CHECK (kind IN ('regional_manager', 'hq', 'other')),
  region_key     text REFERENCES public.plan_regions(key),
  notes          text,
  sort_order     double precision NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_hires_hire_first CHECK (hire_month = date_trunc('month', hire_month)::date),
  CONSTRAINT plan_hires_running_first CHECK (running_month IS NULL OR running_month = date_trunc('month', running_month)::date),
  CONSTRAINT plan_hires_running_after CHECK (running_month IS NULL OR running_month >= hire_month),
  CONSTRAINT plan_hires_rm_has_region CHECK (kind <> 'regional_manager' OR region_key IS NOT NULL)
);
-- One regional manager per region per year, so the region card's line is unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS plan_hires_one_rm_uq ON public.plan_hires (plan_year, region_key) WHERE kind = 'regional_manager';

-- ── RLS: growth, the same predicate 0170 uses ────────────────────────────────────────────────
ALTER TABLE public.plan_regions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_cities     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.field_goal_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_hires      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plan_regions_rw ON public.plan_regions;
CREATE POLICY plan_regions_rw ON public.plan_regions FOR ALL TO authenticated
  USING (public.growth_pages_readable()) WITH CHECK (public.growth_pages_readable());
DROP POLICY IF EXISTS plan_cities_rw ON public.plan_cities;
CREATE POLICY plan_cities_rw ON public.plan_cities FOR ALL TO authenticated
  USING (public.growth_pages_readable()) WITH CHECK (public.growth_pages_readable());
DROP POLICY IF EXISTS field_goal_plan_rw ON public.field_goal_plan;
CREATE POLICY field_goal_plan_rw ON public.field_goal_plan FOR ALL TO authenticated
  USING (public.growth_pages_readable()) WITH CHECK (public.growth_pages_readable());
DROP POLICY IF EXISTS plan_hires_rw ON public.plan_hires;
CREATE POLICY plan_hires_rw ON public.plan_hires FOR ALL TO authenticated
  USING (public.growth_pages_readable()) WITH CHECK (public.growth_pages_readable());

-- ── the anchor threshold, in app_settings ────────────────────────────────────────────────────
-- 670 spots a month in the trailing 30 days (~$7,000 at $10.45 a spot, ~1.2 matches a day).
-- app_settings predates the migrations folder, so its policies are not in this repo. These two are
-- PERMISSIVE and scoped to ONE KEY: they can only widen access to this row, for growth users, and
-- cannot narrow anything that already exists (hero_message is untouched).
INSERT INTO public.app_settings (key, value) VALUES ('ops_plan_anchor_threshold_spots', '670')
  ON CONFLICT (key) DO NOTHING;

DROP POLICY IF EXISTS app_settings_ops_plan_read ON public.app_settings;
CREATE POLICY app_settings_ops_plan_read ON public.app_settings FOR SELECT TO authenticated
  USING (key = 'ops_plan_anchor_threshold_spots' AND public.growth_pages_readable());
DROP POLICY IF EXISTS app_settings_ops_plan_write ON public.app_settings;
CREATE POLICY app_settings_ops_plan_write ON public.app_settings FOR UPDATE TO authenticated
  USING (key = 'ops_plan_anchor_threshold_spots' AND public.growth_pages_readable())
  WITH CHECK (key = 'ops_plan_anchor_threshold_spots' AND public.growth_pages_readable());

-- ── THE THREE WRITES THAT TOUCH MORE THAN ONE TABLE, as functions so each is all-or-nothing ──
-- Two PostgREST calls in a row can half-land: a field row whose plan entry was refused is a 2027
-- row on no page at all, and nobody would ever find it. SECURITY INVOKER, so the caller's RLS
-- (growth_pages_readable) governs every statement inside exactly as it governs a direct write.

-- Add a planned field to a city: a slot row created FOR the plan year, and its plan entry.
CREATE OR REPLACE FUNCTION public.ops_plan_add_field(
  p_year smallint, p_city uuid, p_name text, p_open date, p_type text
) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_row uuid; v_city text;
BEGIN
  SELECT name INTO v_city FROM public.plan_cities WHERE id = p_city AND plan_year = p_year AND status = 'active';
  IF v_city IS NULL THEN RAISE EXCEPTION 'no active plan city % for %', p_city, p_year; END IF;
  INSERT INTO public.field_goal_rows (slot_name, city, plan_year, sort_order)
    VALUES (coalesce(nullif(btrim(p_name), ''), 'New field'), v_city, p_year, extract(epoch FROM now()))
    RETURNING id INTO v_row;
  INSERT INTO public.field_goal_plan (row_id, plan_year, plan_city_id, role, status, planned_type, planned_open_month)
    VALUES (v_row, p_year, p_city, 'field', 'planned', p_type, p_open);
  RETURN v_row;
END $$;

-- Add a city, and N starting fields opening in its launch month. The first fields take its anchor
-- slots; the rest are satellites — the same rule the seed used.
CREATE OR REPLACE FUNCTION public.ops_plan_add_city(
  p_year smallint, p_name text, p_region text, p_launch date, p_anchor_slots integer,
  p_mature numeric, p_fields integer, p_venue_aliases text[], p_city_ids text[]
) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_city uuid; i integer;
BEGIN
  IF p_fields < 0 OR p_fields > 50 THEN RAISE EXCEPTION 'starting fields must be 0-50'; END IF;
  INSERT INTO public.plan_cities (plan_year, name, region_key, launch_month, anchor_slots, mature_spots_per_field,
                                  venue_city_aliases, city_identifiers, sort_order)
    VALUES (p_year, btrim(p_name), p_region, p_launch, p_anchor_slots, p_mature,
            coalesce(p_venue_aliases, '{}'), coalesce(p_city_ids, '{}'), extract(epoch FROM now()))
    RETURNING id INTO v_city;
  FOR i IN 1..p_fields LOOP
    PERFORM public.ops_plan_add_field(p_year, v_city, 'New field ' || i, p_launch,
      CASE WHEN i <= p_anchor_slots THEN 'anchor' ELSE 'satellite' END);
  END LOOP;
  RETURN v_city;
END $$;

-- A planned field becomes real: point it at its venue. If the venue has no goal row yet, the slot
-- row graduates in place (0170's rule — set venue_id, clear slot_name — so its estimates survive)
-- and its plan_year is cleared, because a venue row is shared across years. If the venue ALREADY
-- has a row, the plan entry and the plan-year estimates move onto that row and the emptied slot
-- row is deleted. A venue already in this year's plan is refused rather than double-counted.
CREATE OR REPLACE FUNCTION public.ops_plan_link_venue(p_year smallint, p_row uuid, p_venue bigint)
RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_existing uuid;
BEGIN
  -- ONLY A ROW CREATED FOR THIS PLAN YEAR. A 2026 slot graduating here would change the 2026 page
  -- from the 2027 one, which Ryan ruled out: 2027 edits never touch the 2026 page.
  IF NOT EXISTS (SELECT 1 FROM public.field_goal_rows WHERE id = p_row AND slot_name IS NOT NULL AND plan_year = p_year) THEN
    RAISE EXCEPTION 'row % is not a slot created for the % plan', p_row, p_year;
  END IF;
  SELECT id INTO v_existing FROM public.field_goal_rows WHERE venue_id = p_venue;
  IF v_existing IS NULL THEN
    UPDATE public.field_goal_rows SET venue_id = p_venue, slot_name = NULL, plan_year = NULL WHERE id = p_row;
    UPDATE public.field_goal_plan SET status = 'live' WHERE row_id = p_row AND plan_year = p_year;
    RETURN p_row;
  END IF;
  IF EXISTS (SELECT 1 FROM public.field_goal_plan WHERE row_id = v_existing AND plan_year = p_year) THEN
    RAISE EXCEPTION 'that venue is already in the % plan', p_year;
  END IF;
  UPDATE public.field_goal_plan SET row_id = v_existing, status = 'live' WHERE row_id = p_row AND plan_year = p_year;
  UPDATE public.field_goal_targets SET row_id = v_existing
    WHERE row_id = p_row AND month >= make_date(p_year, 1, 1) AND month < make_date(p_year + 1, 1, 1);
  DELETE FROM public.field_goal_rows WHERE id = p_row;
  RETURN v_existing;
END $$;

REVOKE ALL ON FUNCTION public.ops_plan_add_field(smallint, uuid, text, date, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.ops_plan_add_city(smallint, text, text, date, integer, numeric, integer, text[], text[]) FROM public, anon;
REVOKE ALL ON FUNCTION public.ops_plan_link_venue(smallint, uuid, bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.ops_plan_add_field(smallint, uuid, text, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_plan_add_city(smallint, text, text, date, integer, numeric, integer, text[], text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_plan_link_venue(smallint, uuid, bigint) TO authenticated;

-- ── updated_at, maintained (0170's trigger function) ─────────────────────────────────────────
DROP TRIGGER IF EXISTS plan_regions_touch ON public.plan_regions;
CREATE TRIGGER plan_regions_touch BEFORE UPDATE ON public.plan_regions FOR EACH ROW EXECUTE FUNCTION public.field_goals_touch();
DROP TRIGGER IF EXISTS plan_cities_touch ON public.plan_cities;
CREATE TRIGGER plan_cities_touch BEFORE UPDATE ON public.plan_cities FOR EACH ROW EXECUTE FUNCTION public.field_goals_touch();
DROP TRIGGER IF EXISTS field_goal_plan_touch ON public.field_goal_plan;
CREATE TRIGGER field_goal_plan_touch BEFORE UPDATE ON public.field_goal_plan FOR EACH ROW EXECUTE FUNCTION public.field_goals_touch();
DROP TRIGGER IF EXISTS plan_hires_touch ON public.plan_hires;
CREATE TRIGGER plan_hires_touch BEFORE UPDATE ON public.plan_hires FOR EACH ROW EXECUTE FUNCTION public.field_goals_touch();

commit;
