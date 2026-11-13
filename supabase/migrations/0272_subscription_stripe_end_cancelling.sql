-- 0272: STRIPE'S SCHEDULED END FOR A CANCELLING MEMBERSHIP (Ryan, 2026-11-13).
--
-- WHY. A member who cancels in the app keeps status ACTIVE at MatchDay with a canceled_at (the press),
-- and Stripe is told to stop only after the next invoice is paid (backend 8965437,
-- subscriptions.service.ts:543-559 and stripe.service.ts:854-858). The Members page shows those
-- members on a Cancelling tab with their END DATE, and Ryan's ruling is that the date is Stripe's real
-- one, not an estimate. MatchDay stores no period end that we mirror, so the nightly sub-ends job
-- (lib/stripeSubEnds.ts) now also reads ACTIVE memberships that carry a canceled_at and saves these
-- three fields from the same subscriptions.retrieve it already makes for CANCELED rows.
--
-- WHAT IT ADDS. Three nullable columns on mdapi_subscription_stripe_end (0261):
--   stripe_cancel_at             Stripe's subscription.cancel_at — the instant Stripe will end it.
--   stripe_cancel_at_period_end  subscription.cancel_at_period_end — whether Stripe is scheduled to stop.
--   stripe_current_period_end    items.data[0].current_period_end (in this Stripe API version the
--                                period lives on the item, stripe v22 SubscriptionItems.d.ts:50).
-- Existing rows keep NULL in all three until the job next reads them; nothing is backfilled here.
--
-- Adds only. No table, policy, grant, constraint or sync-log source is created, changed or dropped:
-- the job keeps its 'stripe-sub-ends' source from 0261, and the table stays service-role only.
-- Apply in the Supabase SQL Editor. The last statement returns ONE verdict row.

BEGIN;

ALTER TABLE public.mdapi_subscription_stripe_end
  ADD COLUMN IF NOT EXISTS stripe_cancel_at            timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_cancel_at_period_end boolean,
  ADD COLUMN IF NOT EXISTS stripe_current_period_end   timestamptz;

COMMIT;

-- VERDICT. Expect: columns_added = 3, rows = the same count as before (nothing inserted or deleted),
-- source_kept = true, no_browser_access = true.
SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'mdapi_subscription_stripe_end'
      AND column_name IN ('stripe_cancel_at', 'stripe_cancel_at_period_end', 'stripe_current_period_end')) AS columns_added,
  (SELECT count(*) FROM public.mdapi_subscription_stripe_end) AS rows,
  (SELECT pg_get_constraintdef(oid) LIKE '%''stripe-sub-ends''%' FROM pg_constraint
    WHERE conname = 'fin_sync_log_source_check') AS source_kept,
  (SELECT count(*) = 0 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'mdapi_subscription_stripe_end')
  AND (SELECT count(*) = 0 FROM information_schema.role_table_grants WHERE table_schema = 'public'
       AND table_name = 'mdapi_subscription_stripe_end' AND grantee IN ('anon', 'authenticated')) AS no_browser_access;
