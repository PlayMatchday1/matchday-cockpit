-- Local cache of Telnyx outbound SMS history for the /sms-log dashboard.
--
-- Fed by a daily cron (yesterday's Message Detail Records via
-- /v2/detail_records, plus per-message body via GET /v2/messages/{id})
-- and an on-demand recent-hours fetch. Body is only retrievable from
-- Telnyx for 10 days, so this table is the durable 90-day store; the
-- cron prunes rows older than 90 days by sent_at.
--
-- source_type is pattern-matched at ingest (match_notify by id
-- cross-reference first, then body patterns, then 'other'). It is plain
-- text with no CHECK so new patterns can be added without a migration.
--
-- Recipient name + city are denormalized snapshots matched from
-- mdapi_users by normalized phone at ingest, so the city filter and name
-- search need no join.
--
-- PII: holds recipient phone numbers and message bodies. RLS is enabled
-- with SELECT to authenticated only; the cron writes with the service
-- role (bypasses RLS).
--
-- Apply via Supabase Dashboard -> SQL Editor -> paste & run.

CREATE TABLE IF NOT EXISTS telnyx_sms_log (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telnyx_message_id    text NOT NULL UNIQUE,
  direction            text NOT NULL DEFAULT 'outbound',
  to_phone             text NOT NULL,
  from_phone           text,
  message_type         text,
  parts                integer,
  delivery_status      text,
  message_body         text,
  source_type          text NOT NULL DEFAULT 'unknown',
  cost_amount          numeric,
  cost_currency        text,
  carrier              text,
  errors               jsonb,
  matched_user_id      bigint,
  recipient_first_name text,
  recipient_last_name  text,
  recipient_city       text,
  sent_at              timestamptz,
  completed_at         timestamptz,
  telnyx_created_at    timestamptz,
  raw                  jsonb,
  ingested_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS telnyx_sms_log_sent_idx   ON telnyx_sms_log(sent_at DESC);
CREATE INDEX IF NOT EXISTS telnyx_sms_log_source_idx ON telnyx_sms_log(source_type);
CREATE INDEX IF NOT EXISTS telnyx_sms_log_city_idx   ON telnyx_sms_log(recipient_city);
CREATE INDEX IF NOT EXISTS telnyx_sms_log_status_idx ON telnyx_sms_log(delivery_status);
CREATE INDEX IF NOT EXISTS telnyx_sms_log_to_idx     ON telnyx_sms_log(to_phone);

-- RLS on from the start. Service role (cron) bypasses; authenticated
-- admins read in the dashboard. No anon access (phones + bodies are PII).
ALTER TABLE telnyx_sms_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS telnyx_sms_log_auth_select ON telnyx_sms_log;
CREATE POLICY telnyx_sms_log_auth_select
  ON telnyx_sms_log FOR SELECT TO authenticated USING (true);
