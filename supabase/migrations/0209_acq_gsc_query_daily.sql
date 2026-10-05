-- 0209 — ACQUISITION: Search Console by QUERY and page, for the Website table's Google rank (Ryan, 2026-10-05).
-- (Drafted 2026-10-04 as 0206 and never applied; renumbered because 0207 and 0208 were applied since.)
--
-- The Rank column is the average Google position of a city's page for "pickup soccer [city]" (and,
-- where Search Console has them, "pick up soccer [city]" and "pickup soccer near me"). acq_gsc_page_daily
-- (0203) has no query dimension, so this table holds query + page + day. To keep it small the sync
-- stores only queries containing "soccer" (Search Console's own filter); the page picks the exact
-- queries out of those. Position is stored × impressions, like 0203, so a range averages correctly.
-- Written by the existing gsc-pages sync step (no new fin_sync_log source), backfilled from Jul 1.
-- Server-only, like the other acq_* tables. Applied by hand in the Supabase SQL Editor.

BEGIN;

CREATE TABLE public.acq_gsc_query_daily (
  day                    date NOT NULL,
  page_url               text NOT NULL,
  query                  text NOT NULL,
  clicks                 integer NOT NULL CHECK (clicks >= 0),
  impressions            integer NOT NULL CHECK (impressions >= 0),
  position_x_impressions numeric(14,2) NOT NULL CHECK (position_x_impressions >= 0),
  synced_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, page_url, query)
);

ALTER TABLE public.acq_gsc_query_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.acq_gsc_query_daily FROM anon, authenticated;

COMMIT;

-- Verdict: the table exists and is empty until the backfill runs.
SELECT to_regclass('public.acq_gsc_query_daily') IS NOT NULL AS table_exists,
       (SELECT count(*) FROM public.acq_gsc_query_daily)     AS rows_before_backfill;
