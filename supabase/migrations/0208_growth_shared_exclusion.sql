-- 0208 — ONE definition of who counts, for every Player Lifecycle metric (Ryan, 2026-10-05).
--
-- Until now each growth view decided this on its own: growth_registration and
-- growth_acquisition_daily checked mdapi_users.is_fake_player, growth_participation checked the
-- roster row's user_is_fake_player, and /api/lifecycle/behavior-weekly checked both again in Node.
-- Nothing excluded staff or @matchday.com accounts, and a player who deleted their account and
-- signed up again counted as two people.
--
-- ── THE RULE ─────────────────────────────────────────────────────────────────────────────────
-- EXCLUDED (growth_internal_account), from every player metric:
--   * is_fake_player
--   * every @matchday.com address — 10 of the 210 are not flagged fake (numbered, Oct 2025, Atlanta)
--   * every @playmatchday.com address EXCEPT a deleted-account tombstone — the 6 staff accounts
-- KEPT: deleted accounts. MatchDay scrubs a deleted player in place to
--   del_<40 hex>@playmatchday.com, "Deleted" "Account", phone null (docs/matchday-api-facts.md,
--   "A DELETED PLAYER IS SCRUBBED IN PLACE"). Those 2,148 are real people who played and paid —
--   2,884 PAID spots, $4,485.93 — so the domain alone is not the test; the del_ pattern is.
--
-- ONE BOOKING-LEVEL CHECK STAYS, ON PURPOSE. growth_participation still drops roster rows carrying
-- user_is_fake_player. That is a fact about the BOOKING, not the account: five accounts that are
-- not fake today (and not staff) carry 3,012 roster rows booked as fake roster fills. Dropping the
-- check would put those 3,012 fake spots into every play metric. It lives in this one view, which
-- every play metric reads, so it is still one rule in one place.
--
-- RE-REGISTRATIONS ARE ONE PERSON (growth_person_link). A deleted account links to a live account
-- when a roster row booked before the deletion still carries an email equal to the live account's,
-- or a phone (digits, US country code dropped) that exactly one live account holds. Email wins over
-- phone, then the lowest id. Measured before this migration: 103 deleted accounts → 95 people.
-- The person id is the LIVE account's id. Nothing in mdapi_users is changed or merged.
--   * play (growth_participation.user_id) is the person, so first match = earliest across both
--     accounts, and the newer account is not a new player if the deleted one already played;
--   * registration (growth_account.status) counts the person once, at their EARLIEST signup —
--     the other account reads 're_registration'.
--
-- Apply via Supabase Dashboard → SQL Editor. One transaction; the refresh runs after it.

BEGIN;

-- ── 1. THE EXCLUDED ACCOUNTS ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.growth_internal_account AS
SELECT
  u.id AS user_id,
  CASE
    WHEN COALESCE(u.is_fake_player, false)          THEN 'fake_player'
    WHEN lower(btrim(u.email)) LIKE '%@matchday.com' THEN 'matchday_com'
    ELSE 'playmatchday_staff'
  END                    AS reason,
  u.completed_sign_up_at AS completed_sign_up_at
FROM public.mdapi_users u
WHERE COALESCE(u.is_fake_player, false)
   OR lower(btrim(u.email)) LIKE '%@matchday.com'
   OR (lower(btrim(u.email)) LIKE '%@playmatchday.com'
       AND lower(btrim(u.email)) !~ '^del_[0-9a-f]{40}@playmatchday\.com$');

