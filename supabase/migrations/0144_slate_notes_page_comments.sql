-- 0144 — one comment mechanism, not two.
--
-- Match Promotion needs comments so people reviewing the week can leave suggestions with their
-- name on them. Slate Review already has exactly that: slate_notes (0119) + /api/slate-notes +
-- the NoteList component lifted out of SlateReviewView. Building a second one would be a second
-- place for the author, the week tag or the delete to be wrong.
--
-- SO THE TABLE GAINS A THIRD KIND AND LOSES A NOT NULL.
--
--   'proposal' — Slate Review. A parsed slot, pinned to a city AND a week.      city NOT NULL
--   'note'     — Slate Review. Free text for a city, tagged with its week.      city NOT NULL
--   'comment'  — Match Promotion. One list for the WHOLE PAGE.                  city NULL
--
-- THE SCOPE RULE IS THE CHECK. A note has a city; a comment does not. Match Promotion's grid shows
-- every city at once, so a comment there is about the week's promotion plan and not about any one
-- market — and there is no match_api_id either, deliberately: it is one list, not a thread per
-- fixture. Writing that as a constraint rather than as a convention is what stops a comment
-- arriving with a city and quietly appearing in Slate Review's city list.
--
-- DROPPING NOT NULL DOES NOT OPEN THE CITY BOUNDARY. Confinement is enforced at the ROUTE, not by
-- this column: /api/slate-notes AND /api/match-promotion are both on the REFUSED list in
-- cityConfinement (scripts/city-confinement-test.ts:79). A confined account cannot reach either,
-- so a row with no city cannot leak into one. Checked before writing this, not assumed.
--
-- EVERY EXISTING ROW STILL PASSES. All 8 live rows are kind='note' with a city (measured
-- 2026-08-25), so the new check is satisfied without touching any of them.
--
-- Apply in the Supabase SQL editor.

begin;

-- 1) A comment has no city.
alter table public.slate_notes alter column city drop not null;

-- 2) The third kind.
alter table public.slate_notes drop constraint if exists slate_notes_kind_chk;
alter table public.slate_notes add constraint slate_notes_kind_chk
  check (kind in ('proposal', 'note', 'comment'));

-- 3) THE SHAPE, RESTATED WHOLE. The original check guaranteed a proposal carries its entire parse
--    and a note carries none of it — that is what stops a half-parsed row rendering as a slot with
--    a blank time, and it is kept verbatim. What is ADDED is the scope half: a note has a city, a
--    comment does not, and a comment carries no parse either.
alter table public.slate_notes drop constraint if exists slate_notes_shape_chk;
alter table public.slate_notes add constraint slate_notes_shape_chk check (
  (kind = 'proposal'
     and city is not null
     and day is not null and time_txt is not null and time_min is not null and field_txt is not null)
  or
  (kind = 'note'
     and city is not null
     and day is null and time_txt is null and time_min is null and field_txt is null)
  or
  (kind = 'comment'
     and city is null
     and day is null and time_txt is null and time_min is null and field_txt is null)
);

-- 4) The comment read: every comment, newest first. The existing (city, created_at desc) index
--    cannot serve a null city usefully, so comments get their own partial one. week_start is still
--    stored and still stamped — it is the "week of Aug 24" tag on the row, not a filter.
create index if not exists slate_notes_comment_idx
  on public.slate_notes (created_at desc) where kind = 'comment';

commit;

-- VERDICT — ONE query, ONE row. The SQL editor shows only the last result set.
--   Expected:  city_nullable t | kind_has_comment t | notes_with_city 8 | bad_shape 0 | comments 0 | comment_idx 1
--
-- TWO COLUMNS CARRY THE INTENT, not just the count:
--   bad_shape       must be 0 — any row violating the new scope rule. The check would have
--                   refused the ALTER, so a non-zero here means the constraint did not apply.
--   notes_with_city must still be 8 — dropping NOT NULL must not have changed a single row.
select
  (select is_nullable = 'YES' from information_schema.columns
     where table_name = 'slate_notes' and column_name = 'city')                  as city_nullable,
  (select pg_get_constraintdef(oid) like '%comment%' from pg_constraint
     where conname = 'slate_notes_kind_chk')                                     as kind_has_comment,
  (select count(*) from slate_notes where kind = 'note' and city is not null)    as notes_with_city,
  (select count(*) from slate_notes
     where (kind <> 'comment' and city is null)
        or (kind =  'comment' and city is not null))                             as bad_shape,
  (select count(*) from slate_notes where kind = 'comment')                      as comments,
  (select count(*) from pg_indexes where indexname = 'slate_notes_comment_idx')  as comment_idx;

-- ROLLBACK. Safe ONLY while no comment row exists — a comment has no city, so restoring NOT NULL
-- would fail against one. Delete them first, deliberately, or leave this migration in place.
--   delete from slate_notes where kind = 'comment';
--   drop index if exists slate_notes_comment_idx;
--   alter table slate_notes drop constraint slate_notes_shape_chk;
--   alter table slate_notes add constraint slate_notes_shape_chk check (
--     (kind = 'proposal' and day is not null and time_txt is not null and time_min is not null and field_txt is not null)
--     or (kind = 'note' and day is null and time_txt is null and time_min is null and field_txt is null));
--   alter table slate_notes drop constraint slate_notes_kind_chk;
--   alter table slate_notes add constraint slate_notes_kind_chk check (kind in ('proposal','note'));
--   alter table slate_notes alter column city set not null;
