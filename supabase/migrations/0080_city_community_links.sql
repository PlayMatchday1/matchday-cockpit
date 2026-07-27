-- Community WhatsApp invite auto-poster. When a match finishes, a scheduled
-- job posts a two-message invite (copy line + that city's bare invite URL)
-- into the match's chat. This migration adds the config + idempotency +
-- control-plane tables. The pg_cron schedule is a SEPARATE migration (0081) so
-- you can run this, deploy, dry-run, and only THEN turn the schedule on.
--
-- Cities are keyed by the canonical short code from normalizeCityName
-- (STL, ATX, ATL, DFW, HOU, SATX, OKC, ELP) — the same key
-- mdapi_matches.city_identifier / the discrepancy join use. NOT a free-text
-- city string.
--
-- RLS: admin-only SELECT (same JWT-email pattern as veo_recordings). No client
-- write policies — the job reads with the service role, and all edits go
-- through the admin-gated /api/community/* routes (service role + is_admin).
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run BEFORE deploying.

-- 1) One row per city: the invite link + whether it's live.
CREATE TABLE IF NOT EXISTS city_community_links (
  city_code     text        PRIMARY KEY,           -- canonical short code
  display_name  text        NOT NULL,              -- interpolated into the copy
  whatsapp_url  text,                              -- null until a link is set
  active        boolean     NOT NULL DEFAULT false,
  -- Stamped now() on every inactive→active flip (by the admin route). The job
  -- never posts to a match that ended before this — so activating a city posts
  -- only its future finished matches, not the trailing 24h lookback. Left in
  -- place on deactivate; overwritten on the next activation.
  activated_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 2) Idempotency + audit: one row per match we've posted to. UNIQUE(api_id) +
-- the Firestore deterministic-doc-id batch are the two idempotency layers.
CREATE TABLE IF NOT EXISTS community_posts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  match_api_id    bigint      NOT NULL UNIQUE,      -- == mdapi_matches.api_id / Firestore chat id
  city_code       text,
  display_name    text,
  copy_message_id text,                             -- community-<api_id>-copy
  url_message_id  text,                             -- community-<api_id>-url
  posted_at       timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS community_posts_posted_at_idx
  ON community_posts(posted_at DESC);

-- 3) Control plane: the global kill switch + the run heartbeat. Single row
-- (id is pinned to 1). posting_enabled defaults FALSE — nothing posts until
-- it's turned on. The job updates the heartbeat every run so a stalled
-- schedule / 500ing endpoint is visible on the Community tab.
CREATE TABLE IF NOT EXISTS community_settings (
  id                smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  posting_enabled   boolean     NOT NULL DEFAULT false,
  last_attempted_at timestamptz,
  last_success_at   timestamptz,
  last_status       integer,                        -- last non-2xx status, if any
  last_error        text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS + admin-only SELECT on all three.
ALTER TABLE city_community_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_posts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_settings   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS city_community_links_admin_select ON city_community_links;
CREATE POLICY city_community_links_admin_select
  ON city_community_links FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM app_users
    WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email') AND app_users.is_admin = true));

DROP POLICY IF EXISTS community_posts_admin_select ON community_posts;
CREATE POLICY community_posts_admin_select
  ON community_posts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM app_users
    WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email') AND app_users.is_admin = true));

DROP POLICY IF EXISTS community_settings_admin_select ON community_settings;
CREATE POLICY community_settings_admin_select
  ON community_settings FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM app_users
    WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email') AND app_users.is_admin = true));
-- No INSERT/UPDATE/DELETE policies — writes go via the service role behind the
-- shared secret (the job) or the admin gate (the /api/community/* routes).

-- Seed all 8 cities. St. Louis gets the real invite URL but stays active=false
-- (everything ships OFF); the rest have no url yet. Idempotent.
INSERT INTO city_community_links (city_code, display_name, whatsapp_url, active) VALUES
  ('STL',  'St. Louis',   'https://chat.whatsapp.com/JKCdpXGeqziHTMzYLPFh8e?s=cl&p=i&ilr=1&amv=0', false),
  ('ATX',  'Austin',      NULL, false),
  ('DFW',  'Dallas',      NULL, false),
  ('HOU',  'Houston',     NULL, false),
  ('SATX', 'San Antonio', NULL, false),
  ('ATL',  'Atlanta',     NULL, false),
  ('OKC',  'OKC',         NULL, false),
  ('ELP',  'El Paso',     NULL, false)
ON CONFLICT (city_code) DO NOTHING;

-- Seed the single control-plane row: posting globally OFF.
INSERT INTO community_settings (id, posting_enabled) VALUES (1, false)
ON CONFLICT (id) DO NOTHING;
