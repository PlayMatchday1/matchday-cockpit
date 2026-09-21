-- 0189 — MEMBER SPOTS COUNT TOWARD QUALIFYING REVENUE, FOR HATTRICK, FROM SEPTEMBER 2026.
--
-- ══ WHAT CHANGES ══════════════════════════════════════════════════════════════════════════════
--
-- `flat_percentage` pays a share of DPP revenue plus private rentals. A MEMBER spot is a free
-- booking against an active subscription, so its own match_price_paid is $0 and it has always been
-- skipped. From September 2026 Hattrick's member spots count at the DPP LIST PRICE of the field:
-- the same price a daily player pays there.
--
-- ══ WHY A NEW MODEL AND NOT A DATE IN THE CODE ════════════════════════════════════════════════
--
-- Two decisions have to be expressed: WHICH PARTNER, and FROM WHEN. A date gate in the calculation
-- expresses only the second, leaving "Hattrick only" as a separate condition somewhere else, and
-- the day PAC Global or Parmer takes a member spot they are silently enrolled by a rule nobody
-- wrote for them. The dated successor carries both on one row, and it is the mechanism Crossbar
-- already uses (0150).
--
-- PAC GLOBAL AND PARMER ARE ON THE SAME MODEL AND ARE DELIBERATELY NOT TOUCHED. They currently
-- contribute $0 of member spots, which is exactly why the scoping has to be explicit now rather
-- than discovered later: a predicate over revenue_model = 'flat_percentage' would have caught all
-- three and nobody would have noticed until one of them took a member.
--
-- APRIL THROUGH AUGUST MUST NOT MOVE. modelForPeriod returns the successor only when
-- periodStart >= revenue_model_from, so every closed month resolves to plain flat_percentage
-- through the same path it does today. partner_weekly_payments already freezes a paid amount and
-- PartnerMonthlyView marks a divergence when a recompute disagrees, so a model flipped in place
-- would put a "figures changed after payment" asterisk on five settled months on a page the
-- partner reads.
--
-- ══ THE RATE, AND WHY IT IS PERSISTED RATHER THAN READ ════════════════════════════════════════
--
-- fin_venues.dpp_price for venue 3 reads $8.00 and is the price actually charged: MEASURED over
-- Hattrick's September bookings, 242 of 283 priced daily rows are $8 and the rest are exact
-- multiples of $8, which is one person buying two to six spots.
--
-- NOT fin_pricing.dpp_price, which reads $5 for Hattrick. Every fin_pricing row carries the same
-- updated_at of 2026-04-25, it has no editor anywhere in the app, and $5 was Hattrick's price
-- earlier in the period rather than its price now. fin_venues.dpp_price has a live editor in Field
-- Costs and agrees with the charges. The partner-facing sentence says a member spot counts at the
-- same price a daily player pays at your field; at $5 that sentence would be false.
--
-- AND fin_venues.dpp_price IS EDITABLE, WHICH IS THE WHOLE PROBLEM. It is one live config value
-- with no history. Read at render time, an edit would re-value every period that recomputes from
-- it, including months already paid. So the rate used is FROZEN ONTO THE PAYMENT ROW when the
-- period is generated, and a period that carries one reports from that column rather than from
-- config. A paid period then carries its own evidence and the dashboard can show which rate it
-- was paid at.
--
-- THE ALTERNATIVE WAS "CLOSED PERIODS NEVER RECOMPUTE", and it was rejected: it depends on a
-- status being correct at read time, and it leaves no record of what was actually used.
--
-- CENTS, AND THE NAME SAYS SO, exactly as 0150's per_match_fee_cents does. fin_venues.dpp_price is
-- numeric DOLLARS while mdapi_match_players.amount is CENTS, and this codebase has already eaten
-- an 80x error from that divide being missed once.

begin;

-- ── 1. THE NEW SUCCESSOR MODEL ────────────────────────────────────────────────────────────────
-- The CURRENT model keeps its original allowlist, unchanged from 0150: nothing may retroactively
-- become a member-spot model. Only the SUCCESSOR list grows.
alter table public.partner_dashboards
  drop constraint if exists partner_dashboards_revenue_model_next_range;
alter table public.partner_dashboards add constraint partner_dashboards_revenue_model_next_range
  check (revenue_model_next is null
      or revenue_model_next in ('flat_percentage', 'per_match_minus_manager', 'per_match_fee',
                                'flat_percentage_with_members'));

