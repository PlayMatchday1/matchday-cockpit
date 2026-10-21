-- 0228: a staff member confirmed which account a Player Chats thread belongs to.
--
-- The webhooks attach a thread to an account at the first inbound message (newest account wins
-- when a phone is on several) and latch match_ambiguous to true on every later inbound. Neither
-- column can say "a person checked this". These two do. Set only by
-- POST /api/crm/threads/[id]/link, which also records who and when in change_log.
--
-- A thread is CONFIRMED when account_confirmed_at is set. Claude drafts state account facts only
-- for a confirmed thread, or for a linked thread whose phone is on exactly one account.

ALTER TABLE crm_threads
  ADD COLUMN IF NOT EXISTS account_confirmed_at timestamptz;

ALTER TABLE crm_threads
  ADD COLUMN IF NOT EXISTS account_confirmed_by_user_id uuid
    REFERENCES app_users(id) ON DELETE SET NULL;

-- Make the REST API see the new columns straight away.
NOTIFY pgrst, 'reload schema';
