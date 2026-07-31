-- 0087: P&D (Presence & Direction) weekend roster.
--
-- One row per weekend, keyed by the Saturday date. The CHECK constraint makes a
-- non-Saturday row impossible, so "one row per weekend" is guaranteed by the
-- database rather than remembered by the code. Unassign sets owner_id null
-- (never deletes the row) so updated_by retains who cleared it.
--
-- RLS mirrors the neighbouring collaborative table kanban_cards: any
-- authenticated user can read and write. This is a shared on-call roster, not a
-- financial control; updated_by is the audit trail. No app_users.is_admin gate.
--
-- Apply in the Supabase SQL Editor before/with the Home-rebuild deploy.

create table if not exists pd_assignments (
  weekend_start date primary key,
  owner_id      uuid references app_users(id) on delete set null,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references app_users(id),
  constraint pd_weekend_is_saturday check (extract(dow from weekend_start) = 6)
);

alter table pd_assignments enable row level security;

create policy pd_assignments_all on pd_assignments
  for all to authenticated using (true) with check (true);
