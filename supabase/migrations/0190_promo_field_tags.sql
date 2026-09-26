-- 0190 — FIELD TAGS. Manually set, several per field, and keyed on the FIELD.
--
-- ══ WHY THE FIELD AND NOT THE MATCH ═══════════════════════════════════════════════════════════
--
-- Ryan: "A NEW FIELD / PRIORITY tag we could manually add so we can all see key fields ... As we
-- are going to have multiple tags per field, maybe have each tag a different colour."
--
-- A field is a partner field or it is not. It is a priority or it is not. None of that is a fact
-- about the match that happens to be on screen on a Tuesday, so keying on match_api_id would mean
-- re-tagging the same pitch every week and, worse, a pitch that reads PARTNER on one tile and
-- nothing on the next. The tile looks up its own field and gets the same answer every time.
--
-- mdapi_matches.field_id IS THE KEY, not field_title. Titles are edited upstream and normalised
-- three different ways in this codebase (canonicalVenueName, normalizeMatchName, the fin_venues
-- alias map); an id is none of those things. A match whose field_id is null simply has no tags,
-- which is correct rather than a gap: it has no field to tag.
--
-- ══ FOUR TAGS, AND THE ONE THAT IS A RENAME ══════════════════════════════════════════════════
--
-- key_field, priority, starting_11, partner.
--
-- Ryan asked for "NEW FIELD / PRIORITY". NEW FIELD IS NOT HERE, DELIBERATELY: newnessOf already
-- computes a NEW badge against last week's slate and puts the rule and both dates in its tooltip.
-- A hand-typed pill reading the same words would make the computed one untrustworthy and nobody
-- could tell which was which. key_field carries the same intent and collides with nothing.
--
-- starting_11 IS A LIVE PROMO CODE AND THIS TAG IS SET BY HAND. Ryan's call, knowingly: it will
-- occasionally be stale rather than wired to the code's lifecycle. Deriving it later changes
-- nothing about how it renders, which is why the trade is cheap to reverse.
--
-- ══ THE ENUM IS A CHECK, NOT A LOOKUP TABLE ═══════════════════════════════════════════════════
-- Four values chosen by a person, with colours and copy compiled into the page. A lookup table
-- would imply they can be added without a deploy, and they cannot: each one needs a colour that
-- collides with nothing already on the tile, and that is a design decision, not a row.

begin;

CREATE TABLE IF NOT EXISTS public.match_promotion_field_tag (
  id         bigserial   PRIMARY KEY,
  field_id   bigint      NOT NULL,
  tag        text        NOT NULL,
  set_by     text,
  set_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT match_promotion_field_tag_tag_ck
    CHECK (tag IN ('key_field', 'priority', 'starting_11', 'partner')),
  -- ONE ROW PER (FIELD, TAG). Setting a tag twice is not two tags, and the UI toggles rather than
  -- appends, so the constraint is what makes the toggle safe rather than a race between two
  -- operators producing a duplicate nobody can see.
  CONSTRAINT match_promotion_field_tag_uniq UNIQUE (field_id, tag)
);

-- THE READ IS "every tag for the fields on this week's grid", so the index is on field_id.
CREATE INDEX IF NOT EXISTS match_promotion_field_tag_field_idx
  ON public.match_promotion_field_tag (field_id);

REVOKE ALL ON public.match_promotion_field_tag FROM anon, authenticated;
GRANT ALL ON public.match_promotion_field_tag TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.match_promotion_field_tag_id_seq TO service_role;

COMMENT ON TABLE public.match_promotion_field_tag IS
  'Manually set tags on a FIELD, several per field. Keyed on mdapi field_id rather than on a '
  'match: a field is a partner field or it is not, whichever match is on screen. NEW FIELD is '
  'deliberately absent - it is computed by newnessOf and a hand-typed twin would make the '
  'computed badge untrustworthy.';
COMMENT ON COLUMN public.match_promotion_field_tag.set_by IS
  'The operator email that set it. Nullable because a row written before the column existed, or '
  'by a service path, has nobody to name, and inventing one is worse than saying nothing.';

-- ── THE AUDIT ALLOWLIST, AGAIN ────────────────────────────────────────────────────────────────
-- FOURTH TIME. fin_change_log.table_name carries a CHECK allowlist: 0128 widened it for
-- match_promotion_plan, 0130 for fin_venue_fields, 0176 for match_promotion_push. A new table that
-- writes through recordWrite and is NOT on the list fails at the audit step, which means the write
-- lands and the log does not - loud, but only after the fact.
--
-- TWO THINGS A FIRST DRAFT OF THIS GOT WRONG, both caught before it ran:
--
--   THE CONSTRAINT IS NAMED ..._check, NOT ..._ck. Guarded by an IF EXISTS on the wrong name, the
--   whole statement would have been a no-op and the failure would have surfaced as the first tag
--   write failing its audit.
--
--   AND IT CANNOT BE REBUILT FROM THE DATA. SELECT DISTINCT table_name gives the values that are
--   USED, not the values that are ALLOWED, so a value permitted but not yet written would have
--   been silently dropped from the list.
--
-- So the list is restated in full, exactly as 0176 restated it. Verified 2026-09-26: the DISTINCT
-- values present are the same eight 0176 declared, with no stray.
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
    'fin_venue_fields',
    'match_promotion_push',
    'match_promotion_field_tag'
  ));

commit;

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- TO VERIFY:
--
--   select tag, count(*) from public.match_promotion_field_tag group by tag order by tag;
--
-- EXPECTED immediately after this runs: no rows. The table is written only from the tile panel.
--
--   \d public.match_promotion_field_tag
--
-- EXPECTED: the UNIQUE (field_id, tag) constraint and the four-value CHECK both present.
--
-- TO UNDO:
--
--   drop table if exists public.match_promotion_field_tag;
--
-- The allowlist widening is left in place on an undo: a CHECK that permits a value no row uses
-- costs nothing, and narrowing it again risks dropping a value another migration added.
