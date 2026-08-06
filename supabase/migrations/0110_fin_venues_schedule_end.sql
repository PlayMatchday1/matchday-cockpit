-- 0110: fin_venues schedule-end columns — the "Schedule ends" column that
-- replaces "Next match" on Field Ops. Records when a field's reservation runs
-- out, editable in the row.
--
-- FIVE display states are derived AT RENDER from these columns against today —
-- the status is NEVER stored (a stored "18 days left" is wrong tomorrow and
-- catastrophic in a month):
--   schedule_indefinite = true          -> Standing reservation (mint)
--   schedule_end_date > 30 days out      -> Reserved through   (quiet white)
--   schedule_end_date 0..30 days out     -> Ends soon          (amber)
--   schedule_end_date in the past        -> Reservation expired (coral)
--   both null / false                    -> Not set            (dashed)
--
-- INDEFINITE and a DATE are MUTUALLY EXCLUSIVE, enforced by a CHECK constraint:
-- a row may be indefinite, OR dated, OR neither (Not set) — never both. This is
-- the schema-level guarantee the app also mirrors client-side.
--
-- ATTRIBUTION mirrors venue_schedule_marks (0094): the acting app_user is
-- recorded in schedule_end_updated_by (supplied by the app, exactly like
-- marked_by), and the "when" is server-stamped by a BEFORE UPDATE trigger — never
-- a browser clock, matching how marked_at defaults to now(). (A column DEFAULT
-- only fires on INSERT, so a trigger is the UPDATE-path equivalent of that
-- default.)
--
-- GRANTS: these are new COLUMNS on fin_venues, not a new table. fin_venues
-- already grants authenticated admins UPDATE — the page writes schedule_url
-- through that same path (verified live: an authenticated admin no-op UPDATE
-- returns a row). A table-level GRANT covers all present AND future columns, so
-- no per-column grant is required and none can be missing; the existing RLS
-- UPDATE policy governs these writes unchanged.
--
-- Apply in the Supabase SQL Editor. Not applied by the app.

begin;

alter table fin_venues
  add column if not exists schedule_end_date        date,
  add column if not exists schedule_indefinite      boolean     not null default false,
  add column if not exists schedule_end_updated_by   uuid        references app_users(id),
  add column if not exists schedule_end_updated_at   timestamptz;

-- indefinite XOR dated (neither is allowed and means "Not set")
alter table fin_venues drop constraint if exists fin_venues_schedule_end_xor;
alter table fin_venues
  add constraint fin_venues_schedule_end_xor
  check (not (schedule_indefinite and schedule_end_date is not null));

-- server-stamp the "when" whenever either reservation-end field actually changes
create or replace function fin_venues_stamp_schedule_end()
returns trigger language plpgsql as $$
begin
  if (new.schedule_end_date is distinct from old.schedule_end_date)
     or (new.schedule_indefinite is distinct from old.schedule_indefinite) then
    new.schedule_end_updated_at := now();
  end if;
  return new;
end $$;

drop trigger if exists fin_venues_stamp_schedule_end on fin_venues;
create trigger fin_venues_stamp_schedule_end
  before update on fin_venues
  for each row execute function fin_venues_stamp_schedule_end();

commit;
