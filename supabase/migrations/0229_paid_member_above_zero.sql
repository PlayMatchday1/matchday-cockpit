-- 0229 — THE PAYING-MEMBER RULE IS "PLAN ABOVE $0" (Ryan, 2026-10-21). Replaces 0223's $15 floor.
--
-- Apply via Supabase Dashboard → SQL Editor. One transaction, then a Finder refresh.
--
-- One expression changes: `s.price * 100 >= 1500` becomes `s.price * 100 >= 1`, mirroring
-- PAID_MEMBER_MIN_PRICE_CENTS = 1 in src/lib/membershipStats.ts (scripts/membership-floor-test.ts
-- fails if the two differ). price is numeric dollars, so ">= 1 cent" is "above $0".
-- The internal-email and INCOMPLETE tests are unchanged. Columns are unchanged (s.*), so the view can
-- be replaced in place: fin_member_spots_by_venue_month (0223) and player_finder_mv read it and follow.
--
-- WHY. The $15 floor (2026-10-14) took out 10 ACTIVE legacy plans billed $1 a month. Stripe shows all
-- 10 invoiced and paid every month through 2026-10-01 (admin probe low_plans, 2026-10-21), so they
-- are paying members. $0 plans (comps) stay out.

BEGIN;

CREATE OR REPLACE VIEW public.paid_member_subscription
WITH (security_invoker = true) AS
SELECT s.*
FROM public.mdapi_subscriptions s
WHERE s.price IS NOT NULL
  AND s.price * 100 >= 1                                         -- PAID_MEMBER_MIN_PRICE_CENTS
  AND COALESCE(s.member_email, '') !~* '@matchday\.|@playmatchday\.'  -- INTERNAL_EMAIL_RX
  AND upper(COALESCE(s.status, '')) NOT LIKE 'INCOMPLETE%';

REVOKE ALL ON public.paid_member_subscription FROM anon;
GRANT SELECT ON public.paid_member_subscription TO authenticated, service_role;

COMMIT;

-- player_finder_mv is a materialized view: its is_member column only moves on a refresh.
SELECT public.refresh_player_finder_views();

-- ── READ-BACK. Expect: active_paying_rows = active_paying_rows_before + 10 (the legacy $1 plans),
-- under_15 = 10, zero_price = 0 (comps stay out), internal = 0 (staff stay out).
SELECT
  (SELECT count(*) FROM public.paid_member_subscription WHERE status = 'ACTIVE')                    AS active_paying_rows,
  (SELECT count(*) FROM public.paid_member_subscription WHERE status = 'ACTIVE' AND price < 15)     AS under_15,
  (SELECT count(*) FROM public.paid_member_subscription WHERE price = 0)                            AS zero_price,
  (SELECT count(*) FROM public.paid_member_subscription WHERE member_email ~* '@matchday\.|@playmatchday\.') AS internal,
  (SELECT count(*) FROM public.player_finder_mv WHERE is_member)                                     AS finder_members;
