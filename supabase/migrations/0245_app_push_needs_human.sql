-- 0245 STAFF APP PLAYER CHAT PUSH ON "NEEDS A HUMAN" (Ryan, 2026-10-31). The app's player_chat push now
-- fires when a thread enters Needs a human (src/lib/crmAttention), once per wait, a wait ending only at
-- a staff reply. Two additions, both additive:
--
--   app_push_log.outcome / reason   every send AND every skip is logged with why (a skip row has no
--                                   app_user_id and no ticket). Existing rows keep NULL: they predate it.
--   app_push_chat_waits             the claim: one row per (thread, wait). The insert is the claim, so two
--                                   overlapping ticks cannot both push the same wait (the same pattern as
--                                   app_push_match_risk).
--
-- Locking: ADD COLUMN with no default is a catalog change only (no table rewrite); CREATE TABLE is new.
-- Rollback: DROP TABLE public.app_push_chat_waits; ALTER TABLE public.app_push_log DROP COLUMN reason,
-- DROP COLUMN outcome. Nothing else reads either.

BEGIN;

ALTER TABLE public.app_push_log
  ADD COLUMN IF NOT EXISTS outcome text CHECK (outcome IN ('sent', 'skipped')),
  ADD COLUMN IF NOT EXISTS reason  text;

CREATE TABLE IF NOT EXISTS public.app_push_chat_waits (
  thread_id        uuid        NOT NULL,
  wait_started_at  timestamptz NOT NULL,
  inbound_id       uuid,
  claimed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, wait_started_at)
);
ALTER TABLE public.app_push_chat_waits ENABLE ROW LEVEL SECURITY;

COMMIT;
