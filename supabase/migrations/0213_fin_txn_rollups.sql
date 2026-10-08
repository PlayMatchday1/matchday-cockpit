-- 0213 — fin_txn read functions for the Revenue page.
--
-- WHY FUNCTIONS. The page needs fin_txn summed by Central day or month, city, type and venue. Read
-- row by row that is ~5,700 rows a month and 118k for the record — measured 23 s to page through
-- the whole table from the client, and PostgREST's aggregate functions are switched off on this
-- project ("Use of aggregate functions is not allowed"). Postgres sums it in one statement.
--
-- READ-ONLY, SECURITY INVOKER. Both functions only SELECT, and they run as the caller, so fin_txn's
-- own RLS (authenticated, 0196) is what decides access — nothing here widens it.
--
-- THE CENTRAL DAY IS DERIVED, never stored (0196): (created_at_utc at time zone 'America/Chicago').
-- The range bounds are converted the same way, so the created_at_utc index still serves the filter.

create or replace function public.fin_txn_rollup(
  p_from date,
  p_to date,                         -- inclusive, a Central date
  p_grain text default 'month',      -- 'day' | 'month'
  p_by_venue boolean default true,   -- false folds every venue together (fewer rows)
  p_venue_id bigint default null     -- only this venue's rows (the pace chart's Field filter)
)
returns table (
  period        date,     -- the Central day, or the first of the Central month
  kind          text,
  source        text,
  type          text,
  city          text,
  fin_venue_id  bigint,
  excluded      boolean,  -- test, internal or an exclude_reason: shown nowhere in revenue
  n             integer,
  gross_cents   bigint,
  fee_cents     bigint
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
    sum(t.fee_cents)::bigint
  from public.fin_txn t
  cross join lateral (select (t.created_at_utc at time zone 'America/Chicago')::date as d) x
  where t.created_at_utc >= (p_from::timestamp at time zone 'America/Chicago')
    and t.created_at_utc <  ((p_to + 1)::timestamp at time zone 'America/Chicago')
    and (p_venue_id is null or t.fin_venue_id = p_venue_id)
  group by 1, 2, 3, 4, 5, 6, 7
$$;

-- PER MATCH, for the Revenue page's Match tab. fin_txn carries no match id; the join is the payment
-- intent, which mdapi_match_players also stores. Measured on September 2026: 5,047 of 5,048 DPP
-- charges join, and no payment intent maps to more than one match.
--
-- Refunds and disputes carry no payment intent of their own, so they reach their match through the
-- charge they reverse (charge_id, filled for every reversal since f3434d9). A failed payment carries
-- the charge's payment intent and joins directly.
--
-- The window is the MATCH's date: mdapi_matches.start_date is LOCAL WALL CLOCK despite its Z, so the
-- bound is a UTC midnight compared against it, which is the wall-clock date.
create or replace function public.fin_txn_match_rollup(p_from date, p_to date)
returns table (
  match_api_id  bigint,
  kind          text,
  type          text,
  city          text,
  excluded      boolean,
  n             integer,
  gross_cents   bigint
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
    select pi.match_api_id, t.kind, t.type, t.city, t.is_test, t.is_internal, t.exclude_reason, t.gross_cents
    from public.fin_txn t
    join pi on pi.payment_intent_id = t.payment_intent_id
    union all
    select pi.match_api_id, v.kind, v.type, v.city, v.is_test, v.is_internal, v.exclude_reason, v.gross_cents
    from public.fin_txn v
    join public.fin_txn c on c.charge_id = v.charge_id and c.kind = 'charge'
    join pi on pi.payment_intent_id = c.payment_intent_id
    where v.payment_intent_id is null and v.kind in ('refund', 'dispute', 'failed')
  )
  select
    r.match_api_id, r.kind, coalesce(r.type, 'Unclassified'), r.city,
    (r.is_test or r.is_internal or r.exclude_reason is not null),
    count(*)::integer, sum(r.gross_cents)::bigint
  from r
  group by 1, 2, 3, 4, 5
$$;

-- The two joins above. Built once, small (118k rows).
create index if not exists fin_txn_payment_intent_idx on public.fin_txn (payment_intent_id) where payment_intent_id is not null;
create index if not exists fin_txn_charge_idx         on public.fin_txn (charge_id)         where charge_id is not null;
create index if not exists mdapi_match_players_pi_idx on public.mdapi_match_players (payment_intent_id) where payment_intent_id is not null;

revoke all on function public.fin_txn_rollup(date, date, text, boolean, bigint) from public, anon;
revoke all on function public.fin_txn_match_rollup(date, date) from public, anon;
grant execute on function public.fin_txn_rollup(date, date, text, boolean, bigint) to authenticated, service_role;
grant execute on function public.fin_txn_match_rollup(date, date) to authenticated, service_role;
