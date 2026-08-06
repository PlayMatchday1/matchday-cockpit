-- 0108: add meet_url to calendar_meetings (Join Google Meet button). Additive.
--
-- meet_url is effectively room access — it stays on a service-role-only table
-- (0106 REVOKE'd ALL from anon/authenticated/PUBLIC). A new column inherits the
-- table's grants: anon/authenticated have NO privileges on the table, so they have
-- none on the new column either — no extra REVOKE needed. Confirmed, not assumed:
-- column privileges default to the table's, and there is no per-column GRANT to
-- anon/authenticated anywhere. The service_role GRANT ALL already covers it.
--
-- We store ONLY the "video" entry-point URI (or hangoutLink fallback). Phone/SIP
-- dial-ins + PINs are never stored. No conference_data blob.

BEGIN;

ALTER TABLE public.calendar_meetings ADD COLUMN IF NOT EXISTS meet_url text;

-- Recreate the atomic replace to carry meet_url through the insert + recordset.
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
     human_attendee_count, recurring_event_id, original_start_utc, meet_url, source_account, updated_at)
  SELECT ical_uid, start_utc, end_utc, summary, start_tz, end_tz, all_day, organizer_email,
         human_attendee_count, recurring_event_id, original_start_utc, meet_url, source_account, now()
  FROM jsonb_to_recordset(p_meetings) AS x(
    ical_uid text, start_utc timestamptz, end_utc timestamptz, summary text, start_tz text, end_tz text,
    all_day boolean, organizer_email text, human_attendee_count int, recurring_event_id text,
    original_start_utc timestamptz, meet_url text, source_account text);

  INSERT INTO public.calendar_meeting_attendees (ical_uid, start_utc, email, display_name, organizer)
  SELECT ical_uid, start_utc, email, display_name, organizer
  FROM jsonb_to_recordset(p_attendees) AS y(
    ical_uid text, start_utc timestamptz, email text, display_name text, organizer boolean);

  RETURN v_deleted;
END $$;

COMMIT;
