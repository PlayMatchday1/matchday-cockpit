-- Phase 2 delivery status for outbound /crm messages. Processes the
-- statuses[] branch of the WhatsApp Cloud API webhook (sent →
-- delivered → read → failed) and surfaces that lifecycle in the UI
-- instead of the misleading "not delivered" red label the original
-- bug was firing on every successful WhatsApp send.
--
-- SMS lifecycle progression beyond 'sent' / 'failed' is deferred to
-- a separate Phase 2 item (Telnyx delivery-receipt processing); this
-- migration only sets up the column so the WhatsApp path can use it.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

-- ============================================================
-- crm_messages: delivery_status + delivery_status_updated_at
-- ============================================================
ALTER TABLE crm_messages
  ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'pending';

-- ADD CONSTRAINT IF NOT EXISTS doesn't exist until Postgres v18; do
-- the existence check ourselves so this migration is idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'crm_messages_delivery_status_check'
      AND conrelid = 'crm_messages'::regclass
  ) THEN
    ALTER TABLE crm_messages
      ADD CONSTRAINT crm_messages_delivery_status_check
      CHECK (delivery_status IN ('pending', 'sent', 'delivered', 'read', 'failed'));
  END IF;
END $$;

ALTER TABLE crm_messages
  ADD COLUMN IF NOT EXISTS delivery_status_updated_at timestamptz
  NOT NULL DEFAULT now();


-- ============================================================
-- Backfill existing outbound rows
-- ============================================================
-- New rows from /api/crm/send will write 'sent' explicitly on
-- successful insert and 'failed' in the catch branch. Existing
-- outbound rows pre-date the column, so we synthesize a sensible
-- starting state from the provider-id columns:
--
--   * has external_message_id (WhatsApp wamid) → 'sent'
--   * has telnyx_message_id   (SMS provider id) → 'sent'
--   * neither id present       (send-time failure caught by the
--                              existing catch branch in /api/crm
--                              /send) → 'failed'
--
-- Inbound rows stay at the default 'pending'. The UI only renders
-- delivery state for direction='outbound', so the value is
-- irrelevant for inbound — leaving them at 'pending' keeps the
-- column NOT NULL without needing a per-row default expression.

UPDATE crm_messages
SET delivery_status = 'sent'
WHERE direction = 'outbound'
  AND delivery_status = 'pending'
  AND (external_message_id IS NOT NULL OR telnyx_message_id IS NOT NULL);

UPDATE crm_messages
SET delivery_status = 'failed'
WHERE direction = 'outbound'
  AND delivery_status = 'pending'
  AND external_message_id IS NULL
  AND telnyx_message_id IS NULL;


-- ============================================================
-- Indexes
-- ============================================================
-- The wamid → row lookup the status webhook uses is already covered
-- by `crm_messages_external_message_id_uniq` (partial unique from
-- 0032). No new index needed for that path.
--
-- No additional index on delivery_status itself — the column is
-- low-cardinality (5 distinct values) and queries typically filter
-- on (thread_id, sent_at) or (external_message_id) first, with
-- delivery_status as a secondary predicate. A standalone index
-- here would be net negative on write throughput.
