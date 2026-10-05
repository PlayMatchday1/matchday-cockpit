-- 0204 — ACQUISITION: where an app first-open came from (Ryan, 2026-10-04).
--
-- Ryan's decision: split Apple's page.link downloads by GA4's source shares — in-app share links
-- (firebase / dynamic_link), Instagram organic (ig / social), Meta ads (ig|fb / paid), other —
-- recomputed for the selected range. acq_app_event_daily (0203) keyed on day + event + platform
-- only, so the split had nowhere to live. The table is empty (nothing has synced into it yet), so
-- the key can change in place. Applied by hand in the Supabase SQL Editor.

BEGIN;

ALTER TABLE public.acq_app_event_daily
  ADD COLUMN source_bucket text NOT NULL DEFAULT 'other'
  CHECK (source_bucket IN ('share','ig_social','paid','other'));

ALTER TABLE public.acq_app_event_daily DROP CONSTRAINT acq_app_event_daily_pkey;
ALTER TABLE public.acq_app_event_daily ADD PRIMARY KEY (day, event_name, platform, source_bucket);

COMMENT ON COLUMN public.acq_app_event_daily.source_bucket IS
  'share = sessionSource firebase / sessionMedium dynamic_link; ig_social = ig / social; paid = ig|fb|instagram|facebook / paid; other = everything else, including (not set) and direct.';

COMMIT;
