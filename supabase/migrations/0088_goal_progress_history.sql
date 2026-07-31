-- 0088: goal progress history — start accumulating a real series now.
--
-- There is no history table yet, so there is no chart. This begins recording one
-- point every time a goal's progress changes (from GoalEditDrawer, the only
-- write path to goals.progress). NOT backfilled and NOT synthesized — a real
-- series only. The sparkline renders at 4+ points; fewer means no chart element
-- at all, never a placeholder.
--
-- RLS mirrors kanban_cards: any authenticated user can read/write.
--
-- Apply in the Supabase SQL Editor.

create table if not exists goal_progress_history (
  id          bigserial primary key,
  goal_id     uuid not null references goals(id) on delete cascade,
  progress    integer not null check (progress between 0 and 100),
  recorded_at timestamptz not null default now(),
  recorded_by uuid references app_users(id)
);

create index if not exists goal_progress_history_goal_idx
  on goal_progress_history (goal_id, recorded_at);

alter table goal_progress_history enable row level security;

create policy goal_progress_history_all on goal_progress_history
  for all to authenticated using (true) with check (true);
