-- 0241 STAFF APP PUSH NOTIFICATIONS (Ryan, 2026-10-30). Two events only:
--   player_chat     a player message that makes a Player Chats thread wait on a reply
--   match_at_risk   a match below its minimum 60 minutes before its auto-cancel time, once per match
-- Sent through the Expo push service to the tokens in app_push_tokens.
--
-- Every table here is Clubhouse-owned, RLS on with no policies: only the service role, inside the
-- Clubhouse routes, reads or writes them (the same pattern as app_push_tokens).

BEGIN;

-- Each staff member's own switches, from the avatar sheet. No row means both on.
CREATE TABLE IF NOT EXISTS public.app_push_prefs (
  app_user_id      uuid        PRIMARY KEY REFERENCES public.app_users(id) ON DELETE CASCADE,
  player_chats     boolean     NOT NULL DEFAULT true,
  matches_at_risk  boolean     NOT NULL DEFAULT true,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.app_push_prefs ENABLE ROW LEVEL SECURITY;

-- The admin kill switch per event type: enabled = false stops that type for everyone at once.
CREATE TABLE IF NOT EXISTS public.app_push_switches (
  event         text        PRIMARY KEY CHECK (event IN ('player_chat', 'match_at_risk')),
  enabled       boolean     NOT NULL DEFAULT true,
  updated_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.app_push_switches ENABLE ROW LEVEL SECURITY;
INSERT INTO public.app_push_switches (event, enabled, updated_by)
VALUES ('player_chat', true, 'migration 0241'), ('match_at_risk', true, 'migration 0241')
ON CONFLICT (event) DO NOTHING;

-- Every push sent: the event, who it went to, Expo's ticket, then Expo's receipt.
-- subject is the thread id (player_chat) or "<env>:<match id>" (match_at_risk); never message text.
CREATE TABLE IF NOT EXISTS public.app_push_log (
  id                  bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event               text        NOT NULL CHECK (event IN ('player_chat', 'match_at_risk')),
  app_user_id         uuid        REFERENCES public.app_users(id) ON DELETE SET NULL,
  subject             text        NOT NULL,
  dry_run             boolean     NOT NULL DEFAULT false,
  ticket_id           text,
  ticket_status       text        CHECK (ticket_status IN ('ok', 'error')),
  ticket_error        text,
  receipt_status      text        CHECK (receipt_status IN ('ok', 'error')),
  receipt_error       text,
  receipt_checked_at  timestamptz,
  token_removed       boolean     NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_push_log_created_idx ON public.app_push_log (created_at DESC);
-- The receipt sweep reads only tickets still waiting for a receipt.
CREATE INDEX IF NOT EXISTS app_push_log_receipt_pending_idx ON public.app_push_log (created_at)
  WHERE ticket_status = 'ok' AND receipt_checked_at IS NULL;
ALTER TABLE public.app_push_log ENABLE ROW LEVEL SECURITY;

-- Once per match, never repeated: the insert is the claim, so two overlapping runs cannot both send.
-- A dry run does not claim; it is logged in app_push_log with dry_run = true.
CREATE TABLE IF NOT EXISTS public.app_push_match_risk (
  env          text        NOT NULL CHECK (env IN ('production', 'staging')),
  match_id     bigint      NOT NULL,
  notified_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (env, match_id)
);
ALTER TABLE public.app_push_match_risk ENABLE ROW LEVEL SECURITY;

COMMIT;
