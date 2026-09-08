-- 0163 — WHAT WAS ACTUALLY PAID, beside what the formula produced.
--
-- WHY. August 2026 for Parmer was paid $2,520.00. The two live formulas produce:
--     RENTAL_PLUS_PROFIT_SHARE   F + s*max(0, R - F - M)   = $2,360.00
--     RENTAL_FLOOR_PROFIT_SHARE  max(F, s*(R - M))         = $1,700.00   <- what the page computes
-- Both confirmed against the live August rows. The payment is neither, and $2,520 - $2,360 is
-- exactly one $160 field rental. So a real payment can differ from the model, and until now there
-- was nowhere to say so: Mark paid snapshots the COMPUTED figure into calculated_amount and offers
-- no way to record a different one.
--
-- WHY A NEW COLUMN AND NOT calculated_amount. calculated_amount means "what the formula said when
-- this was marked", and /api/partner-dashboards writes it from a server-side recompute for exactly
-- that reason — so a later data change cannot rewrite what was recorded. Overloading it with "what
-- was paid" would destroy the one thing that makes a disagreement visible. The two are different
-- facts and a month where they differ is the month you most want a record of.
--
-- NULL MEANS "PAID WHAT THE FORMULA SAID". Every existing row keeps its meaning untouched, and a
-- reader falls back to calculated_amount. No backfill.

alter table public.partner_weekly_payments
  add column if not exists paid_amount numeric(10,2);

comment on column public.partner_weekly_payments.paid_amount is
  'What was actually paid, when it differs from the formula. NULL = paid exactly calculated_amount. calculated_amount always keeps the computed figure so the two can be compared.';

-- A payment is a positive amount or nothing at all; a negative one is a data-entry slip, not a
-- refund (there is no refund path here).
alter table public.partner_weekly_payments
  add constraint partner_weekly_payments_paid_amount_nonneg
  check (paid_amount is null or paid_amount >= 0);
