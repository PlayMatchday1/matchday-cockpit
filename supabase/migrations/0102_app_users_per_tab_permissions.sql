-- 0102: rework app_users permissions to one column per top-level nav tab.
--
-- The nav is now Home · Finance · Growth · Membership · Match Ops · Tech, but the
-- permission columns were the old page names (clubhouse, cities, data, docs, …).
-- This migrates the STORED permissions using the audit-derived mapping so nobody
-- is re-granted by hand and NObody's effective access changes:
--
--   old clubhouse  → home, tech, and (with cities) matchops     [Home, Tech tabs]
--   old cities     → growth, membership, matchops               [Growth, Membership]
--   old finance    → finance                                    [kept 1:1]
--   old chats      → chats                                      [kept as-is; its
--                    name + 6 CRM RLS policies from 0047 are DELIBERATELY untouched]
--   old data, docs → folded under tech                          [no separate column]
--
-- Match Ops governs the 5 ops pages (slate review, master schedule, field ops,
-- inventory, reviews) via can_access_matchops. partner-dashboards + field-pipeline
-- stay on the clubhouse→tech audience so cities-only users don't silently gain them.
--
-- Touches ONLY app_users permission columns. can_access_finance, can_access_chats
-- and can_access_org are left exactly as they are.
--
-- EXPAND phase (this file): ADD the new columns + backfill. The OLD columns are
-- KEPT so the currently-deployed code keeps working — no lockout window. The new
-- code deploys AFTER this, then 0103 (CONTRACT) drops the old columns. Order:
--   apply 0102  →  deploy new code  →  apply 0103.

BEGIN;

-- 1. New per-tab columns. NOT NULL DEFAULT false — matches can_access_chats (0046).
ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS can_access_home       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_access_growth     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_access_membership boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_access_matchops   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_access_tech       boolean NOT NULL DEFAULT false;

-- 2. Backfill from the derived mapping.
UPDATE app_users SET
  can_access_home       = can_access_clubhouse,
  can_access_growth     = can_access_cities,
  can_access_membership = can_access_cities,
  can_access_matchops   = (can_access_cities OR can_access_clubhouse),
  can_access_tech       = can_access_clubhouse;

COMMIT;
