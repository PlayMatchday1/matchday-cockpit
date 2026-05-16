-- Phase 1 WhatsApp Cloud API channel for /crm. Reuses every existing
-- CRM table; the only schema changes are:
--
--   1. `channel` column on crm_threads + crm_messages with a check
--      constraint pinning the valid values. DEFAULT 'sms' so the
--      ~weeks of existing rows backfill to the right value with no
--      app-side coordination.
--
--   2. The dedupe key on crm_threads flips from (phone_number) to
--      (phone_number, channel). A player who has texted us via SMS
--      AND messaged us on WhatsApp gets two separate threads — that
--      separation is load-bearing because the channels have
--      different reply windows and rules (WhatsApp has the 24-hour
--      session limit; SMS doesn't).
--
--   3. New `external_message_id` column on crm_messages. This is the
--      channel-agnostic id store — Meta's `wamid` for WhatsApp.
--      Existing `telnyx_message_id` column is left in place and
--      keeps being written by the SMS path. Two columns instead of
--      one rename keeps this migration purely additive — production
--      code continues to write telnyx_message_id without breaking
--      while the new code rolls out. A future migration can fold
--      the two into a single column once we've confirmed no
--      remaining writers reference the Telnyx-specific name.
--
-- All new columns are NULL-safe / DEFAULTed so applying this
-- migration before the matching code deploy is non-breaking — the
-- existing Telnyx webhook + send route keep working unchanged
-- against the new schema.
--
-- RLS: no policy changes. The existing admin-only SELECT policies on
-- both tables already cover the new columns by virtue of being
-- row-level (not column-level).
--
-- Realtime: both tables are already members of the supabase_realtime
-- publication (added by 0029 + 0030); new columns broadcast without
-- additional ALTER PUBLICATION calls.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

-- ============================================================
-- crm_threads: channel column + composite dedupe key
-- ============================================================
ALTER TABLE crm_threads
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'sms';

-- Two-step add-constraint to handle the IF EXISTS idempotency (no
-- ADD CONSTRAINT IF NOT EXISTS exists in Postgres until v18).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'crm_threads_channel_check'
      AND conrelid = 'crm_threads'::regclass
  ) THEN
    ALTER TABLE crm_threads
      ADD CONSTRAINT crm_threads_channel_check
      CHECK (channel IN ('sms', 'whatsapp'));
  END IF;
END $$;

-- Drop the existing phone-only unique and replace with the composite
-- one. The old name is left as a tombstone so a future migration can
-- see in `\d crm_threads` that the index migrated rather than just
-- disappeared.
DROP INDEX IF EXISTS crm_threads_phone_number_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS crm_threads_phone_channel_uniq
  ON crm_threads(phone_number, channel);

-- Single-column filter index for "show me only WhatsApp threads"
-- views and audit queries. Small index (just 'sms'/'whatsapp'); not
-- a partial because both values are present in roughly comparable
-- volumes as the WhatsApp channel grows.
CREATE INDEX IF NOT EXISTS crm_threads_channel_idx
  ON crm_threads(channel);


-- ============================================================
-- crm_messages: channel column + generic external id
-- ============================================================
ALTER TABLE crm_messages
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'sms';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'crm_messages_channel_check'
      AND conrelid = 'crm_messages'::regclass
  ) THEN
    ALTER TABLE crm_messages
      ADD CONSTRAINT crm_messages_channel_check
      CHECK (channel IN ('sms', 'whatsapp'));
  END IF;
END $$;

-- Channel-agnostic provider message id. Used for WhatsApp wamids
-- (inbound webhook AND outbound send-response). SMS continues to
-- write telnyx_message_id; we don't dual-write to keep this
-- migration zero-touch for the existing Telnyx code paths.
ALTER TABLE crm_messages
  ADD COLUMN IF NOT EXISTS external_message_id text;

-- Replay dedupe for WhatsApp wamids — same partial-unique pattern as
-- the existing crm_messages_telnyx_message_id_uniq from 0029. Most
-- rows (every SMS row) will have NULL here; partial keeps the index
-- small.
CREATE UNIQUE INDEX IF NOT EXISTS crm_messages_external_message_id_uniq
  ON crm_messages(external_message_id)
  WHERE external_message_id IS NOT NULL;

-- Compound channel filter on the messages timeline view. Cheap if we
-- ever need "all WhatsApp messages newest-first" for a future audit
-- view; meanwhile it costs ~one btree page per direction.
CREATE INDEX IF NOT EXISTS crm_messages_channel_sent_idx
  ON crm_messages(channel, sent_at DESC);
