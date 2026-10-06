-- 0211 — ACQUISITION: keep Apple's Page Type and Page Title on the stored download rows
-- (Ryan, 2026-10-06), so a custom product page named "Meta ads" / "Meta ads [city]" can be counted as
-- Apple's own count of ad downloads once it exists.
--
-- 1. acq_asc_downloads_daily gains page_type and page_title (default ''), both in the key.
-- 2. acq_asc_instance is emptied so the next sync re-reads every file Apple still lists, this time
--    with the two columns. The sync replaces each day it reads, so nothing is double counted.
--
-- The code tolerates this migration not being applied yet (lib/ascAnalytics probes for page_type).

BEGIN;

ALTER TABLE public.acq_asc_downloads_daily ADD COLUMN page_type  text NOT NULL DEFAULT '';
ALTER TABLE public.acq_asc_downloads_daily ADD COLUMN page_title text NOT NULL DEFAULT '';
ALTER TABLE public.acq_asc_downloads_daily DROP CONSTRAINT acq_asc_downloads_daily_pkey;
ALTER TABLE public.acq_asc_downloads_daily
  ADD PRIMARY KEY (day, report, download_type, source_type, source_info, campaign, territory, page_type, page_title);

DELETE FROM public.acq_asc_instance WHERE instance_id IS NOT NULL;

COMMIT;

-- Read-back
SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'acq_asc_downloads_daily' AND column_name IN ('page_type','page_title')) AS new_columns,
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'acq_asc_downloads_daily_pkey') AS downloads_key,
  (SELECT count(*) FROM public.acq_asc_instance) AS instance_rows;
