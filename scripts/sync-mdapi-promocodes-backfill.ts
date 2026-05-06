// One-shot backfill of mdapi_promocodes. Pulls all promocodes from
// /admin/promocodes — ~6,094 rows in production at first run.
//
// Run: npx tsx scripts/sync-mdapi-promocodes-backfill.ts
//
// Estimated runtime: ~2 seconds (6 paginated calls). Idempotent —
// onConflict=api_id; safe to re-run.
//
// After Phase 5b-followup (cron orchestrator update), this script
// becomes a manual fallback — the cron's 4th step (between
// mdapi-subscriptions and membership-snapshots) handles the daily
// refresh.
//
// Requires .env.local with:
//   - MATCHDAY_API_EMAIL, MATCHDAY_API_PASSWORD
//   - SUPABASE_SERVICE_ROLE_KEY
//   - NEXT_PUBLIC_SUPABASE_URL

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { syncMdapiPromocodes } from "../src/lib/mdapiPromocodesSync";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
function readVar(name: string): string | undefined {
  const m = env.match(new RegExp(`^${name}=(.+)$`, "m"));
  return m ? m[1].trim() : undefined;
}
for (const v of [
  "MATCHDAY_API_EMAIL",
  "MATCHDAY_API_PASSWORD",
  "MATCHDAY_API_BASE_URL",
]) {
  const val = readVar(v);
  if (val) process.env[v] = val;
}

const supabaseUrl = readVar("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = readVar("SUPABASE_SERVICE_ROLE_KEY");

async function main() {
  if (!supabaseUrl || !serviceKey) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local",
    );
    process.exit(1);
  }
  if (!process.env.MATCHDAY_API_EMAIL || !process.env.MATCHDAY_API_PASSWORD) {
    console.error("Missing MATCHDAY_API_EMAIL / MATCHDAY_API_PASSWORD in .env.local");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log("=== mdapi_promocodes backfill ===");
  console.log(`Authenticated as: ${process.env.MATCHDAY_API_EMAIL}`);
  console.log("Estimated runtime: ~2 seconds\n");

  let result;
  try {
    result = await syncMdapiPromocodes(supabase);
  } catch (e) {
    console.error("\n✗ Backfill failed:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  const seconds = (result.durationMs / 1000).toFixed(1);
  console.log(
    `Fetched ${result.fetched.toLocaleString()} promocodes across ${result.pages} page(s)`,
  );
  console.log(
    `Upserted ${result.upserted.toLocaleString()} rows into mdapi_promocodes`,
  );
  console.log(`Done in ${seconds}s.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
