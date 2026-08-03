-- 0094: venue_schedule_marks — the "No document" state for a field's Schedule.
--
-- Field Ops shows a field's schedule as "Open schedule ↗" (fin_venues.schedule_url
-- is set) or "+ Add link" (it isn't). "+ Add link" conflates "nobody has added it
-- yet" with "this field deliberately has no schedule doc". This table records the
-- deliberate case, attributed, so a field marked "No document" stops reading as an
-- open item.
--
--   fin_venues.schedule_url set   → "Open schedule" (link wins; this table ignored)
--   row here, no schedule_url      → "No document" (resolved, with who/when)
--   neither                        → still outstanding ("+ Add link" | "No document")
--
-- venue_id is the PK (one mark per venue → a double-click cannot duplicate).
-- marked_at is a server default (never a browser timestamp). ON DELETE CASCADE so
-- deleting a venue drops its mark. RLS mirrors review_replies after 0090: any
-- authenticated app_user may read/set/undo — this is ops triage, not an admin
-- mutation. The actor must be a real app_user (JWT email matches app_users).
--
-- Apply in the Supabase SQL Editor. Not applied by the app.

create table if not exists venue_schedule_marks (
  venue_id   bigint      primary key references fin_venues(id) on delete cascade,
  marked_by  uuid        not null references app_users(id),
  marked_at  timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists venue_schedule_marks_marked_by_idx on venue_schedule_marks (marked_by);

alter table venue_schedule_marks enable row level security;

-- Read: any authenticated app_user (the app re-reads after each write).
drop policy if exists venue_schedule_marks_appuser_select on venue_schedule_marks;
create policy venue_schedule_marks_appuser_select
  on venue_schedule_marks for select to authenticated
  using (exists (select 1 from app_users
    where lower(app_users.email) = lower(auth.jwt() ->> 'email')));

-- Mark "No document" (insert): any authenticated app_user.
drop policy if exists venue_schedule_marks_appuser_insert on venue_schedule_marks;
create policy venue_schedule_marks_appuser_insert
  on venue_schedule_marks for insert to authenticated
  with check (exists (select 1 from app_users
    where lower(app_users.email) = lower(auth.jwt() ->> 'email')));

-- Undo (delete): any authenticated app_user.
drop policy if exists venue_schedule_marks_appuser_delete on venue_schedule_marks;
create policy venue_schedule_marks_appuser_delete
  on venue_schedule_marks for delete to authenticated
  using (exists (select 1 from app_users
    where lower(app_users.email) = lower(auth.jwt() ->> 'email')));
