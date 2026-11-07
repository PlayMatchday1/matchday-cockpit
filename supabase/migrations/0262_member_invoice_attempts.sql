-- 0262: FAILED MEMBERSHIP PAYMENTS (Ryan, 2026-11-07). Follow-up 2 to the membership history.
--
-- WHY. stripe_member_invoices holds PAID invoices only (lib/stripePeopleSync, invoices.list status
-- "paid"), so a renewal that failed and was retried, or one that is still unpaid, is invisible. Two
-- additions, nothing existing changed:
--
--   1. stripe_member_invoices.attempt_count: Stripe's attempt_count on the paid invoice. 1 = paid first
--      time; N > 1 = "Renewal failed N-1 times, then paid". NULL until the invoice sync re-reads it.
--   2. stripe_member_unpaid_invoices: membership invoices Stripe has NOT been paid for (open,
--      uncollectible, void), with the attempts, the next retry and the last failure's code. A SEPARATE
--      table on purpose: every reader of stripe_member_invoices (the refund check, the history card,
--      Partner/finance joins) assumes a row there is money received.
--
-- ACCESS. Service role only, like 0236 and 0261. No card number, no customer email: last_failure_code is
-- Stripe's code ("card_declined", "insufficient_funds"), last_failure_message Stripe's generic sentence.
--
-- Apply in the Supabase SQL Editor. The last statement returns ONE verdict row.

BEGIN;

ALTER TABLE public.stripe_member_invoices ADD COLUMN IF NOT EXISTS attempt_count integer;

CREATE TABLE IF NOT EXISTS public.stripe_member_unpaid_invoices (
  invoice_id                 text        PRIMARY KEY,   -- in_...
  customer_id                text,
  subscription_id            text,
  md_user_id                 bigint,                    -- subscription metadata.userId
  md_membership_id           bigint,                    -- subscription metadata.userSubscriptionId
  payment_intent_id          text,
  amount_due_cents           integer     NOT NULL,      -- tax included
  status                     text        NOT NULL CHECK (status IN ('open', 'uncollectible', 'void')),
  billing_reason             text,
  attempt_count              integer,
  next_payment_attempt_utc   timestamptz,               -- null when Stripe has stopped retrying
  last_failure_code          text,
  last_failure_message       text,
  created_at_utc             timestamptz NOT NULL,
  synced_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stripe_member_unpaid_invoices_user_idx       ON public.stripe_member_unpaid_invoices (md_user_id)       WHERE md_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stripe_member_unpaid_invoices_membership_idx ON public.stripe_member_unpaid_invoices (md_membership_id) WHERE md_membership_id IS NOT NULL;

ALTER TABLE public.stripe_member_unpaid_invoices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stripe_member_unpaid_invoices FROM anon, authenticated;
GRANT ALL ON public.stripe_member_unpaid_invoices TO service_role;

-- The sync-log allowlist, EXTENDED IN PLACE (the 0236 / 0261 pattern).
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint
   WHERE conname = 'fin_sync_log_source_check' AND conrelid = 'public.fin_sync_log'::regclass;
  IF d IS NULL THEN RAISE EXCEPTION 'fin_sync_log_source_check not found'; END IF;
  IF d NOT LIKE '%''stripe-member-unpaid-invoices''%' THEN
    d := replace(d, ']))', ', ''stripe-member-unpaid-invoices''::text]))');
    IF d NOT LIKE '%''stripe-member-unpaid-invoices''%' THEN RAISE EXCEPTION 'unexpected constraint shape: %', d; END IF;
    EXECUTE 'ALTER TABLE public.fin_sync_log DROP CONSTRAINT fin_sync_log_source_check';
    EXECUTE 'ALTER TABLE public.fin_sync_log ADD CONSTRAINT fin_sync_log_source_check ' || d;
  END IF;
END $$;

COMMIT;

-- VERDICT. Expect: attempt_count_column = true, unpaid_table = true, unpaid_rows = 0, source_ok = true,
-- kept_sub_ends = true (0261's source survived), no_browser_access = true.
SELECT
  (SELECT count(*) = 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'stripe_member_invoices' AND column_name = 'attempt_count') AS attempt_count_column,
  (to_regclass('public.stripe_member_unpaid_invoices') IS NOT NULL) AS unpaid_table,
  (SELECT count(*) FROM public.stripe_member_unpaid_invoices) AS unpaid_rows,
  (SELECT pg_get_constraintdef(oid) LIKE '%''stripe-member-unpaid-invoices''%' FROM pg_constraint WHERE conname = 'fin_sync_log_source_check') AS source_ok,
  (SELECT pg_get_constraintdef(oid) LIKE '%''stripe-sub-ends''%' FROM pg_constraint WHERE conname = 'fin_sync_log_source_check') AS kept_sub_ends,
  (SELECT count(*) = 0 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'stripe_member_unpaid_invoices')
  AND (SELECT count(*) = 0 FROM information_schema.role_table_grants WHERE table_schema = 'public'
       AND table_name = 'stripe_member_unpaid_invoices' AND grantee IN ('anon', 'authenticated')) AS no_browser_access;
