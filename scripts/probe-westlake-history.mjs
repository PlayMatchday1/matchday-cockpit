import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const sb = createClient(url, env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim());

// Probe fin_change_log columns
const probe = await sb.from("fin_change_log").select("*").limit(1);
console.log("=== fin_change_log columns ===");
if (probe.data?.[0]) console.log("  ", Object.keys(probe.data[0]).join(", "));
else console.log("  empty");

// Now use the right timestamp column
const tsCol = probe.data?.[0] ? Object.keys(probe.data[0]).find(c => /at$|^changed_at|^ts$|timestamp/i.test(c)) ?? "id" : "id";
console.log(`  using sort column: ${tsCol}`);

const { data: hist } = await sb
  .from("fin_change_log")
  .select("*")
  .eq("table_name", "fin_venues")
  .eq("row_id", 49)
  .order(tsCol, { ascending: true });
console.log("\n=== Westlake (id=49) history ===");
for (const h of hist ?? []) {
  const before = h.before_json?.billing_type ?? "—";
  const after = h.after_json?.billing_type ?? "—";
  console.log(`  ${h[tsCol]}  ${h.action}  by=${h.changed_by}  billing_type: ${before} → ${after}`);
}
console.log(`Total entries: ${(hist ?? []).length}`);

// Anon-key probe of update + audit-write
const anonKey = env.match(/NEXT_PUBLIC_SUPABASE_ANON_KEY=(.+)/)?.[1]?.trim();
if (!anonKey) { console.log("\n(no anon key in env; skip anon probe)"); process.exit(0); }
const { createClient: cc } = await import("@supabase/supabase-js");
const sbAnon = cc(url, anonKey);
console.log("\n=== Anon UPDATE fin_venues.billing_type ===");
const u = await sbAnon.from("fin_venues").update({ billing_type: "monthly_flat" }).eq("id", 49).select();
if (u.error) console.log(`  Rejected: ${u.error.code} ${u.error.message}`);
else console.log(`  Returned ${u.data?.length ?? 0} rows (${(u.data?.length ?? 0) === 0 ? "silently denied by RLS" : "ALLOWED"})`);

console.log("\n=== Anon INSERT fin_change_log ===");
const ci = await sbAnon.from("fin_change_log").insert({
  table_name: "fin_venues", row_id: 49, action: "update",
  changed_by: "probe@test", before_json: {id:49}, after_json: {id:49},
});
if (ci.error) console.log(`  Rejected: ${ci.error.code} ${ci.error.message}`);
else console.log(`  ALLOWED`);
