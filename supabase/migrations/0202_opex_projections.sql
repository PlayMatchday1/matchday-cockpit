-- 0202_opex_projections.sql — money that MIGHT leave, entered on OpEx only (Ryan, 2026-10-03).
--
-- A projection is added, edited and deleted on the OpEx page and nowhere else. It never creates a
-- venue or an expense, and only the OpEx page reads this table (src/lib/opexProjections.ts), so
-- it cannot reach Field Costs, Expenses, Cost, Cities, the P&L or the 2027 plan.
--
-- BEFORE APPLYING, run this and compare with the allowlist below; if it differs, stop:
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'fin_change_log_table_name_check';

BEGIN;

CREATE TABLE IF NOT EXISTS public.opex_projections (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category      text    NOT NULL CHECK (category IN ('pers','field','equip','mkt','subs','misc')),
  description   text    NOT NULL CHECK (length(btrim(description)) > 0),
  amount        numeric(12,2) NOT NULL CHECK (amount > 0),          -- per payment, dollars
  first_date    date    NOT NULL,
  repeat        text    NOT NULL CHECK (repeat IN ('once','weekly','biweekly','monthly')),
  end_date      date    NULL,                                       -- last day it may pay; null = open
  skipped_dates date[]  NOT NULL DEFAULT '{}',                      -- "remove this payment only"
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text    NOT NULL,
  updated_at    timestamptz NULL,
  updated_by    text    NULL,
  CONSTRAINT opex_projections_end_after_start CHECK (end_date IS NULL OR end_date >= first_date)
);

CREATE INDEX IF NOT EXISTS opex_projections_first_date_idx ON public.opex_projections (first_date);

ALTER TABLE public.opex_projections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS opex_projections_auth ON public.opex_projections;
CREATE POLICY opex_projections_auth ON public.opex_projections
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
REVOKE ALL ON public.opex_projections FROM anon;

-- Audit: fin_change_log's table_name allowlist gains opex_projections (0193's list + 1).
ALTER TABLE public.fin_change_log DROP CONSTRAINT IF EXISTS fin_change_log_table_name_check;
ALTER TABLE public.fin_change_log ADD CONSTRAINT fin_change_log_table_name_check
  CHECK (table_name IN (
    'fin_expenses', 'fin_revenue', 'fin_schedule', 'fin_venue_cost_overrides', 'fin_venues',
    'match_promotion_plan', 'fin_venue_fields', 'match_promotion_push',
    'match_promotion_field_tag', 'promo_tags', 'opex_projections'
  ));

COMMIT;
