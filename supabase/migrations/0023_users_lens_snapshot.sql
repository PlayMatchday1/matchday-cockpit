CREATE TABLE IF NOT EXISTS mdapi_users_lens_snapshot (
  window_key TEXT NOT NULL,
  city TEXT NOT NULL,
  registered INTEGER NOT NULL,
  completed_signup INTEGER NOT NULL,
  played_1plus INTEGER NOT NULL,
  played_3plus INTEGER NOT NULL,
  played_5plus INTEGER NOT NULL,
  played_10plus INTEGER NOT NULL,
  members INTEGER NOT NULL,
  active_30d INTEGER NOT NULL,
  active_60d INTEGER NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (window_key, city)
);

CREATE INDEX IF NOT EXISTS mdapi_users_lens_snapshot_window_idx ON mdapi_users_lens_snapshot(window_key);

ALTER TABLE mdapi_users_lens_snapshot ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mdapi_users_lens_snapshot_auth_select ON mdapi_users_lens_snapshot;
CREATE POLICY mdapi_users_lens_snapshot_auth_select ON mdapi_users_lens_snapshot FOR SELECT TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS mdapi_users_lens_aggregate_snapshot (
  window_key TEXT PRIMARY KEY,
  growth_monthly_signups JSONB NOT NULL,
  growth_monthly_completed JSONB NOT NULL,
  growth_monthly_played JSONB NOT NULL,
  growth_weekly_signups JSONB NOT NULL,
  growth_weekly_completed JSONB NOT NULL,
  growth_weekly_played JSONB NOT NULL,
  matrix_data JSONB NOT NULL,
  funnel_speed JSONB NOT NULL,
  network_active_30d INTEGER NOT NULL,
  network_played_1plus INTEGER NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE mdapi_users_lens_aggregate_snapshot ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mdapi_users_lens_aggregate_snapshot_auth_select ON mdapi_users_lens_aggregate_snapshot;
CREATE POLICY mdapi_users_lens_aggregate_snapshot_auth_select ON mdapi_users_lens_aggregate_snapshot FOR SELECT TO authenticated USING (true);

ALTER TABLE fin_sync_log
  DROP CONSTRAINT IF EXISTS fin_sync_log_source_check;

ALTER TABLE fin_sync_log
  ADD CONSTRAINT fin_sync_log_source_check
  CHECK (source IN (
    'stripe-api',
    'mdapi-reviews',
    'mdapi-subscriptions',
    'mdapi-promocodes',
    'mdapi-matches',
    'mdapi-users',
    'mdapi-users-lens-snapshot',
    'membership-snapshots'
  ));
