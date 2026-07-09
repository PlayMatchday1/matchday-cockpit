// Investigation for Phase 0 CRM MVP — read-only checks.
// 1. mdapi_users.phone_number format + duplicates
// 2. app_users schema (id type, columns) — needed for FK + corp-only auth
// 3. Sanity-check totals
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
const strip = (s) => s.trim().replace(/^["']|["']$/g, "");
const url = strip(env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1]);
const serviceKey = strip(env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1]);
const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

console.log("=== 1. mdapi_users phone_number ===");
const total = await sb.from("mdapi_users").select("id", { count: "exact", head: true });
console.log("Total rows:", total.count);

const withPhone = await sb
  .from("mdapi_users")
  .select("id", { count: "exact", head: true })
  .not("phone_number", "is", null);
console.log("Rows with phone_number not null:", withPhone.count);

const sample = await sb
  .from("mdapi_users")
  .select("id, phone_number, first_name, last_name, preferable_city_normalized")
  .not("phone_number", "is", null)
  .limit(15);
console.log("Sample phones:");
for (const r of sample.data ?? []) {
  console.log(`  id=${r.id} phone='${r.phone_number}' city=${r.preferable_city_normalized ?? "-"}`);
}

// Format distribution: count by prefix character + length buckets.
console.log("\nFormat audit (first 3000 rows):");
const fmt = await sb
  .from("mdapi_users")
  .select("phone_number")
  .not("phone_number", "is", null)
  .limit(3000);
const buckets = new Map();
for (const r of fmt.data ?? []) {
  const p = r.phone_number ?? "";
  const startsPlus = p.startsWith("+");
  const allDigits = /^\+?[0-9]+$/.test(p);
  const len = p.length;
  const key = `${startsPlus ? "+" : "x"}${allDigits ? "d" : "?"}_len${len}`;
  buckets.set(key, (buckets.get(key) ?? 0) + 1);
}
for (const [k, v] of [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${k}: ${v}`);
}

// Duplicate phones?
console.log("\nDuplicate phone_number scan (Postgres):");
const dupes = await sb.rpc("crm_dupe_phone_check").maybeSingle();
if (dupes.error && dupes.error.code === "PGRST202") {
  // No such rpc — do client-side scan on the sample.
  const seen = new Map();
  for (const r of fmt.data ?? []) {
    if (!r.phone_number) continue;
    seen.set(r.phone_number, (seen.get(r.phone_number) ?? 0) + 1);
  }
  const dupList = [...seen.entries()].filter(([, n]) => n > 1).slice(0, 10);
  console.log(`  client-side scan over ${fmt.data?.length ?? 0} rows: ${dupList.length} duplicate phone values`);
  for (const [p, n] of dupList) console.log(`    '${p}' × ${n}`);
} else {
  console.log("  rpc result:", dupes.data, dupes.error);
}

console.log("\n=== 2. app_users schema ===");
const au = await sb.from("app_users").select("*").limit(1);
if (au.error) {
  console.log("ERROR reading app_users:", au.error.code, au.error.message);
} else if (!au.data?.length) {
  console.log("Table exists but no rows.");
} else {
  const row = au.data[0];
  console.log("Columns + sample types:");
  for (const k of Object.keys(row)) {
    const v = row[k];
    console.log(`  ${k}: ${typeof v} ${v === null ? "(null)" : ""}`);
  }
  // Detect uuid vs int id
  const idVal = row.id;
  if (typeof idVal === "string" && /^[0-9a-f-]{36}$/.test(idVal)) {
    console.log("  -> id appears to be UUID");
  } else if (typeof idVal === "number") {
    console.log("  -> id appears to be integer");
  } else {
    console.log(`  -> id is type=${typeof idVal} val=${idVal}`);
  }
}

const auCount = await sb.from("app_users").select("id", { count: "exact", head: true });
console.log("Total app_users rows:", auCount.count);

const admins = await sb
  .from("app_users")
  .select("email, is_admin")
  .eq("is_admin", true);
console.log("Admins:");
for (const a of admins.data ?? []) console.log(`  ${a.email}`);

console.log("\n=== 3. Existing CRM tables (sanity) ===");
for (const t of ["crm_threads", "crm_messages"]) {
  const r = await sb.from(t).select("id", { count: "exact", head: true });
  if (r.error) console.log(`  ${t}: NOT PRESENT (${r.error.code})`);
  else console.log(`  ${t}: PRESENT, ${r.count} rows`);
}
