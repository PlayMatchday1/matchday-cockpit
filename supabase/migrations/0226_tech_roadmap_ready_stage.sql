-- 0226 — Tech Roadmap: a "Ready for release" stage, stored as 'ready'.
--
-- Built and tested, but players do not have it yet (waiting on review or a store release). It sits
-- between in_progress ("Working on it") and shipped ("Done").
--
-- kanban_cards_stage_valid is one CHECK covering all three boards that share kanban_cards (last
-- defined in 0166). It is REPLACED here with the same predicate plus 'ready' on tech_roadmap.
-- Field Pipeline and VC Outreach keep exactly the stages 0166 gave them.
--
-- Widening only: every existing row already passes, so re-adding the constraint (which checks all
-- rows) cannot fail on data. No row is changed.
--
-- The done_at trigger from 0225 needs NO change: it stamps done_at only on a move INTO 'shipped' and
-- clears it on any other stage, so a card moved into 'ready' never gets a done date.
--
-- Applied by Ryan in the Supabase SQL Editor on 2026-10-17 (the pre-check SELECT matched 0166).
-- Confirmed the same day: cards were saved as stage = 'ready' on both roadmap boards.

-- 0) Before applying: confirm the live constraint is still 0166's. It should list exactly
--    field_pipeline: backlog, contacted, negotiation, confirmed, archived
--    tech_roadmap:   ideas, in_plan, in_progress, shipped
--    vc_outreach:    not_contacted, outreach_sent, reply_needed, engaged, first_meeting,
--                    second_scheduling, second_scheduled
--    If it lists anything else, stop: the replacement below would drop it.
select pg_get_constraintdef(oid)
  from pg_constraint
 where conrelid = 'public.kanban_cards'::regclass
   and conname = 'kanban_cards_stage_valid';

begin;

alter table public.kanban_cards drop constraint if exists kanban_cards_stage_valid;
alter table public.kanban_cards
  add constraint kanban_cards_stage_valid check (
    (board_type = 'field_pipeline'
      and stage in ('backlog','contacted','negotiation','confirmed','archived'))
    or (board_type = 'tech_roadmap'
      and stage in ('ideas','in_plan','in_progress','ready','shipped'))
    or (board_type = 'vc_outreach'
      and stage in ('not_contacted','outreach_sent','reply_needed','engaged',
                    'first_meeting','second_scheduling','second_scheduled'))
  );

commit;
