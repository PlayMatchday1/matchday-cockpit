-- ============================================================
-- Migration 0026 — Finance quarter planning + per-quarter commentary
--
-- Backs the Wave 4 changes that wire the Finance page selector to:
--   * a per-quarter Exec Summary (one fin_commentary row per quarter)
--   * planning mode for the next upcoming quarter
--   * a normalized starting-cash key per quarter
--
-- Idempotent — every statement guarded with IF [NOT] EXISTS /
-- ON CONFLICT. Safe to run more than once.
-- ============================================================

-- 1. fin_commentary.quarter_key
-- ----------------------------------------------------------------
-- One commentary row per quarter. Existing single row backfills to
-- '2026Q2' via the DEFAULT clause; future saves from a Q3 view
-- INSERT a new row keyed by '2026Q3'. NOT NULL because every row
-- must scope to a quarter.

ALTER TABLE fin_commentary
  ADD COLUMN IF NOT EXISTS quarter_key TEXT NOT NULL DEFAULT '2026Q2';

CREATE UNIQUE INDEX IF NOT EXISTS fin_commentary_quarter_key_idx
  ON fin_commentary(quarter_key);

-- 2. fin_config — normalize starting-cash key + seed Q3 planning row
-- ----------------------------------------------------------------
-- Existing key 'starting_cash_q2_2026' renamed to 'starting_cash_2026q2'
-- so every quarter's row follows the `starting_cash_${quarter.key}`
-- (lower-cased) convention the new helper reads. The UPDATE is a
-- no-op if the new key already exists.
--
-- Q3 seeded at $0 — operator populates the real number after merge.

UPDATE fin_config
  SET key = 'starting_cash_2026q2'
  WHERE key = 'starting_cash_q2_2026'
    AND NOT EXISTS (SELECT 1 FROM fin_config WHERE key = 'starting_cash_2026q2');

INSERT INTO fin_config (key, value)
  VALUES ('starting_cash_2026q3', '0')
  ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- ROLLBACK (do not run unless Wave 4 has to be reverted)
-- ============================================================
-- DROP INDEX IF EXISTS fin_commentary_quarter_key_idx;
-- ALTER TABLE fin_commentary DROP COLUMN IF EXISTS quarter_key;
-- UPDATE fin_config SET key = 'starting_cash_q2_2026' WHERE key = 'starting_cash_2026q2';
-- DELETE FROM fin_config WHERE key = 'starting_cash_2026q3';
