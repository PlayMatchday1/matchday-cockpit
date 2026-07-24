-- Out-of-hours auto-reply support.
--
-- When an inbound WhatsApp message lands outside business hours (9pm–9am
-- Central), the webhook sends a free session reply letting the customer
-- know we're available 9am–9pm CT and will follow up. Two columns back
-- that behavior:
--
--   crm_messages.is_auto_reply   — marks the outbound auto-reply so it is
--                                  EXCLUDED from support-response metrics.
--                                  Counting it would fake a ~0-minute
--                                  first response on every out-of-hours
--                                  thread. Inbound + real operator
--                                  outbounds stay false.
--
--   crm_threads.auto_reply_sent_at — when we last sent an out-of-hours
--                                  auto-reply on this thread. The webhook
--                                  debounces on it: at most one auto-reply
--                                  per conversation per closed gap (9pm→9am),
--                                  not one per inbound message. Compared
--                                  against the start of the current closed
--                                  period — an auto-reply stamped at/after
--                                  that boundary means "already greeted
--                                  this gap, stay quiet."
--
-- Apply via Supabase Dashboard → SQL Editor.

ALTER TABLE crm_messages
  ADD COLUMN IF NOT EXISTS is_auto_reply boolean NOT NULL DEFAULT false;

ALTER TABLE crm_threads
  ADD COLUMN IF NOT EXISTS auto_reply_sent_at timestamptz;

-- No backfill: existing messages are genuine (is_auto_reply stays false)
-- and no thread has been auto-greeted yet (auto_reply_sent_at stays null).
