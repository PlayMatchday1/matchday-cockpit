-- A FOURTH PAYOUT MODEL, so the third can be switched back to in seconds.
--
-- RENTAL_FLOOR_PROFIT_SHARE. The rental is a FLOOR UNDER THE SPLIT, not a deduction from the pool:
--
--   pool         = gross − matchManager          the rental is NOT deducted
--   split        = max(0, pool) × sharePct/100
--   amountToPay  = max(0, split − fieldRental)   the rental is already paid
--   partnerTotal = fieldRental + amountToPay     i.e. max(fieldRental, split)
--
-- The shipped RENTAL_PLUS_PROFIT_SHARE is untouched, in the code and here. Above the floor the old
-- model pays exactly (1 − s)·F = $96 more per match on Parmer's numbers, whatever the revenue,
-- because it removed the rental from the pool and then handed it back whole.
--
-- THIS MIGRATION ADDS NO COLUMNS. The new kind reads field_rental_cents, match_manager_cents and
-- partner_share_pct exactly as the old one does.
--
-- APPLY THIS BEFORE THE UPDATE THAT MOVES ANY ROW, and deploy the code before either: a row
-- pointing at a model the bundle does not know would fall back to the flat path and show the
-- partner a number from the wrong formula.
--
-- Apply via Supabase Dashboard -> SQL Editor -> paste & run.

-- 1) The enum, widened by one value. Everything else in 0123 stands.
alter table partner_dashboards
  drop constraint if exists partner_dashboards_payout_model_range;

alter table partner_dashboards
  add constraint partner_dashboards_payout_model_range
  check (payout_model in (
    'REVENUE_SHARE',
    'PER_MATCH_MINUS_MANAGER',
    'RENTAL_PLUS_PROFIT_SHARE',
    'RENTAL_FLOOR_PROFIT_SHARE'
  ));

-- 2) THE PARAMETER GUARD FROM 0123 MUST ACCEPT THE NEW KIND, or the switch below is refused.
--    0123 wrote it as `payout_model <> 'RENTAL_PLUS_PROFIT_SHARE' OR (…three params present…)`,
--    which is TRUE for any other model — so on the new kind the guard would pass vacuously and a
--    partner could sit on the floor model with a null rental and be paid on nulls. It is rewritten
--    to name both rental kinds, so the same three parameters are required of both.
alter table partner_dashboards
  drop constraint if exists partner_dashboards_payout_params_present;

alter table partner_dashboards
  add constraint partner_dashboards_payout_params_present check (
    (payout_model not in ('RENTAL_PLUS_PROFIT_SHARE', 'RENTAL_FLOOR_PROFIT_SHARE'))
    or (field_rental_cents is not null and field_rental_cents >= 0
        and match_manager_cents is not null and match_manager_cents >= 0
        and partner_share_pct is not null and partner_share_pct >= 0 and partner_share_pct <= 100)
  );

-- partner_dashboards_revenue_share_params_present is UNCHANGED and needs no edit: it is keyed on
-- `payout_model <> 'REVENUE_SHARE'`, which the new kind satisfies without carrying payout_share_pct.

-- Proof queries after applying:
--   -- the four partners, unchanged except for whichever kind Parmer is on:
--   select partner_name, payout_model, field_rental_cents, match_manager_cents, partner_share_pct
--     from partner_dashboards order by created_at;
--
--   -- must FAIL with a check-constraint violation (the proof the widened guard still bites):
--   -- update partner_dashboards set field_rental_cents = null
--   --  where slug = 'parmer-stadium-q8x2m5rk';
--
--   -- must FAIL (the proof the enum is closed, not open):
--   -- update partner_dashboards set payout_model = 'SOMETHING_ELSE'
--   --  where slug = 'parmer-stadium-q8x2m5rk';

-- ── THE SWITCH, AND THE SWITCH BACK ────────────────────────────────────────────────────────────
-- Not run by this migration. Both are guarded on the CURRENT value, so each is idempotent and
-- neither can move a row that is not where it is expected to be.
--
--   -- forward, to the corrected formula:
--   update partner_dashboards
--      set payout_model = 'RENTAL_FLOOR_PROFIT_SHARE'
--    where slug = 'parmer-stadium-q8x2m5rk'
--      and payout_model = 'RENTAL_PLUS_PROFIT_SHARE';
--
--   -- back, to the shipped one:
--   update partner_dashboards
--      set payout_model = 'RENTAL_PLUS_PROFIT_SHARE'
--    where slug = 'parmer-stadium-q8x2m5rk'
--      and payout_model = 'RENTAL_FLOOR_PROFIT_SHARE';
--
-- Either takes effect on the next page load. No deploy, and the dashboard prints which model it is
-- on, so the switch is visible rather than something you have to remember having done.
