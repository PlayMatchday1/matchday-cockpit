-- 0267 — Player Data Room as a campaign list builder (2026-11-09).
--
-- WHAT THIS ADDS
--   1. dataroom_saved_lists — a saved list is its FILTERS, never its players, so it is always fresh.
--      Seeded with Miguel's three lists (Oct 14, "Player data room Examples").
--   2. dataroom_play — one row per played spot, built on growth_participation (the same base Churn's
--      0264 uses), with two flags: own_spot (user_type PLAYER) and managed (the person managed or
--      co-managed that match). "Played" = a match day before today, America/Chicago, as in 0264.
--   3. dataroom_contact — the accounts a campaign may contact: no fake players, no @matchday.com or
--      @playmatchday.com (staff and deleted-account tombstones), no "Deleted Account" scrubs, no
--      growth_internal_account rows. is_member = an ACTIVE paid_member_subscription row today (0235).
--   4. dataroom_played_list / dataroom_never_played / dataroom_pivot — the filtering and grouping run
--      in Postgres and return one jsonb value each, so nothing loads 173k plays into a function
--      (the old fact table took 12.9–17.7 s cold on 2026-11-08) and no 1,000-row page cap applies.
--
-- READS ONLY, apart from the seed rows. Nothing writes to the MatchDay API. Service role only.

BEGIN;

-- ── 1. saved lists ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.dataroom_saved_lists (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  tab               text        NOT NULL CHECK (tab IN ('played', 'never')),
  filters           jsonb       NOT NULL,
  created_by_email  text        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  removed_at        timestamptz,
  removed_by_email  text
);
ALTER TABLE public.dataroom_saved_lists ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dataroom_saved_lists FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.dataroom_saved_lists TO service_role;

-- Field ids: 1486 LBJ Early College High School (ATX), 958 PRUMC (ATL), 1387 Lowell H. Strike Middle
-- School (DFW). Lowell's retired duplicate 1948 is NOT stored: the app folds a hidden field into the
-- live field of the same fin_venue (both are venue 54) when the list runs.
INSERT INTO public.dataroom_saved_lists (name, tab, filters, created_by_email) VALUES
  ('High frequency at LBJ', 'played',
   '{"city":"ATX","fieldIds":[1486],"period":{"quick":"last4"},"type":"all","matches":{"min":5,"max":null},"within":null}',
   'rmancuso@playmatchday.com'),
  ('Members at PRUMC', 'played',
   '{"city":"ATL","fieldIds":[958],"period":{"quick":"last3"},"type":"members","matches":{"min":1,"max":null},"within":null}',
   'rmancuso@playmatchday.com'),
  ('Lowell non-members', 'played',
   '{"city":"DFW","fieldIds":[1387],"period":{"from":"2026-07","to":"2026-10"},"type":"non_members","matches":{"min":4,"max":null},"within":30}',
   'rmancuso@playmatchday.com');

-- ── 2. played spots ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.dataroom_play WITH (security_invoker = true) AS
SELECT
  g.player_api_id,
  g.user_id                AS person_id,      -- growth_person_link applied: a deleted account's plays belong to its live person
  g.account_id,
  g.match_api_id,
  g.match_date::date       AS match_date,     -- wall-clock day of the match (start_date is local time)
  g.city_identifier,
  g.field_id,
  (p.user_type = 'PLAYER') AS own_spot,
  COALESCE(g.user_id IN (COALESCE(l1.person_id, m.manager_id), COALESCE(l2.person_id, m.second_manager_id)), false) AS managed
FROM public.growth_participation g
JOIN public.mdapi_match_players p ON p.api_id = g.player_api_id
JOIN public.mdapi_matches m       ON m.api_id = g.match_api_id
LEFT JOIN public.growth_person_link l1 ON l1.account_id = m.manager_id
LEFT JOIN public.growth_person_link l2 ON l2.account_id = m.second_manager_id
WHERE g.match_date < to_char((now() AT TIME ZONE 'America/Chicago')::date, 'YYYY-MM-DD');

REVOKE ALL ON public.dataroom_play FROM anon, authenticated;
GRANT SELECT ON public.dataroom_play TO service_role;

