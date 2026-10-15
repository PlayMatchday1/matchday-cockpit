BEGIN;

CREATE TABLE public.mdapi_subscription_stripe_end (
  membership_id           bigint PRIMARY KEY,            -- = MatchDay user_subscriptions.id
  user_id                 bigint NOT NULL,
  stripe_subscription_id  text,
  match_method            text NOT NULL
    CHECK (match_method IN ('matchday_db', 'stripe_metadata', 'stripe_email_date', 'unmatched')),
  candidate_count         integer NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  stripe_status           text,
  stripe_canceled_at      timestamptz,
  stripe_ended_at         timestamptz,
  stripe_start_date       timestamptz,
  stripe_trial_end        timestamptz,
  lookup_error            text,
  fetched_at              timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.mdapi_subscription_stripe_end ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mdapi_subscription_stripe_end FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.mdapi_subscription_stripe_end TO service_role;

ALTER TABLE public.fin_sync_log DROP CONSTRAINT fin_sync_log_source_check;
ALTER TABLE public.fin_sync_log ADD CONSTRAINT fin_sync_log_source_check
  CHECK (source = ANY (ARRAY[
    'stripe-api','mdapi-reviews','mdapi-subscriptions','mdapi-promocodes','mdapi-matches',
    'mdapi-users','mdapi-users-full','mdapi-users-lens-snapshot','membership-snapshots',
    'membership-prices','manager-pay-recompute','firstmatch-ledger','telnyx-sms','play-installs',
    'app-store-installs','google-calendar','meta-ad-spend','wp-submissions',
    'stripe-txn-backfill','stripe-txn','gsc-pages','ga4-web','ga4-app','asc-analytics',
    'stripe-sub-ends'
  ]::text[]));

COMMIT;
