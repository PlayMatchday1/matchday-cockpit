-- Phase 26 — Manager Check-In. Clubhouse's own record of who turned up.
--
-- WHY THIS TABLE EXISTS AT ALL (Part 0, question 2): the user-match DOES carry the attendance
-- field — `userStatus`, enum NONE / ON_TIME / LATE / NO_SHOW / CANCEL_W_IN_SOME_HOURS — but no
-- admin write path for it is proven. Retool, the reference implementation, only ever READS it
-- (`currentRow.userStatus == 'ON_TIME' ? '✅' : ''`); nothing sets it. So Clubhouse records marks
-- here and the UI says plainly that they have not been sent to MatchDay. If a write path is proven
-- later, `pushed_at` / `push_error` are already here to carry it — and question 4 (does setting the
-- same status twice double-count upstream?) must be answered BEFORE that push is enabled.
--
-- ┌──────────────────────────────────────────────────────────────────────────────────────────┐
-- │ HOW A PUSH MUST WORK, IF ONE IS EVER ENABLED. READ THIS BEFORE WIRING setStrike.          │
-- └──────────────────────────────────────────────────────────────────────────────────────────┘
-- We CANNOT set attendance status (no admin write for userStatus). We CAN create the strike
-- itself: POST /admin/strikes (Retool "setStrike") and DELETE-ish /admin/strikes/strike-logs/{id}
-- ("removeStrike") are proven-existing writes. Do NOT take that as permission to push per tap.
--
-- 4 ACTIVE STRIKES = AN AUTOMATIC ONE-WEEK SUSPENSION, applied by the backend with no admin
-- involvement (docs/matchday-api-facts.md, STRIKES). setStrike's idempotency is UNKNOWN — the
-- Retool export's transit encoding dedupes body keys behind symbol references, so the body shape
-- could not be read, and probing it with a body would BE a write against a real player.
--
-- Therefore, if setStrike is not idempotent, a retried tap does not create a harmless duplicate
-- row. It pushes a real person closer to a suspension, and four of them suspends someone for a
-- week for turning up once. So a push MUST be:
--   * a SINGLE EXPLICIT POST-MATCH ACTION — never the per-tap optimistic sync this screen uses;
--   * ONE ROW AT A TIME;
--   * guarded on `pushed_at IS NULL`, so a row already sent can never be sent twice;
--   * NEVER retried on failure — record push_error and let a human decide.
-- Answer "do two identical setStrike calls create two strikeLogs?" BEFORE any of this ships.
--
-- IDEMPOTENT BY CONSTRUCTION. The primary key is (match_id, player_id) and every write is an
-- UPSERT, so the optimistic-sync retry that this screen depends on cannot create a second row no
-- matter how many times it fires. Clearing a mark DELETES the row — absence means unmarked, which
-- is a different thing from any status value.
--
-- STRIKE WEIGHT IS OURS. Part 0 found no evidence the server derives a weight from a status
-- (the one live strikeLog carried penaltyPoint 1; nothing showed a 2). strike_value is stored
-- alongside the status so the number that was applied is a fact of the row, not something a later
-- code change silently re-derives.
--
-- NO PII. change_log gets match_id, player_id and status — never the player's name or phone.

create table if not exists match_checkin_marks (
  match_id     bigint      not null,
  player_id    bigint      not null,
  status       text        not null check (status in ('ok','late','no_show')),
  strike_value int         not null,
  marked_by    text        not null,           -- the Clubhouse user's email
  marked_at    timestamptz not null default now(),
  pushed_at    timestamptz,                    -- null => not sent to MatchDay (shown in the UI)
  push_error   text,
  primary key (match_id, player_id)
);

-- The screen's only read: every mark for one match.
create index if not exists match_checkin_marks_match_idx on match_checkin_marks (match_id);
-- Finding what has not been pushed, for when a push path exists.
create index if not exists match_checkin_marks_unpushed_idx on match_checkin_marks (match_id) where pushed_at is null;

-- NOTE: the column is `team_placing`, NOT `placing`. PLACING is a RESERVED KEYWORD in Postgres
-- (it belongs to `overlay(... placing ...)`), so `placing jsonb` is a syntax error. Quoting it
-- would work but would force every future raw query to write "placing" — a trap for whoever
-- writes the next SELECT. Renaming costs one word and removes the hazard permanently.
create table if not exists match_checkin_result (
  match_id     bigint primary key,
  winning_team int,
  team_placing jsonb,
  set_by       text        not null,
  set_at       timestamptz not null default now(),
  pushed_at    timestamptz
);

-- Reads and writes both go through the guarded route (/api/matchops/checkin/[matchId],
-- authenticateMatchOpsRead) using the service-role client. RLS on with NO policies for anon or
-- authenticated, so a browser holding only the anon key cannot touch either table directly.
alter table match_checkin_marks enable row level security;
alter table match_checkin_result enable row level security;

-- Proof queries after applying:
--   -- must return both tables:
--   select table_name from information_schema.tables
--     where table_name in ('match_checkin_marks','match_checkin_result');
--   -- must return true, true (RLS on):
--   select relname, relrowsecurity from pg_class
--     where relname in ('match_checkin_marks','match_checkin_result');
--   -- must return 0 (no policies — service role only):
--   select count(*) from pg_policies
--     where tablename in ('match_checkin_marks','match_checkin_result');
--   -- must RAISE (the status allowlist):
--   insert into match_checkin_marks (match_id, player_id, status, strike_value, marked_by)
--     values (1, 1, 'maybe', 0, 'test');
--   -- must leave ONE row, not two (the idempotency the sync design rests on):
--   insert into match_checkin_marks (match_id, player_id, status, strike_value, marked_by)
--     values (1, 1, 'late', 1, 'test')
--     on conflict (match_id, player_id) do update set status = excluded.status;
--   insert into match_checkin_marks (match_id, player_id, status, strike_value, marked_by)
--     values (1, 1, 'late', 1, 'test')
--     on conflict (match_id, player_id) do update set status = excluded.status;
--   select count(*) from match_checkin_marks where match_id = 1 and player_id = 1;  -- 1
--   delete from match_checkin_marks where match_id = 1 and player_id = 1;           -- clean up

-- ROLLBACK (kill switch) — drops the marks and the result. There is no soft delete.
--   drop table if exists match_checkin_marks;
--   drop table if exists match_checkin_result;
