-- Phase 26 — Slate Review notes persist.
--
-- The Master Schedule note box on Slate Review was in-memory: its own help text said
-- "Nothing is saved — this clears on reload." This table makes it a TO-DO LIST. A row sits
-- here until someone takes the action and deletes it.
--
-- TWO KINDS, one table:
--   'proposal' — the capture parser found a day + time + field ("8PM thurs Crossbar"). Pinned
--                to its day AND its week: it is a proposed slot for that week and means nothing
--                against a different one.
--   'note'     — everything else, kept word for word. NOT week-scoped: it stays visible for its
--                city whatever week is selected, tagged with the week it was written on.
--
-- RAW TEXT IS STORED ALONGSIDE THE PARSE, always, for both kinds. The parser guesses (a bare
-- hour of 1–11 is read as PM; a field alias is matched against the city's field list). Storing
-- only the parse would make a mis-parse permanent and unreviewable. `raw` is what was typed.
--
-- HARD DELETE. No deleted_at, no restore, no auto-expiry. Delete means gone — that is the
-- whole point of a to-do list.
--
-- NOT in change_log: that table is the audit of writes to the MatchDay API (recordWrite). This
-- is Clubhouse's own scratch data and never leaves Supabase.

create table if not exists slate_notes (
  id          uuid        primary key default gen_random_uuid(),
  city        text        not null,
  kind        text        not null,               -- 'proposal' | 'note'
  raw         text        not null,               -- EXACTLY as typed. Never derived, never rewritten.
  -- the parse — proposals only, all four together or none (see the shape check below)
  day         text,                               -- 'Mon'..'Sun'
  time_txt    text,                               -- display time, e.g. '8:00 PM'
  time_min    integer,                            -- minutes past midnight, so 10 PM sorts after 7 PM
  field_txt   text,                               -- the resolved field, or the text as typed when unresolved
  week_start  date        not null,               -- the Monday of the week it was written on
  created_by  text        not null,               -- the Clubhouse user's email
  created_at  timestamptz not null default now(),

  constraint slate_notes_kind_chk check (kind in ('proposal','note')),
  constraint slate_notes_day_chk  check (day is null or day in ('Mon','Tue','Wed','Thu','Fri','Sat','Sun')),
  -- A proposal MUST carry its whole parse; a note must carry none of it. This is what stops a
  -- half-parsed row rendering as a slot with a blank time.
  constraint slate_notes_shape_chk check (
    (kind = 'proposal' and day is not null and time_txt is not null and time_min is not null and field_txt is not null)
    or
    (kind = 'note' and day is null and time_txt is null and time_min is null and field_txt is null)
  ),
  constraint slate_notes_raw_chk check (length(btrim(raw)) > 0)
);

-- The city read: every row for a city, newest first. Notes are not week-filtered, so the city
-- index does the work for both kinds and the week filter for proposals happens on the small set.
create index if not exists slate_notes_city_idx on slate_notes (city, created_at desc);
-- Proposals for one city + week — the day-strip render.
create index if not exists slate_notes_city_week_idx on slate_notes (city, week_start) where kind = 'proposal';

-- Reads and writes both go through the guarded route (/api/slate-notes, authenticateMatchOpsRead
-- = can_access_matchops) using the service-role client. RLS on with NO policies for anon or
-- authenticated, so a browser holding only the anon key cannot read or write this table directly.
alter table slate_notes enable row level security;

-- Proof queries after applying:
--   -- must return the table with 11 columns:
--   select column_name, data_type from information_schema.columns
--     where table_name = 'slate_notes' order by ordinal_position;
--   -- must return true (RLS on):
--   select relrowsecurity from pg_class where relname = 'slate_notes';
--   -- must return 0 (no policies — service role only):
--   select count(*) from pg_policies where tablename = 'slate_notes';
--   -- must RAISE (the shape check: a proposal with no time):
--   insert into slate_notes (city, kind, raw, day, week_start, created_by)
--     values ('Austin','proposal','x','Mon',current_date,'test');

-- ROLLBACK (kill switch) — drops the table and its data. There is no soft delete to fall back on.
--   drop table if exists slate_notes;
