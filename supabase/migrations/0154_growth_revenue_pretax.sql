-- REVENUE IS PRE-TAX. growth_participation and growth_play_dims stop projecting the
-- tax-inclusive card charge.
--
-- ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
-- mdapi_match_players carries TWO money columns and we were summing the wrong one:
--
--   amount        the pre-tax price. Populated since 2023-04.
--   total_amount  the CARD CHARGE. Populated only since 2025-12, and equal to
--                 round((amount - credit_amount) * (1 + city sales tax rate)).
--
-- Measured on production 2026-08-28, median total_amount/amount over credit-free rows,
-- against the rates in the API's own cities table (stripeTaxRateValue):
--
--   ATX  13,065 rows  1.08250  ->  8.25%   published 8.25   agrees
--   HOU   6,750 rows  1.08250  ->  8.25%   published 8.25   agrees
--   SATX  6,440 rows  1.08222  ->  8.22%   published 8.25   agrees (cent rounding)
--   STL     681 rows  1.09667  ->  9.67%   published 9.68   agrees
--   ATL     679 rows  1.08875  ->  8.88%   published 8.90   agrees
--   DFW   1,038 rows           ->  8.25% aggregate          (rate not published to us)
--   OKC     577 rows           ->  8.65% aggregate          (rate not published to us)
--
-- No city disagrees. The sub-published hundredths are rounding: the rate is applied to
-- integer cents, so a $9.00 spot in San Antonio rounds 74.25c to 74c.
--
-- Two hypotheses this replaces, both killed by measurement rather than argument:
--   * "a processing fee" — it is not; a flat 2.9%+30c fits 0.8% of rows, the per-city
--     tax rate fits 93.1% and the residual is credit rows.
--   * "amount is per-spot, total_amount is the row total" — 0 of 39,145 rows have
--     total_amount as an integer multiple of amount, and a multi-spot purchase is
--     separate ADDITIONAL_SPOT ROWS (1,821 of them, each with its own amount), never a
--     quantity on one row.
--
-- The 1,905 rows where amount > total_amount are CREDITS: all 1,905 carry
-- credit_amount > 0, and (amount - credit_amount) * (1 + rate) reproduces the charge.
--
-- ── WHY total_amount SURVIVES AS AN ALIAS ────────────────────────────────────
-- Code deploys before a migration is applied — that is the normal order here. A reader
-- still on the old build selects `total_amount`, so the alias stays and now carries the
-- SAME PRE-TAX VALUE. That closes the deploy-order window: whichever lands first, nobody
-- reads the tax-inclusive figure again. It is deprecated and
-- scripts/revenue-pretax-test.ts asserts that no revenue path selects it.
--
-- NOT TOUCHED: fin_revenue. It is a Stripe LEDGER and it is tax-inclusive too — its DPP
-- gross clusters on $9.74 / $12.99 / $19.48, which are $9 / $12 / $18 x 1.0825, and
-- $95,508.95 of sales tax sits inside it all-time. Correcting a ledger means re-deriving
-- it, which is an accounting decision and not a projection change.

-- ── 1. the participation filter ──────────────────────────────────────────────
CREATE OR REPLACE VIEW public.growth_participation AS
SELECT
  p.api_id                                                AS player_api_id,
  p.user_id                                               AS user_id,
  to_char(m.start_date AT TIME ZONE 'UTC', 'YYYY-MM-DD')  AS match_date,
  to_char(m.start_date AT TIME ZONE 'UTC', 'YYYY-MM')     AS match_month,
  m.city_identifier                                       AS city_identifier,
  m.field_title                                           AS field_title,
  m.field_id                                              AS field_id,
  -- REVENUE, PRE-TAX, in cents. The column every revenue path should read.
  COALESCE(p.amount, 0)                                   AS amount_cents,
  -- DEPRECATED alias, same pre-tax value, kept only for the deploy-order window above.
  COALESCE(p.amount, 0)                                   AS total_amount
FROM public.mdapi_match_players p
JOIN public.mdapi_matches m ON m.api_id = p.match_api_id
WHERE p.deleted_at IS NULL
  AND COALESCE(p.user_is_fake_player, false) = false
  AND p.paid_status IS DISTINCT FROM 'WAITING'
  AND p.canceled_at IS NULL
  AND p.user_id IS NOT NULL
  AND m.deleted_at IS NULL
  AND COALESCE(m.is_cancelled, false) = false
  AND m.start_date IS NOT NULL;

-- ── 2. play dimensions ───────────────────────────────────────────────────────
-- `amount` here was SUM(total_amount)/100 — dollars, but the tax-inclusive charge. The
-- COLUMN NAME does not change, because it was always meant to be the money and is now
-- finally the right money; growthFromViews reads it unchanged.
-- A materialized view cannot be CREATE OR REPLACE'd, so it is dropped and rebuilt with
-- its indexes. Readers see it empty for the length of this migration only.
DROP MATERIALIZED VIEW IF EXISTS public.growth_play_dims;

CREATE MATERIALIZED VIEW public.growth_play_dims AS
SELECT
  match_month,
  city_identifier,
  field_title,
  field_id,
  COUNT(*)                        AS spots,
  SUM(amount_cents)::numeric / 100 AS amount
FROM public.growth_participation
GROUP BY match_month, city_identifier, field_title, field_id;

CREATE UNIQUE INDEX growth_play_dims_pk ON public.growth_play_dims (
  match_month,
  COALESCE(city_identifier, '__NULL__'),
  COALESCE(field_title, '__NULL__'),
  COALESCE(field_id, -1)
);
CREATE INDEX growth_play_dims_month ON public.growth_play_dims (match_month);

-- Same posture as 0096: these are not RLS-covered, so anon/authenticated get nothing and
-- service_role (the key both growth endpoints use) gets the read.
REVOKE ALL ON public.growth_participation FROM anon, authenticated;
REVOKE ALL ON public.growth_play_dims     FROM anon, authenticated;
GRANT SELECT ON public.growth_participation TO service_role;
GRANT SELECT ON public.growth_play_dims     TO service_role;
