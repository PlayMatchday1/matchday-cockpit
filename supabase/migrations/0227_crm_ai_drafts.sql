-- 0227: Claude drafts for Player Chats (phase 1).
--
-- One row per draft Claude writes for a thread. A draft never reaches a player on its own:
-- staff press Use draft, edit, then the existing Send. outcome records what happened to it,
-- which is how we will judge when auto-send is safe. The text actually sent is NOT copied
-- here; sent_message_id points at it in crm_messages. cost_usd feeds the $20 monthly cap.

CREATE TABLE IF NOT EXISTS crm_ai_drafts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id            uuid NOT NULL REFERENCES crm_threads(id)  ON DELETE CASCADE,
  based_on_message_id  uuid NOT NULL REFERENCES crm_messages(id) ON DELETE CASCADE,
  requested_by_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  model                text NOT NULL,
  playbook_version     text NOT NULL,
  category             text,
  draft_text           text,
  staff_notes          text,
  context_keys         text[] NOT NULL DEFAULT '{}',
  input_tokens         int,
  output_tokens        int,
  cost_usd             numeric(10,6),
  error                text,
  outcome              text NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending','sent_unchanged','sent_edited','discarded','superseded','failed')),
  outcome_at           timestamptz,
  outcome_by_user_id   uuid REFERENCES app_users(id) ON DELETE SET NULL,
  sent_message_id      uuid REFERENCES crm_messages(id) ON DELETE SET NULL,
  edit_distance        int,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_ai_drafts_thread_idx  ON crm_ai_drafts(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crm_ai_drafts_created_idx ON crm_ai_drafts(created_at);

ALTER TABLE crm_ai_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_ai_drafts_select ON crm_ai_drafts;
CREATE POLICY crm_ai_drafts_select ON crm_ai_drafts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM app_users
    WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
      AND (app_users.is_admin = true OR app_users.can_access_chats = true)));
-- No insert/update policies: only the server route writes, with the service role.

-- Make the REST API see the new table straight away.
NOTIFY pgrst, 'reload schema';
