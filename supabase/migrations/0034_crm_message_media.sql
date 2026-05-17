-- ============================================================
-- crm_messages — media attachment columns
-- ============================================================
-- WhatsApp Cloud API delivers exactly one media object per inbound
-- message (image | video | audio | document | sticker), with the
-- bytes available via a short-lived Graph API URL we must download
-- immediately. Columns are added directly to crm_messages rather
-- than a separate crm_message_media table because cardinality is
-- always 0..1 per row and the existing UI is one bubble per row.
-- If a future channel (email, MMS) needs multi-attachment we can
-- migrate then; pre-factoring now is tax without payoff.
--
-- media_url        Supabase Storage path (NOT Meta's URL — Meta's
--                  download URLs expire in minutes; we download on
--                  webhook receipt, re-host in the private
--                  `crm-media` bucket, and serve via short-lived
--                  signed URLs from the thread-detail route).
-- media_mime_type  Verbatim from Meta on inbound; from upload on
--                  outbound (future PR).
-- media_filename   Original filename for documents; null for image
--                  inbound (Meta does not send filenames for images).
-- media_size_bytes Sanity field for UI ("Image · 2.3 MB") and for
--                  server-side limit enforcement on outbound (future
--                  PR).
-- media_kind       One of WhatsApp's media types; drives the bubble
--                  render branch. NULL means text-only message.
--
-- body column stays NOT NULL. For media messages, body holds the
-- caption (or empty string if the player did not include one). For
-- text messages, body holds the text verbatim, unchanged from today.
--
-- Render rules the UI implements off these columns:
--   media_kind IS NULL              → text-only, render body as today
--   media_kind = 'image' AND
--   signed_media_url IS NOT NULL    → render <img>, body as caption
--   other media_kind values         → reserved for PR D; current
--                                     fallback is the placeholder
--                                     text in body
-- ============================================================

ALTER TABLE crm_messages
  ADD COLUMN IF NOT EXISTS media_url        text,
  ADD COLUMN IF NOT EXISTS media_mime_type  text,
  ADD COLUMN IF NOT EXISTS media_filename   text,
  ADD COLUMN IF NOT EXISTS media_size_bytes bigint,
  ADD COLUMN IF NOT EXISTS media_kind       text;

-- Idempotent CHECK constraint — ADD CONSTRAINT IF NOT EXISTS landed
-- in Postgres 18, so guard via pg_constraint lookup for older
-- versions (same pattern as 0032 and 0033).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'crm_messages_media_kind_check'
      AND conrelid = 'crm_messages'::regclass
  ) THEN
    ALTER TABLE crm_messages
      ADD CONSTRAINT crm_messages_media_kind_check
      CHECK (media_kind IS NULL OR media_kind IN (
        'image', 'video', 'audio', 'document', 'sticker'
      ));
  END IF;
END $$;
