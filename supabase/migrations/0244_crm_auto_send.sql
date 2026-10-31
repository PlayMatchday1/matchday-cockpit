-- 0244: Player Chats first line without a human: config, decisions, holds, review.
--
-- SHIPS OFF. enabled = false, shadow = true, both category lists empty. In this state a decision is
-- worked out and stored, and nothing is sent and no action is written.
--
-- crm_auto_send_config  One row, enforced by the boolean primary key. Staff with chats access may read
--                       it. No client write policy: only the server route writes, after reading
--                       is_admin fresh from app_users on the request, and it refuses service accounts.
-- crm_ai_drafts         The decision and its reason on every draft; the hold; the Agree / Disagree review.
-- crm_messages          auto_sent_draft_id marks a message nobody typed. is_auto_reply can't be reused:
--                       it means an out-of-hours acknowledgment that does NOT count as our answer.
--
-- At most one hold per thread at a time, enforced by the partial unique index.

CREATE TABLE IF NOT EXISTS crm_auto_send_config (
  id                 boolean PRIMARY KEY DEFAULT true CHECK (id),
  auto_categories    text[]  NOT NULL DEFAULT '{}',
  action_categories  text[]  NOT NULL DEFAULT '{}',
  credit_cap_cents   int     NOT NULL DEFAULT 1500 CHECK (credit_cap_cents >= 0),
  hold_minutes       int     NOT NULL DEFAULT 3 CHECK (hold_minutes BETWEEN 1 AND 60),
  enabled            boolean NOT NULL DEFAULT false,
  shadow             boolean NOT NULL DEFAULT true,
  disabled_reason    text,
  disabled_at        timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL
);

INSERT INTO crm_auto_send_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE crm_auto_send_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_auto_send_config_select ON crm_auto_send_config;
CREATE POLICY crm_auto_send_config_select ON crm_auto_send_config FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM app_users
    WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
      AND (app_users.is_admin = true OR app_users.can_access_chats = true)));
-- No insert/update/delete policies: only the server route writes, with the service role.

ALTER TABLE crm_ai_drafts
  ADD COLUMN IF NOT EXISTS decision            text
    CHECK (decision IN ('auto_send','auto_send_with_action','human')),
  ADD COLUMN IF NOT EXISTS decision_reason     text,
  ADD COLUMN IF NOT EXISTS decision_shadow     boolean,
  ADD COLUMN IF NOT EXISTS hold_until          timestamptz,
  ADD COLUMN IF NOT EXISTS hold_status         text
    CHECK (hold_status IN ('holding','sending','sent','cancelled','failed')),
  ADD COLUMN IF NOT EXISTS hold_note           text,
  ADD COLUMN IF NOT EXISTS hold_cancelled_by_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_verdict      text
    CHECK (review_verdict IN ('agree','disagree')),
  ADD COLUMN IF NOT EXISTS review_reason       text,
  ADD COLUMN IF NOT EXISTS review_by_user_id   uuid REFERENCES app_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_at           timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS crm_ai_drafts_one_hold_per_thread
  ON crm_ai_drafts(thread_id) WHERE hold_status IN ('holding','sending');
CREATE INDEX IF NOT EXISTS crm_ai_drafts_hold_due_idx
  ON crm_ai_drafts(hold_until) WHERE hold_status = 'holding';
CREATE INDEX IF NOT EXISTS crm_ai_drafts_decision_idx
  ON crm_ai_drafts(created_at) WHERE decision IS NOT NULL;

ALTER TABLE crm_messages
  ADD COLUMN IF NOT EXISTS auto_sent_draft_id uuid REFERENCES crm_ai_drafts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS crm_messages_auto_sent_idx
  ON crm_messages(sent_at) WHERE auto_sent_draft_id IS NOT NULL;

-- Make the REST API see the new table and columns straight away.
NOTIFY pgrst, 'reload schema';
