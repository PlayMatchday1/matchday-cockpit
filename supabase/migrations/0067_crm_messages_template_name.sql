-- ============================================================
-- crm_messages.template_name — records which approved WhatsApp
-- template an outbound row was sent from (NULL for normal text/media
-- sends). Enables marketing-send cost reconciliation against monthly
-- Meta bills and per-template analytics.
--
-- Applied manually via the Supabase SQL Editor before app code shipped.
-- ============================================================

ALTER TABLE crm_messages
  ADD COLUMN IF NOT EXISTS template_name text;

CREATE INDEX IF NOT EXISTS crm_messages_template_name_idx
  ON crm_messages(template_name) WHERE template_name IS NOT NULL;
