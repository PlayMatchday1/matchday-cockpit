-- 0251 MATCHES CUT SHORT (Ryan, 2026-11-02).
--
-- A match that started and stopped early: the lights went out, weather, an injury. The MatchDay API
-- has no field for it (the match is not cancelled, so nobody was credited), so the city manager marks
-- it on Gameday Ops and Clubhouse keeps the mark here. Player Chats drafts read it: a player asking
-- about a marked match gets the match_cancelled treatment (credit the match price).
--
-- One row per match. Marking writes change_log first (src/app/api/matchday/[env]/matches/[id]/cut-short);
-- unmarking deletes the row and logs that too.
--
-- Locking: a new table, nothing existing is touched. Rollback: DROP TABLE public.match_cut_short;

BEGIN;

CREATE TABLE IF NOT EXISTS public.match_cut_short (
  env                text        NOT NULL CHECK (env IN ('production', 'staging')),
  match_id           bigint      NOT NULL,
  reason             text        NOT NULL CHECK (reason IN ('lights', 'weather', 'injury', 'other')),
  note               text,
  minutes_played     integer     NOT NULL CHECK (minutes_played >= 0 AND minutes_played <= 240),
  set_by_app_user_id uuid        REFERENCES public.app_users(id) ON DELETE SET NULL,
  set_by_email       text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (env, match_id),
  CHECK (reason <> 'other' OR length(btrim(coalesce(note, ''))) > 0)
);
ALTER TABLE public.match_cut_short ENABLE ROW LEVEL SECURITY;

COMMIT;

NOTIFY pgrst, 'reload schema';
