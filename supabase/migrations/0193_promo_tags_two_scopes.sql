-- 0193 — PRIORITY MOVES TO THE MATCH, KEY FIELD COMES BACK AT FIELD SCOPE, AND THE TABLE IS RENAMED.
--
-- 0190 AND 0192 ARE APPLIED AND ARE NOT EDITED. This migration is the whole change.
--
-- ══ ONE CONCEPT, TWO SCOPES ════════════════════════════════════════════════════════════════════
--
-- Ryan: "priority tag is not supposed to be at the field level it's supposed to be at the match
-- level." And: "key field could be fine to keep, I like it because can basically make it the
-- priority version of the full field."
--
--   priority     -> a MATCH.  We are pushing this one harder.
--   key_field    -> a FIELD.  The same thing for every match at that field.
--   starting_11  -> a FIELD.  Starting 11 is live at this venue.
--
-- THIS REVERSES 0192, KNOWINGLY. 0192 merged key_field INTO priority on the grounds that they meant
-- the same thing, which was my reading of "they mean the same thing in practice". They do mean the
-- same thing - at two different SCOPES, which is the part that reading missed. key_field is
-- re-admitted to the tag list here and the scope is what now distinguishes them.
--
-- PARTNER DOES NOT COME BACK. It is derived from the contract via isRevenueShareVenue and rendered
-- read-only; see 0192 and src/lib/revenueShare.ts.
--
-- ══ THE CHECK IS TAG-AWARE, WHICH IS THE POINT ═════════════════════════════════════════════════
--
-- A generic "exactly one of field_id and match_id" would still permit a key_field row carrying a
-- match_id - KEY FIELD applied to one single match, which is precisely the mistake this migration
-- exists to make impossible. So the tag list and the scope rule are ONE constraint, in 0191's
-- mutually-exclusive-and-total style, one degree stricter.
--
-- COUPLING THE CHECK TO THE TAG LIST MEANS ADDING A TAG NEEDS A MIGRATION. Intended. The list is
-- small and deliberate, and this codebase has already been bitten by an allowlist rebuilt from
-- SELECT DISTINCT, where values IN USE were mistaken for values PERMITTED (see 0190's note).
--
-- ══ THE EXISTING ROWS: 2, BOTH SEED, BOTH DELETED ══════════════════════════════════════════════
--
-- Counted on prod 2026-09-26 before writing this:
--
--   priority  2   field 958 (set 21:32:38), field 1717 (set 20:33:21)
--   TOTAL     2
--
-- BOTH ARE SEED ROWS written during this session to exercise the covered state and the "+1"
-- overflow: every row in the table carries set_at on 2026-09-26 and set_by rmancuso@, and there are
-- no rows on any other date. NOTHING REAL IS LOST. There are no `partner` rows left - 0192 deleted
-- the one that existed - and no key_field or starting_11 rows.
--
-- They are field-scoped `priority` rows, which the new CHECK makes illegal, so they are DELETED
-- rather than rescoped: rescoping would mean inventing a match_id for a tag that was set against a
-- pitch, and there is no honest way to choose which of that field's matches was meant.
--
-- ══ THE FK POINTS AT A TOMBSTONED TABLE, AND THAT IS WHY IT IS SAFE ════════════════════════════
--
-- mdapi_matches.api_id is `bigint PRIMARY KEY` (0016). mdapi_matches is a MIRROR, and the sync
-- TOMBSTONES rather than deletes: a row that goes unseen gets deleted_at set and its next upsert
-- clears it (mdapiMatchesSync.ts:567-572). So a real FK cannot block the sync, and ON DELETE CASCADE
-- cannot fire spuriously - it is there for a genuine hard delete, where a tag pointing at a match
-- that no longer exists is garbage rather than history.

begin;

-- ── 1. THE NAME ───────────────────────────────────────────────────────────────────────────────
-- It holds match rows now, so match_promotion_field_tag would lie forever. Checked before
-- committing to it: the ONLY code callers are src/lib/matchPromotion.ts:836 and two lines in
-- src/app/api/match-promotion/route.ts, all written this week and all updated in this commit. No
-- view, no trigger, no policy and no other migration reads it.
--
-- RENAMING A TABLE DOES NOT RENAME ITS CONSTRAINTS, ITS INDEXES OR ITS SEQUENCE. Each is renamed
-- explicitly below; the alternative is a table called promo_tags whose constraint names still say
-- match_promotion_field_tag, which is the half-rename this migration was told to avoid.
ALTER TABLE public.match_promotion_field_tag RENAME TO promo_tags;
ALTER SEQUENCE public.match_promotion_field_tag_id_seq RENAME TO promo_tags_id_seq;
ALTER INDEX  public.match_promotion_field_tag_field_idx RENAME TO promo_tags_field_idx;

-- ── 2. THE SEED ROWS GO, BEFORE THE CHECK THAT WOULD REJECT THEM ──────────────────────────────
-- ORDER IS LOAD-BEARING: adding the CHECK first fails on these two rows and aborts the whole
-- migration. A WHERE clause is present because pg_safeupdate rejects an unqualified DELETE.
DELETE FROM public.promo_tags WHERE tag = 'priority' AND field_id IS NOT NULL;

-- Belt: partner was removed by 0192 and there should be none. Stated rather than assumed.
DELETE FROM public.promo_tags WHERE tag = 'partner';

-- ── 3. THE TWO SCOPES ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.promo_tags ALTER COLUMN field_id DROP NOT NULL;

ALTER TABLE public.promo_tags
  ADD COLUMN IF NOT EXISTS match_id bigint
    REFERENCES public.mdapi_matches(api_id) ON DELETE CASCADE;

-- ── 4. THE TAG-AWARE SHAPE CHECK ──────────────────────────────────────────────────────────────
-- 0192 narrowed the old check to ('priority','starting_11'). It is DROPPED BY NAME - the name was
-- verified against the live constraint by a rejected insert, not assumed, because an IF EXISTS on a
-- wrong name is a silent no-op and this codebase has already been bitten by exactly that.
ALTER TABLE public.promo_tags
  DROP CONSTRAINT IF EXISTS match_promotion_field_tag_tag_ck;

ALTER TABLE public.promo_tags
  ADD CONSTRAINT promo_tags_scope_ck CHECK (
       (tag = 'priority'    AND match_id IS NOT NULL AND field_id IS NULL)
    OR (tag = 'key_field'   AND field_id IS NOT NULL AND match_id IS NULL)
    OR (tag = 'starting_11' AND field_id IS NOT NULL AND match_id IS NULL)
  );

-- ── 5. ONE PARTIAL UNIQUE INDEX PER SCOPE ─────────────────────────────────────────────────────
-- The old UNIQUE (field_id, tag) cannot serve both: with field_id nullable, two match-scoped rows
-- for one tag both carry field_id NULL, and NULLs do not collide in a unique index - so it would
-- silently permit duplicate priority rows on one match.
--
-- These are what the UI's upsert targets, one per scope (onConflict field_id,tag / match_id,tag),
-- which is what keeps the toggle safe against two operators at once rather than a read-then-write
-- with a window between.
ALTER TABLE public.promo_tags
  DROP CONSTRAINT IF EXISTS match_promotion_field_tag_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS promo_tags_field_tag_uniq
  ON public.promo_tags (field_id, tag) WHERE field_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS promo_tags_match_tag_uniq
  ON public.promo_tags (match_id, tag) WHERE match_id IS NOT NULL;

-- THE READ IS "every tag for the matches and fields on this week's grid", so both sides are indexed.
CREATE INDEX IF NOT EXISTS promo_tags_match_idx ON public.promo_tags (match_id);

-- ── 6. THE AUDIT ALLOWLIST, AND A GAP WORTH NAMING ────────────────────────────────────────────
-- TAG WRITES ARE NOT AUDITED TODAY. 0190 widened fin_change_log.table_name in anticipation, with a
-- comment about a table that "writes through recordWrite and is NOT on the list", but the route
-- never called recordWrite: src/app/api/match-promotion/route.ts has ZERO recordWrite calls, so the
-- 0190 entry has never been used. That is a standing-rule gap ("every write goes through
-- recordWrite") and it is mine, from 0190.
--
-- 'promo_tags' is permitted here so that wiring recordWrite is a code change and not another
-- migration. The old value is LEFT IN PLACE: a CHECK permitting a value no row uses costs nothing,
-- and narrowing the list is how a value another migration added gets dropped by accident.
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
    'match_promotion_field_tag',
    'promo_tags'
  ));

