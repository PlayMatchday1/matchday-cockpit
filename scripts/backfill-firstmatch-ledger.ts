// One-time backfill of firstmatch_ledger from existing
// mdapi_match_players history. Insert-only and idempotent — safe to
// re-run; existing ledger rows are never touched.
//
// Hashing uses FIRSTMATCH_LEDGER_SALT, read from .env.local (pull it
// from Vercel production first so it matches the cron's salt). The salt
// is pushed into process.env before any hashing so the shared lib picks
// it up.
//
// Usage:
//   npx tsx scripts/backfill-firstmatch-ledger.ts

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { syncFirstmatchLedger } from "../src/lib/firstmatchLedgerSync";

const ENV_PATH = "/Users/ryanmancuso/Code/matchday-cockpit/.env.local";
const env = readFileSync(ENV_PATH, "utf8");

function readEnv(name: string): string | null {
  const m = env.match(new RegExp(`^${name}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : null;
}

const url = readEnv("NEXT_PUBLIC_SUPABASE_URL");
const key = readEnv("SUPABASE_SERVICE_ROLE_KEY");
const salt = readEnv("FIRSTMATCH_LEDGER_SALT");

if (!url || !key) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local.",
  );
  process.exit(2);
}
if (!salt) {
  console.error(
    "Missing FIRSTMATCH_LEDGER_SALT in .env.local — pull it from Vercel " +
      "production (vercel env pull) before backfilling.",
  );
  process.exit(2);
}
process.env.FIRSTMATCH_LEDGER_SALT = salt;

const sb = createClient(url, key, { auth: { persistSession: false } });

async function main() {
  const r = await syncFirstmatchLedger(sb, "backfill");
  console.log("firstmatch_ledger backfill complete:");
  console.log(`  scanned (is_first_match=true):  ${r.scanned}`);
  console.log(`  clean hashes captured:          ${r.cleanHashed}`);
  console.log(`  unrecoverable (scrubbed):       ${r.unrecoverable}`);
  console.log(`  new rows inserted:              ${r.inserted}`);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