-- ── 3. contactable accounts ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.dataroom_contact WITH (security_invoker = true) AS
SELECT
  u.id,
  NULLIF(btrim(u.first_name), '')   AS first_name,
  NULLIF(btrim(u.last_name), '')    AS last_name,
  NULLIF(btrim(u.email), '')        AS email,
  NULLIF(btrim(u.phone_number), '') AS phone,
  u.preferable_city_normalized      AS city,
  u.completed_sign_up_at,
  EXISTS (SELECT 1 FROM public.paid_member_subscription s
           WHERE s.user_id = u.id AND upper(s.status) = 'ACTIVE') AS is_member
FROM public.mdapi_users u
WHERE NOT COALESCE(u.is_fake_player, false)
  AND lower(btrim(COALESCE(u.email, ''))) !~ '@(play)?matchday\.com$'
  AND NOT (btrim(COALESCE(u.first_name, '')) = 'Deleted' AND btrim(COALESCE(u.last_name, '')) = 'Account')
  AND NOT EXISTS (SELECT 1 FROM public.growth_internal_account i WHERE i.user_id = u.id);

REVOKE ALL ON public.dataroom_contact FROM anon, authenticated;
GRANT SELECT ON public.dataroom_contact TO service_role;

-- ── 4a. the Played list ────────────────────────────────────────────────────────────────────────
-- Matches = distinct matches in [p_from, p_to] played in the player's OWN spot, not managed, at the
-- given fields (or city). last_played runs from p_from to yesterday at the same fields, so "last played
-- within N days" can see past p_to. p_within N keeps last_played >= today − N.
CREATE OR REPLACE FUNCTION public.dataroom_played_list(
  p_from date, p_to date, p_city text, p_field_ids integer[],
  p_member text, p_min integer, p_max integer, p_within integer)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public
SET statement_timeout = '30s'
AS $$
  WITH s AS (
    SELECT d.person_id, d.match_api_id, d.match_date, d.city_identifier
      FROM public.dataroom_play d
     WHERE d.own_spot AND NOT d.managed
       AND d.match_date >= COALESCE(p_from, DATE '2000-01-01')
       AND (p_city IS NULL OR d.city_identifier = p_city)
       AND (p_field_ids IS NULL OR d.field_id = ANY (p_field_ids))
  ), a AS (
    SELECT person_id,
           count(DISTINCT match_api_id) FILTER (WHERE p_to IS NULL OR match_date <= p_to) AS matches,
           max(match_date) AS last_played,
           mode() WITHIN GROUP (ORDER BY city_identifier) FILTER (WHERE p_to IS NULL OR match_date <= p_to) AS play_city
      FROM s GROUP BY person_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', c.id, 'first', c.first_name, 'last', c.last_name, 'email', c.email, 'phone', c.phone,
           'home', c.city, 'member', c.is_member, 'matches', a.matches, 'lastPlayed', a.last_played,
           'city', a.play_city) ORDER BY a.person_id), '[]'::jsonb)
    FROM a JOIN public.dataroom_contact c ON c.id = a.person_id
   WHERE a.matches >= GREATEST(COALESCE(p_min, 1), 1)
     AND (p_max IS NULL OR a.matches <= p_max)
     AND (p_within IS NULL OR a.last_played >= (now() AT TIME ZONE 'America/Chicago')::date - p_within)
     AND (COALESCE(p_member, 'all') = 'all' OR (p_member = 'members') = c.is_member);
$$;

-- ── 4b. the Never played list ──────────────────────────────────────────────────────────────────
-- Completed sign-up in [p_from, p_to) (the app passes Chicago month starts), declared city, and no
-- played own spot ever (a deleted account's plays count for its live person).
CREATE OR REPLACE FUNCTION public.dataroom_never_played(p_from timestamptz, p_to timestamptz, p_city text)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public
SET statement_timeout = '30s'
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', c.id, 'first', c.first_name, 'last', c.last_name, 'email', c.email, 'phone', c.phone,
           'home', c.city, 'signedUp', c.completed_sign_up_at) ORDER BY c.completed_sign_up_at, c.id), '[]'::jsonb)
    FROM public.dataroom_contact c
   WHERE c.completed_sign_up_at >= p_from AND c.completed_sign_up_at < p_to
     AND (p_city IS NULL OR c.city = p_city)
     AND NOT EXISTS (SELECT 1 FROM public.dataroom_play d WHERE d.person_id = c.id AND d.own_spot);
$$;

