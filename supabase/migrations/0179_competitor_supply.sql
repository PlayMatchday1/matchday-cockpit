-- 0179 — competitor bookable supply, as captured. NOT a feed.
--
-- Every row is a human capture of a competitor app at a point in time, through an emulator with
-- mocked GPS, one region at a time. The WINDOW is the load-bearing part: a spots-per-week figure
-- taken over eight days is not comparable to one taken over seven, and the only thing that can
-- say so is a column that records it.
--
-- Ryan: "I want to add a competitor page to the growth tab that shows all the goodrec and plei data
-- so we can review it. You see bookable matches fields spots price size (7v7 etc)."
--
-- ══ WHY THREE TABLES ═════════════════════════════════════════════════════════════════════════
-- A capture is a source, a city and a window. The facility rows hang off it, and the individual
-- matches hang off those. One table would repeat the window on all 59 rows and let two of them
-- disagree, and it has no room for a match log at all.
--
-- ══ MD STANDARD IS NOT HERE, DELIBERATELY ════════════════════════════════════════════════════
-- MD Standard = bookable spots / 18, because one MatchDay match is 18 bookable spots and a 5v5
-- slot and an 11v11 slot are not the same match. It is DERIVED, in one exported function in
-- src/lib/competitorSupply.ts, and there is no column for it here. A stored derivation is a second
-- number that can disagree with the first.

CREATE TABLE IF NOT EXISTS public.competitor_captures (
  id            bigserial PRIMARY KEY,
  source        text NOT NULL CHECK (source IN ('plei','goodrec')),
  -- What the capture called the city. The truth for display.
  city_label    text NOT NULL,
  -- Our scope code where we operate there, NULL where we do not. Plei is in ~38 regions and we
  -- are in 8; a competitor city we have never entered is still worth capturing.
  city_identifier text,
  window_start  date NOT NULL,
  window_end    date NOT NULL,
  -- THE WINDOW IS NOT ALWAYS CLEAN. The Sep 2026 DFW Plei capture is "Mon 21 plus Tue 15 to Sun
  -- 20", which is eight days of listings, not seven. A per-week figure built from windows of
  -- different lengths is not comparable and this column is the only thing that says so.
  window_note   text,
  captured_at   timestamptz NOT NULL DEFAULT now(),
  captured_by   text NOT NULL,
  CONSTRAINT competitor_captures_window_ck CHECK (window_end >= window_start),
  CONSTRAINT competitor_captures_uniq UNIQUE (source, city_label, window_start, window_end)
);

CREATE TABLE IF NOT EXISTS public.competitor_facility_supply (
  id            bigserial PRIMARY KEY,
  capture_id    bigint NOT NULL REFERENCES public.competitor_captures(id) ON DELETE CASCADE,
  facility      text NOT NULL,
  -- STORED AND NOT SHOWN. It does not reconcile with the formats: Memorial Indoor Soccer shows 2
  -- matches and 70 spots at 5v5, Vaqueros Field 7 matches and 203 spots at 7v7. Whatever a "match"
  -- means inside those apps, SPOTS is what was actually counted. Kept because throwing away a
  -- captured number to make a page tidier is not a decision code gets to make.
  matches_per_week numeric,
  bookable_spots_per_week integer NOT NULL CHECK (bookable_spots_per_week >= 0),
  -- CENTS, NOT A STRING. "$12.50 to $16.50" cannot be sorted, averaged or compared.
  -- Both NULL means the facility published no price, which is not the same as free.
  price_low_cents  integer CHECK (price_low_cents IS NULL OR price_low_cents >= 0),
  price_high_cents integer CHECK (price_high_cents IS NULL OR price_high_cents >= 0),
  formats       text[] NOT NULL DEFAULT '{}',
  -- THE SHARED-FIELD LINK, AND IT IS NULL UNTIL A HUMAN SAYS OTHERWISE. The importer proposes,
  -- a person accepts. "Athlete Training & Health | Cypress" and "Athlete Training and Health |
  -- Katy" differ by one word and are different places, one of which is ours.
  our_venue_id  bigint REFERENCES public.fin_venues(id),
  CONSTRAINT competitor_facility_uniq UNIQUE (capture_id, facility),
  CONSTRAINT competitor_price_order_ck CHECK (
    price_low_cents IS NULL OR price_high_cents IS NULL OR price_high_cents >= price_low_cents)
);