-- ── 2. RE-REGISTRATIONS: deleted account → the live account of the same person ───────────────
-- Materialized: it scans every roster row of every deleted account, and growth_participation
-- reads it on every query. Refreshed FIRST by refresh_growth_views().
CREATE MATERIALIZED VIEW public.growth_person_link AS
WITH tomb AS (
  SELECT u.id
  FROM public.mdapi_users u
  WHERE lower(btrim(u.email)) ~ '^del_[0-9a-f]{40}@playmatchday\.com$'
),
snap AS (
  -- What the booking captured before the account was scrubbed.
  SELECT DISTINCT
    p.user_id                                AS tomb_id,
    NULLIF(lower(btrim(p.user_email)), '')   AS email,
    CASE WHEN length(d.digits) = 11 AND left(d.digits, 1) = '1' THEN substr(d.digits, 2) ELSE d.digits END AS phone
  FROM public.mdapi_match_players p
  JOIN tomb t ON t.id = p.user_id
  CROSS JOIN LATERAL (SELECT regexp_replace(COALESCE(p.user_phone_number, ''), '\D', '', 'g') AS digits) d
),
live AS (
  SELECT
    u.id,
    lower(btrim(u.email)) AS email,
    CASE WHEN length(d.digits) = 11 AND left(d.digits, 1) = '1' THEN substr(d.digits, 2) ELSE d.digits END AS phone
  FROM public.mdapi_users u
  CROSS JOIN LATERAL (SELECT regexp_replace(COALESCE(u.phone_number, ''), '\D', '', 'g') AS digits) d
  WHERE NOT EXISTS (SELECT 1 FROM tomb t WHERE t.id = u.id)
    AND NOT EXISTS (SELECT 1 FROM public.growth_internal_account i WHERE i.user_id = u.id)
),
unique_phone AS (
  -- A phone two live accounts share (a family phone) identifies neither.
  SELECT phone, min(id) AS id
  FROM live
  WHERE length(phone) >= 10
  GROUP BY phone
  HAVING count(*) = 1
),
cand AS (
  SELECT s.tomb_id, l.id AS person_id, 1 AS rank, 'email'::text AS via
  FROM snap s
  JOIN live l ON l.email = s.email
  WHERE s.email IS NOT NULL
    AND s.email !~ '^del_[0-9a-f]{40}@playmatchday\.com$'
  UNION ALL
  SELECT s.tomb_id, up.id, 2, 'phone'::text
  FROM snap s
  JOIN unique_phone up ON up.phone = s.phone
  WHERE length(s.phone) >= 10
)
SELECT DISTINCT ON (tomb_id)
  tomb_id   AS account_id,
  person_id,
  via
FROM cand
ORDER BY tomb_id, rank, person_id;

CREATE UNIQUE INDEX growth_person_link_pk     ON public.growth_person_link (account_id);
CREATE INDEX        growth_person_link_person ON public.growth_person_link (person_id);

-- ── 3. EVERY ACCOUNT, CLASSIFIED ─────────────────────────────────────────────────────────────
-- status: 'counted' (the person's one registration) · 'internal' · 're_registration'.
CREATE OR REPLACE VIEW public.growth_account AS
WITH a AS (
  SELECT
    u.id                         AS account_id,
    COALESCE(l.person_id, u.id)  AS person_id,
    u.created_at,
    u.completed_sign_up_at,
    u.preferable_city_name       AS declared_city_raw,
    i.reason                     AS internal_reason
  FROM public.mdapi_users u
  LEFT JOIN public.growth_person_link      l ON l.account_id = u.id
  LEFT JOIN public.growth_internal_account i ON i.user_id    = u.id
)
SELECT
  a.account_id,
  a.person_id,
  a.created_at,
  a.completed_sign_up_at,
  a.declared_city_raw,
  a.internal_reason,
  CASE
    WHEN a.internal_reason IS NOT NULL THEN 'internal'
    WHEN row_number() OVER (
           PARTITION BY a.person_id, (a.internal_reason IS NULL)
           ORDER BY (a.completed_sign_up_at IS NULL), a.completed_sign_up_at, a.created_at, a.account_id
         ) = 1 THEN 'counted'
    ELSE 're_registration'
  END AS status
FROM a;

-- ── 4. PLAY: the person, never an excluded account ──────────────────────────────────────────
-- Same columns in the same order as 0154, so the materialized views built on it stay valid;
-- match_api_id and account_id are appended. user_id is now the PERSON.
CREATE OR REPLACE VIEW public.growth_participation AS
SELECT
  p.api_id                                                AS player_api_id,
  COALESCE(l.person_id, p.user_id)                        AS user_id,
  to_char(m.start_date AT TIME ZONE 'UTC', 'YYYY-MM-DD')  AS match_date,
  to_char(m.start_date AT TIME ZONE 'UTC', 'YYYY-MM')     AS match_month,
  m.city_identifier                                       AS city_identifier,
  m.field_title                                           AS field_title,
  m.field_id                                              AS field_id,
  COALESCE(p.amount, 0)                                   AS total_amount,
  COALESCE(p.amount, 0)                                   AS amount_cents,
  p.match_api_id                                          AS match_api_id,
  p.user_id                                               AS account_id
FROM public.mdapi_match_players p
JOIN public.mdapi_matches m ON m.api_id = p.match_api_id
LEFT JOIN public.growth_person_link l ON l.account_id = p.user_id
WHERE p.deleted_at IS NULL
  AND COALESCE(p.user_is_fake_player, false) = false   -- the BOOKING was a fake fill; see header
  AND p.paid_status IS DISTINCT FROM 'WAITING'
  AND p.canceled_at IS NULL
  AND p.user_id IS NOT NULL
  AND m.deleted_at IS NULL
  AND COALESCE(m.is_cancelled, false) = false
  AND m.start_date IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.growth_internal_account i WHERE i.user_id = p.user_id);

