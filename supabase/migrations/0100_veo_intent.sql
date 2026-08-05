-- Two Clubhouse-side Veo tables. Neither touches the MatchDay API or any existing
-- object (the one reference to an existing table is a READ-ONLY seed source; see
-- below). Both are service-role-only, like schedule_master.
--
-- 1) veo_intent — per-match camera intent. The 🎥 emoji in mdapi_matches.name is a
--    MANUAL admin edit in the MatchDay app; this is Clubhouse's own record of which
--    matches should be filmed, so the camera chip can be toggled without writing
--    back to MatchDay. SEEDED once from the emoji so the Veo view opens on the real
--    current state — but the emoji is NOT authoritative afterwards (whole cities run
--    nightly coverage with zero emoji, so a sparse seed is the honest start).
--    Column note: requested `on` -> `enabled` (SQL reserved word). No FK: mdapi_* is
--    a read-only mirror we don't constrain against.
CREATE TABLE IF NOT EXISTS public.veo_intent (
  match_api_id bigint PRIMARY KEY,
  enabled      boolean     NOT NULL DEFAULT true,
  set_by       text,
  set_at       timestamptz NOT NULL DEFAULT now()
);

-- Seed from the camera emoji (🎥 U+1F3A5) in the match name. This SELECT is the
-- ONLY reference to an existing object anywhere in this migration and it is
-- strictly read-only — it inserts into the NEW veo_intent table, never modifies
-- mdapi_matches. Only 🎥 is present in the data today. Idempotent via ON CONFLICT.
INSERT INTO public.veo_intent (match_api_id, enabled, set_by, set_at)
SELECT api_id, true, 'seed:emoji', now()
FROM public.mdapi_matches
WHERE deleted_at IS NULL
  AND name LIKE '%' || U&'\+01F3A5' || '%'
ON CONFLICT (match_api_id) DO NOTHING;

REVOKE ALL ON public.veo_intent FROM anon, authenticated;
GRANT ALL ON public.veo_intent TO service_role;

-- 2) veo_camera_count — editable per-city camera inventory (the fleet changes, so
--    this persists). The Veo view's +/- edits THIS, never veo_codes. veo_codes stays
--    a read-only reference the recordings pipeline uses; this grid reads inventory,
--    so the two can drift and the grid surfaces where. Seeded with the current fleet:
--    Austin 2, Houston 2, San Antonio 1, Dallas 1, Atlanta 1, OKC 1, St. Louis 1
--    = 9 cameras, 63 camera-nights of weekly capacity (9 × 7).
CREATE TABLE IF NOT EXISTS public.veo_camera_count (
  city       text PRIMARY KEY,
  cameras    integer     NOT NULL DEFAULT 1 CHECK (cameras >= 0),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.veo_camera_count (city, cameras) VALUES
  ('Austin', 2),
  ('Houston', 2),
  ('San Antonio', 1),
  ('Dallas', 1),
  ('Atlanta', 1),
  ('OKC', 1),
  ('St. Louis', 1)
ON CONFLICT (city) DO NOTHING;

REVOKE ALL ON public.veo_camera_count FROM anon, authenticated;
GRANT ALL ON public.veo_camera_count TO service_role;
