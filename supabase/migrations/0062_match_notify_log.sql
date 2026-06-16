-- Audit log for the "Notify players" feature (Cockpit Chats → match
-- right pane). One row per send batch: an operator fires operational
-- SMS via Telnyx to the currently-registered PLAYER rows in a match.
--
-- Recipients are resolved server-side from mdapi_match_players:
--   user_type = 'PLAYER', not cancelled / waitlist / absent / fake /
--   soft-deleted, deduped by E.164 phone. recipient_count is how many
--   had a valid phone and were actually attempted; success/failure
--   come from Telnyx per-recipient (Promise.allSettled).
--
-- recipients jsonb shape (one object per attempted recipient):
--   { "user_id": <bigint>, "phone": "+1512...", "send_status":
--     "sent" | "failed", "telnyx_message_id": "..." | null,
--     "error_message": "..." | null }
-- Full E.164 phones are stored for debugging failed sends; the table
-- is SELECT TO authenticated only (RLS below), so anon cannot read it.
--
-- sent_by_user_id is ON DELETE SET NULL so a deactivated operator
-- doesn't take the audit trail with them (mirrors crm_assignment_log
-- and crm_messages.sent_by_user_id).
--
-- Apply via Supabase Dashboard -> SQL Editor -> paste & run.

CREATE TABLE IF NOT EXISTS match_notify_log (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  match_api_id     bigint        NOT NULL,
  sent_by_user_id  uuid          REFERENCES app_users(id) ON DELETE SET NULL,
  sent_at          timestamptz   NOT NULL DEFAULT now(),
  template_used    text          NOT NULL CHECK (template_used IN
                     ('field_change', 'time_change', 'weather_policy', 'free_form')),
  message_body     text          NOT NULL,
  recipient_count  integer       NOT NULL,
  success_count    integer       NOT NULL DEFAULT 0,
  failure_count    integer       NOT NULL DEFAULT 0,
  recipients       jsonb         NOT NULL,
  created_at       timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS match_notify_log_match_idx
  ON match_notify_log(match_api_id);
CREATE INDEX IF NOT EXISTS match_notify_log_sent_idx
  ON match_notify_log(sent_at DESC);

-- RLS on from the start. The send route writes with the service role
-- (bypasses RLS); authenticated admins read the log in the UI. No anon
-- access (the jsonb holds player phone numbers).
ALTER TABLE match_notify_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS match_notify_log_auth_select ON match_notify_log;
CREATE POLICY match_notify_log_auth_select
  ON match_notify_log FOR SELECT TO authenticated USING (true);
