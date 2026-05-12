-- ============================================================
-- Migration 0028 — quarter_key on goals + topics
--
-- Brings Clubhouse Goals + Topics under the same quarter-aware
-- pattern Finance shipped in Waves 2-4. Each table gets a
-- quarter_key TEXT column matching the QuarterKey shape
-- (e.g. "2026Q2"). Default backfills every existing row to
-- "2026Q2" — the only quarter cockpit data exists for today.
--
-- Org-scoped goals (scope='org') technically receive a quarter_key
-- too, but consumer logic ignores it for org rows since org goals
-- are company-wide and stay visible across every quarter view.
--
-- Production row counts pre-migration (scanned just before
-- writing this file):
--   goals = 3 rows  (2 org, 0 q2, 0 monthly, 1 city)
--   topics = 4 rows
--
-- Idempotent — IF NOT EXISTS makes a re-run a no-op.
-- ============================================================

ALTER TABLE goals
  ADD COLUMN IF NOT EXISTS quarter_key TEXT NOT NULL DEFAULT '2026Q2';

ALTER TABLE topics
  ADD COLUMN IF NOT EXISTS quarter_key TEXT NOT NULL DEFAULT '2026Q2';

-- ============================================================
-- ROLLBACK (only if Clubhouse Quarter awareness has to be reverted)
-- ============================================================
-- ALTER TABLE goals DROP COLUMN IF EXISTS quarter_key;
-- ALTER TABLE topics DROP COLUMN IF EXISTS quarter_key;
