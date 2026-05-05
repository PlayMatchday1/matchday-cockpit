// One-shot snapshot refresh. Used after the Phase 3b cutover to
// regenerate members_monthly_snapshots from the new mdapi_subscriptions
// data without going through a CSV upload.
//
// Run: npx tsx scripts/refresh-membership-snapshots.ts
//
// Requires .env.local with:
//   - SUPABASE_SERVICE_ROLE_KEY (writes go through service role —
//     bypasses RLS, same pattern as scripts/sync-mdapi-*.ts)
//   - NEXT_PUBLIC_SUPABASE_URL

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { refreshMembershipSnapshots } from "../src/lib/membershipSnapshots";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
function readVar(name: string): string | undefined {
  const m = env.match(new RegExp(`^${name}=(.+)$`, "m"));
  return m ? m[1].trim() : undefined;
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
        "  Supabase Dashboard → Project Settings → API → service_role → Reveal & copy",
    );
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log("=== membership snapshot refresh ===");
  console.log("Reads mdapi_subscriptions + match_registrations,");
  console.log("recomputes members_monthly_snapshots.\n");

  const startedAt = Date.now();
  try {
    await refreshMembershipSnapshots({
      client: supabase,
      sourceFileName: "phase-3b-cutover-refresh",
    });
  } catch (e) {
    console.error("\n✗ Refresh failed:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`✓ Snapshots refreshed in ${seconds}s.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
