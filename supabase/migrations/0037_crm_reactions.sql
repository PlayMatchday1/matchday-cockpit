-- ============================================================
-- crm_messages — reaction support
-- ============================================================
-- Meta delivers WhatsApp reactions as type="reaction" with the
-- emoji and the wamid of the parent message being reacted to. The
-- webhook now stores them as their own row with:
--   media_kind             = 'reaction'
--   body                   = "Reacted ❤️ to your message"
--                            (or "Removed reaction" if emoji is "")
--   reaction_target_wamid  = the wamid of the parent outbound message
--
-- New media_kind 'reaction' extends the CHECK constraint installed
-- by 0034_crm_message_media.sql. New column reaction_target_wamid
-- lets the UI later link the reaction note to its target bubble.
-- ============================================================

ALTER TABLE crm_messages
  ADD COLUMN IF NOT EXISTS reaction_target_wamid text;

ALTER TABLE crm_messages
  DROP CONSTRAINT IF EXISTS crm_messages_media_kind_check;

ALTER TABLE crm_messages
  ADD CONSTRAINT crm_messages_media_kind_check
  CHECK (media_kind IS NULL OR media_kind IN (
    'image', 'video', 'audio', 'document', 'sticker', 'reaction'
  ));
