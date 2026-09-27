-- 0192 — TWO TAGS, NOT FOUR. key_field merges into priority; partner stops being a tag at all.
--
-- ══ WHY key_field GOES ═════════════════════════════════════════════════════════════════════════
--
-- Ryan: KEY FIELD ("a field we are choosing to push harder than the rest") and PRIORITY ("needs
-- attention this week, whatever its push state says") mean the same thing in practice.
--
-- They also live at the SAME SCOPE — both are rows in this table keyed on field_id, both permanent,
-- neither carries a week — so the merge is a value change and not a re-modelling. That was checked
-- before writing this: had one been per-field and the other per-match-per-week there would have
-- been no single tag to merge them into.
--
-- ══ WHY partner GOES, AND DOES NOT COME BACK AS A ROW ══════════════════════════════════════════
--
-- PARTNER is a CONTRACT FACT and it is already recorded on the finance side: fin_venues.billing_type
-- and partner_dashboards.revenue_model, reconciled by basisOf() in src/lib/fieldEconomics.ts. A tag
-- anyone can apply by hand is a SECOND copy of that fact with no constraint tying it to the first,
-- and the copy was already wrong on the only field carrying it:
--
--   field 1717 "Keswick Park (Chamblee)" -> fin_venue 66 Keswick Park, billing_type per_match,
--   cost_per_match 80, NO partner_dashboards row. A rental, tagged as a revenue share.
--
-- Meanwhile the five fields that ARE on a share carried no tag at all: 1024 The Hattrick, 1189 PAC
-- GLOBAL, 1288 The Hattrick T., 1321 Crossbar Rowlett, 1585 PARMER Stadium. Wrong on the one it was
-- set on and absent on all five it belonged on is the whole argument for deriving it.
--
-- So the badge is DERIVED at read time from the venue the field maps to, and it is READ-ONLY: not
-- in the tag picker, not writable through the API, no row here to drift.
--
-- ══ THE CHECK IS NARROWED, WHICH IS WHAT MAKES IT UNAPPLIABLE AGAIN ════════════════════════════
-- Dropping the two keys from TAG_KEYS in the page stops the buttons rendering. Narrowing the CHECK
-- is what stops a value arriving any other way — the API validates against isTagKey, but a
-- constraint that still permits 'partner' is a door left open for the next caller.

begin;

-- ── 1. key_field BECOMES priority ─────────────────────────────────────────────────────────────
-- Order matters and this is the safe order: ADD the priority row first for any field that has
-- key_field and not priority, THEN delete the key_field rows. An UPDATE ... SET tag = 'priority'
-- would hit match_promotion_field_tag_uniq (field_id, tag) on every field that already carries
-- both — which is field 1717, the only field with key_field today — and abort the whole migration.
--
-- ON CONFLICT DO NOTHING is the "where a field already has both, keep one PRIORITY" rule, enforced
-- by the unique constraint rather than by a subquery that could race.
--
-- set_by / set_at are CARRIED OVER from the key_field row, not stamped with now(). Whoever marked
-- the pitch made that call on that date, and rewriting it to today would lose the only provenance
-- these rows carry.
INSERT INTO public.match_promotion_field_tag (field_id, tag, set_by, set_at)
SELECT field_id, 'priority', set_by, set_at
  FROM public.match_promotion_field_tag
 WHERE tag = 'key_field'
ON CONFLICT (field_id, tag) DO NOTHING;

DELETE FROM public.match_promotion_field_tag WHERE tag = 'key_field';

-- ── 2. THE MANUAL partner ROWS GO ─────────────────────────────────────────────────────────────
-- Not archived. The fact they were trying to record lives in fin_venues / partner_dashboards and is
-- better recorded there; keeping a dead copy is keeping the thing this migration exists to remove.
DELETE FROM public.match_promotion_field_tag WHERE tag = 'partner';

-- ── 3. NEITHER KEY CAN BE APPLIED AGAIN ───────────────────────────────────────────────────────
-- Named ..._tag_ck, which is what 0190 called it. Checked against the live constraint name rather
-- than assumed: an IF EXISTS on a wrong name is a silent no-op, and this codebase has already been
-- bitten by exactly that on fin_change_log_table_name_check.
ALTER TABLE public.match_promotion_field_tag
  DROP CONSTRAINT IF EXISTS match_promotion_field_tag_tag_ck;

ALTER TABLE public.match_promotion_field_tag
  ADD CONSTRAINT match_promotion_field_tag_tag_ck
  CHECK (tag IN ('priority', 'starting_11'));

COMMENT ON TABLE public.match_promotion_field_tag IS
  'Manually set tags on a FIELD. TWO values: priority and starting_11. key_field was merged into '
  'priority by 0192 - they meant the same thing. partner was REMOVED as a tag: it is a contract '
  'fact derived from fin_venues.billing_type / partner_dashboards.revenue_model and rendered '
  'read-only, because a hand-applied copy was wrong on the one field it was set on and absent on '
  'all five that were actually on a revenue share.';

commit;

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- TO VERIFY:
--
--   select tag, count(*) from public.match_promotion_field_tag group by tag order by tag;
--
-- EXPECTED, measured on prod 2026-09-26 BEFORE this runs (4 rows):
--   key_field 1 (field 1717) · priority 2 (fields 958, 1717) · partner 1 (field 1717)
-- EXPECTED AFTER (2 rows):
--   priority 2 (fields 958, 1717)
-- starting_11 is 0 before and 0 after - no field has ever carried it.
--
-- Field 1717 already had priority, so its key_field row is DELETED and no row is inserted. The
-- INSERT above affects 0 rows on this data; it is there for the general case, not for this one.
--
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.match_promotion_field_tag'::regclass and contype = 'c';
--
-- EXPECTED: CHECK (tag = ANY (ARRAY['priority', 'starting_11']))
--
-- TO UNDO: there is no clean undo. The key_field rows are gone and which priority rows were once
-- key_field is not recorded anywhere after this runs. Widening the CHECK back to four values
-- restores the SHAPE and not the DATA:
--
--   alter table public.match_promotion_field_tag
--     drop constraint if exists match_promotion_field_tag_tag_ck;
--   alter table public.match_promotion_field_tag
--     add constraint match_promotion_field_tag_tag_ck
--     check (tag in ('key_field', 'priority', 'starting_11', 'partner'));
--
-- Two rows on two fields is a small enough loss to accept knowingly, which is why this is stated
-- rather than worked around.
