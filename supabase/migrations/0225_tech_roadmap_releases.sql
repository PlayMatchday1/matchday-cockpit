-- 0225 — Tech Roadmap 2.0: releases, who the work belongs to, and the done date.
-- Additive only. Nothing is dropped; owner_user_id and data.estimated_hours stay as they are.
-- Applied by Ryan in the Supabase SQL Editor on 2026-10-17; confirmed through the REST API the same day.

begin;

-- 1. Releases. One roadmap each (app | clubhouse). Dates are plain calendar days, no time zone.
--    Building / Planned is NOT stored: it is derived from starts_on vs today.
create table if not exists public.kanban_releases (
  id         uuid        primary key default gen_random_uuid(),
  board      text        not null check (board in ('app','clubhouse')),
  version    text        not null check (btrim(version) <> ''),
  name       text        not null default '',
  starts_on  date        not null,
  out_by     date        not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint kanban_releases_dates check (out_by >= starts_on),
  constraint kanban_releases_board_version_key unique (board, version),
  constraint kanban_releases_id_board_key unique (id, board)   -- target of the card FK below
);

drop trigger if exists kanban_releases_set_updated_at on public.kanban_releases;
create trigger kanban_releases_set_updated_at before update on public.kanban_releases
  for each row execute function kanban_set_updated_at();

alter table public.kanban_releases enable row level security;
drop policy if exists kanban_releases_rw on public.kanban_releases;
create policy kanban_releases_rw on public.kanban_releases
  for all to authenticated
  using      (public.kanban_board_readable('tech_roadmap'))
  with check (public.kanban_board_readable('tech_roadmap'));

-- 2. A card is in one release or none, and only a release of ITS OWN roadmap.
--    The composite FK makes "App card in a Clubhouse release" impossible. Deleting a release
--    clears release_id only (PG15+ column-list SET NULL), so the card's board is untouched.
alter table public.kanban_cards add column if not exists release_id uuid;
alter table public.kanban_cards drop constraint if exists kanban_cards_release_fk;
alter table public.kanban_cards
  add constraint kanban_cards_release_fk
  foreign key (release_id, board) references public.kanban_releases (id, board)
  on delete set null (release_id);
alter table public.kanban_cards drop constraint if exists kanban_cards_release_roadmap_only;
alter table public.kanban_cards
  add constraint kanban_cards_release_roadmap_only
  check (release_id is null or board_type = 'tech_roadmap');
create index if not exists kanban_cards_release_idx
  on public.kanban_cards (release_id) where release_id is not null;

-- 3. Who: Ryan, ScrumLaunch, or null ("No one yet"). ScrumLaunch is not an app_users row, so this
--    is its own column rather than owner_user_id. Roadmap cards only.
alter table public.kanban_cards add column if not exists assignee text;
alter table public.kanban_cards drop constraint if exists kanban_cards_assignee_check;
alter table public.kanban_cards
  add constraint kanban_cards_assignee_check
  check (assignee is null or (board_type = 'tech_roadmap' and assignee in ('ryan','scrumlaunch')));
--    No backfill: every existing card starts with no assignee ("No one yet").

-- 4. Done date. Stamped by the database on the move INTO Done, cleared on the move out, so every
--    writer (drag, the panel, a script) gets it without the client remembering to.
alter table public.kanban_cards add column if not exists done_at timestamptz;

create or replace function public.kanban_cards_stamp_done_at()
returns trigger language plpgsql as $$
begin
  if new.board_type <> 'tech_roadmap' then return new; end if;
  if new.stage = 'shipped' then
    if tg_op = 'INSERT' then
      new.done_at := coalesce(new.done_at, now());
    elsif old.stage is distinct from 'shipped' then
      new.done_at := now();
    end if;
  else
    new.done_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_kanban_cards_done_at on public.kanban_cards;
create trigger trg_kanban_cards_done_at
  before insert or update on public.kanban_cards
  for each row execute function public.kanban_cards_stamp_done_at();

--    Backfill the 13 cards already in Done from when they entered that column.
update public.kanban_cards
   set done_at = coalesce(stage_entered_at, updated_at, created_at)
 where board_type = 'tech_roadmap'
   and stage = 'shipped'
   and done_at is null;

-- 5. Audit: count a change of who or release as an edit. Same function as 0066, two columns added
--    to the "did anything change" tuple. done_at is left out: it only moves with stage, which is
--    already audited as stage_change.
create or replace function kanban_audit() returns trigger
language plpgsql security definer as $$
declare actor uuid;
begin
  select id into actor from app_users
    where lower(email) = lower(auth.jwt() ->> 'email') limit 1;
  if tg_op = 'INSERT' then
    insert into kanban_audit_log(board_type, card_id, action, actor_user_id, details)
      values (new.board_type, new.id, 'create', actor,
              jsonb_build_object('title', new.title, 'stage', new.stage));
    return new;
  elsif tg_op = 'UPDATE' then
    if new.stage is distinct from old.stage then
      insert into kanban_audit_log(board_type, card_id, action, actor_user_id, details)
        values (new.board_type, new.id, 'stage_change', actor,
                jsonb_build_object('from', old.stage, 'to', new.stage));
    elsif (new.title, new.owner_user_id, new.data, new.assignee, new.release_id)
          is distinct from (old.title, old.owner_user_id, old.data, old.assignee, old.release_id) then
      insert into kanban_audit_log(board_type, card_id, action, actor_user_id, details)
        values (new.board_type, new.id, 'update', actor,
                jsonb_build_object('title', new.title));
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    insert into kanban_audit_log(board_type, card_id, action, actor_user_id)
      values (old.board_type, old.id, 'delete', actor);
    return old;
  end if;
  return null;
end;
$$;

commit;
