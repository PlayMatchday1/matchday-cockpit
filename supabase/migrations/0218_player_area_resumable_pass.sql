-- 0218 — PLAYER-AREAS SYNC: A RESUMABLE PASS (Ryan, 2026-10-08).
--
-- Applied by hand in the Supabase SQL Editor. Server-only, like 0215: RLS on, no anon/authenticated
-- grants; written and read by /api/sync/player-areas with the service role.
--
-- WHY. The 00:40 UTC run hit HTTP 503 on page 113 of /admin/players, the third MatchDay outage of
-- the day during a full walk. The walk now reads 50 players a page, 2 seconds apart — about 30
-- minutes for a full pass, longer than one function run (300 s). So a pass is several LEGS: each
-- leg reads what fits, saves its place here, and hands on to the next.
--
-- ONE RUN ROW PER PASS. The row is the pass: next_page is where the next leg starts, heartbeat_at
-- is bumped after every page (a pass whose heartbeat goes stale has stalled and no longer holds
-- the lock), legs counts the invocations, stop_reason says how it ended.
--
-- player_area_pass_seen holds every player a pass has read, so the pass can count DISTINCT ids
-- across legs and, only when every page has been read, clear the areas of players it saw without
-- one. Rows for a pass are deleted when it ends (and cascade with the run row).

BEGIN;

ALTER TABLE public.player_area_sync_runs
  ADD COLUMN next_page    integer,
  ADD COLUMN pages_total  integer,
  ADD COLUMN page_size    integer,
  ADD COLUMN legs         integer NOT NULL DEFAULT 0,
  ADD COLUMN heartbeat_at timestamptz,
  ADD COLUMN stop_reason  text
    CHECK (stop_reason IN ('complete', 'strain', 'evening', 'error', 'stalled'));

CREATE TABLE public.player_area_pass_seen (
  run_id    bigint  NOT NULL REFERENCES public.player_area_sync_runs (id) ON DELETE CASCADE,
  player_id bigint  NOT NULL,
  has_area  boolean NOT NULL,
  PRIMARY KEY (run_id, player_id)
);

ALTER TABLE public.player_area_pass_seen ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.player_area_pass_seen FROM anon, authenticated;

COMMIT;
