-- fin_expenses: who-changed-it audit columns.
--
-- Today fin_expenses has created_at only. A booked cost that changes with no
-- record of who changed it is not acceptable on a finance table, and inline
-- editing (OpEx Calendar + the Expenses tab) is about to make edits easy.
--
-- Every UPDATE from either surface populates both columns (updated_at = now(),
-- updated_by = the editor's app_users.id). Additive, nullable — existing rows
-- and inserts are unaffected until first edited.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run BEFORE deploying.

alter table fin_expenses add column if not exists updated_at timestamptz;
alter table fin_expenses add column if not exists updated_by uuid references app_users(id);
