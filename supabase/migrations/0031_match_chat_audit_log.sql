-- Phase 3 Match Chats — operator-side audit trail for Cockpit-sent
-- replies. Firestore stores every match-chat message as the "MatchDay"
-- system identity (a deliberate UX choice — players see a single
-- unified voice rather than "Ryan from MatchDay" / "Nick from MatchDay"
-- /  etc.). For internal accountability we still want to know which
-- human pressed Send. This table is that record.
--
-- Append-only. Cockpit writes one row per reply at the same moment it
-- writes the Firestore message. The two IDs together (firestore_chat_id
-- + firestore_message_id) let us reconcile back to the actual Firestore
-- doc later if needed (e.g. "MatchDay replied — sent by Ryan 3m ago"
-- in an internal audit drawer).
--
-- Not a foreign key to anything in Supabase — Firestore lives outside
-- Supabase's referential reach. Both Firestore IDs are stored as text
-- for forward-compat (today the chat id happens to be a numeric string
-- matching mdapi_matches.api_id, but we don't bake that assumption into
-- a constraint here).
--
-- RLS: admin-only SELECT, same JWT-email pattern as the rest of the
-- crm_* tables. No client write policies — writes go via the
-- /api/match-chats/[chatId]/reply route using the service role.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

CREATE TABLE IF NOT EXISTS match_chat_audit_log (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The Firestore chat parent doc id. Today this is the numeric
  -- mdapi_matches.api_id as a string (e.g. "14613"). Kept as text so
  -- a future non-numeric chat id (system messages, broadcast lists,
  -- etc.) doesn't require a migration.
  firestore_chat_id     text          NOT NULL,

  -- The `_id` field we set on the Firestore message at write time
  -- (a UUID we generate before the Firestore write, so we have a
  -- traceable handle even if the Firestore write fails). NOT the
  -- Firestore document id, which Firestore assigns and which we
  -- could store later if we want a second join key.
  firestore_message_id  text          NOT NULL,

  -- Who actually clicked Send. SET NULL on operator deactivation so
  -- audit rows survive — same reason crm_messages.sent_by_user_id is
  -- nullable.
  sent_by_user_id       uuid          REFERENCES app_users(id) ON DELETE SET NULL,

  -- The message body as we wrote it to Firestore. Stored so the
  -- internal audit drawer can show exactly what was sent without
  -- a second Firestore read. (Bodies are typically short SMS-style
  -- replies; if media-only messages get added later we'll extend.)
  body                  text,

  created_at            timestamptz   NOT NULL DEFAULT now()
);

-- Per-chat chronological audit query: "show me everything Cockpit
-- has sent to chat 14613 in newest-first order." Composite index
-- lets the future audit drawer be a single index scan.
CREATE INDEX IF NOT EXISTS match_chat_audit_log_chat_created_idx
  ON match_chat_audit_log(firestore_chat_id, created_at DESC);

-- "What has operator X sent recently?" — useful for accountability
-- audits and operator self-service ("did my message actually go
-- through?"). Partial because cron-path / system writes will leave
-- this null, and they're not the audit signal we care about here.
CREATE INDEX IF NOT EXISTS match_chat_audit_log_sent_by_idx
  ON match_chat_audit_log(sent_by_user_id, created_at DESC)
  WHERE sent_by_user_id IS NOT NULL;

ALTER TABLE match_chat_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS match_chat_audit_log_admin_select ON match_chat_audit_log;
CREATE POLICY match_chat_audit_log_admin_select
  ON match_chat_audit_log FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND app_users.is_admin = true
    )
  );
-- No INSERT/UPDATE/DELETE policies. Cockpit's reply route uses the
-- service role to write rows alongside the Firestore message.
