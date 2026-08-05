-- Per-match Veo camera intent, Clubhouse-side. The 🎥 emoji in mdapi_matches.name
-- is a MANUAL admin edit in the MatchDay app; this table is Clubhouse's own record
-- of which matches should be filmed, so an admin can toggle the camera chip without
-- writing back to the MatchDay API. It is SEEDED once from the emoji so the Veo view
-- opens on the real current state instead of blank — but the emoji is NOT treated as
-- authoritative afterwards (the audit shows whole cities running nightly coverage
-- with zero emoji, so a nearly-empty seed is the honest starting point, not a bug).
--
-- Column note: the requested name was `on`, but `on` is a SQL reserved word — using
-- `enabled` avoids quoting it in every query. match_api_id is the mdapi_matches
-- api_id (no FK: mdapi_* is a read-only mirror we don't constrain against).
CREATE TABLE IF NOT EXISTS public.veo_intent (
  match_api_id bigint PRIMARY KEY,
  enabled      boolean     NOT NULL DEFAULT true,
  set_by       text,
  set_at       timestamptz NOT NULL DEFAULT now()
);

-- Seed from the camera emoji (🎥 U+1F3A5) currently in the match name. Only 🎥 is
-- present in the data today; the app-side detector also covers the rest of the
-- camera family for future variants. ON CONFLICT keeps this migration idempotent.
INSERT INTO public.veo_intent (match_api_id, enabled, set_by, set_at)
SELECT api_id, true, 'seed:emoji', now()
FROM public.mdapi_matches
WHERE deleted_at IS NULL
  AND name LIKE '%' || U&'\+01F3A5' || '%'
ON CONFLICT (match_api_id) DO NOTHING;

-- Clubhouse-only: written/read exclusively through service-role API routes (same as
-- schedule_master). RLS on with no policies denies anon/authenticated entirely;
-- service_role bypasses RLS. Belt-and-suspenders REVOKE of the default grants too.
ALTER TABLE public.veo_intent ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.veo_intent FROM anon, authenticated;
GRANT ALL ON public.veo_intent TO service_role;
