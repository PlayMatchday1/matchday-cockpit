-- Denormalize the last message's direction (and whether it was a
-- template) onto crm_threads, so the inbox can cheaply tell an
-- awaiting-OUR-reply thread (customer sent last) from an answered one.
--
-- Why denormalize: the inbox list route previously ran one bounded
-- .limit(1) query per visible thread to learn the last message's
-- direction (its own comment invited "switch to a view or a
-- denormalized column"). That N+1 covered only the ~100 visible rows —
-- it could NOT power a global "Awaiting reply" count or city-scoped
-- counts, which read the lightweight all-threads index. A denormalized
-- column, maintained on every message write exactly like
-- last_message_at / last_message_preview already are, makes all of it a
-- single indexed scan.
--
--   last_message_direction   — 'inbound' (customer spoke last → awaiting
--                              our reply) or 'outbound' (we spoke last →
--                              answered). Nullable only for the brief
--                              backfill gap / a thread with no messages.
--   last_message_is_template — true when the last outbound message was a
--                              (billable) WhatsApp template send, so the
--                              answered row can read "template sent" vs a
--                              plain "replied". Meaningless when the last
--                              message is inbound (stays false).
--
-- Clearing semantics fall out for free: only an inbound webhook or an
-- outbound send writes last_message_*, so assign / mark-read / star /
-- close (which never touch these columns) can never flip a thread's
-- awaiting state — exactly the product rule.
--
-- Apply via Supabase Dashboard → SQL Editor.

ALTER TABLE crm_threads
  ADD COLUMN IF NOT EXISTS last_message_direction text
    CHECK (last_message_direction IN ('inbound', 'outbound'));

ALTER TABLE crm_threads
  ADD COLUMN IF NOT EXISTS last_message_is_template boolean NOT NULL DEFAULT false;

-- Backfill from the most recent message per thread. DISTINCT ON with
-- the (thread_id, sent_at DESC) ordering picks each thread's latest row
-- — the same index crm_messages already carries.
UPDATE crm_threads t
SET
  last_message_direction = m.direction,
  last_message_is_template = (m.direction = 'outbound' AND m.template_name IS NOT NULL)
FROM (
  SELECT DISTINCT ON (thread_id)
    thread_id, direction, template_name
  FROM crm_messages
  ORDER BY thread_id, sent_at DESC
) m
WHERE m.thread_id = t.id;

-- Powers the awaiting view (status='open' AND direction='inbound',
-- ordered oldest-first = longest waiting first) and its global count.
CREATE INDEX IF NOT EXISTS crm_threads_awaiting_idx
  ON crm_threads (status, last_message_at)
  WHERE last_message_direction = 'inbound';
