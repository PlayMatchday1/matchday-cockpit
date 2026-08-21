-- ── A PER-LINK EXCEPTION TO THE EVENT MARKER ───────────────────────────────────────────────────
--
-- THE DEFECT. venueResolver.ts:55 classifies a match as an event by testing its field_title
-- against EVENT_MARKERS. "Tourney ATH Pearland" (mdapi field 22) fires on `tourney` and every
-- match on it has been dropped from venue cost since the link was made — 519 alive matches back
-- to June 2024, $83,040 at the $160 rate. The field is named for a tournament and carries the
-- ordinary weekly schedule: 33 matches in August 2026 alone, none cancelled. The marker is
-- matching a NAME, not a FACT.
--
-- WHY NOT EDIT THE REGEX. It is right about what it does — "tourney" in a field title usually
-- does mean a one-off, and 5 other venues carry links that genuinely are events. Loosening it
-- reclassifies every field matching that word at every venue, and that blast radius is unmeasured.
-- The exception belongs to the LINK, which is the thing that is actually wrong.
--
-- DEFAULT false MEANS NOTHING MOVES ON DEPLOY. Every existing link keeps today's behaviour, and
-- ATH Pearland stays at zero until someone ticks it. $83,040 spans 26 closed months; it does not
-- move as a side effect of a migration.
ALTER TABLE public.fin_venue_fields
  ADD COLUMN IF NOT EXISTS counts_as_regular_play boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.fin_venue_fields.counts_as_regular_play IS
  'When true, matches on this mdapi field count toward venue cost even though EVENT_MARKERS '
  'classifies its title as an event. Per-link override for fields permanently named after a '
  'tournament that in fact carry the regular schedule. Default false: no existing link changes.';

-- ── THE AUDIT ALLOWLIST HAS TO BE WIDENED, OR THE TOGGLE'S LOG ENTRY IS REFUSED ────────────────
-- fin_change_log.table_name carries a CHECK allowlist and fin_venue_fields is not on it. This is
-- the second time this trap has been hit (0128 widened it for match_promotion_plan); the failure
-- is loud rather than silent, but it is total — the toggle would write and then fail at the audit
-- step. Existing values re-listed verbatim, as in 0128.
ALTER TABLE public.fin_change_log
  DROP CONSTRAINT IF EXISTS fin_change_log_table_name_check;

ALTER TABLE public.fin_change_log
  ADD CONSTRAINT fin_change_log_table_name_check
  CHECK (table_name IN (
    'fin_expenses',
    'fin_revenue',
    'fin_schedule',
    'fin_venue_cost_overrides',
    'fin_venues',
    'match_promotion_plan',
    'fin_venue_fields'
  ));