-- ── 5. REGISTRATION: one row per person, at their earliest signup ───────────────────────────
-- is_fake_player is gone (always false now; nothing reads it). completed_sign_up_at and
-- account_id are added, so the weekly and daily grains can read registrations from here.
DROP MATERIALIZED VIEW IF EXISTS public.growth_registration;
CREATE MATERIALIZED VIEW public.growth_registration AS
SELECT
  a.person_id                                            AS user_id,
  (a.completed_sign_up_at IS NOT NULL)                   AS completed,
  CASE WHEN a.completed_sign_up_at IS NOT NULL
       THEN to_char(a.completed_sign_up_at::timestamptz AT TIME ZONE 'America/Chicago', 'YYYY-MM') END AS signup_month,
  a.declared_city_raw                                    AS declared_city_raw,
  COALESCE(pp.matches_played, 0)                         AS lifetime_matches,
  a.completed_sign_up_at                                 AS completed_sign_up_at,
  a.account_id                                           AS account_id
FROM public.growth_account a
LEFT JOIN public.growth_player_profile pp ON pp.user_id = a.person_id
WHERE a.status = 'counted';

CREATE UNIQUE INDEX growth_registration_pk        ON public.growth_registration (user_id);
CREATE INDEX        growth_registration_signup    ON public.growth_registration (signup_month);
CREATE INDEX        growth_registration_signup_at ON public.growth_registration (completed_sign_up_at);

