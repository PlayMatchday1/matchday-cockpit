ALTER TABLE mdapi_users_lens_aggregate_snapshot
  ADD COLUMN IF NOT EXISTS first_match_by_field_monthly JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE mdapi_users_lens_aggregate_snapshot
  ADD COLUMN IF NOT EXISTS first_match_by_field_weekly JSONB NOT NULL DEFAULT '[]'::jsonb;