COMMENT ON TABLE public.promo_tags IS
  'Hand-set promotion tags at TWO scopes, enforced by promo_tags_scope_ck: priority is keyed on '
  'match_id, key_field and starting_11 on field_id. Renamed from match_promotion_field_tag by 0193 '
  'once it started holding match rows. PARTNER is deliberately absent: it is derived from the '
  'contract by isRevenueShareVenue and rendered read-only.';
COMMENT ON COLUMN public.promo_tags.match_id IS
  'mdapi_matches.api_id. Set only for priority. ON DELETE CASCADE never fires in practice - the '
  'match mirror tombstones via deleted_at rather than deleting.';
COMMENT ON COLUMN public.promo_tags.field_id IS
  'mdapi field id. Set only for key_field and starting_11. Deliberately NOT an FK: there is no '
  'fields table to point at, which is why 0190 keyed on the id rather than on a title.';

commit;

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- TO VERIFY:
--
--   select tag, count(*) filter (where match_id is not null) as on_match,
--                count(*) filter (where field_id is not null) as on_field
--     from public.promo_tags group by tag order by tag;
--
-- EXPECTED immediately after this runs: NO ROWS. Both seed rows were deleted by step 2 and the
-- table is written only from the tile panel.
--
--   -- THE TAG-AWARE CHECK, PROVED AND ROLLED BACK. This is verification item 7.
--   begin;
--     insert into public.promo_tags (field_id, match_id, tag) values (1717, 17516, 'key_field');
--     -- EXPECTED: ERROR ... violates check constraint "promo_tags_scope_ck"
--   rollback;
--
--   begin;
--     insert into public.promo_tags (field_id, tag) values (1717, 'priority');
--     -- EXPECTED: ERROR - priority may not be field-scoped either.
--   rollback;
--
-- CONTROL, so the two refusals above are the constraint and not a broken insert:
--
--   begin;
--     insert into public.promo_tags (field_id, tag) values (1717, 'key_field');
--     -- EXPECTED: one row inserted.
--   rollback;
--
-- TO UNDO:
--
--   alter table public.promo_tags rename to match_promotion_field_tag;
--   alter sequence public.promo_tags_id_seq rename to match_promotion_field_tag_id_seq;
--   alter table public.match_promotion_field_tag drop constraint if exists promo_tags_scope_ck;
--   alter table public.match_promotion_field_tag drop column if exists match_id;
--   drop index if exists public.promo_tags_field_tag_uniq;
--   drop index if exists public.promo_tags_match_tag_uniq;
--   alter table public.match_promotion_field_tag
--     add constraint match_promotion_field_tag_tag_ck check (tag in ('priority','starting_11'));
--   -- field_id cannot be set back to NOT NULL while match-scoped rows exist; delete them first.
--
-- The undo restores the SHAPE and not the DATA: the two deleted seed rows are gone either way, and
-- they were seed rows, which is the whole reason this migration is cheap to run today.
