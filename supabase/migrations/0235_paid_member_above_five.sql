-- 0235: THE PAYING-MEMBER RULE IS "PLAN ABOVE $5" (Ryan, 2026-10-27, to match the investor deck).
-- Replaces 0229's "above $0".
--
-- Apply via Supabase Dashboard, SQL Editor. One transaction, then a Finder refresh.
--
-- One expression changes: `s.price * 100 >= 1` becomes `s.price * 100 >= 501`, mirroring
-- PAID_MEMBER_MIN_PRICE_CENTS = 501 in src/lib/membershipStats.ts (scripts/membership-floor-test.ts
-- fails if the two differ). price is whole dollars, so this admits plans of $6 and up.
-- The internal-email and INCOMPLETE tests are unchanged. Columns are unchanged (s.*), so the view is
-- replaced in place: fin_member_spots_by_venue_month (0223) and player_finder_mv read it and follow.
--
-- WHAT LEAVES: the ACTIVE $1 a month plans (9 on 2026-10-27). $0 comps were already out.

BEGIN;

CREATE OR REPLACE VIEW public.paid_member_subscription
WITH (security_invoker = true) AS
SELECT s.*
FROM public.mdapi_subscriptions s
WHERE s.price IS NOT NULL
  AND s.price * 100 >= 501                                       -- PAID_MEMBER_MIN_PRICE_CENTS
  AND COALESCE(s.member_email, '') !~* '@matchday\.|@playmatchday\.'  -- INTERNAL_EMAIL_RX
  AND upper(COALESCE(s.status, '')) NOT LIKE 'INCOMPLETE%';

REVOKE ALL ON public.paid_member_subscription FROM anon;
GRANT SELECT ON public.paid_member_subscription TO authenticated, service_role;

COMMIT;

-- player_finder_mv is a materialized view: its is_member column only moves on a refresh.
SELECT public.refresh_player_finder_views();

-- READ-BACK. Expect: at_or_under_5 = 0, zero_price = 0, internal = 0, and active_paying_rows 9 lower
-- than before (the $1 a month plans).
SELECT
  (SELECT count(*) FROM public.paid_member_subscription WHERE status = 'ACTIVE')                    AS active_paying_rows,
  (SELECT count(*) FROM public.paid_member_subscription WHERE price <= 5)                           AS at_or_under_5,
  (SELECT count(*) FROM public.paid_member_subscription WHERE price = 0)                            AS zero_price,
  (SELECT count(*) FROM public.paid_member_subscription WHERE member_email ~* '@matchday\.|@playmatchday\.') AS internal,
  (SELECT count(*) FROM public.player_finder_mv WHERE is_member)                                     AS finder_members;
