-- 0180 — a ruling about whether a competitor facility is ours must survive the next capture.
--
-- ══ THE BUG 0179 SHIPPED WITH ═══════════════════════════════════════════════════════════════
-- Re-importing a (source, city, window) DELETES the capture and lets the FK cascade clear its
-- facility rows, then inserts fresh ones with our_venue_id NULL. That is the right behaviour for
-- the CAPTURE — a re-import is a correction and the old numbers should go — but it also destroys
-- every human ruling attached to those rows. Accept "Katy International Sports Complex is our
-- KISC" today, re-capture Houston next month, and the link is gone with no trace that anyone ever
-- said so. Ryan captures per region and Plei is in about 38 of them, so this would have happened
-- within weeks.
--
-- ══ AND "NOT OURS" WAS NOT EXPRESSIBLE AT ALL ═══════════════════════════════════════════════
-- our_venue_id NULL meant two different things: "nobody has looked at this" and "somebody looked
-- and it is not ours". The second is a real answer and the page kept re-proposing it.
--
-- Ryan, 2026-09-16, on The HatTrick Oakridge and The HatTrick Patio, both of which the matcher
-- wanted to link to our venue 52 "Hattrick T." because "hattrick" is the whole significant word on
-- our side: "Both hattricks different than our venue, same owner but different facilities."
--
-- That is a ruling about two named places, not about this week's capture, and it has to outlive it.

ALTER TABLE public.competitor_facility_supply
  ADD COLUMN IF NOT EXISTS not_ours boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.competitor_facility_supply.not_ours IS
  'A person ruled this facility is NOT one of ours. Distinct from our_venue_id IS NULL, which '
  'means nobody has looked yet. Set true to stop the matcher proposing it again.';
COMMENT ON COLUMN public.competitor_facility_supply.our_venue_id IS
  'Confirmed link to fin_venues, set only by a person accepting a proposal. Carried forward across '
  'a re-import by facility name, so a capture correction does not erase a ruling.';

-- A ruling is about a NAMED FACILITY IN A CITY, not about a row that a re-import will replace.
-- The importer reads this to carry rulings forward; it is the durable record and the supply row's
-- two columns are its cache.
CREATE TABLE IF NOT EXISTS public.competitor_facility_rulings (
  id           bigserial PRIMARY KEY,
  source       text NOT NULL CHECK (source IN ('plei','goodrec')),
  city_label   text NOT NULL,
  facility     text NOT NULL,
  -- Exactly one of these is meaningful: a venue id, or not_ours. Both null is not a ruling and
  -- such a row is deleted rather than stored, so a row here always says something.
  our_venue_id bigint REFERENCES public.fin_venues(id),
  not_ours     boolean NOT NULL DEFAULT false,
  ruled_by     text NOT NULL,
  ruled_at     timestamptz NOT NULL DEFAULT now(),
  note         text,
  CONSTRAINT competitor_ruling_uniq UNIQUE (source, city_label, facility),
  CONSTRAINT competitor_ruling_says_something CHECK (our_venue_id IS NOT NULL OR not_ours)
);

ALTER TABLE public.competitor_facility_rulings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS competitor_rulings_read ON public.competitor_facility_rulings;
CREATE POLICY competitor_rulings_read ON public.competitor_facility_rulings
  FOR SELECT TO authenticated USING (public.competitor_data_readable());

REVOKE ALL ON public.competitor_facility_rulings FROM anon;
GRANT SELECT ON public.competitor_facility_rulings TO authenticated;
GRANT ALL ON public.competitor_facility_rulings TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.competitor_facility_rulings_id_seq TO service_role;

-- ── RYAN'S RULING, 2026-09-16 ─────────────────────────────────────────────────────────────────
-- Both HatTrick facilities are Plei Houston rows the matcher wanted to give our venue 52. They are
-- the same owner as our Hattrick T. and different places. Recorded here so the matcher stops
-- asking and so a re-capture of Houston cannot quietly re-open the question.
INSERT INTO public.competitor_facility_rulings (source, city_label, facility, not_ours, ruled_by, note)
VALUES
  ('plei', 'Houston', 'The HatTrick Oakridge', true, 'rmancuso@playmatchday.com',
   'Same owner as our Hattrick T., different facility. Ruled 2026-09-16.'),
  ('plei', 'Houston', 'The HatTrick Patio',    true, 'rmancuso@playmatchday.com',
   'Same owner as our Hattrick T., different facility. Ruled 2026-09-16.')
ON CONFLICT (source, city_label, facility) DO NOTHING;

-- Apply the ruling to the rows that exist right now.
UPDATE public.competitor_facility_supply s
SET not_ours = true
FROM public.competitor_facility_rulings r, public.competitor_captures c
WHERE s.capture_id = c.id
  AND c.source = r.source AND c.city_label = r.city_label AND s.facility = r.facility
  AND r.not_ours;
