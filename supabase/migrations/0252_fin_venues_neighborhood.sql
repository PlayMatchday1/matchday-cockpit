-- 0252 — fin_venues.neighborhood: the public area label for a venue ("North Austin", "Buckhead").
--
-- Shown on the website's venue cards (the area badge) through the public site feed, and edited on
-- Match Ops > Field Ops. Nullable, no default: a venue with no label simply shows no badge.
-- Nothing reads it until the code that names it ships, and that code ships after this applies.

ALTER TABLE public.fin_venues
  ADD COLUMN IF NOT EXISTS neighborhood text;

COMMENT ON COLUMN public.fin_venues.neighborhood IS
  'Public area label for the venue (e.g. "North Austin"). Shown as the area badge on playmatchday.com via /api/public/site.json. Null = no badge.';
