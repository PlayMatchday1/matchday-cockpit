-- Phase C: weekly payment tracking.
--
-- Adds payment configuration columns to partner_dashboards + a new
-- partner_weekly_payments ledger table. Anon can flag disputes on
-- weeks belonging to enabled partner dashboards; everything else is
-- admin-only. Defense in depth: column-level GRANT restricts surface
-- area, RLS USING gates which rows, RLS WITH CHECK gates what the
-- row becomes, and a trigger owns disputed_at so anon can't fake it.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

-- 1. partner_dashboards payment configuration.
ALTER TABLE partner_dashboards
  ADD COLUMN IF NOT EXISTS revenue_share_pct  numeric(5,2) NOT NULL DEFAULT 50.00,
  ADD COLUMN IF NOT EXISTS payment_start_date date,
  ADD COLUMN IF NOT EXISTS payment_day_of_week smallint    NOT NULL DEFAULT 0;

ALTER TABLE partner_dashboards
  DROP CONSTRAINT IF EXISTS partner_dashboards_share_range;
ALTER TABLE partner_dashboards
  ADD CONSTRAINT partner_dashboards_share_range
  CHECK (revenue_share_pct >= 0 AND revenue_share_pct <= 100);

ALTER TABLE partner_dashboards
  DROP CONSTRAINT IF EXISTS partner_dashboards_dow_range;
ALTER TABLE partner_dashboards
  ADD CONSTRAINT partner_dashboards_dow_range
  CHECK (payment_day_of_week BETWEEN 0 AND 6);

-- 2. Weekly payment ledger.
CREATE TABLE IF NOT EXISTS partner_weekly_payments (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_dashboard_id uuid          NOT NULL REFERENCES partner_dashboards(id) ON DELETE CASCADE,
  week_start_date      date          NOT NULL,
  calculated_amount    numeric(10,2) NOT NULL,
  status               text          NOT NULL DEFAULT 'pending'
                                     CHECK (status IN ('pending','paid','disputed')),
  paid_at              timestamptz,
  paid_notes           text,
  dispute_note         text,
  disputed_at          timestamptz,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (partner_dashboard_id, week_start_date)
);

CREATE INDEX IF NOT EXISTS partner_weekly_payments_pd_week_idx
  ON partner_weekly_payments(partner_dashboard_id, week_start_date);

-- updated_at maintenance.
CREATE OR REPLACE FUNCTION partner_weekly_payments_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS partner_weekly_payments_updated_at ON partner_weekly_payments;
CREATE TRIGGER partner_weekly_payments_updated_at
  BEFORE UPDATE ON partner_weekly_payments
  FOR EACH ROW EXECUTE FUNCTION partner_weekly_payments_set_updated_at();

-- Stamp disputed_at on transition into 'disputed'. The trigger guards
-- against re-stamping on a no-op transition, preserving the original
-- timestamp even if the partner edits dispute_note later.
CREATE OR REPLACE FUNCTION partner_weekly_payments_stamp_disputed_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'disputed' AND (OLD.status IS DISTINCT FROM 'disputed') THEN
    NEW.disputed_at = now();
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS partner_weekly_payments_stamp_disputed_at_tr ON partner_weekly_payments;
CREATE TRIGGER partner_weekly_payments_stamp_disputed_at_tr
  BEFORE UPDATE ON partner_weekly_payments
  FOR EACH ROW EXECUTE FUNCTION partner_weekly_payments_stamp_disputed_at();

-- 3. RLS.
ALTER TABLE partner_weekly_payments ENABLE ROW LEVEL SECURITY;

-- Anon SELECT: rows whose parent partner_dashboard is enabled.
DROP POLICY IF EXISTS partner_weekly_payments_anon_read ON partner_weekly_payments;
CREATE POLICY partner_weekly_payments_anon_read
  ON partner_weekly_payments FOR SELECT TO anon
  USING (
    EXISTS (
      SELECT 1 FROM partner_dashboards pd
      WHERE pd.id = partner_weekly_payments.partner_dashboard_id
        AND pd.enabled = true
    )
  );

-- Authenticated cockpit users: full access.
DROP POLICY IF EXISTS partner_weekly_payments_auth_read ON partner_weekly_payments;
CREATE POLICY partner_weekly_payments_auth_read
  ON partner_weekly_payments FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS partner_weekly_payments_auth_write ON partner_weekly_payments;
CREATE POLICY partner_weekly_payments_auth_write
  ON partner_weekly_payments FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Anon UPDATE: only the dispute path. Combined with column-level
-- GRANT below, anon can ONLY change (status, dispute_note). The
-- WITH CHECK ensures the resulting row has status='disputed' AND
-- still belongs to an enabled dashboard.
DROP POLICY IF EXISTS partner_weekly_payments_anon_dispute ON partner_weekly_payments;
CREATE POLICY partner_weekly_payments_anon_dispute
  ON partner_weekly_payments FOR UPDATE TO anon
  USING (
    EXISTS (
      SELECT 1 FROM partner_dashboards pd
      WHERE pd.id = partner_weekly_payments.partner_dashboard_id
        AND pd.enabled = true
    )
  )
  WITH CHECK (
    status = 'disputed'
    AND EXISTS (
      SELECT 1 FROM partner_dashboards pd
      WHERE pd.id = partner_weekly_payments.partner_dashboard_id
        AND pd.enabled = true
    )
  );

-- 4. Column-level grants for anon. SELECT all, UPDATE only the two
-- dispute columns. disputed_at is stamped by trigger; all financial
-- columns (calculated_amount, paid_at, paid_notes) are off-limits.
REVOKE ALL ON partner_weekly_payments FROM anon;
GRANT SELECT ON partner_weekly_payments TO anon;
GRANT UPDATE (status, dispute_note) ON partner_weekly_payments TO anon;

-- 5. Seed PAC Global's payment configuration. Other partners stay at
-- revenue_share_pct=50 + payment_start_date=NULL (payment system off
-- until an admin configures it via /admin/finance/partners/[id]).
UPDATE partner_dashboards
   SET payment_start_date = '2026-05-01'
 WHERE slug = 'pac-global-7vdybfv4';
