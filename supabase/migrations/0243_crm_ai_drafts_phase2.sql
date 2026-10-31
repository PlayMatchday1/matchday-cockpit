-- 0243: Claude drafts phase 2: discard reasons and actions.
--
-- discard_reason        what staff picked when they threw the draft away (chips plus optional text).
-- reply_without_action  the reply that does not claim the action happened; Use draft alone fills this.
-- action                the proposed action as guarded on the server. Staff press it; the model never
--                       applies anything. No message text and no player PII beyond what the draft holds.
-- action_status         null until pressed. 'applying' is claimed on this row BEFORE any write, so a
--                       second press cannot move money twice. Writes never retry.
-- action_at, action_by_user_id  who pressed it and when.
--
-- Adds columns only. No existing row changes.

ALTER TABLE crm_ai_drafts
  ADD COLUMN IF NOT EXISTS discard_reason       text,
  ADD COLUMN IF NOT EXISTS reply_without_action text,
  ADD COLUMN IF NOT EXISTS action               jsonb,
  ADD COLUMN IF NOT EXISTS action_status        text
    CHECK (action_status IN ('applying','landed','failed','not_applied','unknown')),
  ADD COLUMN IF NOT EXISTS action_at            timestamptz,
  ADD COLUMN IF NOT EXISTS action_by_user_id    uuid REFERENCES app_users(id) ON DELETE SET NULL;

-- Make the REST API see the new columns straight away.
NOTIFY pgrst, 'reload schema';
