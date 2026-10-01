-- 0196 — fin_txn: one row per Stripe balance transaction.
--
-- WHY A NEW TABLE RATHER THAN A CHANGE TO fin_revenue.
-- fin_revenue aggregates at import on (date, city, type, venue) — financeImport.ts:426-428 — so a
-- month holds 562 rows for 5,451 charges and the individual charge timestamps are gone. That makes
-- three things impossible without a re-import: re-dating UTC→Central (the instant is not there),
-- storing refunds/disputes/fees as their own movements (they were never imported at all), and
-- carrying payment_metadata[fieldId] (never read). This table stores the grain Stripe gives us and
-- derives everything else at query time.
--
-- fin_revenue IS NOT TOUCHED BY THIS MIGRATION and stays the live source for every Finance page
-- until the switch is approved. Nothing here drops, alters or reads it.

create table if not exists public.fin_txn (
  id                  bigint generated always as identity primary key,

  -- ── WHEN ────────────────────────────────────────────────────────────────────────────────────
  -- The full instant, stored UTC. MONTH AND DAY ARE NEVER STORED: they are derived in
  -- America/Chicago at query time —
  --     (created_at_utc at time zone 'America/Chicago')::date
  -- A stored month label is exactly what let the UTC/Central question go unnoticed in fin_revenue
  -- for the life of the table.
  created_at_utc      timestamptz not null,

  -- ── WHAT KIND OF MOVEMENT ───────────────────────────────────────────────────────────────────
  -- Stripe's reporting_category, plus 'manual' for the Venmo rows that never went through Stripe.
  kind                text not null
                      check (kind in ('charge','refund','failed','dispute','fee','manual')),

  -- ── MONEY, IN CENTS, SIGNED AS STRIPE SIGNS IT. Charges positive, reversals negative.
  -- INTEGER CENTS, NOT NUMERIC DOLLARS. fin_revenue stores dollars; this estate has been bitten by
  -- the dollar/cent boundary before (mdapi price is dollars, MemberLike.price_cents is cents), and
  -- an integer cannot drift the way a float sum can.
  gross_cents         integer not null,
  fee_cents           integer not null default 0,
  net_cents           integer not null,

  -- ── ATTRIBUTION. Carried from the originating charge wherever Stripe links the movement.
  city                text,
  type                text,          -- DPP | Membership | Private Rental | Strike | Unclassified
  -- THE REAL FIELD, from payment_metadata[fieldId]. Measured on September: 5,031 of 5,434 charges
  -- carry one, 30 distinct values, and ALL 30 map to a fin_venue_fields row — $0.00 unmapped. The
  -- 403 without one are 399 subscriptions and 4 strikes, neither of which has a field.
  field_id            integer,
  fin_venue_id        bigint references public.fin_venues(id),

  -- ── STRIPE IDENTITY. balance_txn_id is the natural key: one row per movement.
  balance_txn_id      text,
  charge_id           text,
  payment_intent_id   text,
  subscription_id     text,
  invoice_id          text,
  source_id           text,

  -- ── EXCLUSIONS. A FLAG, NOT A DELETE. A test charge is still money that moved, and a row that
  -- silently vanishes is how a reconciliation stops tying to Stripe.
  is_test             boolean not null default false,
  is_internal         boolean not null default false,
  exclude_reason      text,

  source              text not null default 'Stripe',   -- Stripe | Venmo
  description         text,
  dispute_reason      text,

  -- ── ROW LIFECYCLE. fin_revenue has no updated_at, which is precisely why "Adjusted after final"
  -- cannot be answered for existing history: a row edited in place leaves no trace.
  created_at          timestamptz not null default now(),
  updated_at          timestamptz
);

-- ONE ROW PER BALANCE TRANSACTION, ENFORCED. The back-fill is re-runnable because of this index
-- and for no other reason. Manual Venmo rows carry no Stripe id, so the index is partial.
create unique index if not exists fin_txn_balance_txn_uniq
  on public.fin_txn (balance_txn_id)
  where balance_txn_id is not null;

-- The read pattern every Finance page uses: a Central month, by city, by kind, by field.
create index if not exists fin_txn_created_idx    on public.fin_txn (created_at_utc);
create index if not exists fin_txn_city_kind_idx  on public.fin_txn (city, kind);
create index if not exists fin_txn_field_idx      on public.fin_txn (field_id) where field_id is not null;

-- ── RLS: MIRRORS fin_revenue EXACTLY ────────────────────────────────────────────────────────────
-- Confirmed from pg_policies: fin_revenue carries fin_revenue_auth_all, cmd ALL, roles
-- {authenticated}, qual true, with_check true; relrowsecurity true, relforcerowsecurity false.
-- Identical here so nothing new can block access. Tightening every finance table is a separate job.
alter table public.fin_txn enable row level security;

drop policy if exists fin_txn_auth_all on public.fin_txn;
create policy fin_txn_auth_all on public.fin_txn
  for all to authenticated
  using (true) with check (true);

-- ── THE SYNC-LOG ALLOWLIST ──────────────────────────────────────────────────────────────────────
-- fin_sync_log.source is an explicit CHECK allowlist, and runWithLog's insert for a value outside
-- it returns ok:false WITHOUT THROWING — so the job runs, writes its rows, and its logging simply
-- vanishes. The back-fill walks month by month and records each month here, so its source value has
-- to be added in the same migration that creates the table it fills.
alter table public.fin_sync_log drop constraint if exists fin_sync_log_source_check;
alter table public.fin_sync_log add constraint fin_sync_log_source_check
  CHECK (source IN (
    'stripe-api','mdapi-reviews','mdapi-subscriptions','mdapi-promocodes','mdapi-matches',
    'mdapi-users','mdapi-users-full','mdapi-users-lens-snapshot','membership-snapshots',
    'membership-prices','manager-pay-recompute','firstmatch-ledger','telnyx-sms','play-installs',
    'app-store-installs','google-calendar','meta-ad-spend','wp-submissions',
    'stripe-txn-backfill'
  ));

comment on table public.fin_txn is
  'One row per Stripe balance transaction, plus manual Venmo rows. Replaces fin_revenue''s '
  'aggregated grain. Month and day are derived in America/Chicago at query time, never stored.';
comment on column public.fin_txn.created_at_utc is
  'Stripe created, UTC. Central month = (created_at_utc at time zone ''America/Chicago'')::date.';
comment on column public.fin_txn.kind is
  'charge | refund | failed | dispute | fee | manual. Reversals carry negative gross_cents.';
comment on column public.fin_txn.field_id is
  'mdapi field id from payment_metadata[fieldId]. Joins fin_venue_fields.mdapi_field_id.';
