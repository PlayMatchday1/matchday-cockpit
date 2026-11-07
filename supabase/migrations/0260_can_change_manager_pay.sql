-- 0260 — MANAGER PAY CHANGES IN THE STAFF APP, PER PERSON (Ryan, 2026-11-07).
--
-- Until now the staff app offered manager pay changes to every account with Match Ops and no city
-- (/api/app/manager-pay POST; me.canChangeManagerPay = !confined). Ryan: manager pay changes stay off
-- unless he turns them on per person. This is that box. Admins keep it without the box.
-- The DESKTOP Manager Pay page is unchanged by this column.
--
-- Run in the Supabase SQL Editor. Adds one column, default false; no row is changed.

begin;
alter table app_users add column if not exists can_change_manager_pay boolean not null default false;
comment on column app_users.can_change_manager_pay is
  '0260: the staff app''s manager pay changes (Additional pay, Add someone not on the schedule) for a non-admin. Off by default; ticked per person on Admin → User access. Desktop Manager Pay is unaffected.';
commit;

-- Check (expect has_column = 1, ticked = 0):
select
  (select count(*) from information_schema.columns where table_name = 'app_users' and column_name = 'can_change_manager_pay') as has_column,
  (select count(*) from app_users where can_change_manager_pay) as ticked;
