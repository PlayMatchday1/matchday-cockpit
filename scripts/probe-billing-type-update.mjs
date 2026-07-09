import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const serviceKey = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const anonKey = env.match(/NEXT_PUBLIC_SUPABASE_ANON_KEY=(.+)/)?.[1]?.trim();

const sbService = createClient(url, serviceKey);

console.log("=== RLS policies — inferring from live UPDATE attempts below ===");

// 2. Find a venue we can safely toggle. Pick one with current billing_type
//    we can flip back-and-forth without breaking anything: a per_match venue
//    that isn't in a combined group.
const { data: probeVenue, error: pErr } = await sbService
  .from("fin_venues")
  .select("id, venue_name, city, billing_type, per_match_rate, cost_per_match")
  .eq("venue_name", "Westlake")
  .maybeSingle();
if (pErr) console.error("Find Westlake:", pErr);
console.log("\n=== Westlake current row ===");
console.log(JSON.stringify(probeVenue, null, 2));

// 3. SERVICE-ROLE UPDATE attempt (bypasses RLS) — confirms schema permits the change.
console.log("\n=== Service-role UPDATE attempt (should succeed if schema is OK) ===");
if (probeVenue) {
  const original = probeVenue.billing_type;
  const target = original === "per_match" ? "monthly_flat" : "per_match";
  const upd1 = await sbService.from("fin_venues").update({ billing_type: target }).eq("id", probeVenue.id).select("billing_type").single();
  console.log(`  ${original} → ${target}: ${upd1.error ? "FAIL " + upd1.error.message : "OK (now " + upd1.data.billing_type + ")"}`);
  if (!upd1.error) {
    const upd2 = await sbService.from("fin_venues").update({ billing_type: original }).eq("id", probeVenue.id).select("billing_type").single();
    console.log(`  reverted ${target} → ${original}: ${upd2.error ? "FAIL " + upd2.error.message : "OK"}`);
  }
}

// 4. ANON-KEY UPDATE attempt (subject to RLS). This is what an unauthenticated
//    browser session would do. The real UI flow uses an authenticated session
//    via supabase auth — RLS policy is likely "authenticated" with some predicate
//    (admin claim, etc). Anon should be denied; the result tells us whether RLS
//    is enabled at all.
if (anonKey && probeVenue) {
  console.log("\n=== Anon-key UPDATE attempt (should fail — confirms RLS active) ===");
  const sbAnon = createClient(url, anonKey);
  const upd = await sbAnon.from("fin_venues").update({ billing_type: "no_charge" }).eq("id", probeVenue.id).select();
  if (upd.error) console.log(`  Anon UPDATE rejected: ${upd.error.message}  (status ${upd.status})`);
  else console.log(`  Anon UPDATE returned ${upd.data?.length ?? 0} rows — ${(upd.data?.length ?? 0) === 0 ? "SILENT NO-OP (RLS denies but returns 0 rows, no error)" : "SUCCEEDED (no RLS)"}`);
}

// 5. Also check: does an anon UPDATE of a price field behave the same? That
//    would tell us whether the bug is specific to billing_type or affects every
//    field — i.e., whether user is authenticating correctly at all.
if (anonKey && probeVenue) {
  console.log("\n=== Anon-key UPDATE of cost_per_match (control — same as billing_type if it's table-level RLS) ===");
  const sbAnon = createClient(url, anonKey);
  const upd = await sbAnon.from("fin_venues").update({ cost_per_match: probeVenue.cost_per_match }).eq("id", probeVenue.id).select();
  if (upd.error) console.log(`  Anon UPDATE rejected: ${upd.error.message}`);
  else console.log(`  Anon UPDATE returned ${upd.data?.length ?? 0} rows`);
}
