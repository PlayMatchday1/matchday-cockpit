-- 0246 MATCH CANCEL REASONS (Ryan, 2026-11-01). The reason staff pick when they cancel a match in the
-- Clubhouse (desktop Match panel, the match editor page, the staff app's Adjust sheet), written only
-- after the cancel has landed. Players (a MatchDay auto-cancel), Unknown and the inferred Slate change
-- are worked out at read time (src/lib/cancelReasons.ts) and never stored; a stored reason always wins.
--
-- Locking: a new table, nothing existing is touched. Rollback: DROP TABLE public.match_cancel_reasons.

BEGIN;

CREATE TABLE IF NOT EXISTS public.match_cancel_reasons (
  env                text        NOT NULL CHECK (env IN ('production', 'staging')),
  match_id           bigint      NOT NULL,
  reason             text        NOT NULL CHECK (reason IN ('weather', 'manager', 'facility', 'slate_change', 'other')),
  note               text,
  surface            text        NOT NULL,   -- 'Match panel', 'Match editor', 'Staff app'
  set_by_app_user_id uuid        REFERENCES public.app_users(id) ON DELETE SET NULL,
  set_by_email       text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (env, match_id),
  CHECK (reason <> 'other' OR length(btrim(coalesce(note, ''))) > 0)
);
ALTER TABLE public.match_cancel_reasons ENABLE ROW LEVEL SECURITY;

COMMIT;
