-- ============================================================
-- DOCUMENTATION ARTIFACT — SUPERSEDED by the .mjs harness
-- ============================================================
-- This SQL file was the first attempt at a diff harness for
-- PR-E. It joins the OLD path through the DB alias table
-- (fin_venue_aliases) only — it cannot replicate the TS-only
-- CROSS_VENUE_ALIASES + INTERNAL_PREFIX_RULES from
-- src/lib/venueNormalization.ts, so the "pre" side under-
-- attributes badly. Nearly every venue shows $0 DPP because
-- the bare alias table doesn't reproduce production's name
-- canonicalization pipeline.
--
-- The actual verification tool is
-- scripts/diff-finance-pre-post-field-id.mjs, which calls into
-- production `buildRankingRows` via `npx tsx` on both branches
-- (main and feat/venue-field-id-migration-pre) against an
-- immutable Supabase snapshot. That comparison is faithful to
-- production behavior on both sides.
--
-- This file is kept in the repo for historical context only.
-- Do not use it for the PR-E verification gate.
-- ============================================================
-- (Original header below — describes the SQL approach.)
-- ============================================================
-- PR-E diff harness — name-vs-field_id attribution diff for April 2026
-- ============================================================
-- Run from Supabase SQL Editor. No client setup, no env, no scripts.
-- The whole diff is one query against live data.
--
-- Compares two attribution paths for April 2026 mdapi match-player
-- rows against fin_venues:
--   OLD  (production today):
--          field_title → fin_venue_aliases.alias → canonical_venue
--          → fin_venues.venue_name → fin_venues.id
--   NEW  (post-PR-E):
--          field_id → fin_venue_fields.mdapi_field_id
--          → fin_venue_fields.fin_venue_id → fin_venues.id
--
-- ────────────────────────────────────────────────────────────
-- Caveats — acknowledged on approval
-- ────────────────────────────────────────────────────────────
--   * The OLD side here covers ONLY the DB alias table
--     (fin_venue_aliases). Production's "pre" path also runs
--     CROSS_VENUE_ALIASES + INTERNAL_PREFIX_RULES in
--     src/lib/venueNormalization.ts plus a 10-step regex
--     pipeline. This SQL UNDER-attributes relative to
--     production: any field_title that production resolved via
--     code-only rules but has no fin_venue_aliases row will
--     show NULL on the OLD side. Those rows correctly land on a
--     fin_venues row under NEW via fin_venue_fields. The diff
--     surfaces them as a delta in the NEW direction. That's
--     the migration's win surface — anything going to the
--     WRONG venue under NEW is a regression to flag.
--   * No day-of-week swap (the TS-side resolveVenueForMatch
--     that splits ATH Katy Sunday onto its own fin_venues row).
--     Both paths get base-venue attribution. The swap is
--     applied identically downstream in production so it would
--     not produce a delta anyway.
--   * No fin_revenue (Private Rental). PR-E doesn't touch the
--     fin_revenue.venue → fin_venue_aliases → fin_venues.id
--     resolver, so private-rental attribution is identical on
--     both sides and would always be a $0 delta.
--   * No cost line. canonicalVenueCost is id-keyed pre and post
--     so per-venue cost is unchanged. Delta is purely on the
--     revenue + member-allocation side.
--
-- ────────────────────────────────────────────────────────────
-- What to look at in the output
-- ────────────────────────────────────────────────────────────
--   Per-venue rows sorted by ABS(delta) DESC. Then per-city
--   subtotal rows. Each venue row has:
--     pre_dpp, post_dpp           — DPP $ attributed under each path
--     pre_member_rev, post_member_rev — member-rev allocation under each path
--     pre_total, post_total       — sum of the above
--     delta                       — post_total − pre_total
--     is_expected_zero_venue      — flag: Helix Park / Crossbar Rowlett /
--                                   Hattrick T. — three venues that had
--                                   no fin_venues row at the time of
--                                   PR-A so the OLD path had nowhere
--                                   to land their attribution. April
--                                   pre/post should both be ~$0 since
--                                   none of those venues were active in
--                                   April (retired Feb, launched May,
--                                   launched May). Non-zero delta on
--                                   any of these is a flag.
--
--   Positive deltas are EXPECTED for field_titles that the OLD
--   path missed entirely (no fin_venue_aliases row, no direct
--   venue_name match). Production's "pre" already attributed
--   them via TS-only rules — so a positive SQL delta here means
--   "field_id correctly resolves a row that bare-aliases would
--   have missed, but production didn't actually miss it." Net
--   effect on production: zero.
--
--   NEGATIVE deltas, or deltas attributing to the WRONG venue,
--   are the regression signal. Specifically:
--     - A venue whose pre_dpp drops to post_dpp = $0 means
--       field_id is missing the link (fin_venue_fields gap).
--     - A venue whose post_dpp lands on a venue that doesn't
--       match the field_title's text identity means field_id
--       maps to the wrong fin_venues row (bad seed).
-- ============================================================

WITH params AS (
  SELECT
    'Apr 2026'::text AS month_key,
    '2026-04-01 00:00:00+00'::timestamptz AS month_start,
    '2026-05-01 00:00:00+00'::timestamptz AS month_end
),

