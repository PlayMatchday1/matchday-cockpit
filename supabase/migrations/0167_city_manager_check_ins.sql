-- City Manager Check-Ins — native replacement for the Google Form + published-CSV pipeline.
-- Same shape as 0077 (Equipment Inventory), which is the working model for a public no-login form:
-- every submit is a NEW row (full history), and the dashboard derives latest-per-city at read time.
-- Never upsert.
--
-- Apply via Supabase Dashboard -> SQL Editor. The public submit endpoint
-- (/api/city-check-ins/submit), the /check-in page and Match Ops -> Check-Ins all need this table,
-- so apply BEFORE deploying the feature.
--
-- ── WHY city_identifier AND NOT A CITY NAME ─────────────────────────────────────────────────
-- The Sheet stored whatever the manager typed, and src/lib/checkIns.ts carried the cost: a
-- keyword-matching column finder, a fuzzy cityMatch with a special case for OKC (whose Sheet
-- spelling is "Oklahoma City") and an includes() fallback so "Atlanta, GA" resolved. The repo
-- spells one city three ways — "DFW", "Dallas", "Dallas-Fort Worth" — which is exactly why
-- anything that has to JOIN uses the identifier. Storing the identifier deletes that whole class
-- of problem at the source: the read side compares MANAGERS[].cityId to this column with `===`.
--
-- ── THE CHECK, AND WHAT IT COSTS ────────────────────────────────────────────────────────────
-- src/lib/cityScope.ts is the allowlist and the route enforces it; this CHECK is defence in depth,
-- in the shape 0077 uses. STATED PLAINLY: cityScope.ts's own header argues against constraining
-- city_identifier in the database, because migration 0120 wanted "adding a city" to be a one-line
-- code edit rather than a migration. With this CHECK, opening a city needs BOTH — the cityScope.ts
-- line and an ALTER here. That is a deliberate trade for a submissions table, where a typo'd
-- identifier is not an error but a check-in that silently matches no manager and never appears.

CREATE TABLE IF NOT EXISTS city_manager_check_ins (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  submitted_at       timestamptz NOT NULL DEFAULT now(),

  -- The Sheet had NO name column, which is why the seven managers in MANAGERS had to be
  -- reconstructed by joining submitting emails back to app_users, and why two were misspelt until
  -- someone checked. Captured directly from now on.
  manager_name       text        NOT NULL,

  city_identifier    text        NOT NULL,

  -- The month the check-in is ABOUT, not when it was filed. They are routinely different: of the
  -- twelve Sheet submissions, one filed 17 Apr reports month-ending 31 Mar, and one filed 20 Feb
  -- reports month-ending 3 Mar. Bucketing by filing date files March's check-in under April.
  month_ending       date        NOT NULL,

  -- 1-5. The Sheet header declares the scale itself: "Overall Weekly Rating (1-5) (Linear scale:
  -- 1 = Poor, 5 = Excellent)". Measured across all twelve rows: integers only, observed 3-5.
  rating             smallint    NOT NULL,

  fields_contacted   text,
  fields_list        text,
  field_progress     text,
  match_manager      text,
  marketing_channels text,
  marketing_results  text,
  win                text,
  challenge          text,
  focus              text,

  created_at         timestamptz NOT NULL DEFAULT now(),

  -- Mirrors src/lib/cityScope.ts CITY_SCOPES. No El Paso: it appears in lib/types CITIES for
  -- display but carries no city_identifier, so nothing could join it.
  CONSTRAINT city_manager_check_ins_city_check CHECK (
    city_identifier IN ('ATL', 'ATX', 'DFW', 'HOU', 'OKC', 'SATX', 'STL', 'WAW')
  ),
  CONSTRAINT city_manager_check_ins_rating_check CHECK (rating BETWEEN 1 AND 5),

  -- Defence-in-depth against absurd payloads (the route validates the same bounds).
  CONSTRAINT city_manager_check_ins_len_check CHECK (
    char_length(manager_name)            BETWEEN 1 AND 120 AND
    char_length(coalesce(fields_contacted,   '')) <= 200  AND
    char_length(coalesce(fields_list,        '')) <= 4000 AND
    char_length(coalesce(field_progress,     '')) <= 4000 AND
    char_length(coalesce(match_manager,      '')) <= 4000 AND
    char_length(coalesce(marketing_channels, '')) <= 4000 AND
    char_length(coalesce(marketing_results,  '')) <= 4000 AND
    char_length(coalesce(win,                '')) <= 4000 AND
    char_length(coalesce(challenge,          '')) <= 4000 AND
    char_length(coalesce(focus,              '')) <= 4000
  )
);

-- Dashboard reads: latest-per-city within a viewed month, and newest-first overall.
CREATE INDEX IF NOT EXISTS city_manager_check_ins_city_month_idx
  ON city_manager_check_ins (city_identifier, month_ending DESC, submitted_at DESC);
CREATE INDEX IF NOT EXISTS city_manager_check_ins_submitted_idx
  ON city_manager_check_ins (submitted_at DESC);

-- ============================================================
-- RLS — HARD-GUARDED write path, identical posture to 0077. Anon gets NO policies (RLS enabled +
-- no policy = zero access): anon can neither read nor write directly. The ONLY write path is the
-- guarded server route (/api/city-check-ins/submit), which inserts with the service_role key
-- (bypasses RLS) AFTER the honeypot / rate-limit / validation guards. So the guards cannot be
-- bypassed and the public/anon key cannot touch this table at all.
--
-- NOTE THE ASYMMETRY AND IT IS DELIBERATE: the FORM is public, the TABLE is not. A city manager
-- files without logging in; reading what everyone filed stays behind a Clubhouse session.
-- ============================================================
ALTER TABLE city_manager_check_ins ENABLE ROW LEVEL SECURITY;

-- Authenticated cockpit users can read (the Check-Ins dashboard reads this from the browser).
-- Page-level gating stays at the app layer via PagePermissionGuard, same as inventory_submissions.
DROP POLICY IF EXISTS city_check_ins_auth_select ON city_manager_check_ins;
CREATE POLICY city_check_ins_auth_select
  ON city_manager_check_ins FOR SELECT TO authenticated
  USING (true);

-- No anon policy, and no INSERT/UPDATE/DELETE policy for anyone: writes happen only via the
-- service_role server route, which bypasses RLS.
