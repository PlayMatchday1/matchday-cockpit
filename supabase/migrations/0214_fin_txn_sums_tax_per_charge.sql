-- 0214 — fin_txn sums with sales tax rounded PER CHARGE, the way Stripe charged it.
--
-- WHY. 0213's functions return gross only; the page took tax off each summed group in one rounding.
-- Stripe adds tax per charge: every one of September 2026's 5,451 charges equals
-- price + round(price × city rate) exactly (checked 2026-10-08). Rounding once per group instead
-- drifted September's net revenue $2.71 high ($80,556.74 vs $80,554.03 per charge). These functions
-- add a tax_cents column summed from each row's own rounded tax.
--
-- THE RATES COME FROM THE CALLER (salesTax.ts, CITY_TAX_RATE) as p_rates {"Austin": 0.0825, …}, so
-- there is one rate table, not a second copy in SQL. p_default_rate is the rate for Unassigned
-- (no city, or "Deleted Account Revenue"). A city missing from p_rates is taxed at 0 here and NAMED
-- on the page by the caller — never silently.
--
-- Tax on a row = gross − round(gross ÷ (1 + rate)) — the pre-tax price recovered per charge, rounded
-- half away from zero. Only Stripe money rows carry tax; Venmo and Stripe's fee rows carry none.
--
-- READ-ONLY, SECURITY INVOKER, like 0213. 0213's two functions are left in place, unused.

create or replace function public.fin_txn_sums(
  p_from date,
  p_to date,
  p_grain text,
  p_by_venue boolean,
  p_venue_id bigint,
  p_rates jsonb,
  p_default_rate numeric
)
returns table (
  period        date,
  kind          text,
  source        text,
  type          text,
  city          text,
  fin_venue_id  bigint,
  excluded      boolean,
  n             integer,
  gross_cents   bigint,
  fee_cents     bigint,
  tax_cents     bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    case when p_grain = 'day' then x.d else date_trunc('month', x.d)::date end,
    t.kind,
    t.source,
    coalesce(t.type, 'Unclassified'),
    t.city,
    case when p_by_venue then t.fin_venue_id end,
    (t.is_test or t.is_internal or t.exclude_reason is not null),
    count(*)::integer,
    sum(t.gross_cents)::bigint,
    sum(t.fee_cents)::bigint,
    sum(case
          when t.source = 'Stripe' and t.kind in ('charge', 'refund', 'failed', 'dispute')
          then t.gross_cents - round(t.gross_cents / (1 + rt.rate))
          else 0
        end)::bigint
  from public.fin_txn t
  cross join lateral (select (t.created_at_utc at time zone 'America/Chicago')::date as d) x
  cross join lateral (select case
      when t.city is null or btrim(t.city) = '' or t.city = 'Deleted Account Revenue' then p_default_rate
      else coalesce((p_rates ->> t.city)::numeric, 0)
    end as rate) rt
  where t.created_at_utc >= (p_from::timestamp at time zone 'America/Chicago')
    and t.created_at_utc <  ((p_to + 1)::timestamp at time zone 'America/Chicago')
    and (p_venue_id is null or t.fin_venue_id = p_venue_id)
  group by 1, 2, 3, 4, 5, 6, 7
$$;

-- Per match, as 0213's fin_txn_match_rollup, plus per-row tax.
create or replace function public.fin_txn_match_sums(p_from date, p_to date, p_rates jsonb, p_default_rate numeric)
returns table (
  match_api_id  bigint,
  kind          text,
  type          text,
  city          text,
  excluded      boolean,
  n             integer,
  gross_cents   bigint,
  tax_cents     bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with m as (
    select api_id from public.mdapi_matches
    where start_date >= (p_from::timestamp at time zone 'UTC')
      and start_date <  ((p_to + 1)::timestamp at time zone 'UTC')
  ),
  pi as (
    select distinct on (mp.payment_intent_id) mp.payment_intent_id, mp.match_api_id
    from public.mdapi_match_players mp
    join m on m.api_id = mp.match_api_id
    where mp.payment_intent_id is not null
    order by mp.payment_intent_id, mp.match_api_id
  ),
  r as (
    select pi.match_api_id, t.kind, t.type, t.city, t.source, t.is_test, t.is_internal, t.exclude_reason, t.gross_cents
    from public.fin_txn t
    join pi on pi.payment_intent_id = t.payment_intent_id
    union all
    select pi.match_api_id, v.kind, v.type, v.city, v.source, v.is_test, v.is_internal, v.exclude_reason, v.gross_cents
    from public.fin_txn v
    join public.fin_txn c on c.charge_id = v.charge_id and c.kind = 'charge'
    join pi on pi.payment_intent_id = c.payment_intent_id
    where v.payment_intent_id is null and v.kind in ('refund', 'dispute', 'failed')
  )
  select
    r.match_api_id, r.kind, coalesce(r.type, 'Unclassified'), r.city,
    (r.is_test or r.is_internal or r.exclude_reason is not null),
    count(*)::integer, sum(r.gross_cents)::bigint,
    sum(case
          when r.source = 'Stripe' and r.kind in ('charge', 'refund', 'failed', 'dispute')
          then r.gross_cents - round(r.gross_cents / (1 + rt.rate))
          else 0
        end)::bigint
  from r
  cross join lateral (select case
      when r.city is null or btrim(r.city) = '' or r.city = 'Deleted Account Revenue' then p_default_rate
      else coalesce((p_rates ->> r.city)::numeric, 0)
    end as rate) rt
  group by 1, 2, 3, 4, 5
$$;

revoke all on function public.fin_txn_sums(date, date, text, boolean, bigint, jsonb, numeric) from public, anon;
revoke all on function public.fin_txn_match_sums(date, date, jsonb, numeric) from public, anon;
grant execute on function public.fin_txn_sums(date, date, text, boolean, bigint, jsonb, numeric) to authenticated, service_role;
grant execute on function public.fin_txn_match_sums(date, date, jsonb, numeric) to authenticated, service_role;