-- 1. April 2026 match-player rows that contribute to ranking
--    revenue or member-spot allocation. Filters mirror the
--    intersection of venuePartnerRevenueFor and
--    buildMdapiMemberSpotIndex in src/lib/financeStats.ts.
april_plays AS (
  SELECT
    m.api_id AS match_api_id,
    m.field_id,
    m.field_title,
    m.city_identifier,
    p.user_email,
    p.amount,
    CASE
      WHEN p.paid_status = 'FREE' THEN 'MEMBER'
      WHEN p.paid_status = 'PAID' AND p.promocode_id IS NULL THEN 'DAILY PAID'
      WHEN p.paid_status = 'PAID' AND p.promocode_id IS NOT NULL THEN 'PROMOCODE'
      ELSE NULL
    END AS payment_type
  FROM mdapi_matches m
  JOIN mdapi_match_players p ON p.match_api_id = m.api_id
  CROSS JOIN params
  WHERE m.start_date >= params.month_start
    AND m.start_date <  params.month_end
    AND m.is_cancelled = false
    AND COALESCE(p.is_absent, false) = false
    AND COALESCE(p.user_is_fake_player, false) = false
    AND p.paid_status IN ('FREE', 'PAID')
    AND p.canceled_at IS NULL
    AND (p.user_email IS NULL OR p.user_email NOT ILIKE '%@matchday.com')
),

