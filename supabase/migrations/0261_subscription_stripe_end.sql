-- 0261: STRIPE'S END DATE FOR A MEMBERSHIP (Ryan, 2026-11-07). Replaces 0224, which was drafted on
-- 2026-10-14 and never applied (production answered PGRST205 for this table on 2026-11-07).
--
-- WHY NOT 0224 AS WRITTEN. Its step 2 dropped fin_sync_log_source_check and re-created it from a typed
-- list. Every source added since (0236's stripe-customers and stripe-member-invoices, and any later)
-- would have been dropped, and a sync whose source is missing logs nothing, silently (runWithLog returns
-- ok:false without throwing). This file extends the LIVE constraint in place instead, the 0236 pattern.
--
-- WHAT IT HOLDS. One row per MatchDay membership (mdapi_subscriptions.membership_id) that Stripe has
-- been asked about: the Stripe subscription's status, canceled_at and ended_at. MatchDay records no end
-- date at all, and leaves canceled_at empty whenever Stripe ends a membership (backend webhooks), so
-- this is the only exact end date in the estate. Written by the Stripe sub-ends sync
-- (lib/stripeSubEnds.ts, POST /api/sync/stripe-people?job=sub-ends), read by the membership history.
--
-- ACCESS. Service role only, like the other Stripe-people tables: no policy, no grant to anon or
-- authenticated. Pages read it through a server route.
--
-- Adds only: one new table and one sync-log source. Nothing existing is changed or dropped.
-- Apply in the Supabase SQL Editor. The last statement returns ONE verdict row.

BEGIN;

CREATE TABLE IF NOT EXISTS public.mdapi_subscription_stripe_end (
  membership_id           bigint      PRIMARY KEY,       -- = MatchDay user_subscriptions.id
  user_id                 bigint      NOT NULL,
  stripe_subscription_id  text,
  match_method            text        NOT NULL
    CHECK (match_method IN ('matchday_db', 'stripe_metadata', 'stripe_email_date', 'unmatched')),
  candidate_count         integer     NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  stripe_status           text,
  stripe_canceled_at      timestamptz,
  stripe_ended_at         timestamptz,
  stripe_start_date       timestamptz,
  stripe_trial_end        timestamptz,
  lookup_error            text,
  fetched_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mdapi_subscription_stripe_end_user_idx ON public.mdapi_subscription_stripe_end (user_id);

ALTER TABLE public.mdapi_subscription_stripe_end ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mdapi_subscription_stripe_end FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.mdapi_subscription_stripe_end TO service_role;

-- The sync-log allowlist, EXTENDED IN PLACE: the live definition is read and one source appended.
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint
   WHERE conname = 'fin_sync_log_source_check' AND conrelid = 'public.fin_sync_log'::regclass;
  IF d IS NULL THEN RAISE EXCEPTION 'fin_sync_log_source_check not found'; END IF;
  IF d NOT LIKE '%''stripe-sub-ends''%' THEN
    d := replace(d, ']))', ', ''stripe-sub-ends''::text]))');
    IF d NOT LIKE '%''stripe-sub-ends''%' THEN RAISE EXCEPTION 'unexpected constraint shape: %', d; END IF;
    EXECUTE 'ALTER TABLE public.fin_sync_log DROP CONSTRAINT fin_sync_log_source_check';
    EXECUTE 'ALTER TABLE public.fin_sync_log ADD CONSTRAINT fin_sync_log_source_check ' || d;
  END IF;
END $$;

COMMIT;

-- VERDICT. Expect: table_exists = true, rows = 0, source_ok = true, kept_member_invoices = true
-- (0236's source survived), no_browser_access = true.
SELECT
  (to_regclass('public.mdapi_subscription_stripe_end') IS NOT NULL) AS table_exists,
  (SELECT count(*) FROM public.mdapi_subscription_stripe_end) AS rows,
  (SELECT pg_get_constraintdef(oid) LIKE '%''stripe-sub-ends''%' FROM pg_constraint WHERE conname = 'fin_sync_log_source_check') AS source_ok,
  (SELECT pg_get_constraintdef(oid) LIKE '%''stripe-member-invoices''%' FROM pg_constraint WHERE conname = 'fin_sync_log_source_check') AS kept_member_invoices,
  (SELECT count(*) = 0 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'mdapi_subscription_stripe_end')
  AND (SELECT count(*) = 0 FROM information_schema.role_table_grants WHERE table_schema = 'public'
       AND table_name = 'mdapi_subscription_stripe_end' AND grantee IN ('anon', 'authenticated')) AS no_browser_access;
