// Manual sync of /admin/subscriptions into mdapi_subscriptions.
//
// Run: npx tsx scripts/sync-mdapi-subscriptions.ts
//
// Requires .env.local with:
//   - MATCHDAY_API_EMAIL, MATCHDAY_API_PASSWORD (Phase 1 auth)
//   - SUPABASE_SERVICE_ROLE_KEY (writes go through service role —
//     RLS on mdapi_subscriptions allows SELECT for authenticated only,
//     no INSERT/UPDATE policy, so the publishable key won't work)
//   - NEXT_PUBLIC_SUPABASE_URL

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { syncMdapiSubscriptions } from "../src/lib/mdapiSubscriptionsSync";

// Mirror env file → process.env so the auth helper picks up the
// MATCHDAY_API_* vars (it reads from process.env at call time).
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
  if (!supabaseUrl) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL in .env.local");
    process.exit(1);
  }
  if (!serviceKey) {
    console.error(
      "Missing SUPABASE_SERVICE_ROLE_KEY in .env.local. Add it before running:\n" +
        "  Supabase Dashboard → Project Settings → API → service_role → Reveal & copy\n" +
        "  Then append to .env.local: SUPABASE_SERVICE_ROLE_KEY=<value>",
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

  console.log("=== mdapi_subscriptions sync ===");
  console.log(`Authenticated as: ${process.env.MATCHDAY_API_EMAIL}`);
  console.log(
    `API base:         ${process.env.MATCHDAY_API_BASE_URL ?? "https://playmatchday.herokuapp.com (default)"}`,
  );
  console.log("");

  let result;
  try {
    result = await syncMdapiSubscriptions(supabase);
  } catch (e) {
    console.error("\n✗ Sync failed:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  const seconds = (result.durationMs / 1000).toFixed(1);
  console.log(
    `Fetched ${result.fetched.toLocaleString()} rows across ${result.cities} cities × ${result.statuses} statuses (${result.apiCalls.toLocaleString()} API calls)`,
  );
  console.log(
    `Upserted ${result.upserted.toLocaleString()} rows into mdapi_subscriptions`,
  );

  const errorEntries = Object.entries(result.loopErrors);
  if (errorEntries.length > 0) {
    console.log(`\n⚠ ${errorEntries.length} (city, status) loop(s) failed:`);
    for (const [key, msg] of errorEntries) {
      console.log(`    ${key}: ${msg}`);
    }
  }

  console.log(`\nDone in ${seconds}s.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
