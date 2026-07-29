-- Split community WhatsApp posting from one-per-city to one-per-community,
-- keyed on the match's field. A city can now hold several communities; a
-- match's destination is decided by its field_id.
--
-- Dedup is UNCHANGED: community_posts.match_api_id stays the UNIQUE key, the
-- alreadyPosted set and the Firestore doc ids stay keyed on api_id. The new
-- community_id column on community_posts is INFORMATIONAL only — it is never in
-- a unique index or dedupe path, and is left NULL on historical rows.
--
-- field_id is the PRIMARY KEY of community_field_map on purpose: it makes "one
-- match resolves to at most one community" a database guarantee.
--
-- RLS mirrors manager_gusto_aliases: authenticated SELECT, service-role writes,
-- no write policy for authenticated.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run BEFORE deploying.

-- 1) Communities within a city.
CREATE TABLE IF NOT EXISTS city_communities (
  id            bigserial   PRIMARY KEY,
  city_code     text        NOT NULL REFERENCES city_community_links(city_code),
  name          text        NOT NULL CHECK (length(btrim(name)) > 0),
  whatsapp_url  text,
  active        boolean     NOT NULL DEFAULT false,
  activated_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (city_code, name)
);
CREATE INDEX IF NOT EXISTS city_communities_city_idx ON city_communities(city_code);

-- 2) Field → community. field_id PK = one match maps to at most one community.
CREATE TABLE IF NOT EXISTS community_field_map (
  field_id      bigint      PRIMARY KEY,
  community_id  bigint      NOT NULL REFERENCES city_communities(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid        REFERENCES app_users(id)
);
CREATE INDEX IF NOT EXISTS community_field_map_community_idx ON community_field_map(community_id);

-- 3) Informational community attribution on the audit table. NULL on historical
-- rows; NOT part of any unique index or dedupe path.
ALTER TABLE community_posts
  ADD COLUMN IF NOT EXISTS community_id bigint REFERENCES city_communities(id);

-- RLS.
ALTER TABLE city_communities    ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_field_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS city_communities_auth_select ON city_communities;
CREATE POLICY city_communities_auth_select
  ON city_communities FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS community_field_map_auth_select ON community_field_map;
CREATE POLICY community_field_map_auth_select
  ON community_field_map FOR SELECT TO authenticated USING (true);
-- No INSERT/UPDATE/DELETE policy: writes are service-role only, from the
-- is_admin-gated /api/community/* routes.

-- ============================================================
-- Seed
-- ============================================================

-- 1) One community per existing city, carrying url/active/activated_at verbatim
-- and named the city's display_name. THIS is what makes the five active cities
-- a no-op: each resolves to its single community with the same URL.
-- Guarded on "the city has no community yet" (not ON CONFLICT name) so a re-run
-- after the Austin/Houston rename below does NOT recreate an "Austin"/"Houston"
-- base row — the whole migration is idempotent.
INSERT INTO city_communities (city_code, name, whatsapp_url, active, activated_at)
  SELECT l.city_code, l.display_name, l.whatsapp_url, l.active, l.activated_at
  FROM city_community_links l
  WHERE NOT EXISTS (
    SELECT 1 FROM city_communities c WHERE c.city_code = l.city_code
  );

-- 2) Split Austin and Houston. Their seeded row is renamed to the first
-- community; the second is added (inactive, no URL — neither city has a URL
-- today, so nothing is lost).
UPDATE city_communities SET name = 'North Austin', updated_at = now()
  WHERE city_code = 'ATX' AND name = 'Austin';
INSERT INTO city_communities (city_code, name, active) VALUES ('ATX', 'South Austin', false)
  ON CONFLICT (city_code, name) DO NOTHING;

UPDATE city_communities SET name = 'Katy', updated_at = now()
  WHERE city_code = 'HOU' AND name = 'Houston';
INSERT INTO city_communities (city_code, name, active) VALUES ('HOU', 'Pearland', false)
  ON CONFLICT (city_code, name) DO NOTHING;

-- 3) Field → community assignments (Austin + Houston only; the five active
-- cities are intentionally left unseeded — they resolve via the single-
-- community fallback in the poster). Houston field 1288 ("The Hattrick T.") is
-- deliberately left UNASSIGNED so it surfaces as field_unassigned, not silent.
INSERT INTO community_field_map (field_id, community_id)
  SELECT v.field_id, c.id
  FROM (VALUES (10),(17),(12),(25),(18),(925),(1024),(1486)) AS v(field_id)
  CROSS JOIN city_communities c
  WHERE c.city_code = 'ATX' AND c.name = 'North Austin'
ON CONFLICT (field_id) DO NOTHING;

INSERT INTO community_field_map (field_id, community_id)
  SELECT v.field_id, c.id
  FROM (VALUES (27),(1),(1453),(13),(859)) AS v(field_id)
  CROSS JOIN city_communities c
  WHERE c.city_code = 'ATX' AND c.name = 'South Austin'
ON CONFLICT (field_id) DO NOTHING;

INSERT INTO community_field_map (field_id, community_id)
  SELECT v.field_id, c.id
  FROM (VALUES (892),(1552),(1156),(1189)) AS v(field_id)
  CROSS JOIN city_communities c
  WHERE c.city_code = 'HOU' AND c.name = 'Katy'
ON CONFLICT (field_id) DO NOTHING;

INSERT INTO community_field_map (field_id, community_id)
  SELECT v.field_id, c.id
  FROM (VALUES (22),(32)) AS v(field_id)
  CROSS JOIN city_communities c
  WHERE c.city_code = 'HOU' AND c.name = 'Pearland'
ON CONFLICT (field_id) DO NOTHING;
