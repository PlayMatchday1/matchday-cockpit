CREATE TABLE IF NOT EXISTS manager_pay_adjustments (
  id BIGSERIAL PRIMARY KEY,
  manager_id BIGINT,
  manager_email TEXT NOT NULL,
  week_start DATE NOT NULL,
  amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (manager_email, week_start)
);

CREATE INDEX IF NOT EXISTS manager_pay_adjustments_week_idx ON manager_pay_adjustments(week_start);
CREATE INDEX IF NOT EXISTS manager_pay_adjustments_email_idx ON manager_pay_adjustments(LOWER(manager_email));

ALTER TABLE manager_pay_adjustments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS manager_pay_adjustments_auth_select ON manager_pay_adjustments;
CREATE POLICY manager_pay_adjustments_auth_select ON manager_pay_adjustments FOR SELECT TO authenticated USING (true);
