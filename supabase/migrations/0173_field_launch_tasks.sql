-- 0173 — the field launch plan: 24 task rows per field, copied from the playbook.
--
-- ══ WHY ROWS AND NOT A JSON BLOB ON fin_venues ═══════════════════════════════════════════════
-- Every task carries an owner, a done flag, an N/A flag and a week window, and two people work a
-- launch at once. A jsonb column would make "tick task 9" a read-modify-write of the whole plan,
-- so the last writer silently discards the other's tick. Rows make each task its own write.
--
-- ══ THE PLAN IS A COPY, AND THE TEMPLATE IS IN CODE ══════════════════════════════════════════
-- src/lib/launchPlan.ts holds the 24 template tasks; seeding COPIES them here at bind time. There
-- is deliberately no templates table: nothing in this app may edit the playbook, so making it
-- editable data would be building the control we decided not to ship. A city's own task is a row
-- here with template_key NULL, which is also what makes it the only kind that can be removed.
--
-- ══ THERE IS NO PLANS TABLE EITHER ═══════════════════════════════════════════════════════════
-- "This field has a plan" is already recorded: kanban_cards.venue_id points at it (0172) and
-- fin_venues.launch_date dates it. A third row saying so could disagree with both.
--
-- THE LAUNCH DATE IS NOT COPIED HERE. It lives on fin_venues, alone, so that moving it moves every
-- date on the plan page. A date on this table would be 24 copies to keep in step.
--
-- Apply in the Supabase SQL Editor. Not applied by the app.
--
-- SAFE TO APPLY AFTER THE CODE DEPLOYS. Seeding fails soft: until this table exists the bind
-- dialog still binds the card and the venue, and the plan page seeds on first open instead.

begin;

create table if not exists public.field_launch_tasks (
  id           bigint generated always as identity primary key,
  -- ON DELETE CASCADE: a venue's plan is meaningless without the venue. This is the only place in
  -- the estate where a fin_venues delete should take rows with it, and it is why venue_id on
  -- kanban_cards is SET NULL instead — a card outlives its binding, a task does not.
  venue_id     bigint not null references public.fin_venues (id) on delete cascade,
  -- NULL means somebody added this task for this field. Non-null names the playbook row it came
  -- from, which is what makes re-seeding idempotent and what decides N/A-vs-Remove in the UI.
  template_key text,
  title        text not null check (length(btrim(title)) > 1),
  scope        text not null,
  department   text,
  week_start   smallint not null check (week_start between 1 and 20),
  week_end     smallint not null check (week_end   between 1 and 20),
  sort_order   integer not null default 0,
  done         boolean not null default false,
  done_at      timestamptz,
  -- N/A IS NOT DELETION. The row stays, struck through, out of the denominator and the overdue
  -- count, and it can be put back.
  na           boolean not null default false,
  owner_user_id uuid references public.app_users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint field_launch_tasks_week_order check (week_end >= week_start)
);

-- ONE ROW PER PLAYBOOK TASK PER FIELD. Seeding is "insert the keys this venue is missing", and two
-- tabs opening the same plan at once both run it; this is what makes the loser a no-op rather than
-- a second copy of the plan. Custom tasks carry NULL and a unique index ignores them, so a field
-- can have as many of its own as it likes.
create unique index if not exists field_launch_tasks_venue_key
  on public.field_launch_tasks (venue_id, template_key)
  where template_key is not null;

create index if not exists field_launch_tasks_venue_idx
  on public.field_launch_tasks (venue_id);

-- ══ RLS ═════════════════════════════════════════════════════════════════════════════════════
-- The SAME predicate the Field Pipeline board uses (0166). A launch plan is downstream of a
-- pipeline card, so anyone who can read the board can read its plans and nobody else — and the
-- browser holds a Supabase client with the user's JWT, so this is the gate that actually holds.
-- kanban_board_readable() already refuses confined city managers and service accounts.
alter table public.field_launch_tasks enable row level security;

drop policy if exists field_launch_tasks_rw on public.field_launch_tasks;
create policy field_launch_tasks_rw on public.field_launch_tasks
  for all to authenticated
  using      (public.kanban_board_readable('field_pipeline'))
  with check (public.kanban_board_readable('field_pipeline'));

comment on table public.field_launch_tasks is
  'One field launch plan = 24 rows copied from the playbook in src/lib/launchPlan.ts at bind time. '
  'template_key null means a task added for this field only, and only those can be removed. '
  'The launch date is NOT here: it lives on fin_venues.launch_date so moving it moves the plan.';

commit;
