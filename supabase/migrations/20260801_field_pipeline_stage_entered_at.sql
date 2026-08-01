-- Field Pipeline: record WHEN a card entered its current stage.
--
-- Why: the board has no per-stage timestamp today. The stage-change write path
-- (useKanbanBoard.updateCard) patches only `stage`; `updated_at` is a general
-- "row last modified" column and moves for ANY edit (title, owner, checklist),
-- so it cannot stand in for stage age. Rather than synthesise a false age from
-- created_at/updated_at, the board omits aging/stalled UI until a real column
-- exists. This migration adds that column and keeps it current.
--
-- Run this in the Supabase SQL Editor. It is additive and non-destructive:
-- no drops, no deletes, no writes to any mdapi_* table.

-- 1) The column. Backfilled to NULL on purpose — we do NOT know the true
--    stage-entry time for existing rows, and a guessed value would be a lie.
--    "Age unknown" is honest; the board treats NULL as "no age to show".
alter table public.kanban_cards
  add column if not exists stage_entered_at timestamptz;

-- 2) Stamp it whenever a row's stage actually changes (and on insert).
create or replace function public.kanban_cards_stamp_stage_entered_at()
returns trigger
language plpgsql
as $$
begin
  if (tg_op = 'INSERT') then
    -- New card: it enters its initial stage now.
    new.stage_entered_at := coalesce(new.stage_entered_at, now());
  elsif (new.stage is distinct from old.stage) then
    -- Stage moved: reset the clock. Same-stage edits leave it untouched.
    new.stage_entered_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_kanban_cards_stage_entered_at on public.kanban_cards;
create trigger trg_kanban_cards_stage_entered_at
  before insert or update on public.kanban_cards
  for each row
  execute function public.kanban_cards_stamp_stage_entered_at();

-- After this runs, existing rows stay NULL (age hidden) and only start
-- accumulating a real stage age the next time each one is moved. To then light
-- up the aging/stalled chips + spine banding on the Field Pipeline board, wire
-- the client to read stage_entered_at (add it to the select in
-- src/lib/useKanbanBoard.ts and compute age = now - stage_entered_at, shown only
-- when stage_entered_at is non-null).
