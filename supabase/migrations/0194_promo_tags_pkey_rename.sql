-- 0194 — FINISH THE RENAME. One statement.
--
-- 0193 renamed the table, the sequence and the field index, and MISSED THE PRIMARY KEY. Renaming a
-- table renames none of its constraints, and I named that fact in 0193's own comment and then left
-- one behind anyway. Confirmed against the live database rather than read off the file: forcing a
-- duplicate-id insert reported
--
--   violates unique constraint "match_promotion_field_tag_pkey"
--
-- so promo_tags was carrying a constraint named for a table that no longer exists. That is the
-- half-rename 0193 was written to avoid.
--
-- ALTER INDEX, NOT ALTER TABLE ... RENAME CONSTRAINT. A primary key and its backing index share one
-- name in Postgres, so renaming the index renames the constraint with it. ALTER TABLE ... RENAME
-- CONSTRAINT would also work; ALTER INDEX is the form that says what the object is.

begin;

ALTER INDEX public.match_promotion_field_tag_pkey RENAME TO promo_tags_pkey;

commit;

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- TO VERIFY, and it has to be forced because a PK name is not readable through PostgREST:
--
--   begin;
--     insert into public.promo_tags (id, field_id, tag) values (999999, -1, 'key_field');
--     insert into public.promo_tags (id, field_id, tag) values (999999, -2, 'key_field');
--     -- EXPECTED: ERROR ... violates unique constraint "promo_tags_pkey"
--   rollback;
--
-- Or directly:
--
--   select conname from pg_constraint
--    where conrelid = 'public.promo_tags'::regclass and contype = 'p';
--
-- EXPECTED: promo_tags_pkey
--
-- TO UNDO:
--
--   alter index public.promo_tags_pkey rename to match_promotion_field_tag_pkey;
