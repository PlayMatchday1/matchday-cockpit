// Investigation for CRM Phase 1 — read-only.
// 1. app_users full column list (for assignment dropdown payload)
// 2. distinct mdapi_users.preferable_city_normalized values
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
const strip = (s) => s.trim().replace(/^["']|["']$/g, "");
const url = strip(env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1]);
const serviceKey = strip(env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1]);
const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

console.log("=== 1. app_users full schema ===");
const au = await sb.from("app_users").select("*").limit(5);
if (au.error) console.log("ERR", au.error);
else if (!au.data?.length) console.log("(empty)");
else {
  const row = au.data[0];
  console.log("Columns + sample types:");
  for (const k of Object.keys(row)) {
    const v = row[k];
    console.log(`  ${k}: ${typeof v}${v === null ? " (null)" : ""}`);
  }
  console.log("\nAll rows (admins flagged):");
  for (const r of au.data) {
    console.log(
      `  id=${r.id} email=${r.email} full_name=${JSON.stringify(r.full_name)} is_admin=${r.is_admin}`,
    );
  }
}

console.log("\n=== 2. mdapi_users.preferable_city_normalized distinct values ===");
// Paginate through all users; PostgREST max 1000/page.
const counts = new Map();
let from = 0;
const PAGE = 1000;
while (true) {
  const r = await sb
    .from("mdapi_users")
    .select("preferable_city_normalized")
    .range(from, from + PAGE - 1);
  if (r.error) { console.log("ERR", r.error); break; }
  if (!r.data?.length) break;
  for (const row of r.data) {
    const v = row.preferable_city_normalized ?? "(null)";
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  if (r.data.length < PAGE) break;
  from += PAGE;
}
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
for (const [v, n] of sorted) console.log(`  ${v.padEnd(20)} ${n}`);

const expected = new Set(["ATX","HOU","SATX","DFW","STL","ATL","OKC","ELP"]);
const found = new Set(sorted.map(([v]) => v));
const missing = [...expected].filter((c) => !found.has(c));
const extra = [...found].filter((v) => v !== "(null)" && !expected.has(v));
console.log("\nExpected vs found:");
console.log("  missing from DB:", missing.length ? missing.join(", ") : "(none)");
console.log("  extra in DB:    ", extra.length ? extra.join(", ") : "(none)");
