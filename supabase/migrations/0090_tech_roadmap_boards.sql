-- Tech Roadmap → two boards: App Roadmap + Clubhouse Roadmap.
--
-- The Tech Roadmap becomes two boards in one table. `kanban_cards` is shared
-- with Field Pipeline, which is distinguished by board_type='field_pipeline';
-- the Tech Roadmap is board_type='tech_roadmap'. This migration adds a SECOND
-- discriminator, `board` (app|clubhouse), that ONLY the Tech Roadmap reads.
-- Field Pipeline rows also get board='app' from the DEFAULT, but nothing on the
-- Field Pipeline read/write path ever looks at `board` (it filters on
-- board_type='field_pipeline' — see src/lib/useKanbanBoard.ts reload()), so the
-- new column cannot collide with how Field Pipeline distinguishes its rows.
-- Verified: grep of the codebase shows `board_type` is the only discriminator in
-- every kanban query; `board` is introduced here and read only by the roadmap.
--
-- On "moved_at": the brief expected a new moved_at column. The repo ALREADY has
-- stage_entered_at (migration 20260801_field_pipeline_stage_entered_at.sql) with
-- a BEFORE INSERT/UPDATE trigger that stamps now() on every stage change, for
-- BOTH boards. That is exactly what moved_at would be — a last-moved timestamp,
-- DB-enforced for every writer (drag, drawer buttons, API). Adding a second
-- column would be a redundant source of truth the client would have to keep in
-- sync by hand. So the roadmap's stale model reads stage_entered_at, and this
-- migration only BACKFILLS it for existing tech_roadmap rows (which were NULL,
-- because that migration deliberately left existing rows unstamped). The
-- backfill is the brief's COALESCE(updated_at, created_at), applied to the
-- column that already exists.
--
-- Run this in the Supabase SQL Editor. Additive and non-destructive: no drops,
-- no deletes, nothing writes to any mdapi_* table.

begin;

-- 1) The board discriminator. NOT NULL, defaulted to 'app' so every existing
--    row (the current page IS the App Roadmap) becomes App, and constrained so
--    only the two known boards are possible.
alter table public.kanban_cards
  add column if not exists board text not null default 'app';

alter table public.kanban_cards
  drop constraint if exists kanban_cards_board_check;
alter table public.kanban_cards
  add constraint kanban_cards_board_check check (board in ('app','clubhouse'));

-- 2) Backfill stage_entered_at for existing Tech Roadmap rows only. Field
--    Pipeline's rows keep their intentional NULL ("age unknown until moved");
--    the roadmap needs a last-moved date for every non-idea card, so we seed it
--    from the best available lower bound. New moves overwrite this via the
--    existing trigger.
update public.kanban_cards
   set stage_entered_at = coalesce(stage_entered_at, updated_at, created_at)
 where board_type = 'tech_roadmap'
   and stage_entered_at is null;

-- 3) The read path filters (board_type, board, stage). Index it.
create index if not exists idx_kanban_cards_board
  on public.kanban_cards (board_type, board, stage);

