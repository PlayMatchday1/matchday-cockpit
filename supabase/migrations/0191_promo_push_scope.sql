-- 0191 — A PUSH GAINS A SCOPE. Match, field or city, in the table it already lives in.
--
-- ══ WHY THIS EXTENDS 0176 RATHER THAN GETTING ITS OWN TABLE ═══════════════════════════════════
--
-- Ryan: "We should add an option per city so we can add general pushes (pushing all the slate to
-- registered users or pushing general slate for a specific field for example)." And, on the shape:
-- "the queue is derived from one source and asserted both directions, because a push on the strip
-- and a push on a tile that disagree is the one failure this page cannot survive. Two tables would
-- give you exactly that, and it would show up weeks later as a count that does not add up."
--
-- That is the whole reason. The day queue is a projection of the week's pushes; the tile's
-- coverage is a projection of the same set. Two tables means two reads, two filters and two places
-- to forget one, and the symptom is a queue total that disagrees with the grid by a number nobody
-- can source. One table, one scope column, one read.
--
-- ══ match_api_id BECOMES NULLABLE, AND THAT IS THE RISKY PART ════════════════════════════════
--
-- A city push belongs to no match. Dropping NOT NULL is not reversible while general pushes exist,
-- and every existing reader assumes the column is there. So the CHECK below makes the three shapes
-- mutually exclusive and total: exactly one of match / field / city is populated for its scope, and
-- the other two are NULL. A row that satisfies no branch cannot be written at all.
--
-- EVERY EXISTING ROW IS scope='match' BY DEFAULT and keeps its match_api_id, so the 0176 readers
-- are unaffected by construction rather than by care.
--
-- ══ THE AUDIENCE IS TEXT AND IS NOT DERIVED ══════════════════════════════════════════════════
--
-- "all registered in Atlanta" is what the operator tells the reader, and it is what they need to
-- judge whether the blast was enough. Deriving it would mean this table knowing what a Klaviyo
-- segment contains, which it does not and should not. Nullable: a field push to the field's own
-- list often needs no sentence.
--
-- ══ WHAT A GENERAL PUSH COVERS, AND WHAT IT DOES NOT ═════════════════════════════════════════
--
-- THE DAY IT IS SENT FOR, NOT THE WEEK. Built the other way first and Austin went to zero "no
-- plan" instantly, at which point the column tells nobody anything. A city wanting its week
-- covered sends one a day, which is what the operator does anyway. That rule lives in the code
-- (coverage is a projection, not a stored fact) and is asserted there; nothing here stores it.

begin;

ALTER TABLE public.match_promotion_push
  ADD COLUMN IF NOT EXISTS scope          text NOT NULL DEFAULT 'match',
  ADD COLUMN IF NOT EXISTS scope_city     text,
  ADD COLUMN IF NOT EXISTS scope_field_id bigint,
  ADD COLUMN IF NOT EXISTS audience       text;

ALTER TABLE public.match_promotion_push
  ALTER COLUMN match_api_id DROP NOT NULL;

ALTER TABLE public.match_promotion_push
  DROP CONSTRAINT IF EXISTS match_promotion_push_scope_ck;
ALTER TABLE public.match_promotion_push
  ADD CONSTRAINT match_promotion_push_scope_ck
  CHECK (scope IN ('match', 'field', 'city'));

-- ── THE THREE SHAPES, MUTUALLY EXCLUSIVE AND TOTAL ───────────────────────────────────────────
-- A match push has a match and no scope columns. A field push has a field and a city (the city is
-- what the header it was created from is scoped to, and what the queue row prints). A city push
-- has a city and no field. Anything else is refused rather than stored and reasoned about later.
ALTER TABLE public.match_promotion_push
  DROP CONSTRAINT IF EXISTS match_promotion_push_scope_shape_ck;
ALTER TABLE public.match_promotion_push
  ADD CONSTRAINT match_promotion_push_scope_shape_ck CHECK (
    (scope = 'match' AND match_api_id IS NOT NULL AND scope_field_id IS NULL AND scope_city IS NULL)
 OR (scope = 'field' AND match_api_id IS NULL     AND scope_field_id IS NOT NULL AND scope_city IS NOT NULL)
 OR (scope = 'city'  AND match_api_id IS NULL     AND scope_field_id IS NULL     AND scope_city IS NOT NULL)
  );

-- THE WEEK'S GENERAL PUSHES ARE READ BY CITY AND DATE, so the index carries both. Partial on the
-- non-match scopes: match pushes are already served by match_promotion_push_match_idx, and a
-- general push is a small minority of the table.
CREATE INDEX IF NOT EXISTS match_promotion_push_scope_idx
  ON public.match_promotion_push (scope_city, push_at)
  WHERE scope <> 'match';

COMMENT ON COLUMN public.match_promotion_push.scope IS
  'match | field | city. A general push belongs to no match, so match_api_id is NULL for those '
  'two and the shape CHECK makes the three mutually exclusive. Defaulted to match so every row '
  'written before 0191 is correct without being touched.';
COMMENT ON COLUMN public.match_promotion_push.audience IS
  'Who the blast went to, in the operator''s own words - "all registered in Atlanta". NOT derived: '
  'that would mean this table knowing what a Klaviyo segment holds. The queue prints it because a '
  'tile has no room for it and the operator needs it to judge whether the blast was enough.';
COMMENT ON COLUMN public.match_promotion_push.scope_field_id IS
  'mdapi field_id for a field-scoped push. Paired with scope_city, which is the city header the '
  'push was created from and what the queue row prints beside the field name.';

commit;

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- TO VERIFY:
--
--   select scope, count(*), count(match_api_id) as with_match,
--          count(scope_city) as with_city, count(scope_field_id) as with_field
--     from public.match_promotion_push group by scope order by scope;
--
-- EXPECTED immediately after this runs: one row, scope 'match', count equal to the table's total,
-- with_match equal to that same count, with_city 0 and with_field 0. Every existing push is a
-- match push and nothing has moved.
--
--   select count(*) from public.match_promotion_push where match_api_id is null;
--
-- EXPECTED: 0. The column is now nullable and nothing is null yet.
--
-- TO UNDO, and it is only safe while no general push exists:
--
--   delete from public.match_promotion_push where scope <> 'match';
--   alter table public.match_promotion_push
--     drop constraint if exists match_promotion_push_scope_shape_ck,
--     drop constraint if exists match_promotion_push_scope_ck,
--     drop column if exists scope, drop column if exists scope_city,
--     drop column if exists scope_field_id, drop column if exists audience;
--   alter table public.match_promotion_push alter column match_api_id set not null;
--
-- THE DELETE IS NOT OPTIONAL. Restoring NOT NULL with a general push present fails, and dropping
-- the scope column first would leave those rows indistinguishable from match pushes with a null
-- match - which is the one state the CHECK above exists to make impossible.
