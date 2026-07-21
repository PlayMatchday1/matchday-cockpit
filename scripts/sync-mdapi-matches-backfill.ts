// One-shot backfill of mdapi_matches + mdapi_match_players for all of
// 2026 (fromDate=2026-01-01).
//
// Run: npx tsx scripts/sync-mdapi-matches-backfill.ts
//
// Estimated runtime: 16-20 minutes (~4,700 matches × N+1 players call).
// Idempotent — onConflict=api_id upserts; safe to re-run after a crash.
//
// Requires .env.local with:
//   - MATCHDAY_API_EMAIL, MATCHDAY_API_PASSWORD
//   - SUPABASE_SERVICE_ROLE_KEY (writes via service role; matches the
//     pattern of other sync-mdapi-* scripts)
//   - NEXT_PUBLIC_SUPABASE_URL

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { syncMdapiMatches } from "../src/lib/mdapiMatchesSync";

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

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log("=== mdapi_matches backfill (fromDate=2026-01-01) ===");
  console.log(`Authenticated as: ${process.env.MATCHDAY_API_EMAIL}`);
  console.log(
    `API base:         ${process.env.MATCHDAY_API_BASE_URL ?? "https://playmatchday.herokuapp.com (default)"}`,
  );
  console.log("Estimated runtime: 16-20 minutes\n");

  let result;
  try {
    result = await syncMdapiMatches(supabase, { fromDate: "2026-01-01" });
  } catch (e) {
    console.error("\n✗ Backfill failed:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  const minutes = (result.durationMs / 60000).toFixed(1);
  console.log(
    `\nMatches: fetched ${result.matchesFetched.toLocaleString()}, upserted ${result.matchesUpserted.toLocaleString()} (${result.pages} pages)`,
  );
  console.log(
    `Players: fetched ${result.playersFetched.toLocaleString()}, upserted ${result.playersUpserted.toLocaleString()}`,
  );
  console.log(`API calls: ${result.apiCalls.toLocaleString()}`);

  const errCount = Object.keys(result.perMatchErrors).length;
  if (errCount > 0) {
    console.log(`\n⚠ ${errCount} match(es) had /players fetch errors:`);
    const entries = Object.entries(result.perMatchErrors);
    for (const [matchId, msg] of entries.slice(0, 10)) {
      console.log(`    match ${matchId}: ${msg}`);
    }
    if (errCount > 10) console.log(`    ... and ${errCount - 10} more`);
    console.log(
      `\nThese matches' player rosters are missing or stale. Re-run the script to retry — upsert is idempotent.`,
    );
  }

  console.log(`\nDone in ${minutes} minutes.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
