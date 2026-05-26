-- Shared Finance Actions list. Renders at the top of every non-Cash-
-- Flow Finance tab (Cities, Field Ranking, Match P&L, Slate Review).
-- One global list across all users — replaces the per-(city,
-- week_start) slate_review_action_items section that used to live in
-- the middle of the Slate Review tab.
--
-- Status moves from a boolean is_done to a 4-state enum: open,
-- needs_follow_up, blocked, resolved. Adds a threaded comments table
-- so any user can discuss an action inline.
--
-- city is free-text rather than an enum so adding a 9th market
-- doesn't need another migration. The UI constrains it to the 8
-- markets + 'Company-wide' (the default for non-city-specific items
-- like fundraise / deck / company tasks).
--
-- slate_review_action_items is intentionally left in place but
-- unused — drop later once the new shape is settled.
--
-- Apply via Supabase Dashboard → SQL Editor → paste & run.

CREATE TABLE IF NOT EXISTS finance_actions (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  body        text          NOT NULL,
  status      text          NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open','needs_follow_up','blocked','resolved')),
  city        text          NOT NULL DEFAULT 'Company-wide',
  created_by  text          NOT NULL,
  created_at  timestamptz   NOT NULL DEFAULT now(),
  updated_at  timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS finance_actions_city_idx
  ON finance_actions(city);
CREATE INDEX IF NOT EXISTS finance_actions_status_idx
  ON finance_actions(status);
CREATE INDEX IF NOT EXISTS finance_actions_created_idx
  ON finance_actions(created_at DESC);

CREATE TABLE IF NOT EXISTS finance_action_comments (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id   uuid          NOT NULL REFERENCES finance_actions(id) ON DELETE CASCADE,
  body        text          NOT NULL,
  created_by  text          NOT NULL,
  created_at  timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS finance_action_comments_action_idx
  ON finance_action_comments(action_id, created_at);

-- RLS: authenticated cockpit users read+write. Same shape as
-- field_week_projections and the other internal-only finance tables.
ALTER TABLE finance_actions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_action_comments  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS finance_actions_auth ON finance_actions;
CREATE POLICY finance_actions_auth
  ON finance_actions FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS finance_action_comments_auth ON finance_action_comments;
CREATE POLICY finance_action_comments_auth
  ON finance_action_comments FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- updated_at maintenance for finance_actions (comments are immutable
-- once posted, so no trigger needed there).
CREATE OR REPLACE FUNCTION finance_actions_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS finance_actions_updated_at ON finance_actions;
CREATE TRIGGER finance_actions_updated_at
  BEFORE UPDATE ON finance_actions
  FOR EACH ROW EXECUTE FUNCTION finance_actions_set_updated_at();

-- One-time backfill: move the single existing slate_review_action_items
-- row into the new shared list. The week_start column doesn't carry
-- over (the new list isn't per-week). Status maps from is_done=false
-- to 'open'. Guarded with NOT EXISTS so re-running the migration is
-- idempotent.
INSERT INTO finance_actions (body, status, city, created_by, created_at, updated_at)
SELECT
  sr.body,
  CASE WHEN sr.is_done THEN 'resolved' ELSE 'open' END,
  sr.city,
  sr.created_by,
  sr.created_at,
  sr.created_at
FROM slate_review_action_items sr
WHERE NOT EXISTS (
  SELECT 1 FROM finance_actions fa
  WHERE fa.body = sr.body
    AND fa.city = sr.city
    AND fa.created_by = sr.created_by
);
