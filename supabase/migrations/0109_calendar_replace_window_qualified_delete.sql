-- 0109: harden calendar_replace_window's DELETE.
--
-- A sync run failed once with "calendar_replace_window failed: DELETE requires a
-- WHERE clause" — that's the pg-safeupdate guard rejecting the unqualified
-- `DELETE FROM calendar_meetings`. It's intermittent (a later run succeeded), but
-- it must never be able to fail the sync. Give the DELETE an always-true WHERE
-- (start_utc is the NOT NULL PK, so this still clears the whole table) so safeupdate
-- is satisfied whether or not it's enabled. Body is otherwise identical to 0108
-- (still carries meet_url).

BEGIN;

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

  DELETE FROM public.calendar_meetings WHERE start_utc IS NOT NULL;  -- always-true WHERE (PK); satisfies safeupdate; attendees cascade

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
