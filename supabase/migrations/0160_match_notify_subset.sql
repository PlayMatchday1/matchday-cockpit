-- SUBSET SENDS on the match notify log (roster panel → "Send operational text").
--
-- Until now every row in match_notify_log was a whole-match send, so the table did
-- not need to say so. The roster panel can now text a SELECTION — four people out of
-- eighteen — and a subset send that logs like a whole-match send is a log that lies
-- the first time somebody asks who was told.
--
--   audience            'match'  = every registered player, the behaviour that exists today
--                       'subset' = the operator picked rows on the roster panel
--   requested_user_ids  the ids the operator actually asked for, as sent. NOT the same as
--                       `recipients`: that records who was texted after every filter and the
--                       phone dedupe, and the difference between the two is the answer to
--                       "why did only three of the four I picked get it".
--
-- BOTH ARE NULLABLE AND audience DEFAULTS TO 'match', so every existing row stays valid and
-- reads as what it was, and the send route keeps working if this has not been applied yet.
--
-- Apply via Supabase Dashboard -> SQL Editor -> paste & run.

ALTER TABLE match_notify_log
  ADD COLUMN IF NOT EXISTS audience           text  NOT NULL DEFAULT 'match',
  ADD COLUMN IF NOT EXISTS requested_user_ids jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'match_notify_log_audience_chk'
  ) THEN
    ALTER TABLE match_notify_log
      ADD CONSTRAINT match_notify_log_audience_chk CHECK (audience IN ('match', 'subset'));
  END IF;
END $$;

-- "show me the subset sends on this match" is the question this table exists to answer.
CREATE INDEX IF NOT EXISTS match_notify_log_audience_idx
  ON match_notify_log(match_api_id, audience);