-- 4) Seed the Clubhouse Roadmap from the approved backlog (mockup BOARDS.ch).
--    Timestamps are now(): these rows are created now, and inserting the
--    mockup's synthetic per-card ages as production timestamps would be a lie
--    (same principle as the stage_entered_at migration). They accumulate real
--    age from here. Estimated_hours is set only where a real estimate was typed
--    in the backlog; most cards carry none, which the page states plainly.
--    Owners map to real app_users; one Idea is deliberately owner-less.
--    Idempotent: skips if any clubhouse card already exists.
insert into public.kanban_cards (board_type, board, title, stage, owner_user_id, sort_order, data)
select v.board_type, v.board, v.title, v.stage, v.owner_user_id, v.sort_order, v.data
from (values
  -- Ideas
  ('tech_roadmap','clubhouse','Retool sunset','ideas','50e7c3ba-e778-42eb-a960-81b69c18c1c5'::uuid,1,'{"priority":"High","description":"","planned_date":null}'::jsonb),
  ('tech_roadmap','clubhouse','QuickBooks sync','ideas','50e7c3ba-e778-42eb-a960-81b69c18c1c5'::uuid,2,'{"priority":"High","description":"","planned_date":null}'::jsonb),
  ('tech_roadmap','clubhouse','Members & retention dashboard','ideas','50e7c3ba-e778-42eb-a960-81b69c18c1c5'::uuid,3,'{"priority":"Medium","description":"","planned_date":null}'::jsonb),
  ('tech_roadmap','clubhouse','Uncovered-weekend nudge','ideas','50e7c3ba-e778-42eb-a960-81b69c18c1c5'::uuid,4,'{"priority":"Medium","description":"","planned_date":null}'::jsonb),
  ('tech_roadmap','clubhouse','Repeated-failure alert (N=3)','ideas','3ab23c75-be12-4a1a-8fc1-928c2cc4857e'::uuid,5,'{"priority":"Medium","description":"","planned_date":null}'::jsonb),
  ('tech_roadmap','clubhouse','Promotion to recurring matches','ideas','50e7c3ba-e778-42eb-a960-81b69c18c1c5'::uuid,6,'{"priority":"Medium","description":"","planned_date":null}'::jsonb),
  ('tech_roadmap','clubhouse','Veo naming cheat-sheet','ideas','50e7c3ba-e778-42eb-a960-81b69c18c1c5'::uuid,7,'{"priority":"Low","description":"","planned_date":null}'::jsonb),
  ('tech_roadmap','clubhouse','Operating Snapshot fix','ideas','50e7c3ba-e778-42eb-a960-81b69c18c1c5'::uuid,8,'{"priority":"High","description":"","planned_date":null}'::jsonb),
  ('tech_roadmap','clubhouse','Single source for field cost','ideas','50e7c3ba-e778-42eb-a960-81b69c18c1c5'::uuid,9,'{"priority":"High","description":"","planned_date":null}'::jsonb),
  ('tech_roadmap','clubhouse','Goal status has two sources of truth','ideas',null,10,'{"priority":"Medium","description":"","planned_date":null}'::jsonb),
  ('tech_roadmap','clubhouse','Kanban: one implementation, not two','ideas','3ab23c75-be12-4a1a-8fc1-928c2cc4857e'::uuid,11,'{"priority":"Medium","description":"","planned_date":null}'::jsonb),
  -- In plan
  ('tech_roadmap','clubhouse','Google Calendar integration (Phase A)','in_plan','133257e6-e640-421a-a681-caaed46dc744'::uuid,1,'{"priority":"High","description":"Read-only, events-only service account. Blocked on the service account handoff.","planned_date":null}'::jsonb),
  ('tech_roadmap','clubhouse','Player Chats','in_plan','3ab23c75-be12-4a1a-8fc1-928c2cc4857e'::uuid,2,'{"priority":"High","description":"The player-side counterpart to Match Chats, with an awaiting-reply queue.","planned_date":null,"estimated_hours":24}'::jsonb),
  ('tech_roadmap','clubhouse','Nav restructure: Inventory + automation','in_plan','50e7c3ba-e778-42eb-a960-81b69c18c1c5'::uuid,3,'{"priority":"Medium","description":"Inventory becomes its own rail item; Veo and Community move behind one automation button.","planned_date":null}'::jsonb),
  -- In progress
  ('tech_roadmap','clubhouse','Manager Pay redesign','in_progress','50e7c3ba-e778-42eb-a960-81b69c18c1c5'::uuid,1,'{"priority":"High","description":"Calendar and payout run on one screen, moving out of Finance into Match Ops.","planned_date":null,"estimated_hours":16}'::jsonb),
  ('tech_roadmap','clubhouse','Fields attendance correction','in_progress','50e7c3ba-e778-42eb-a960-81b69c18c1c5'::uuid,2,'{"priority":"High","description":"The page labels sign-ups as attendance. is_absent is 0% populated — there is no attendance signal.","planned_date":null,"estimated_hours":4}'::jsonb),
  -- Shipped
  ('tech_roadmap','clubhouse','Master Schedule mobile fix','shipped','50e7c3ba-e778-42eb-a960-81b69c18c1c5'::uuid,1,'{"priority":"High","description":"Shipped as a481a48.","planned_date":null,"estimated_hours":6}'::jsonb),
  ('tech_roadmap','clubhouse','Reviews page','shipped','50e7c3ba-e778-42eb-a960-81b69c18c1c5'::uuid,2,'{"priority":"Medium","description":"First-match review queue.","planned_date":null,"estimated_hours":12}'::jsonb),
  ('tech_roadmap','clubhouse','Field Pipeline kanban','shipped','3ab23c75-be12-4a1a-8fc1-928c2cc4857e'::uuid,3,'{"priority":"Medium","description":"Drag-ordered field acquisition board.","planned_date":null,"estimated_hours":16}'::jsonb)
) as v(board_type, board, title, stage, owner_user_id, sort_order, data)
where not exists (
  select 1 from public.kanban_cards
   where board_type = 'tech_roadmap' and board = 'clubhouse'
);

commit;
