-- 0198 — fin_txn_balance_txn_uniq must not be partial.
--
-- 0196 created it as `... where balance_txn_id is not null`, reasoning that the manual Venmo rows
-- carry a null id and would collide. They do not: Postgres treats NULLs as DISTINCT in a unique
-- index, so any number of null-id rows are already allowed without a predicate. Proven against the
-- live table — two rows with a null balance_txn_id were both accepted under the partial index.
--
-- THE PREDICATE COST THE UPSERT, which is the one property the whole back-fill design rests on.
-- ON CONFLICT (col) will only use a PARTIAL index if the statement repeats the index predicate, and
-- PostgREST's upsert emits no WHERE. Every call returned
--     there is no unique or exclusion constraint matching the ON CONFLICT specification
-- and the back-fill failed on all 42 months, writing nothing.
--
-- The index enforced correctly the whole time — a duplicate insert was refused. It simply could not
-- be named as a conflict target, which an insert-only test could never have shown. That is why the
-- check after this migration upserts rather than inserts.
drop index if exists public.fin_txn_balance_txn_uniq;

create unique index fin_txn_balance_txn_uniq
  on public.fin_txn (balance_txn_id);
