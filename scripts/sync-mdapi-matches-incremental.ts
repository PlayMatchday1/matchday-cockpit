// Daily incremental refresh of mdapi_matches + mdapi_match_players.
// Window: now - 14 days through now + 60 days (per design Section 3.4).
//
// Run: npx tsx scripts/sync-mdapi-matches-incremental.ts
//
// In Phase 5c this same logic gets wired into /api/sync/cron as a
// 5th step. Keeping it as a standalone script for early operational
// use and parity with the backfill flow.
//
// Estimated runtime: ~150s (~750 matches × N+1).
// Idempotent — onConflict=api_id upserts.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import {
  syncMdapiMatches,
  defaultIncrementalWindow,
} from "../src/lib/mdapiMatchesSync";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
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

  const { fromDate, toDate } = defaultIncrementalWindow();

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log("=== mdapi_matches incremental sync ===");
  console.log(`Window: ${fromDate} → ${toDate}`);
  console.log(`Authenticated as: ${process.env.MATCHDAY_API_EMAIL}`);
  console.log(
    `API base:         ${process.env.MATCHDAY_API_BASE_URL ?? "https://playmatchday.herokuapp.com (default)"}\n`,
  );

  let result;
  try {
    result = await syncMdapiMatches(supabase, { fromDate, toDate });
  } catch (e) {
    console.error("\n✗ Incremental sync failed:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  const seconds = (result.durationMs / 1000).toFixed(1);
  console.log(
    `Matches: ${result.matchesFetched.toLocaleString()} fetched, ${result.matchesUpserted.toLocaleString()} upserted (${result.pages} pages)`,
  );
  console.log(
    `Players: ${result.playersFetched.toLocaleString()} fetched, ${result.playersUpserted.toLocaleString()} upserted`,
  );
  console.log(`API calls: ${result.apiCalls.toLocaleString()}`);

  const errCount = Object.keys(result.perMatchErrors).length;
  if (errCount > 0) {
    console.log(`\n⚠ ${errCount} match(es) had errors:`);
    const entries = Object.entries(result.perMatchErrors);
    for (const [matchId, msg] of entries.slice(0, 10)) {
      console.log(`    match ${matchId}: ${msg}`);
    }
    if (errCount > 10) console.log(`    ... and ${errCount - 10} more`);
  }

  console.log(`\nDone in ${seconds}s.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
