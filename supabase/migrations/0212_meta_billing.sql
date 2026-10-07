-- 0212: Meta billing charges and balance, saved by the daily
-- Meta sync (Ryan, 2026-10-07). OpEx reads these instead of
-- Meta's activity log on every page load.
--
-- fin_meta_billing_charge: one row per entry Meta logs as a
--   billing charge, keyed on Meta's transaction_id. A charge read
--   again is the same row; one Meta's log stops returning is kept.
--   amount_cents is signed: a refund or reversal, if Meta ever
--   logs one, is stored negative, never dropped. Zero is refused.
--   kind: 'charge' or 'refund' (as Meta's event says), so a
--   reversal is never mistaken for a payment.
-- fin_meta_billing_balance: Meta's own unbilled balance (cents)
--   and lifetime amount spent, read once per sync.
--
-- Service role only, like the other fin_meta_* tables.

create table if not exists public.fin_meta_billing_charge (
  transaction_id text primary key,
  ad_account_id  text        not null,
  charged_at     timestamptz not null,
  amount_cents   integer     not null,
  kind           text        not null default 'charge',
  event_type     text        not null,
  currency       text        not null,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  constraint fin_meta_billing_charge_nonzero
    check (amount_cents <> 0),
  constraint fin_meta_billing_charge_kind
    check (kind in ('charge', 'refund')),
  constraint fin_meta_billing_charge_usd
    check (currency = 'USD')
);

create index if not exists fin_meta_billing_charge_at_idx
  on public.fin_meta_billing_charge (ad_account_id, charged_at);

create table if not exists public.fin_meta_billing_balance (
  ad_account_id      text        not null,
  read_at            timestamptz not null,
  balance_cents      bigint      not null,
  amount_spent_cents bigint      not null,
  primary key (ad_account_id, read_at)
);

alter table public.fin_meta_billing_charge
  enable row level security;
alter table public.fin_meta_billing_balance
  enable row level security;

revoke all on public.fin_meta_billing_charge
  from anon, authenticated;
revoke all on public.fin_meta_billing_balance
  from anon, authenticated;

grant select, insert, update on public.fin_meta_billing_charge
  to service_role;
grant select, insert on public.fin_meta_billing_balance
  to service_role;

-- READ-BACK: expect two rows, rls_on true,
-- 9 columns for the charge table and 4 for the balance table.
select c.relname as table_name,
       c.relrowsecurity as rls_on,
       (select count(*)
          from information_schema.columns k
         where k.table_schema = 'public'
           and k.table_name = c.relname) as columns
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('fin_meta_billing_charge',
                     'fin_meta_billing_balance')
 order by 1;