-- 2. OLD attribution: field_title → fin_venue_aliases (alias →
--    canonical_venue) → fin_venues.venue_name → fin_venues.id.
--    If no alias matches, fall back to the field_title itself
--    matching a venue_name directly (covers the "no aliasing
--    needed" common case).
old_attr AS (
  SELECT
    pl.match_api_id,
    pl.field_id,
    pl.field_title,
    pl.amount,
    pl.payment_type,
    v.id   AS fin_venue_id,
    v.city AS city
  FROM april_plays pl
  LEFT JOIN fin_venue_aliases a ON a.alias = pl.field_title
  LEFT JOIN fin_venues v
    ON v.venue_name = COALESCE(a.canonical_venue, pl.field_title)
),

-- 3. NEW attribution: field_id → fin_venue_fields → fin_venues.id.
new_attr AS (
  SELECT
    pl.match_api_id,
    pl.field_id,
    pl.field_title,
    pl.amount,
    pl.payment_type,
    vf.fin_venue_id AS fin_venue_id,
    v.city          AS city
  FROM april_plays pl
  LEFT JOIN fin_venue_fields vf ON vf.mdapi_field_id = pl.field_id
  LEFT JOIN fin_venues v ON v.id = vf.fin_venue_id
),

-- 4. Per-venue DPP $ + MEMBER spot counts under each path.
--    Aggregations exclude unattributed rows (fin_venue_id IS NULL).
old_per_venue AS (
  SELECT
    fin_venue_id,
    COALESCE(SUM(amount) FILTER (WHERE payment_type = 'DAILY PAID'), 0) / 100.0
      AS dpp_revenue,
    COALESCE(COUNT(*) FILTER (WHERE payment_type = 'MEMBER'), 0)::int
      AS member_spots
  FROM old_attr
  WHERE fin_venue_id IS NOT NULL
  GROUP BY fin_venue_id
),
new_per_venue AS (
  SELECT
    fin_venue_id,
    COALESCE(SUM(amount) FILTER (WHERE payment_type = 'DAILY PAID'), 0) / 100.0
      AS dpp_revenue,
    COALESCE(COUNT(*) FILTER (WHERE payment_type = 'MEMBER'), 0)::int
      AS member_spots
  FROM new_attr
  WHERE fin_venue_id IS NOT NULL
  GROUP BY fin_venue_id
),

-- 5. Per-city total MEMBER spots — denominator for the
--    venueAllocatedMemberRevenueFor algebra.
old_per_city AS (
  SELECT v.city, SUM(o.member_spots)::int AS city_total_member_spots
  FROM old_per_venue o
  JOIN fin_venues v ON v.id = o.fin_venue_id
  GROUP BY v.city
),
new_per_city AS (
  SELECT v.city, SUM(o.member_spots)::int AS city_total_member_spots
  FROM new_per_venue o
  JOIN fin_venues v ON v.id = o.fin_venue_id
  GROUP BY v.city
),

-- 6. City membership revenue (same on both sides). Source:
--    fin_revenue type='Membership' for the target month.
city_membership AS (
  SELECT city, COALESCE(SUM(net), 0) AS membership_rev
  FROM fin_revenue, params
  WHERE month = params.month_key
    AND type = 'Membership'
  GROUP BY city
),

-- 7. Per-venue member-rev allocation under each path:
--    (venue_member_spots / city_total_member_spots) × city_membership_rev
old_member_rev AS (
  SELECT
    o.fin_venue_id,
    o.member_spots,
    CASE
      WHEN COALESCE(c.city_total_member_spots, 0) > 0
        THEN (o.member_spots::numeric / c.city_total_member_spots)
             * COALESCE(cm.membership_rev, 0)
      ELSE 0
    END AS member_rev
  FROM old_per_venue o
  JOIN fin_venues v ON v.id = o.fin_venue_id
  LEFT JOIN old_per_city c ON c.city = v.city
  LEFT JOIN city_membership cm ON cm.city = v.city
),
new_member_rev AS (
  SELECT
    n.fin_venue_id,
    n.member_spots,
    CASE
      WHEN COALESCE(c.city_total_member_spots, 0) > 0
        THEN (n.member_spots::numeric / c.city_total_member_spots)
             * COALESCE(cm.membership_rev, 0)
      ELSE 0
    END AS member_rev
  FROM new_per_venue n
  JOIN fin_venues v ON v.id = n.fin_venue_id
  LEFT JOIN new_per_city c ON c.city = v.city
  LEFT JOIN city_membership cm ON cm.city = v.city
),

-- 8. Per-venue join. Includes every fin_venues row so that a
--    venue that exists in fin_venues but has no April activity
--    on either side surfaces explicitly as $0/$0.
expected_zero AS (
  SELECT * FROM (VALUES
    ('Helix Park',       'Houston'),
    ('Crossbar Rowlett', 'Dallas'),
    ('Hattrick T.',      'Houston')
  ) AS x(venue_name, city)
),
per_venue AS (
  SELECT
    v.id            AS fin_venue_id,
    v.city,
    v.venue_name,
    COALESCE(o.dpp_revenue, 0)::numeric  AS pre_dpp_revenue,
    COALESCE(n.dpp_revenue, 0)::numeric  AS post_dpp_revenue,
    COALESCE(o.member_spots, 0)          AS pre_member_spots,
    COALESCE(n.member_spots, 0)          AS post_member_spots,
    COALESCE(omr.member_rev, 0)::numeric AS pre_member_rev,
    COALESCE(nmr.member_rev, 0)::numeric AS post_member_rev,
    EXISTS (
      SELECT 1 FROM expected_zero z
      WHERE z.venue_name = v.venue_name AND z.city = v.city
    ) AS is_expected_zero_venue
  FROM fin_venues v
  LEFT JOIN old_per_venue   o   ON o.fin_venue_id   = v.id
  LEFT JOIN new_per_venue   n   ON n.fin_venue_id   = v.id
  LEFT JOIN old_member_rev  omr ON omr.fin_venue_id = v.id
  LEFT JOIN new_member_rev  nmr ON nmr.fin_venue_id = v.id
),

-- 9. Per-venue final rows. Drop venues with zero everything,
--    unless they're on the expected-zero watchlist (always emit
--    those so absence vs presence is explicit).
venue_rows AS (
  SELECT
    1 AS kind_order,
    'venue'::text AS row_kind,
    city,
    venue_name,
    is_expected_zero_venue,
    ROUND(pre_dpp_revenue, 2)     AS pre_dpp,
    ROUND(post_dpp_revenue, 2)    AS post_dpp,
    ROUND(pre_member_rev, 2)      AS pre_member_rev,
    ROUND(post_member_rev, 2)     AS post_member_rev,
    pre_member_spots,
    post_member_spots,
    ROUND(pre_dpp_revenue  + pre_member_rev,  2) AS pre_total,
    ROUND(post_dpp_revenue + post_member_rev, 2) AS post_total,
    ROUND(
      (post_dpp_revenue + post_member_rev)
      - (pre_dpp_revenue + pre_member_rev), 2
    ) AS delta
  FROM per_venue
  WHERE pre_dpp_revenue  > 0
     OR post_dpp_revenue > 0
     OR pre_member_rev   > 0
     OR post_member_rev  > 0
     OR is_expected_zero_venue
),

-- 10. Per-city subtotals. Reuses per_venue so the sums line up
--     with what's shown above.
city_rows AS (
  SELECT
    2 AS kind_order,
    'city'::text AS row_kind,
    city,
    NULL::text   AS venue_name,
    false        AS is_expected_zero_venue,
    ROUND(SUM(pre_dpp_revenue), 2)  AS pre_dpp,
    ROUND(SUM(post_dpp_revenue), 2) AS post_dpp,
    ROUND(SUM(pre_member_rev), 2)   AS pre_member_rev,
    ROUND(SUM(post_member_rev), 2)  AS post_member_rev,
    SUM(pre_member_spots)::int      AS pre_member_spots,
    SUM(post_member_spots)::int     AS post_member_spots,
    ROUND(SUM(pre_dpp_revenue + pre_member_rev), 2)   AS pre_total,
    ROUND(SUM(post_dpp_revenue + post_member_rev), 2) AS post_total,
    ROUND(SUM(
      (post_dpp_revenue + post_member_rev)
      - (pre_dpp_revenue + pre_member_rev)
    ), 2) AS delta
  FROM per_venue
  GROUP BY city
)

SELECT *
FROM (
  SELECT * FROM venue_rows
  UNION ALL
  SELECT * FROM city_rows
) all_rows
ORDER BY
  kind_order,
  ABS(COALESCE(delta, 0)) DESC NULLS LAST,
  city,
  venue_name;
