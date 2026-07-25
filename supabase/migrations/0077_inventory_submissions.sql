-- Equipment Inventory — native replacement for the Google Form + Sheets
-- CSV pipeline. Every submit is a NEW row (full history); the admin
-- dashboard derives "latest per manager" at read time. Never upsert.
--
-- city is constrained to the SAME canonical labels as fin_venues.city /
-- lib/types CITIES, so this can join to the city_managers roster later.
--
-- Apply via Supabase Dashboard → SQL Editor. The public submit endpoint
-- (/api/inventory/submit) and the Field Ops → Inventory tab both need
-- this table, so apply BEFORE deploying the feature.

CREATE TABLE IF NOT EXISTS inventory_submissions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  name         text        NOT NULL,
  city         text        NOT NULL,
  white        integer     NOT NULL DEFAULT 0,
  green        integer     NOT NULL DEFAULT 0,
  orange       integer     NOT NULL DEFAULT 0,
  blue         integer     NOT NULL DEFAULT 0,
  balls        integer     NOT NULL DEFAULT 0,
  needs        text,
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- city must be one of the 8 canonical labels (matches fin_venues.city).
  CONSTRAINT inventory_submissions_city_check CHECK (
    city IN ('Austin', 'Houston', 'San Antonio', 'Atlanta',
             'Dallas', 'St. Louis', 'OKC', 'El Paso')
  ),
  -- Defense-in-depth against absurd payloads (app validates too).
  CONSTRAINT inventory_submissions_counts_check CHECK (
    white  BETWEEN 0 AND 999 AND
    green  BETWEEN 0 AND 999 AND
    orange BETWEEN 0 AND 999 AND
    blue   BETWEEN 0 AND 999 AND
    balls  BETWEEN 0 AND 999
  )
);

-- Dashboard reads: newest-first, and per-city grouping.
CREATE INDEX IF NOT EXISTS inventory_submissions_submitted_idx
  ON inventory_submissions (submitted_at DESC);
CREATE INDEX IF NOT EXISTS inventory_submissions_city_submitted_idx
  ON inventory_submissions (city, submitted_at DESC);

-- ============================================================
-- RLS — HARD-GUARDED write path. Anon gets NO policies (RLS enabled +
-- no policy = zero access): anon can neither read nor write directly.
-- The ONLY write path is the guarded server route (/api/inventory/submit),
-- which inserts with the service_role key (bypasses RLS) AFTER running the
-- honeypot / rate-limit / validation guards. So the guards can't be
-- bypassed and the public/anon key can't touch this table at all.
-- ============================================================
ALTER TABLE inventory_submissions ENABLE ROW LEVEL SECURITY;

-- Authenticated cockpit users can read (the dashboard). Admin gating is
-- enforced at the app layer by PagePermissionGuard, same as the other
-- internal tables (fin_opex_entries, city_managers).
DROP POLICY IF EXISTS inventory_auth_select ON inventory_submissions;
CREATE POLICY inventory_auth_select
  ON inventory_submissions FOR SELECT TO authenticated
  USING (true);

-- No anon policy, no INSERT/UPDATE/DELETE policy for anyone: writes happen
-- only via the service_role server route, which bypasses RLS.
