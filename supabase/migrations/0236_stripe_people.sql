-- 0236: TIE STRIPE MONEY TO MATCHDAY PEOPLE (Ryan, 2026-10-27).
--
-- Apply via Supabase Dashboard, SQL Editor. One transaction. Nothing existing is changed or dropped.
--
-- WHY. fin_txn cannot say who paid a charge: customer and invoice are blank on every row
-- (finTxnMap.ts), so "a member is someone with a membership charge above $5" (the investor deck) and
-- per-player totals cannot be computed. Three pieces fix that:
--
--   1. fin_txn.customer_id: the Stripe customer on the charge (cus_...). The sync already reads the
--      charge with every balance transaction, so this costs no extra Stripe call. A refund, dispute or
--      failure copies its charge's customer, as it already copies the charge's city and type.
--   2. stripe_customers: one row per Stripe customer, with its email and metadata.userId. MatchDay's
--      backend sets metadata.userId when it creates a customer (backend
--      apps/api/src/core/stripe/stripe.service.ts:144-149, commit 7698a52), so a customer maps to a
--      player exactly; the email is the fallback for customers without it, and is what shows one
--      person holding two customer records.
--   3. stripe_member_invoices: one row per paid membership invoice, carrying the subscription's
--      metadata.userId and metadata.userSubscriptionId (= mdapi_subscriptions.membership_id; backend
--      subscription-metadata.interface.ts:3-8) and the payment intent, which joins to
--      fin_txn.payment_intent_id. That ties each membership charge to a member and a membership.
--
-- ACCESS. Emails are personal data, so the two new tables are SERVICE ROLE ONLY: no grant and no
-- policy for anon or authenticated (Ryan, 2026-10-27). The sync writes them and server routes read
-- them. fin_txn keeps its existing policy; customer_id there is a Stripe id, not an email.
--
-- Adds only: one nullable column, two new tables, indexes and two sync-log sources.

BEGIN;

-- 1. The customer on every fin_txn row.
ALTER TABLE public.fin_txn ADD COLUMN IF NOT EXISTS customer_id text;
CREATE INDEX IF NOT EXISTS fin_txn_customer_idx ON public.fin_txn (customer_id) WHERE customer_id IS NOT NULL;

-- 2. Stripe customers.
CREATE TABLE IF NOT EXISTS public.stripe_customers (
  customer_id     text        PRIMARY KEY,           -- cus_...
  email           text,                              -- the customer's email, as Stripe holds it
  md_user_id      bigint,                            -- metadata.userId, when MatchDay set one
  deleted         boolean     NOT NULL DEFAULT false,
  created_at_utc  timestamptz,
  synced_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stripe_customers_email_idx   ON public.stripe_customers (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS stripe_customers_md_user_idx ON public.stripe_customers (md_user_id)  WHERE md_user_id IS NOT NULL;

-- 3. Paid membership invoices.
CREATE TABLE IF NOT EXISTS public.stripe_member_invoices (
  invoice_id         text        PRIMARY KEY,        -- in_...
  customer_id        text,
  subscription_id    text,                           -- sub_...
  md_user_id         bigint,                         -- subscription metadata.userId
  md_membership_id   bigint,                         -- subscription metadata.userSubscriptionId
  payment_intent_id  text,                           -- joins fin_txn.payment_intent_id
  charge_id          text,
  amount_paid_cents  integer     NOT NULL,           -- tax included, as charged
  status             text,
  billing_reason     text,                           -- subscription_create, subscription_cycle, ...
  created_at_utc     timestamptz NOT NULL,
  paid_at_utc        timestamptz,
  synced_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stripe_member_invoices_pi_idx         ON public.stripe_member_invoices (payment_intent_id) WHERE payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stripe_member_invoices_membership_idx ON public.stripe_member_invoices (md_membership_id) WHERE md_membership_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stripe_member_invoices_user_idx       ON public.stripe_member_invoices (md_user_id)       WHERE md_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stripe_member_invoices_customer_idx   ON public.stripe_member_invoices (customer_id)      WHERE customer_id IS NOT NULL;

-- SERVICE ROLE ONLY, like growth_test_fields (0232) and locations_play_stats (0233): RLS on with no
-- policy, and no grant to anon or authenticated. The browser cannot read either table; pages read them
-- through a server route that applies the caller's capability. Confined accounts never see an email.
ALTER TABLE public.stripe_customers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_member_invoices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stripe_customers       FROM anon, authenticated;
REVOKE ALL ON public.stripe_member_invoices FROM anon, authenticated;
GRANT ALL ON public.stripe_customers, public.stripe_member_invoices TO service_role;

-- 4. The sync-log allowlist, EXTENDED IN PLACE: the live definition is read and the two new sources
--    appended, so no source added since 0224 can be dropped by retyping the list. A source missing
--    here makes the sync's log insert fail silently (runWithLog returns ok:false without throwing).
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint
   WHERE conname = 'fin_sync_log_source_check' AND conrelid = 'public.fin_sync_log'::regclass;
  IF d IS NULL THEN RAISE EXCEPTION 'fin_sync_log_source_check not found'; END IF;
  IF d NOT LIKE '%stripe-member-invoices%' THEN
    d := replace(d, ']))', ', ''stripe-customers''::text, ''stripe-member-invoices''::text]))');
    IF d NOT LIKE '%stripe-member-invoices%' THEN RAISE EXCEPTION 'unexpected constraint shape: %', d; END IF;
    EXECUTE 'ALTER TABLE public.fin_sync_log DROP CONSTRAINT fin_sync_log_source_check';
    EXECUTE 'ALTER TABLE public.fin_sync_log ADD CONSTRAINT fin_sync_log_source_check ' || d;
  END IF;
END $$;

COMMIT;

-- READ-BACK. Expect: customer_id_column = 1, both tables at 0 rows, rows_with_customer = 0 (the
-- backfill fills it), the two new sources accepted, and no_browser_access = true (no policies, and
-- neither anon nor authenticated holds any privilege on either table).
SELECT
  (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fin_txn' AND column_name = 'customer_id') AS customer_id_column,
  (SELECT count(*) FROM public.fin_txn WHERE customer_id IS NOT NULL) AS rows_with_customer,
  (SELECT count(*) FROM public.stripe_customers)       AS stripe_customers_rows,
  (SELECT count(*) FROM public.stripe_member_invoices) AS stripe_member_invoices_rows,
  (SELECT pg_get_constraintdef(oid) LIKE '%stripe-member-invoices%' FROM pg_constraint WHERE conname = 'fin_sync_log_source_check') AS sources_ok,
  (SELECT count(*) = 0 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('stripe_customers','stripe_member_invoices'))
  AND (SELECT count(*) = 0 FROM information_schema.role_table_grants WHERE table_schema = 'public'
       AND table_name IN ('stripe_customers','stripe_member_invoices') AND grantee IN ('anon','authenticated')) AS no_browser_access;
