-- Master Schedule: auto-reconcile completed matches + one-click add of one-off
-- entries. Additive only — no destructive changes.
--
--   schedule_master.match_api_id : the mdapi match this row represents (NULL for
--                                  the seeded recurring template rows).
--   schedule_master.source       : 'template'       — seeded recurring rows (existing data)
--                                   'manual'         — one-click "Add to schedule" (one-off)
--                                   'auto_completed' — auto-reconciled from a completed match (one-off)
--   partial UNIQUE(match_api_id)  : idempotency for auto-add / one-click add. A re-run
--                                   collides (23505 = no-op). Partial so the many existing
--                                   template rows (match_api_id IS NULL) never collide.
--   schedule_settings            : single-row control plane — the auto-reconcile kill
--                                   switch (ON by default, flippable without a deploy) plus
--                                   the run heartbeat (nobody waits on this job, so a silent
--                                   stall must be visible — same reason community_settings
--                                   has these).
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run BEFORE deploying.

ALTER TABLE schedule_master
  ADD COLUMN IF NOT EXISTS match_api_id bigint,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'template';

-- Constrain source to the known values — a typo'd source would silently break
-- the one-off vs recurring rendering. Idempotent (drop-then-add the named
-- constraint); safe because every existing row is the 'template' default.
ALTER TABLE schedule_master DROP CONSTRAINT IF EXISTS schedule_master_source_check;
ALTER TABLE schedule_master
  ADD CONSTRAINT schedule_master_source_check
  CHECK (source IN ('template', 'manual', 'auto_completed'));

CREATE UNIQUE INDEX IF NOT EXISTS schedule_master_match_api_id_uniq
  ON schedule_master(match_api_id) WHERE match_api_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS schedule_master_source_idx
  ON schedule_master(source);

CREATE TABLE IF NOT EXISTS schedule_settings (
  id                    smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  autoreconcile_enabled boolean     NOT NULL DEFAULT true,   -- kill switch, defaults ON
  last_attempted_at     timestamptz,
  last_success_at       timestamptz,
  last_status           text,
  last_error            text,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schedule_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE schedule_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS schedule_settings_admin_read ON schedule_settings;
CREATE POLICY schedule_settings_admin_read
  ON schedule_settings FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM app_users
      WHERE LOWER(app_users.email) = LOWER(auth.jwt() ->> 'email')
        AND app_users.is_admin = true
    )
  );
-- No client write policies — the reconcile job + admin routes write with the
-- service role (auto-reconcile gated by schedule_settings.autoreconcile_enabled;
-- one-click add + Undo gated by authenticateCrm → is_admin).
