-- 0207 — PROMO TAGS: a start and end date, for Starting 11 (Ryan, 2026-10-05).
--
-- starting_11 is a FIELD-scoped row with no dates, so once set it shows on every week forever.
-- Two nullable dates: a match shows STARTING 11 only when its date is between starts_on and ends_on,
-- inclusive. ends_on NULL = still live. Both NULL (every existing row) = shows everywhere, as today,
-- until edited. The route requires starts_on when Starting 11 is turned on; the database does not,
-- because the existing undated rows must stay valid. Applied by hand in the Supabase SQL Editor.

BEGIN;

ALTER TABLE public.promo_tags
  ADD COLUMN IF NOT EXISTS starts_on date,
  ADD COLUMN IF NOT EXISTS ends_on   date;

ALTER TABLE public.promo_tags
  ADD CONSTRAINT promo_tags_dates_order_ck
  CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on);

COMMENT ON COLUMN public.promo_tags.starts_on IS 'First day the tag applies (inclusive). NULL with ends_on NULL = always (pre-0207 rows).';
COMMENT ON COLUMN public.promo_tags.ends_on   IS 'Last day the tag applies (inclusive). NULL = still live.';

COMMIT;