-- THE MATCH LOG. A DIFFERENT GRAIN, and the September capture does not have it: that capture
-- recorded weekly totals per facility. The page must render both states and the empty one has to
-- say WHICH it is, because an empty panel reads as "no matches this week" and that is false.
CREATE TABLE IF NOT EXISTS public.competitor_matches (
  id            bigserial PRIMARY KEY,
  supply_id     bigint NOT NULL REFERENCES public.competitor_facility_supply(id) ON DELETE CASCADE,
  match_date    date NOT NULL,
  -- Wall clock at the pitch, as listed. No timezone: a competitor's listing is a local time and
  -- converting it would be inventing an instant we were never told.
  kickoff_local time NOT NULL,
  format        text NOT NULL,
  spots         integer NOT NULL CHECK (spots >= 0),
  price_cents   integer CHECK (price_cents IS NULL OR price_cents >= 0),
  CONSTRAINT competitor_match_uniq UNIQUE (supply_id, match_date, kickoff_local, format)
);

CREATE INDEX IF NOT EXISTS competitor_supply_capture_idx
  ON public.competitor_facility_supply (capture_id);
CREATE INDEX IF NOT EXISTS competitor_matches_supply_idx
  ON public.competitor_matches (supply_id);

-- ── RLS ───────────────────────────────────────────────────────────────────────────────────────
-- 0166 is the precedent and the lesson: kanban_cards shipped with FOR ALL TO authenticated
-- USING (true), which means a page gate is not a boundary — every signed-in account could read
-- the table straight off PostgREST whatever the rail showed them.
--
-- This is competitor intelligence. It is not VC check sizes, but it is a list of who is selling
-- what and at what price in markets we are entering, and the people it would embarrass us with
-- are the competitors themselves. So it gets the SAME gate the rest of the Growth tab has, through
-- the same SECURITY DEFINER shape 0166 introduced: can_access_growth or is_admin, confinement
-- beating every flag, service accounts excluded.
--
-- WRITES ARE SERVICE ROLE ONLY. The importer runs through an admin-gated route; nothing about this
-- data is edited by hand in a browser, so authenticated gets SELECT and nothing else.
CREATE OR REPLACE FUNCTION public.competitor_data_readable()
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
      -- CONFINEMENT BEATS EVERY FLAG, is_admin included. Mirrors canAccess().
      AND coalesce(u.city_identifier, '') = ''
      AND coalesce(u.is_service_account, false) = false
      AND (u.is_admin OR u.can_access_growth)
  );
$$;

REVOKE ALL ON FUNCTION public.competitor_data_readable() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.competitor_data_readable() TO authenticated, service_role;

ALTER TABLE public.competitor_captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competitor_facility_supply ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competitor_matches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS competitor_captures_read ON public.competitor_captures;
CREATE POLICY competitor_captures_read ON public.competitor_captures
  FOR SELECT TO authenticated USING (public.competitor_data_readable());

DROP POLICY IF EXISTS competitor_supply_read ON public.competitor_facility_supply;
CREATE POLICY competitor_supply_read ON public.competitor_facility_supply
  FOR SELECT TO authenticated USING (public.competitor_data_readable());

DROP POLICY IF EXISTS competitor_matches_read ON public.competitor_matches;
CREATE POLICY competitor_matches_read ON public.competitor_matches
  FOR SELECT TO authenticated USING (public.competitor_data_readable());

REVOKE ALL ON public.competitor_captures, public.competitor_facility_supply,
  public.competitor_matches FROM anon;
GRANT SELECT ON public.competitor_captures, public.competitor_facility_supply,
  public.competitor_matches TO authenticated;
GRANT ALL ON public.competitor_captures, public.competitor_facility_supply,
  public.competitor_matches TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.competitor_captures_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.competitor_facility_supply_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.competitor_matches_id_seq TO service_role;

COMMENT ON TABLE public.competitor_captures IS
  'One human capture of one competitor app, for one city, over one window. Captured by hand '
  'through an emulator with mocked GPS. window_note records a window that is not a clean week.';
COMMENT ON COLUMN public.competitor_facility_supply.matches_per_week IS
  'As captured. Does NOT reconcile with the formats and is not shown on the page; spots is what '
  'was actually counted and MD Standard (spots/18) is the match figure on screen.';
