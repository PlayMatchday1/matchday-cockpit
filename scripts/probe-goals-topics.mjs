import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

console.log("=== goals — column probe (any row) ===");
const g = await sb.from("goals").select("*").limit(1);
if (g.error) { console.error(g.error); } else if (g.data[0]) {
  for (const [k, v] of Object.entries(g.data[0])) console.log("  ", k, "=", JSON.stringify(v));
} else {
  console.log("  (empty table — fetch column list via head)");
  const h = await sb.from("goals").select("*").limit(0);
  console.log("  no row sample available");
}

console.log("\n=== goals row counts by scope ===");
const scopes = ["org", "q2", "monthly", "city"];
for (const s of scopes) {
  const { count } = await sb.from("goals").select("*", { count: "exact", head: true }).eq("scope", s);
  console.log(`  scope=${s.padEnd(8)}  count=${count}`);
}
const totalRes = await sb.from("goals").select("*", { count: "exact", head: true });
console.log(`  TOTAL                count=${totalRes.count}`);

console.log("\n=== monthly goals — sample with target_date ===");
const mg = await sb.from("goals").select("id, title, scope, city, target_date, status").eq("scope", "monthly").limit(10);
for (const r of mg.data ?? []) console.log("  ", JSON.stringify(r));

console.log("\n=== q2 goals — sample with target_date ===");
const q2 = await sb.from("goals").select("id, title, scope, city, target_date, status").eq("scope", "q2").limit(10);
for (const r of q2.data ?? []) console.log("  ", JSON.stringify(r));

// Topics
console.log("\n=== topics — column probe ===");
const t = await sb.from("topics").select("*").limit(1);
if (t.error) { console.error(t.error); }
else if (t.data[0]) {
  for (const [k, v] of Object.entries(t.data[0])) console.log("  ", k, "=", JSON.stringify(typeof v === "string" && v.length > 80 ? v.slice(0,80)+"…" : v));
} else console.log("  empty");

const tc = await sb.from("topics").select("*", { count: "exact", head: true });
console.log(`\n  topics count: ${tc.count}`);
