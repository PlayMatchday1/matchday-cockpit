-- 0210 — ACQUISITION: Apple App Downloads, stored for the page (Ryan, 2026-10-06).
--
-- 1. acq_asc_downloads_daily (0203, still EMPTY) gains `territory`, in the key. Poland's downloads
--    are shown outside our markets (Warsaw is the licensee), so the country has to be kept.
-- 2. acq_asc_instance: one row per Apple report instance the sync has stored, so each file is read
--    once — and the one-time Detailed history is picked up the first run after Apple delivers it.
--
-- The sync source 'asc-analytics' is already in fin_sync_log's allowlist (0203). No change there.

BEGIN;

DO $$ BEGIN
  IF (SELECT count(*) FROM public.acq_asc_downloads_daily) <> 0 THEN
    RAISE EXCEPTION 'acq_asc_downloads_daily is not empty — rolled back (the key change assumes no rows)';
  END IF;
END $$;

ALTER TABLE public.acq_asc_downloads_daily ADD COLUMN territory text NOT NULL DEFAULT '';
ALTER TABLE public.acq_asc_downloads_daily DROP CONSTRAINT acq_asc_downloads_daily_pkey;
ALTER TABLE public.acq_asc_downloads_daily
  ADD PRIMARY KEY (day, report, download_type, source_type, source_info, campaign, territory);

CREATE TABLE public.acq_asc_instance (
  instance_id      text PRIMARY KEY,
  request          text NOT NULL CHECK (request IN ('ongoing','snapshot')),
  report           text NOT NULL CHECK (report IN ('standard','detailed')),
  granularity      text NOT NULL,
  processing_date  date NOT NULL,
  first_day        date,
  last_day         date,
  file_rows        integer NOT NULL CHECK (file_rows >= 0),
  stored_rows      integer NOT NULL CHECK (stored_rows >= 0),
  stored_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.acq_asc_instance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.acq_asc_instance FROM anon, authenticated;

COMMIT;

-- Read-back
SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'acq_asc_downloads_daily' AND column_name = 'territory') AS territory_column,
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'acq_asc_downloads_daily_pkey') AS downloads_key,
  (SELECT count(*) FROM public.acq_asc_instance) AS instance_rows;
