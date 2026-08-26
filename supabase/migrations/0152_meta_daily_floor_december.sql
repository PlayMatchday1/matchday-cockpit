-- 0152 — the DAILY store's floor moves to 2025-12-01. THE LEDGER'S FLOOR DOES NOT MOVE.
--
-- TWO FLOORS, DIFFERENT REASONS. 0151 gave fin_meta_ad_spend_daily a CHECK at 2026-08-01 because
-- at the time one constant served both purposes. They are not the same constraint and must never
-- be re-merged:
--
--   fin_meta_ad_spend_daily  >= 2025-12-01   (this migration)
--   fin_expenses ownership   >= 2026-08-01   (UNCHANGED, and enforced in code)
--
-- WHY THE LEDGER FLOOR STAYS, written here so it does not get "tidied" later: fin_expenses HAS NO
-- ROWS OF ANY KIND BEFORE 2026-04-30 — no venue cost, no manager pay, no salaries. Loading ad spend
-- into Dec–Mar would produce five months of P&L showing marketing cost against nothing else: a
-- statement that reads as COMPLETE and is not. A missing number looks missing; a half-populated
-- month does not. The daily table has no such problem because it only ever claims to be ad spend.
--
-- WHY DECEMBER AND NOT NOVEMBER. Meta's comscore_market breakdown does not exist before 2025-11 —
-- probed month by month, zero rows returned, with December in the same table as the positive
-- control proving the query works. November is only 91.3% covered ($1,992.14 of $2,181.24) and
-- there is no way to say which city lost the remainder, so it is skipped rather than loaded at a
-- known 8.7% understatement.
--
-- NOTHING IN THIS MIGRATION TOUCHES fin_expenses.

alter table public.fin_meta_ad_spend_daily
  drop constraint if exists fin_meta_ad_spend_daily_floor;
alter table public.fin_meta_ad_spend_daily add constraint fin_meta_ad_spend_daily_floor
  check (spend_date >= date '2025-12-01');

-- VERDICT. november_still_refused proves the new floor is a real boundary and not just "lower":
-- a 2025-11-30 row must still be rejected. Both probes roll back.
do $$
begin
  insert into public.fin_meta_ad_spend_daily (spend_date, market_raw, spend_cents, ad_account_id, currency)
  values (date '2025-11-30', '__probe__', 0, '__probe__', 'USD');
  raise exception 'FLOOR TOO LOW: a November row was accepted';
exception when check_violation then null;
end $$;

do $$
begin
  insert into public.fin_meta_ad_spend_daily (spend_date, market_raw, spend_cents, ad_account_id, currency)
  values (date '2025-12-01', '__probe__', 0, '__probe__', 'USD');
  delete from public.fin_meta_ad_spend_daily where market_raw = '__probe__';
exception when check_violation then
  raise exception 'FLOOR TOO HIGH: December is still refused';
end $$;

select
  (select count(*) from pg_constraint
     where conname = 'fin_meta_ad_spend_daily_floor'
       and pg_get_constraintdef(oid) like '%2025-12-01%')                    as daily_floor_is_december,
  true                                                                        as november_still_refused,
  (select count(*) from public.fin_meta_ad_spend_daily where market_raw = '__probe__') as probe_rows_left,
  (select count(*) from public.fin_expenses)                                  as fin_expenses_rowcount_untouched,
  (select coalesce(sum(amount), 0) from public.fin_expenses
     where vendor = 'Meta' and manual_entry = false and date >= date '2026-08-01') as august_meta_total_untouched;
