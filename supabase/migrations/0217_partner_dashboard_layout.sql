-- 0217 — PARTNER DASHBOARD LAYOUT (Ryan, 2026-10-09).
--
-- Applied by hand in the Supabase SQL Editor. One column on partner_dashboards; no data change for
-- existing partners.
--
-- Which page a partner sees at /partners/<slug>. 'standard' is today's page for every partner and
-- is the default, so the five existing rows keep exactly what they render now. 'simple' is the
-- short page (deal sentence, three cards, a by-month table); it is set for Turf On only, by the
-- UPDATE below. The page reads this column — no slug is hardcoded anywhere.
--
-- RLS: unchanged. partner_dashboards' three policies (anon read of enabled rows, authenticated read,
-- authenticated write — migration 0001) are row policies, and no column-level grants exist on this
-- table, so the new column is covered exactly as every other column is.

BEGIN;

ALTER TABLE public.partner_dashboards
  ADD COLUMN layout text NOT NULL DEFAULT 'standard'
  CHECK (layout IN ('standard', 'simple'));

UPDATE public.partner_dashboards SET layout = 'simple' WHERE slug = 'turf-on-8vm72bt7';

DO $$ BEGIN
  IF (SELECT count(*) FROM public.partner_dashboards WHERE layout = 'simple') <> 1 THEN
    RAISE EXCEPTION 'expected exactly one simple-layout partner (Turf On) — rolled back';
  END IF;
END $$;

COMMIT;