-- ── 2. THE FROZEN RATE, ON THE PAYMENT ROW ────────────────────────────────────────────────────
-- NULL means "this period was not computed under a member-spot model", which is every existing
-- row and every future row for every other partner. It is NOT "the rate was zero": a period that
-- should have had a rate and has none reports that it could not be valued, and says why.
alter table public.partner_weekly_payments
  add column if not exists member_spot_rate_cents integer,
  add column if not exists member_spots           integer;

comment on column public.partner_weekly_payments.member_spot_rate_cents is
  'The DPP list price in CENTS that this period''s member spots were valued at, frozen when the '
  'period was generated. NULL for periods not computed under a member-spot model. Never read '
  'fin_venues.dpp_price for a period that carries this column.';
comment on column public.partner_weekly_payments.member_spots is
  'Member spots PLAYED in the period (player-cancelled bookings excluded), frozen alongside the '
  'rate so the pair can be re-derived and shown to the partner.';

-- A RATE WITHOUT A COUNT, OR A COUNT WITHOUT A RATE, IS HALF A RECORD. Same both-or-neither shape
-- 0150 put on the successor pair, and for the same reason: half a frozen figure reads as frozen
-- and recomputes from config.
alter table public.partner_weekly_payments
  drop constraint if exists partner_weekly_payments_member_freeze_pair;
alter table public.partner_weekly_payments add constraint partner_weekly_payments_member_freeze_pair
  check ((member_spot_rate_cents is null and member_spots is null)
      or (member_spot_rate_cents is not null and member_spots is not null));

-- A negative rate or a negative count is not a discount, it is a bug.
alter table public.partner_weekly_payments
  drop constraint if exists partner_weekly_payments_member_nonneg;
alter table public.partner_weekly_payments add constraint partner_weekly_payments_member_nonneg
  check ((member_spot_rate_cents is null or member_spot_rate_cents >= 0)
     and (member_spots is null or member_spots >= 0));

commit;

-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- ══ THE UPDATE. SEPARATE, AND RYAN APPROVES IT SEPARATELY. ════════════════════════════════════
-- ══════════════════════════════════════════════════════════════════════════════════════════════
--
-- BOUNDED BY PRIMARY KEY, never by a predicate over revenue_model. `where revenue_model =
-- 'flat_percentage'` would enrol PAC Global and Parmer in the same statement, which is precisely
-- the decision this brief rules out, and it would do it silently because both currently add $0.
--
-- The id below is Hattrick's partner_dashboards row, read from production 2026-09-21:
--   id 1dcda3cf-3854-4ad9-aafa-0b6c07f64b60 · partner_name 'Hattrick' · venue_id 3 · flat_percentage
--
-- THE partner_name IS IN THE PREDICATE AS A BELT. It cannot widen the statement (the id already
-- selects one row) and it makes the statement refuse rather than act if the id is ever wrong.
-- pg_safeupdate requires a WHERE clause; this has two.
--
-- RUN THIS ONLY AFTER THE MIGRATION ABOVE HAS COMMITTED. The CHECK constraint must already allow
-- 'flat_percentage_with_members' or this UPDATE is rejected with 23514.
--
--   update public.partner_dashboards
--      set revenue_model_next = 'flat_percentage_with_members',
--          revenue_model_from = '2026-09-01'
--    where id = '1dcda3cf-3854-4ad9-aafa-0b6c07f64b60'
--      and partner_name = 'Hattrick';
--
-- EXPECTED: UPDATE 1. Anything else, roll back and stop.
--
-- TO VERIFY, and to prove the other two were not caught:
--
--   select partner_name, venue_id, revenue_model, revenue_model_next, revenue_model_from
--     from public.partner_dashboards
--    order by partner_name;
--
-- EXPECTED: Hattrick carries the successor and the date; Crossbar Rowlett still carries
-- per_match_fee / 2026-08-01; PAC Global and Parmer carry NULL in both columns.
--
-- TO UNDO:
--
--   update public.partner_dashboards
--      set revenue_model_next = null, revenue_model_from = null
--    where id = '1dcda3cf-3854-4ad9-aafa-0b6c07f64b60'
--      and partner_name = 'Hattrick';
