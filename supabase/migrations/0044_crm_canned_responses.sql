-- ============================================================
-- crm_canned_responses — operator-curated reply templates
-- ============================================================
-- Phase 0: Ryan curates ~10-20 text+optional-image templates that
-- operators select from a picker in the /chats Composer. Picker is
-- visible to all CRM users; curation is admin-only.
--
-- Rationale for splitting body_text from image_path:
--   - Text-only templates (most common) skip Storage entirely.
--   - Image+caption templates piggy-back on the existing
--     /api/crm/send-media pipeline — the picker fetches a signed
--     URL, builds a File from the bytes, and routes through the
--     Composer's onFileSelected (same entry point as paperclip /
--     drag-drop / paste). Server unchanged.
--   - CHECK constraint enforces that at least one of body_text or
--     image_path is non-null so the operator never selects an
--     empty card.
--
-- Variable substitution ({{first_name}}, etc.) is intentionally
-- out of scope for v1.
--
-- Storage:
--   Bucket `canned-response-images` (private, signed-URL reads).
--   Path scheme: {response_id}/{filename} — response_id first so
--   per-template prefix listing works and the row's id is the
--   canonical reference.
-- ============================================================

CREATE TABLE IF NOT EXISTS crm_canned_responses (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  label         text          NOT NULL,
  body_text     text,
  image_path    text,
  display_order integer       NOT NULL DEFAULT 0,
  created_by    uuid          REFERENCES app_users(id) ON DELETE SET NULL,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  updated_at    timestamptz   NOT NULL DEFAULT now()
);

-- At least one of body_text / image_path must be populated. Empty
-- strings count as "missing" so the picker never renders a blank
-- card. Idempotent guard mirrors 0034's pattern.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'crm_canned_responses_content_present'
      AND conrelid = 'crm_canned_responses'::regclass
  ) THEN
    ALTER TABLE crm_canned_responses
      ADD CONSTRAINT crm_canned_responses_content_present
      CHECK (
        (body_text IS NOT NULL AND length(trim(body_text)) > 0)
        OR (image_path IS NOT NULL AND length(trim(image_path)) > 0)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS crm_canned_responses_display_order_idx
  ON crm_canned_responses(display_order);

-- ============================================================
-- RLS — admin (corp) read+write, no public access
-- ============================================================
-- All CRM users in Phase 0 are admins (app_users.is_admin = true)
-- per the authenticateCrm gate. Both read (operators using the
-- picker) and write (admin curating) go through the service-role
-- API routes that bypass RLS. The policy below is defense in
-- depth in case a caller ever hits the table with the user JWT
-- directly.
ALTER TABLE crm_canned_responses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_canned_responses_admin_all ON crm_canned_responses;
CREATE POLICY crm_canned_responses_admin_all
  ON crm_canned_responses FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND app_users.is_admin = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND app_users.is_admin = true
    )
  );

-- ============================================================
-- Storage bucket — canned-response-images
-- ============================================================
-- Private bucket; reads happen via short-lived signed URLs minted
-- by /api/crm/canned-responses/[id]/signed-url. All writes go
-- through the service role so no storage.objects RLS policy is
-- needed (the existing crm-media bucket follows the same model
-- per src/lib/crmMedia.ts).
INSERT INTO storage.buckets (id, name, public)
VALUES ('canned-response-images', 'canned-response-images', false)
ON CONFLICT (id) DO NOTHING;

-- updated_at maintenance — bump on every UPDATE so the admin UI
-- can show "last edited" if it ever wants to.
CREATE OR REPLACE FUNCTION crm_canned_responses_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS crm_canned_responses_updated_at
  ON crm_canned_responses;
CREATE TRIGGER crm_canned_responses_updated_at
  BEFORE UPDATE ON crm_canned_responses
  FOR EACH ROW EXECUTE FUNCTION crm_canned_responses_set_updated_at();
