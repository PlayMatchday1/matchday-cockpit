-- Veo → match-chat auto-poster. One row per ingested Veo "ready to watch"
-- email (the FINAL video). Ingestion (Google Apps Script on the Gmail
-- account) POSTs the parsed email to /api/veo/inbound; that route parses the
-- title, matches it to a scheduled mdapi match, and either posts the link
-- into the match's Firestore thread (status='posted') or files a review item
-- (status='queued'). This table is both the audit trail of auto-posts AND the
-- review queue — the admin surface reads it directly.
--
-- Idempotency: recording_id (the trailing id from the shareable URL, e.g.
-- "v8d5b42e") is UNIQUE. The inbound route inserts the row FIRST to claim the
-- recording; a duplicate email hits 23505 and is treated as a no-op replay,
-- so the same recording can never post twice.
--
-- RLS: admin-only SELECT (same JWT-email pattern as match_chat_audit_log).
-- No client write policies — the inbound route (service role via shared
-- secret) and the assign/dismiss routes (service role behind the admin gate)
-- own all writes.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run BEFORE deploying
-- the feature.

CREATE TABLE IF NOT EXISTS veo_recordings (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- IDEMPOTENCY KEY. Trailing id segment of the shareable URL slug
  -- (https://app.veo.co/matches/<slug>-<id>/ → <id>, e.g. "v8d5b42e").
  recording_id       text        NOT NULL,

  -- Full match-path slug (e.g. "20260725-sc-jul-24-800pm-v8d5b42e"). The
  -- leading YYYYMMDD is Veo's PROCESSING date (~1 day after the match) and
  -- is used only to resolve the title's year — never for matching.
  match_path_slug    text,

  -- The shareable link, posted into the thread verbatim (extracted from the
  -- "Watch your video" href — never reconstructed).
  video_url          text        NOT NULL,

  email_subject      text        NOT NULL,
  email_from         text,
  received_at        timestamptz,

  -- Parsed from the subject title "CODE | Mon DD | H:MMPM". Null when the
  -- title didn't parse. parsed_match_date already has the year resolved.
  parsed_code        text,
  parsed_match_date  date,
  parsed_time_minutes int,       -- minutes since local midnight
  parsed_time_label  text,       -- normalized "8:00 PM"

  -- 'posted'    — link landed in a match thread.
  -- 'queued'    — needs review (see queue_reason).
  -- 'dismissed' — reviewer discarded it (junk / duplicate-by-hand).
  status             text        NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('posted', 'queued', 'dismissed')),

  -- Why it's queued (null once posted): 'unparseable_subject',
  -- 'unknown_code', 'unconfirmed_code', 'no_match', 'multiple_matches',
  -- 'field_mismatch', 'ambiguous_time', 'post_failed'.
  queue_reason       text,

  -- mdapi_matches.api_id the link was posted to (== Firestore chat id).
  matched_api_id     bigint,

  -- Candidate api_ids for the multiple_matches case (or a lone best-guess for
  -- an unconfirmed_code), so the review UI can one-click assign.
  candidate_api_ids  jsonb,

  -- The `_id` we set on the Firestore message (for reconciliation).
  firestore_message_id text,

  -- Who resolved a queued item via the assign route (null for auto-posts,
  -- which run under the shared-secret / server identity). SET NULL on
  -- operator deactivation so audit rows survive.
  posted_by_user_id  uuid        REFERENCES app_users(id) ON DELETE SET NULL,
  posted_at          timestamptz,

  -- Raw email payload (subject/from/body/link) for debugging a miss.
  raw                jsonb,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Idempotency key. A replayed email (same recording) collides here and the
-- inbound route treats 23505 as a successful no-op.
CREATE UNIQUE INDEX IF NOT EXISTS veo_recordings_recording_id_uniq
  ON veo_recordings(recording_id);

-- Review-queue query: "show me everything needing attention, newest first."
CREATE INDEX IF NOT EXISTS veo_recordings_status_created_idx
  ON veo_recordings(status, created_at DESC);

-- Recent-activity feed for the admin surface.
CREATE INDEX IF NOT EXISTS veo_recordings_created_idx
  ON veo_recordings(created_at DESC);

ALTER TABLE veo_recordings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS veo_recordings_admin_select ON veo_recordings;
CREATE POLICY veo_recordings_admin_select
  ON veo_recordings FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND app_users.is_admin = true
    )
  );
-- No INSERT/UPDATE/DELETE policies. The inbound route writes with the service
-- role (authenticated by a shared secret); the assign/dismiss routes write
-- with the service role behind authenticateCrm's admin/chats gate.
