-- 0106: Google Calendar integration — "This week" meetings on the home page.
--
-- SENSITIVE DATA (meeting titles + attendee identities): RLS on, REVOKE ALL from
-- anon/authenticated/PUBLIC, service_role only. The app reads exclusively through
-- session-authed API routes that use the service role — never the browser client.
--
-- PRIVACY AS SCHEMA: no description column, no location column. Those bytes are
-- never even requested from Google (see the `fields` parameter in calendarSync.ts).
--
-- DEDUP KEY: (ical_uid, start_utc). iCalUID alone is WRONG — every occurrence of a
-- recurring event shares one iCalUID (with singleEvents=true they're expanded into
-- separate instances), so keying on iCalUID collapses a whole series onto one row.
-- Adding start_utc keeps genuine occurrences distinct while still collapsing the
-- same meeting across N attendees' calendars into one row.
--
-- SYNC MODEL: a FULL window rebuild every run (no syncToken). Each run deletes the
-- table and reinserts everything all accounts returned, inside one transaction
-- (calendar_replace_window). That kills three staleness classes at once —
-- cancellations, moved occurrences, and meetings dropped below 2 people.
--
-- RETENTION: only the sync window (calendarSync.ts: now-7d … now+21d) is ever
-- inserted, so nothing else accumulates.

BEGIN;

-- ── fin_sync_log source: add 'google-calendar' (live list read empirically from
--    the constraint — 14 existing values + the new one).
ALTER TABLE public.fin_sync_log DROP CONSTRAINT IF EXISTS fin_sync_log_source_check;
ALTER TABLE public.fin_sync_log ADD CONSTRAINT fin_sync_log_source_check
  CHECK (source IN (
    'stripe-api','mdapi-reviews','mdapi-subscriptions','mdapi-promocodes','mdapi-matches',
    'mdapi-users','mdapi-users-lens-snapshot','membership-snapshots','membership-prices',
    'manager-pay-recompute','firstmatch-ledger','telnyx-sms','play-installs','app-store-installs',
    'google-calendar'
  ));

-- ── accounts to impersonate (domain-wide delegation). Seeded from people already
--    in the app — NO Directory scope. No sync_token column: every run is a full sync.
CREATE TABLE IF NOT EXISTS public.calendar_sync_accounts (
  email          text PRIMARY KEY,
  last_synced_at timestamptz,
  last_error     text,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ── one row per MEETING OCCURRENCE, deduped on (ical_uid, start_utc).
CREATE TABLE IF NOT EXISTS public.calendar_meetings (
  ical_uid             text        NOT NULL,           -- shared across attendees AND across occurrences
  start_utc            timestamptz NOT NULL,           -- the UTC instant (distinguishes occurrences)
  end_utc              timestamptz,
  summary              text,                            -- title (topic)
  start_tz             text,                            -- event's original timeZone (stored separately)
  end_tz               text,
  all_day              boolean     NOT NULL DEFAULT false,
  organizer_email      text,
  human_attendee_count int         NOT NULL,
  recurring_event_id   text,                            -- traceability: the series
  original_start_utc   timestamptz,                     -- traceability: a moved occurrence
  source_account       text,                            -- which copy won the resolve (provenance)
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ical_uid, start_utc)
);
CREATE INDEX IF NOT EXISTS calendar_meetings_start_idx ON public.calendar_meetings (start_utc);

-- ── attendee identities (email + display name + organizer). Composite FK to the
--    occurrence, cascade on delete.
CREATE TABLE IF NOT EXISTS public.calendar_meeting_attendees (
  ical_uid     text        NOT NULL,
  start_utc    timestamptz NOT NULL,
  email        text        NOT NULL,
  display_name text,
  organizer    boolean     NOT NULL DEFAULT false,
  PRIMARY KEY (ical_uid, start_utc, email),
  FOREIGN KEY (ical_uid, start_utc) REFERENCES public.calendar_meetings (ical_uid, start_utc) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS calendar_attendees_email_idx ON public.calendar_meeting_attendees (email, start_utc);

-- ── atomic full-window rebuild. Returns eventsDeleted = occurrences present before
--    but absent from the new set (cancellations + moves + dropped-below-2). Runs as
--    one transaction (it's a function body); SECURITY DEFINER so the service-role
--    caller replaces the whole mirror atomically.
CREATE OR REPLACE FUNCTION public.calendar_replace_window(p_meetings jsonb, p_attendees jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_deleted integer;
BEGIN
  SELECT count(*) INTO v_deleted
  FROM public.calendar_meetings m
  WHERE NOT EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_meetings) AS n(ical_uid text, start_utc timestamptz)
    WHERE n.ical_uid = m.ical_uid AND n.start_utc = m.start_utc
  );

  DELETE FROM public.calendar_meetings;  -- attendees cascade; only the window is ever stored

  INSERT INTO public.calendar_meetings
    (ical_uid, start_utc, end_utc, summary, start_tz, end_tz, all_day, organizer_email,
     human_attendee_count, recurring_event_id, original_start_utc, source_account, updated_at)
  SELECT ical_uid, start_utc, end_utc, summary, start_tz, end_tz, all_day, organizer_email,
         human_attendee_count, recurring_event_id, original_start_utc, source_account, now()
  FROM jsonb_to_recordset(p_meetings) AS x(
    ical_uid text, start_utc timestamptz, end_utc timestamptz, summary text, start_tz text, end_tz text,
    all_day boolean, organizer_email text, human_attendee_count int, recurring_event_id text,
    original_start_utc timestamptz, source_account text);

  INSERT INTO public.calendar_meeting_attendees (ical_uid, start_utc, email, display_name, organizer)
  SELECT ical_uid, start_utc, email, display_name, organizer
  FROM jsonb_to_recordset(p_attendees) AS y(
    ical_uid text, start_utc timestamptz, email text, display_name text, organizer boolean);

  RETURN v_deleted;
END $$;

-- ── lock down.
ALTER TABLE public.calendar_sync_accounts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_meetings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_meeting_attendees ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.calendar_sync_accounts     FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.calendar_meetings          FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.calendar_meeting_attendees FROM anon, authenticated, PUBLIC;
REVOKE ALL ON FUNCTION public.calendar_replace_window(jsonb, jsonb) FROM anon, authenticated, PUBLIC;

GRANT ALL     ON public.calendar_sync_accounts     TO service_role;
GRANT ALL     ON public.calendar_meetings          TO service_role;
GRANT ALL     ON public.calendar_meeting_attendees TO service_role;
GRANT EXECUTE ON FUNCTION public.calendar_replace_window(jsonb, jsonb) TO service_role;

-- ── seed accounts from the team already in the app (domain only).
INSERT INTO public.calendar_sync_accounts (email)
SELECT DISTINCT lower(email) FROM public.app_users
WHERE email ILIKE '%@playmatchday.com'
ON CONFLICT (email) DO NOTHING;

COMMIT;