-- ── 6. ACQUISITION BY DAY: same six columns as 0185, from the counted registrations ─────────
CREATE OR REPLACE VIEW public.growth_acquisition_daily AS
SELECT
  to_char(a.completed_sign_up_at::timestamptz AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD')
                                                              AS signup_date,
  a.declared_city_raw                                         AS declared_city_raw,
  count(*)                                                    AS registrations,
  count(*) FILTER (WHERE pp.first_match_date IS NOT NULL)      AS became_players,
  count(*) FILTER (
    WHERE pp.first_match_date IS NOT NULL
      AND pp.first_match_date::date
          <= (a.completed_sign_up_at::timestamptz AT TIME ZONE 'America/Chicago')::date + 7
  )                                                           AS played_within_7d,
  count(*) FILTER (
    WHERE pp.first_match_date IS NOT NULL
      AND pp.first_match_date::date
          <= (a.completed_sign_up_at::timestamptz AT TIME ZONE 'America/Chicago')::date + 30
  )                                                           AS played_within_30d
FROM public.growth_account a
LEFT JOIN public.growth_player_profile pp ON pp.user_id = a.person_id
WHERE a.status = 'counted'
  AND a.completed_sign_up_at IS NOT NULL
GROUP BY 1, 2;

-- ── 7. REFRESH ORDER: the link first, because participation reads it ────────────────────────
CREATE OR REPLACE FUNCTION public.refresh_growth_views()
  RETURNS void
  LANGUAGE plpgsql
  SET statement_timeout = '300s'
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW public.growth_person_link;
  REFRESH MATERIALIZED VIEW public.growth_player_profile;
  REFRESH MATERIALIZED VIEW public.growth_player_month;
  REFRESH MATERIALIZED VIEW public.growth_cohort_matrix;
  REFRESH MATERIALIZED VIEW public.growth_play_dims;
  REFRESH MATERIALIZED VIEW public.growth_registration;
  REFRESH MATERIALIZED VIEW public.growth_row_counts;
END $$;

-- ── 8. ACCESS: same posture as 0096 — service role only ─────────────────────────────────────
REVOKE ALL ON public.growth_internal_account  FROM anon, authenticated;
REVOKE ALL ON public.growth_person_link       FROM anon, authenticated;
REVOKE ALL ON public.growth_account           FROM anon, authenticated;
REVOKE ALL ON public.growth_participation     FROM anon, authenticated;
REVOKE ALL ON public.growth_registration      FROM anon, authenticated;
REVOKE ALL ON public.growth_acquisition_daily FROM anon, authenticated;
GRANT SELECT ON public.growth_internal_account  TO service_role;
GRANT SELECT ON public.growth_person_link       TO service_role;
GRANT SELECT ON public.growth_account           TO service_role;
GRANT SELECT ON public.growth_participation     TO service_role;
GRANT SELECT ON public.growth_registration      TO service_role;
GRANT SELECT ON public.growth_acquisition_daily TO service_role;
REVOKE EXECUTE ON FUNCTION public.refresh_growth_views() FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.refresh_growth_views() TO service_role;

COMMIT;

-- ── 9. REBUILD every materialized view on the new definition (takes up to a few minutes) ────
SELECT public.refresh_growth_views();

-- ── 10. VERDICT — each check that passes at zero has a positive control beside it ───────────
SELECT
  (SELECT count(*) FROM public.growth_internal_account)                                 AS internal_total,          -- expect 217
  (SELECT count(*) FROM public.growth_internal_account WHERE reason = 'fake_player')    AS internal_fake,           -- expect 201
  (SELECT count(*) FROM public.growth_internal_account WHERE reason = 'matchday_com')   AS internal_matchday_com,   -- expect 10
  (SELECT count(*) FROM public.growth_internal_account WHERE reason = 'playmatchday_staff') AS internal_staff,      -- expect 6
  (SELECT count(*) FROM public.growth_person_link)                                      AS links,                   -- expect about 103
  (SELECT count(DISTINCT person_id) FROM public.growth_person_link)                     AS linked_people,           -- expect about 95
  (SELECT count(*) FROM public.growth_account a JOIN public.mdapi_users u ON u.id = a.account_id
     WHERE a.status = 'counted' AND lower(btrim(u.email)) ~ '^del_[0-9a-f]{40}@playmatchday\.com$')
                                                                                        AS deleted_accounts_counted, -- CONTROL: about 2,000, NOT 0
  (SELECT count(*) FROM public.growth_participation gp
     JOIN public.growth_internal_account i ON i.user_id = gp.account_id)                AS internal_spots_in_play,  -- expect 0
  (SELECT count(*) FROM public.mdapi_match_players p
     JOIN public.growth_internal_account i ON i.user_id = p.user_id
     WHERE p.deleted_at IS NULL AND COALESCE(p.user_is_fake_player, false) = false)     AS internal_rows_in_roster, -- CONTROL: > 0, so the 0 above means something
  (SELECT count(*) FROM public.growth_registration)
    = (SELECT count(DISTINCT user_id) FROM public.growth_registration)                  AS one_registration_per_person, -- expect true
  (SELECT sum(registrations)  FROM public.growth_acquisition_daily
     WHERE signup_date BETWEEN '2026-09-01' AND '2026-09-30')                           AS sep_registrations,
  (SELECT sum(became_players) FROM public.growth_acquisition_daily
     WHERE signup_date BETWEEN '2026-09-01' AND '2026-09-30')                           AS sep_registrants_who_played,
  (SELECT count(*) FROM public.growth_player_profile WHERE first_match_month = '2026-09') AS sep_first_time_players;
