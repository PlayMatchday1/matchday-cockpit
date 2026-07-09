// Read-only safety checks for the Wave 4 migration. Does NOT
// modify the DB. Confirms (a) fin_commentary row count, (b) prints
// the migration SQL that would run, (c) verifies the planned new
// fin_config rows don't collide with anything already there.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

console.log("=== fin_commentary row count ===");
const { data: rows, error } = await sb
  .from("fin_commentary")
  .select("id, eyebrow, body, updated_at");
if (error) {
  console.error(error);
  process.exit(1);
}
console.log(`Count: ${rows.length}`);
for (const r of rows) {
  console.log(
    `  id=${r.id}  eyebrow=${JSON.stringify((r.eyebrow ?? "").slice(0, 60))}  body=${JSON.stringify((r.body ?? "").slice(0, 60))}  updated_at=${r.updated_at}`,
  );
}

console.log("\n=== fin_commentary columns (probe) ===");
// PostgREST exposes columns via OpenAPI; the simplest probe is just
// reading the row shape from the first row above. If quarter_key
// already exists, it'll show in r's keys.
if (rows[0]) {
  console.log("  columns:", Object.keys(rows[0]).join(", "));
  console.log(
    `  quarter_key column already present? ${Object.prototype.hasOwnProperty.call(rows[0], "quarter_key") ? "YES (migration is a no-op for this column)" : "no"}`,
  );
}

console.log("\n=== fin_config — collision check for new keys ===");
const { data: cfg } = await sb
  .from("fin_config")
  .select("key, value")
  .or("key.eq.starting_cash_2026q3,key.eq.starting_cash_q2_2026,key.eq.quarter_label");
for (const c of cfg ?? []) {
  console.log(`  ${c.key.padEnd(28)} = ${JSON.stringify(c.value)}`);
}
const has2026q3 = (cfg ?? []).some((c) => c.key === "starting_cash_2026q3");
console.log(
  `  starting_cash_2026q3 already present? ${has2026q3 ? "YES (INSERT will be skipped via ON CONFLICT)" : "no"}`,
);

console.log("\n=== Migration plan (NOT executed) ===");
console.log(`
-- ============================================================
-- Migration 0026 — fin_commentary.quarter_key + Q3 planning seed
-- Idempotent: every statement guarded with IF [NOT] EXISTS / ON
-- CONFLICT. Safe to run multiple times.
-- ============================================================

-- 1. Add quarter_key column with DEFAULT '2026Q2' so the existing row
--    backfills cleanly. NOT NULL because every commentary row must
--    scope to a quarter.
ALTER TABLE fin_commentary
  ADD COLUMN IF NOT EXISTS quarter_key TEXT NOT NULL DEFAULT '2026Q2';

-- 2. UNIQUE index — one commentary row per quarter. The existing row
--    becomes the Q2 2026 entry; future saves from a Q3 view INSERT a
--    new row keyed by 2026Q3.
CREATE UNIQUE INDEX IF NOT EXISTS fin_commentary_quarter_key_idx
  ON fin_commentary(quarter_key);

-- 3. Seed starting_cash_2026q3 = 0 placeholder. Operator populates
--    the real number from /finance later. ON CONFLICT keeps the
--    statement idempotent if it's already been seeded.
INSERT INTO fin_config (key, value)
  VALUES ('starting_cash_2026q3', '0')
  ON CONFLICT (key) DO NOTHING;
`);

console.log("=== Rollback SQL (NOT executed; ready in PR description) ===");
console.log(`
-- Reverses migration 0026. Run only if Wave 4 has to be backed out.
DROP INDEX IF EXISTS fin_commentary_quarter_key_idx;
ALTER TABLE fin_commentary DROP COLUMN IF EXISTS quarter_key;
DELETE FROM fin_config WHERE key = 'starting_cash_2026q3';
`);

console.log("=== Supabase backups (read via management API) ===");
console.log(
  "Supabase's automated PITR / daily backups live on the project's Database → Backups page in the dashboard.",
);
console.log(
  "There's no service-role-key endpoint to query backup history from a script.",
);
console.log(
  "URL: https://supabase.com/dashboard/project/_/database/backups (substitute project ref).",
);
console.log(
  "Verify the most recent backup timestamp + retention policy there before approving the merge.",
);
console.log(
  "If you want a manual snapshot first: `supabase db dump --db-url $DATABASE_URL > pre-wave4-backup.sql`",
);
