// Targeted re-sync of mdapi_matches + mdapi_match_players for an
// arbitrary date window (fromDate / toDate). Pulls only matches
// inside the window; refreshes existing rows in place via upsert
// on api_id, so corrected field_title / field_id / player_count
// values from the platform propagate to the DB.
//
// Use when:
//   - You've edited matches on the MatchDay platform (e.g. fixed
//     a stale field_title) and need the changes to land before the
//     next daily cron's rolling-14d window catches them.
//   - You need to refresh older rows outside the cron's normal
//     incremental window without running the full multi-year
//     backfill (sync-mdapi-matches-backfill.ts).
//
// Run:
//   FROMDATE=2026-05-01 TODATE=2026-05-24 \
//     npx tsx scripts/sync-mdapi-matches-window.ts
//
// Defaults if env unset: last 30 days through today.
//
// Safety:
//   - Upsert keyed on api_id (mirrors the daily cron). Existing
//     rows update; missing rows insert. NEVER deletes.
//   - The fromDate/toDate are server-side filters on the
//     /admin/matches API call. Matches outside the window are
//     never fetched, so they can't be touched.
//   - Idempotent. Safe to re-run.

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

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const today = new Date();
const thirtyDaysAgo = new Date(today.getTime() - 30 * 86_400_000);

const fromDate = process.env.FROMDATE ?? ymd(thirtyDaysAgo);
const toDate = process.env.TODATE ?? ymd(today);

const ISO_DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
if (!ISO_DATE_RX.test(fromDate) || !ISO_DATE_RX.test(toDate)) {
  console.error(
    `FROMDATE / TODATE must be YYYY-MM-DD. Got fromDate="${fromDate}" toDate="${toDate}".`,
  );
  process.exit(1);
}
if (fromDate > toDate) {
  console.error(`FROMDATE (${fromDate}) must be <= TODATE (${toDate}).`);
  process.exit(1);
}

async function main() {
  if (!supabaseUrl || !serviceKey) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local",
    );
    process.exit(1);
  }
  if (!process.env.MATCHDAY_API_EMAIL || !process.env.MATCHDAY_API_PASSWORD) {
    console.error(
      "Missing MATCHDAY_API_EMAIL / MATCHDAY_API_PASSWORD in .env.local",
    );
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`=== mdapi_matches window resync ===`);
  console.log(`Window:  ${fromDate} → ${toDate}`);
  console.log(`Auth:    ${process.env.MATCHDAY_API_EMAIL}`);
  console.log(
    `API:     ${process.env.MATCHDAY_API_BASE_URL ?? "https://playmatchday.herokuapp.com (default)"}`,
  );
  console.log("Estimated: ~1-3 minutes for a 30-day window\n");

  let result;
  try {
    result = await syncMdapiMatches(supabase, { fromDate, toDate });
  } catch (e) {
    console.error(
      "\n✗ Resync failed:",
      e instanceof Error ? e.message : String(e),
    );
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
      `\nRe-run to retry — upsert is idempotent, only the failed matches' players will re-fetch.`,
    );
  }

  console.log(`\nDone in ${minutes} minutes.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