-- ── 4c. the pivot ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.dataroom_dim(p_dim text, p_city text, p_field bigint, p_day date, p_cohort text)
RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT CASE p_dim
    WHEN 'City'         THEN COALESCE(p_city, '?')
    WHEN 'Field'        THEN COALESCE(p_field::text, '?')
    WHEN 'Month'        THEN to_char(p_day, 'YYYY-MM')
    WHEN 'Year'         THEN to_char(p_day, 'YYYY')
    WHEN 'Cohort month' THEN COALESCE(p_cohort, '?')
    WHEN 'Cohort year'  THEN COALESCE(left(p_cohort, 4), '?')
    ELSE '' END
$$;

-- Players = distinct contactable people with an own, non-managed spot (the same people the Played tab
-- lists, so a clicked cell opens a list of that size). Spots = every played spot booked, guests and
-- additional spots included. One GROUPING SETS pass gives cells, row totals, column totals and the
-- grand total, each a true distinct count. New players = Players counted only in the month of their
-- first match (growth_player_profile.first_match_month), as the old pivot's "New players" was. g = GROUPING(r1, r2, c): 0 cell, 1 row total, 6 column
-- total, 7 grand total. p_field_map folds a hidden field id into its live field ({"1948": 1387}).
CREATE OR REPLACE FUNCTION public.dataroom_pivot(
  p_from date, p_to date, p_city text, p_field_ids integer[], p_field_map jsonb,
  p_r1 text, p_r2 text, p_c text)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public
SET statement_timeout = '30s'
AS $$
  WITH b AS (
    SELECT d.person_id,
           (d.own_spot AND NOT d.managed AND c.id IS NOT NULL) AS counts_player,
           d.city_identifier AS city,
           COALESCE((p_field_map ->> d.field_id::text)::bigint, d.field_id) AS fid,
           d.match_date,
           pr.first_match_month AS cohort
      FROM public.dataroom_play d
      LEFT JOIN public.dataroom_contact c       ON c.id = d.person_id
      LEFT JOIN public.growth_player_profile pr ON pr.user_id = d.person_id
     WHERE d.match_date BETWEEN p_from AND p_to
       AND (p_city IS NULL OR d.city_identifier = p_city)
       AND (p_field_ids IS NULL OR d.field_id = ANY (p_field_ids))
  ), k AS (
    SELECT person_id, counts_player,
           (counts_player AND cohort = to_char(match_date, 'YYYY-MM')) AS is_new,
           public.dataroom_dim(p_r1, city, fid, match_date, cohort) AS r1,
           public.dataroom_dim(p_r2, city, fid, match_date, cohort) AS r2,
           public.dataroom_dim(p_c,  city, fid, match_date, cohort) AS c
      FROM b
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('r1', r1, 'r2', r2, 'c', c, 'g', g, 'players', players, 'new', new_players, 'spots', spots)), '[]'::jsonb)
    FROM (
      SELECT r1, r2, c, GROUPING(r1, r2, c) AS g,
             count(DISTINCT person_id) FILTER (WHERE counts_player) AS players,
             count(DISTINCT person_id) FILTER (WHERE is_new) AS new_players,
             count(*) AS spots
        FROM k
       GROUP BY GROUPING SETS ((r1, r2, c), (r1, r2), (c), ())
    ) s;
$$;

REVOKE EXECUTE ON FUNCTION public.dataroom_played_list(date, date, text, integer[], text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.dataroom_never_played(timestamptz, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.dataroom_pivot(date, date, text, integer[], jsonb, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.dataroom_played_list(date, date, text, integer[], text, integer, integer, integer) TO service_role;
GRANT  EXECUTE ON FUNCTION public.dataroom_never_played(timestamptz, timestamptz, text) TO service_role;
GRANT  EXECUTE ON FUNCTION public.dataroom_pivot(date, date, text, integer[], jsonb, text, text, text) TO service_role;

COMMIT;

-- READ-BACK (reads only). Expect saved_lists = 3, active_members near 262 (ACTIVE paying rows on
-- 2026-11-09), and a size for the Lowell test case (1387 + its retired duplicate 1948, Jul–Oct 2026,
-- 4+ matches, non-members, last played within 30 days).
SELECT
  (SELECT count(*) FROM public.dataroom_saved_lists WHERE removed_at IS NULL) AS saved_lists,
  (SELECT count(*) FROM public.dataroom_contact)                               AS contactable_accounts,
  (SELECT count(*) FROM public.dataroom_contact WHERE is_member)               AS active_members,
  jsonb_array_length(public.dataroom_played_list(DATE '2026-07-01', DATE '2026-10-31', 'DFW', ARRAY[1387, 1948], 'non_members', 4, NULL, 30)) AS lowell_test_case;
