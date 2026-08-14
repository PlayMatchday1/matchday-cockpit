-- Phase 28 — the PAYOUT MODEL becomes a property of the partner record.
--
-- ── A CORRECTION TO THE BRIEF, MADE DELIBERATELY ────────────────────────────────────────────────
-- The brief said "the three existing partners are paid 50% of qualifying revenue" and asked for
-- TWO models. Only TWO of the three are on 50%: PAC Global and Hattrick. The third, Crossbar
-- Rowlett, has been on `per_match_minus_manager` since migration 0057 — max(0, Σ match revenue −
-- Σ manager pay), with manager pay keyed on match CAPACITY. Folding Crossbar into REVENUE_SHARE
-- would have changed its numbers, and "their numbers must not change by a cent" is the binding
-- instruction. So this migration recognises THREE payout models, not two.
--
--   REVENUE_SHARE            PAC Global, Hattrick.   Parameter: payout_share_pct (50).
--   PER_MATCH_MINUS_MANAGER  Crossbar Rowlett.       Parameters: the existing manager_pay_* columns.
--   RENTAL_PLUS_PROFIT_SHARE Parmer (new).           Parameters: the three *_cents/pct columns below.
--
-- The legacy `revenue_model` column is LEFT EXACTLY AS IT IS and keeps driving periodOwed() for the
-- first two models. `payout_model` is the new, explicit selector; it is derived from revenue_model
-- for every existing row, so nothing recomputes and no existing figure can move. Deleting or
-- rewriting revenue_model was the tempting cleanup and is precisely what would have changed a
-- number — the old column is the thing three live payouts already agree with.
--
-- MONEY IS STORED IN CENTS in the new columns. The pre-existing manager_pay_* columns are
-- numeric(10,2) DOLLARS and are deliberately not converted: they feed a computation that is
-- already correct and already reconciled with three months of real payments.

-- 1) The selector. Defaults derived from revenue_model so every existing row keeps its behaviour.
alter table partner_dashboards
  add column if not exists payout_model text not null default 'REVENUE_SHARE';

-- 2) The REVENUE_SHARE parameter. Seeded from the existing revenue_share_pct, so the two flat
--    partners carry forward the exact percentage their payments were computed with.
alter table partner_dashboards
  add column if not exists payout_share_pct numeric(5,2);

-- 3) The RENTAL_PLUS_PROFIT_SHARE parameters, in CENTS. Null for every other model.
alter table partner_dashboards
  add column if not exists field_rental_cents      integer,
  add column if not exists match_manager_cents     integer,
  add column if not exists partner_share_pct       numeric(5,2),
  -- The spot price the BREAKEVEN line is derived from. Stored rather than inferred so a venue that
  -- changes its price does not silently change the published breakeven figure mid-month.
  add column if not exists spot_price_cents        integer;

-- 4) Backfill from the model that is live today. No row changes behaviour.
update partner_dashboards
   set payout_model     = case revenue_model
                            when 'per_match_minus_manager' then 'PER_MATCH_MINUS_MANAGER'
                            else 'REVENUE_SHARE'
                          end,
       payout_share_pct = coalesce(payout_share_pct, revenue_share_pct, 50)
 where payout_model is not null;   -- always true; satisfies pg_safeupdate

alter table partner_dashboards
  drop constraint if exists partner_dashboards_payout_model_range;
alter table partner_dashboards
  add constraint partner_dashboards_payout_model_range
  check (payout_model in ('REVENUE_SHARE', 'PER_MATCH_MINUS_MANAGER', 'RENTAL_PLUS_PROFIT_SHARE'));

-- 5) A model must carry its own parameters. Enforced at the database so a half-configured partner
--    cannot be saved and then quietly pay someone the wrong amount.
alter table partner_dashboards
  drop constraint if exists partner_dashboards_payout_params_present;
alter table partner_dashboards
  add constraint partner_dashboards_payout_params_present check (
    (payout_model <> 'RENTAL_PLUS_PROFIT_SHARE')
    or (field_rental_cents is not null and field_rental_cents >= 0
        and match_manager_cents is not null and match_manager_cents >= 0
        and partner_share_pct is not null and partner_share_pct >= 0 and partner_share_pct <= 100)
  );
