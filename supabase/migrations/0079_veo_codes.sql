-- Veo auto-poster: the code→field map, moved out of a hardcoded TS constant
-- (src/lib/veo.ts VEO_FIELD_CODES) into a table so it can be edited + confirmed
-- from /admin/veo without a deploy. Each row maps a Veo title CODE (a field
-- abbreviation) to the mdapi field_id(s) it denotes within a fin_venue.
--
--   field_ids  jsonb array of mdapi_matches.field_id, e.g. [102, 199] — a code
--              may cover several fields (SC's regular games land on both 102
--              and 199). The matcher nets candidates over the venue and then
--              field-agreement-checks the winner against THIS set.
--   confirmed  false = queue-only (safe default). true = auto-posts to player
--              chats. Flipping to true is the go-live switch for that field.
--   code       stored NORMALIZED (upper, single-spaced) and UNIQUE.
--
-- RLS: admin-only SELECT (same JWT-email pattern as veo_recordings). No client
-- write policies — the matcher reads with the service role, and all edits go
-- through the admin-gated /api/veo/codes routes (service role + is_admin).
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run BEFORE deploying.

CREATE TABLE IF NOT EXISTS veo_codes (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text        NOT NULL UNIQUE,
  fin_venue_id  integer     NOT NULL,
  field_ids     jsonb       NOT NULL,           -- array of mdapi field_ids
  field_label   text        NOT NULL,
  city          text        NOT NULL,
  confirmed     boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE veo_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS veo_codes_admin_select ON veo_codes;
CREATE POLICY veo_codes_admin_select
  ON veo_codes FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND app_users.is_admin = true
    )
  );
-- No INSERT/UPDATE/DELETE policies — writes go via the service role behind the
-- admin gate (src/app/api/veo/codes routes).

-- Seed: the current 10 rows, exactly as they were in VEO_FIELD_CODES. SC is the
-- one confirmed (auto-posting) code; the rest are queue-only until confirmed.
-- Idempotent — re-running leaves existing rows untouched.
INSERT INTO veo_codes (code, fin_venue_id, field_ids, field_label, city, confirmed) VALUES
  ('SC',           11, '[102, 199]'::jsonb, 'Soccer Central (SC Field 3/4/4A)',    'San Antonio', true),
  ('ATH P',         8, '[32]'::jsonb,       'ATH Pearland',                        'Houston',     false),
  ('ATH K',         7, '[892]'::jsonb,      'ATH Katy',                            'Houston',     false),
  ('PRUMC',        16, '[958]'::jsonb,      'PRUMC',                               'Atlanta',     false),
  ('WESTLAKE',     49, '[1]'::jsonb,        'Westlake HS',                         'Austin',      false),
  ('ONION CREEK',   5, '[27]'::jsonb,       'Onion Creek',                         'Austin',      false),
  ('HILL COUNTRY', 56, '[1453]'::jsonb,     'Hill Country MS',                     'Austin',      false),
  ('LF',           18, '[664]'::jsonb,      'Lou Fusz Outdoor (Field 5/10)',       'St. Louis',   false),
  ('LFI',          19, '[364]'::jsonb,      'Lou Fusz Indoor (Training Center)',   'St. Louis',   false),
  ('CC',           20, '[760]'::jsonb,      'Centennial Commons',                  'St. Louis',   false)
ON CONFLICT (code) DO NOTHING;
