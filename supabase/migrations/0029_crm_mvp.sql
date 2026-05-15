-- Phase 0 CRM MVP — two-way SMS conversations between corp ops and
-- mdapi users via Telnyx. Two tables:
--
--   crm_threads   1 row per unique phone_number (E.164). Holds the
--                 player linkage (player_id, nullable — inbound from
--                 an unknown number creates a thread with player_id
--                 null) and a denormalized "last message" preview for
--                 the left-pane list.
--
--   crm_messages  Append-only event log. direction ∈ ('inbound',
--                 'outbound'). Inbound rows are written by the Telnyx
--                 webhook; outbound by /api/crm/send. Both record the
--                 Telnyx message id for reconciliation.
--
-- Key decisions (vs original spec):
--   * player_id is bigint (matches mdapi_users.id, which is bigint —
--     NOT uuid). ON DELETE SET NULL so a player vanishing on resync
--     doesn't take their thread history with them.
--   * sent_by_user_id references app_users(id) (uuid). There is no
--     bare `users` table; app_users is the cockpit's operator table.
--     ON DELETE SET NULL for the same audit reason.
--   * phone_number on crm_threads is E.164 — the webhook normalizes
--     before upsert. mdapi_users.phone_number itself is left untouched
--     (mix of 10-digit + E.164); join logic normalizes on read.
--   * match_ambiguous: set true when the inbound matcher finds >1
--     candidate mdapi_users row for the same normalized phone. The
--     UI right-pane will surface this so corp can disambiguate
--     manually rather than silently picking the oldest.
--   * Tables added to supabase_realtime publication so the /crm page
--     can subscribe to live INSERT / UPDATE events.
--
-- RLS: corp-only. SELECT is gated by app_users.is_admin = true (email
-- match against the JWT). No client INSERT/UPDATE policies — all
-- writes go through API routes using the service role.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

-- ============================================================
-- crm_threads
-- ============================================================
CREATE TABLE IF NOT EXISTS crm_threads (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Linkage to the mdapi user, if we matched the inbound phone.
  -- Nullable: unknown numbers still get a thread, the right pane
  -- prompts corp to link manually.
  player_id             bigint        REFERENCES mdapi_users(id) ON DELETE SET NULL,

  -- E.164 (e.g. '+15125550123'). The webhook normalizes before
  -- upsert; this column is the dedupe key for a conversation.
  phone_number          text          NOT NULL,

  -- Denormalized last-message fields. Updated on every inbound /
  -- outbound write so the left-pane list query stays a single
  -- table scan with no aggregation.
  last_message_at       timestamptz   NOT NULL DEFAULT now(),
  last_message_preview  text,

  -- True when the inbound matcher found >1 candidate mdapi_users
  -- row for this phone. UI surfaces this so corp can disambiguate
  -- instead of trusting the oldest-created_at tiebreak.
  match_ambiguous       boolean       NOT NULL DEFAULT false,

  created_at            timestamptz   NOT NULL DEFAULT now()
);

-- Dedupe key: one thread per phone_number. The webhook upserts on
-- this — without uniqueness, a burst of two inbound messages could
-- race and create duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS crm_threads_phone_number_uniq
  ON crm_threads(phone_number);

-- Left-pane "recent conversations" list (ORDER BY last_message_at
-- DESC LIMIT 50). Index avoids a sort at query time.
CREATE INDEX IF NOT EXISTS crm_threads_last_message_at_idx
  ON crm_threads(last_message_at DESC);

-- Player → thread lookup (right pane "View in CRM" link from a
-- user page later).
CREATE INDEX IF NOT EXISTS crm_threads_player_id_idx
  ON crm_threads(player_id)
  WHERE player_id IS NOT NULL;

ALTER TABLE crm_threads ENABLE ROW LEVEL SECURITY;

-- Corp-only SELECT: admin app_users only. Matches on email from the
-- JWT (same lookup pattern as src/lib/useAuth.ts). Non-admin
-- authenticated sessions get nothing.
DROP POLICY IF EXISTS crm_threads_admin_select ON crm_threads;
CREATE POLICY crm_threads_admin_select
  ON crm_threads FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND app_users.is_admin = true
    )
  );
-- No INSERT/UPDATE/DELETE policies. All writes use the service role
-- via API routes (which do their own corp gate before writing).


-- ============================================================
-- crm_messages
-- ============================================================
CREATE TABLE IF NOT EXISTS crm_messages (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  thread_id          uuid          NOT NULL REFERENCES crm_threads(id) ON DELETE CASCADE,

  -- 'inbound'  = received from the player (Telnyx webhook write)
  -- 'outbound' = sent by corp via /api/crm/send
  direction          text          NOT NULL
                                   CHECK (direction IN ('inbound', 'outbound')),

  body               text          NOT NULL,
  sent_at            timestamptz   NOT NULL DEFAULT now(),

  -- Who in the cockpit sent it (outbound only; null for inbound).
  -- SET NULL so a deactivated operator doesn't nuke their history.
  sent_by_user_id    uuid          REFERENCES app_users(id) ON DELETE SET NULL,

  -- Telnyx message id for reconciliation against delivery webhooks
  -- and for dedupe if Telnyx replays an inbound. Nullable: send may
  -- fail before Telnyx returns an id, in which case we still want
  -- the outbound row for the UI.
  telnyx_message_id  text,

  segment_count      int           NOT NULL DEFAULT 1
);

-- Thread-scoped chronological read: the center-pane message stream
-- is "WHERE thread_id = $1 ORDER BY sent_at ASC". Index on
-- (thread_id, sent_at DESC) per spec — both directions use the same
-- composite, Postgres reads it backwards for ASC.
CREATE INDEX IF NOT EXISTS crm_messages_thread_sent_idx
  ON crm_messages(thread_id, sent_at DESC);

-- Telnyx replay dedupe: if the webhook receives the same
-- message.received twice, we skip the second insert. Partial index
-- because most rows (outbound failures) may not have an id.
CREATE UNIQUE INDEX IF NOT EXISTS crm_messages_telnyx_message_id_uniq
  ON crm_messages(telnyx_message_id)
  WHERE telnyx_message_id IS NOT NULL;

ALTER TABLE crm_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_messages_admin_select ON crm_messages;
CREATE POLICY crm_messages_admin_select
  ON crm_messages FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND app_users.is_admin = true
    )
  );


-- ============================================================
-- Realtime publication
-- ============================================================
-- The /crm page subscribes to INSERTs on crm_messages and UPDATEs
-- on crm_threads (last_message_at) for live updates. Adding to the
-- publication is what makes Supabase Realtime broadcast row events
-- over the websocket.
--
-- DO blocks because ALTER PUBLICATION errors if the table is
-- already in the publication, and is not idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'crm_threads'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE crm_threads;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'crm_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE crm_messages;
  END IF;
END $$;