alter table partner_dashboards
  drop constraint if exists partner_dashboards_revenue_share_params_present;
alter table partner_dashboards
  add constraint partner_dashboards_revenue_share_params_present check (
    (payout_model <> 'REVENUE_SHARE')
    or (payout_share_pct is not null and payout_share_pct >= 0 and payout_share_pct <= 100)
  );

-- 6) PARMER. The venue does not yet exist in fin_venues — PARMER Stadium (MatchDay field_id 1585,
--    Austin) has six matches from 2026-08-05 and no finance row — and partner_dashboards.venue_id
--    is a FK to fin_venues, so the venue is created first. venue_name is what fetchPartnerRows
--    ILIKEs against mdapi_matches.field_title, so it must match "PARMER Stadium".
insert into fin_venues (venue_name, city, billing_type, is_active, dpp_price, launch_date)
select 'PARMER Stadium', 'Austin', 'profit_share', true, 15, '2026-08-05'
 where not exists (select 1 from fin_venues where venue_name = 'PARMER Stadium');

-- The parameters, and the ONLY place they appear. 16000c field rental, 4000c match manager, 40%
-- partner share, 1500c a spot. One rental = one match.
insert into partner_dashboards (
  slug, venue_id, partner_name, enabled, payout_model,
  field_rental_cents, match_manager_cents, partner_share_pct, spot_price_cents,
  payment_start_date, payment_cadence, revenue_model, revenue_share_pct
)
select 'parmer-stadium-q8x2m5rk',
       (select id from fin_venues where venue_name = 'PARMER Stadium'),
       'Parmer', true, 'RENTAL_PLUS_PROFIT_SHARE',
       16000, 4000, 40, 1500,
       '2026-08-01', 'monthly',
       -- revenue_model is left on its default so the legacy periodOwed() path, which knows nothing
       -- of this model, can never be handed a partner it would mis-compute. payout_model is what
       -- selects the formula.
       'flat_percentage', 50
 where not exists (select 1 from partner_dashboards where slug = 'parmer-stadium-q8x2m5rk');

-- Proof queries after applying:
--   -- the three existing partners must be UNCHANGED in model and percentage:
--   select partner_name, payout_model, payout_share_pct, revenue_model, revenue_share_pct,
--          manager_pay_base, manager_pay_high, manager_pay_threshold
--     from partner_dashboards order by created_at;
--   -- expect: PAC Global REVENUE_SHARE/50/flat_percentage, Hattrick REVENUE_SHARE/50/flat_percentage,
--   --         Crossbar Rowlett PER_MATCH_MINUS_MANAGER/50/per_match_minus_manager (20/30/25 intact),
--   --         Parmer RENTAL_PLUS_PROFIT_SHARE with 16000/4000/40/1500.
--
--   -- must return 0 — no partner may sit on a model without its parameters:
--   select count(*) from partner_dashboards
--    where (payout_model = 'RENTAL_PLUS_PROFIT_SHARE' and field_rental_cents is null)
--       or (payout_model = 'REVENUE_SHARE' and payout_share_pct is null);
--
--   -- must FAIL with a check-constraint violation (the proof the guard bites):
--   -- update partner_dashboards set field_rental_cents = null where slug = 'parmer-stadium-q8x2m5rk';

-- REVOKE / ROLLBACK — the WHERE is REQUIRED (pg_safeupdate rejects an unqualified UPDATE).
--   update partner_dashboards set enabled = false where slug = 'parmer-stadium-q8x2m5rk';
--   -- to fully undo, drop the constraints first, then the columns:
--   -- alter table partner_dashboards drop constraint if exists partner_dashboards_payout_params_present;
--   -- alter table partner_dashboards drop constraint if exists partner_dashboards_revenue_share_params_present;
--   -- alter table partner_dashboards drop constraint if exists partner_dashboards_payout_model_range;
--   -- alter table partner_dashboards drop column if exists payout_model, drop column if exists payout_share_pct,
--   --   drop column if exists field_rental_cents, drop column if exists match_manager_cents,
--   --   drop column if exists partner_share_pct, drop column if exists spot_price_cents;
