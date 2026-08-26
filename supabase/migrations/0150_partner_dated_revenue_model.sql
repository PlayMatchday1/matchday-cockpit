-- 0150 — A PARTNER'S PAYOUT MODEL CAN NOW CHANGE ON A DATE.
--
-- Crossbar Rowlett moves from `per_match_minus_manager` to a flat $100 per match that goes ahead,
-- effective 2026-08-01. May, June and July are settled and paid ($0 / $161 / $1,000) and MUST NOT
-- MOVE — not in the ledger and not in a recompute.
--
-- WHY DATING IT, RATHER THAN JUST EDITING THE MODEL. partner_weekly_payments already freezes a paid
-- amount, and PartnerMonthlyView renders the frozen figure with a divergence marker when a fresh
-- recompute disagrees. So flipping revenue_model in place would keep the NUMBERS right and still
-- put a "figures changed after payment" asterisk on all three settled months — on a page the
-- partner reads. Dating the change means those months recompute exactly as before and no marker
-- ever appears.
--
-- NOTHING ELSE IN THIS CODEBASE DATES A RATE. fin_venues carries one billing_type and one rate;
-- fin_venue_cost_overrides is a per-(venue, month) billing-timing lump and deliberately unread by
-- the Field Costs page. This is the first rate history, and it is deliberately the SMALLEST one
-- that works: one successor model and one date on the partner row, not a general history table.
-- A second dated change would justify that table; one does not.

alter table public.partner_dashboards
  add column if not exists revenue_model_next  text,
  add column if not exists revenue_model_from  date,
  -- CENTS, AND THE NAME SAYS SO. mdapi_match_players.amount is numeric(10,2) and holds CENTS —
  -- mdapiMatchesRead.ts:496 divides by 100 to get dollars. Reconstructing these very months
  -- against that column produced an 80x error before the divide was found. A column whose name
  -- carries its unit cannot be read the wrong way by the next person.
  add column if not exists per_match_fee_cents integer;

-- The CURRENT model keeps its original allowlist: nothing may retroactively become a fee.
alter table public.partner_dashboards
  drop constraint if exists partner_dashboards_revenue_model_range;
alter table public.partner_dashboards add constraint partner_dashboards_revenue_model_range
  check (revenue_model in ('flat_percentage', 'per_match_minus_manager'));

alter table public.partner_dashboards
  drop constraint if exists partner_dashboards_revenue_model_next_range;
alter table public.partner_dashboards add constraint partner_dashboards_revenue_model_next_range
  check (revenue_model_next is null
      or revenue_model_next in ('flat_percentage', 'per_match_minus_manager', 'per_match_fee'));

-- BOTH OR NEITHER — the constraint that stops a rate change from HIDING.
-- A successor model with no date silently never applies. A date with no successor silently applies
-- nothing. Either half alone reads as configured in the admin UI and pays out the old terms
-- forever, which is the exact failure shape that goes unnoticed until a partner asks.
alter table public.partner_dashboards
  drop constraint if exists partner_dashboards_model_next_paired;
alter table public.partner_dashboards add constraint partner_dashboards_model_next_paired
  check ((revenue_model_next is null) = (revenue_model_from is null));

-- A fee model without a fee is the same class of silent no-op, so it is refused too.
alter table public.partner_dashboards
  drop constraint if exists partner_dashboards_fee_requires_rate;
alter table public.partner_dashboards add constraint partner_dashboards_fee_requires_rate
  check (revenue_model_next is distinct from 'per_match_fee'
      or (per_match_fee_cents is not null and per_match_fee_cents > 0));

-- Ryan's ruling, 2026-08-25: from Aug 1, $100 per match that actually goes ahead; a cancelled
-- match pays nothing. That matches fin_venues.charge_on_cancel = false already set on venue 51,
-- so the cost side and the partner side agree without further change.
update public.partner_dashboards
   set revenue_model_next  = 'per_match_fee',
       revenue_model_from  = '2026-08-01',
       per_match_fee_cents = 10000
 where slug like 'crossbar-rowlett-%';

-- VERDICT ROW. paired must be true, fee_cents 10000, and the three settled months must still be
-- present and paid at their original amounts — this migration must not touch them.
select
  (select count(*) from public.partner_dashboards
    where slug like 'crossbar-rowlett-%'
      and revenue_model = 'per_match_minus_manager'
      and revenue_model_next = 'per_match_fee'
      and revenue_model_from = '2026-08-01'
      and per_match_fee_cents = 10000) as crossbar_configured,
  (select string_agg(week_start_date::text || '=' || calculated_amount::text, ', ' order by week_start_date)
     from public.partner_weekly_payments p
     join public.partner_dashboards d on d.id = p.partner_dashboard_id
    where d.slug like 'crossbar-rowlett-%') as settled_months_unchanged;
