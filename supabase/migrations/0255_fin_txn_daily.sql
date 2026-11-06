-- 0255 — fin_txn_daily: Finance > Revenue's figures, one row per Central day × city × type × venue
-- × source. A read-only mirror of fin_txn, rebuilt by the fin_txn sync over every day it touched,
-- plus the last 90 days nightly, so every other page in Clubhouse (Home, Finance Cities, Cost,
-- field economics, period compare, quarters, the monthly report, partner dashboards) can read
-- Finance's one definition of revenue in one indexed read instead of re-aggregating 124k rows per
-- page load (Ryan, 2026-11-05).
--
-- SAME ARITHMETIC AS fin_txn_sums (0214): the Central day, the per-charge sales tax at the caller's
-- rates (salesTax.ts, passed in), test / internal / excluded rows out, money kinds only.
--   gross_cents     charges + Venmo, tax in                 = Finance "Gross collected"
--   reversal_cents  refunds + failed + disputes, negative   (tax in, at Stripe's amounts)
--   tax_cents       per-charge tax on every money row, signed like the row
--   net_cents       gross + reversals − tax                 = Finance "Net revenue"
--   fee_cents       Stripe's fees on those rows (not in net; Finance shows them under it)
-- fin_revenue is NOT touched.
--
-- Apply in the Supabase SQL Editor. Then the app's one-off backfill calls
-- refresh_fin_txn_daily('2023-05-01', today) with salesTax.ts's rates.

begin;

create table if not exists public.fin_txn_daily (
  day            date    not null,
  city           text    not null default '',            -- '' = no city ("Deleted Account Revenue")
  type           text    not null default 'Unclassified',
  fin_venue_id   bigint,
  venue_key      bigint  generated always as (coalesce(fin_venue_id, 0)) stored,
  source         text    not null,                        -- 'Stripe' | 'Venmo'
  n_charges      integer not null default 0,
  gross_cents    bigint  not null default 0,
  reversal_cents bigint  not null default 0,
  fee_cents      bigint  not null default 0,
  tax_cents      bigint  not null default 0,
  net_cents      bigint  not null default 0,
  refreshed_at   timestamptz not null default now(),
  primary key (day, city, type, venue_key, source)
);
create index if not exists fin_txn_daily_day_idx on public.fin_txn_daily (day);

alter table public.fin_txn_daily enable row level security;
drop policy if exists fin_txn_daily_auth_select on public.fin_txn_daily;
create policy fin_txn_daily_auth_select on public.fin_txn_daily for select to authenticated using (true);

-- Rebuilds every day in [p_from, p_to] from fin_txn. Returns the rows written.
create or replace function public.refresh_fin_txn_daily(p_from date, p_to date, p_rates jsonb, p_default_rate numeric)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  delete from public.fin_txn_daily where day between p_from and p_to;
  insert into public.fin_txn_daily
    (day, city, type, fin_venue_id, source, n_charges, gross_cents, reversal_cents, fee_cents, tax_cents, net_cents)
  select
    x.d,
    coalesce(nullif(btrim(t.city), ''), ''),
    coalesce(t.type, 'Unclassified'),
    t.fin_venue_id,
    t.source,
    count(*) filter (where t.kind in ('charge', 'manual'))::integer,
    coalesce(sum(t.gross_cents) filter (where t.kind in ('charge', 'manual')), 0)::bigint,
    coalesce(sum(t.gross_cents) filter (where t.kind in ('refund', 'failed', 'dispute')), 0)::bigint,
    coalesce(sum(t.fee_cents), 0)::bigint,
    coalesce(sum(case when t.source = 'Stripe' and t.kind in ('charge', 'refund', 'failed', 'dispute')
                      then t.gross_cents - round(t.gross_cents / (1 + rt.rate)) else 0 end), 0)::bigint,
    (coalesce(sum(t.gross_cents), 0)
     - coalesce(sum(case when t.source = 'Stripe' and t.kind in ('charge', 'refund', 'failed', 'dispute')
                         then t.gross_cents - round(t.gross_cents / (1 + rt.rate)) else 0 end), 0))::bigint
  from public.fin_txn t
  cross join lateral (select (t.created_at_utc at time zone 'America/Chicago')::date as d) x
  cross join lateral (select case
      when t.city is null or btrim(t.city) = '' or t.city = 'Deleted Account Revenue' then p_default_rate
      else coalesce((p_rates ->> t.city)::numeric, 0)
    end as rate) rt
  where t.kind in ('charge', 'manual', 'refund', 'failed', 'dispute')
    and not coalesce(t.is_test, false)
    and not coalesce(t.is_internal, false)
    and t.exclude_reason is null
    and t.created_at_utc >= (p_from::timestamp at time zone 'America/Chicago')
    and t.created_at_utc <  ((p_to + 1)::timestamp at time zone 'America/Chicago')
  group by 1, 2, 3, 4, 5;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.refresh_fin_txn_daily(date, date, jsonb, numeric) from public, anon, authenticated;
grant execute on function public.refresh_fin_txn_daily(date, date, jsonb, numeric) to service_role;

commit;
