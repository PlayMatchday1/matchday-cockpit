-- 0182 — how long the slot is, and what the listing called itself.
--
-- ══ WHY DURATION CHANGES AN ANSWER, NOT JUST A COLUMN ════════════════════════════════════════
-- 0181 stored spots and format, and the only quality check available on those two was SPOTS PER
-- MATCH against what the format implies. That check called Memorial Indoor Soccer a 3.5x outlier:
-- 35 bookable spots in a 5v5, where 5v5 implies 10. With the duration it is a 180-minute open play,
-- which is 11.7 spots an hour against an implied 10, and not an outlier at all. TOCA Colony's
-- 28-spot 7v7 over 120 minutes is exactly 14.0 an hour, which is 7v7 precisely.
--
-- The capture was never wrong. The unit was. SPOTS PER HOUR is the comparable figure and it cannot
-- be computed without this column, so a page that flags data quality has to have it.
--
-- NULL IS THE NORMAL STATE FOR ONE WHOLE SOURCE. GoodRec publishes a start time and no duration, so
-- all 114 GoodRec rows are null and always will be. That is not missing data to chase; it is what
-- GoodRec shows. Any per-hour figure is therefore computable for Plei and not for GoodRec, and the
-- page must not imply otherwise by rendering a blank where a number belongs.
--
-- Plus exactly one Plei row: the Foro Sports Club card on 18 Sep that was recorded partially
-- visible. It has no time, no duration and no price, and it is the same row 0181 made nullable
-- kickoff_local for. One bad recording, three nulls, and its 12 spots still count.
ALTER TABLE public.competitor_matches
  ADD COLUMN IF NOT EXISTS duration_minutes integer
    CHECK (duration_minutes IS NULL OR duration_minutes > 0);

-- ══ THE LISTING'S OWN TITLE ══════════════════════════════════════════════════════════════════
-- What the competitor called the slot: "Open play Memorial indoor", "Happy hour West Houston
-- outdoor", "20% OFF West Houston indoor". It is how a facility describes and discounts its own
-- supply, which is the thing this page exists to let somebody read. Kept verbatim; it is their copy
-- and paraphrasing it would make it ours.
ALTER TABLE public.competitor_matches
  ADD COLUMN IF NOT EXISTS listing_title text;

COMMENT ON COLUMN public.competitor_matches.duration_minutes IS
  'Slot length as listed. NULL on every GoodRec row because GoodRec publishes a start time only, '
  'which is a fact about the source and not missing data. Spots per hour is the comparable unit; '
  'spots per match reads a 180-minute open play as a broken 5v5.';
COMMENT ON COLUMN public.competitor_matches.listing_title IS
  'The competitor''s own title for the slot, verbatim. Carries their discounting and their framing '
  '("Happy hour", "20% OFF", "Open play").';
