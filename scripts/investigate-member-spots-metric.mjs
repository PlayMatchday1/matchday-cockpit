// Read-only investigation for the "Member Spots — $X / N spots used"
// Finance Cities metric. Dumps fin_revenue / fin_member_spots shape
// and computes the candidate query for Apr 2026.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const CANON_CITIES = [
  "Austin", "Dallas", "Houston", "San Antonio",
  "Atlanta", "St. Louis", "OKC", "El Paso",
];

// ─── fin_revenue ────────────────────────────────────────────────────
const { data: rev, error: revErr } = await sb
  .from("fin_revenue")
  .select("id, month, city, venue, type, source, gross, net, notes");
if (revErr) {
  console.error("fin_revenue error:", revErr);
  process.exit(1);
}
console.log(`\n========================================`);
console.log(`fin_revenue — ${rev.length} total rows`);
console.log(`========================================`);

// distinct types overall, with Apr 2026 breakdown
const typeAprCount = new Map();
const typeAprNet = new Map();
const typeAllCount = new Map();
for (const r of rev) {
  typeAllCount.set(r.type, (typeAllCount.get(r.type) ?? 0) + 1);
  if (r.month === "Apr 2026") {
    typeAprCount.set(r.type, (typeAprCount.get(r.type) ?? 0) + 1);
    typeAprNet.set(r.type, (typeAprNet.get(r.type) ?? 0) + Number(r.net ?? 0));
  }
}
console.log("\nDistinct `type` values (all-time row counts) and Apr 2026 (rows / sum net):");
const allTypes = [...new Set(rev.map((r) => r.type))].sort((a, b) => String(a).localeCompare(String(b)));
for (const t of allTypes) {
  const allN = typeAllCount.get(t) ?? 0;
  const aN = typeAprCount.get(t) ?? 0;
  const aSum = typeAprNet.get(t) ?? 0;
  console.log(
    `  ${String(t).padEnd(20)}  all-time rows=${String(allN).padStart(5)}   Apr 2026 rows=${String(aN).padStart(4)}   Apr 2026 net=$${aSum.toFixed(2).padStart(10)}`,
  );
}

// distinct cities + canonical-city match check
const cityCount = new Map();
for (const r of rev) cityCount.set(r.city ?? "(null)", (cityCount.get(r.city ?? "(null)") ?? 0) + 1);
console.log(`\nDistinct fin_revenue.city values (${cityCount.size}):`);
for (const [c, n] of [...cityCount.entries()].sort((a, b) => b[1] - a[1])) {
  const canon = CANON_CITIES.includes(c) ? "✓" : "  ";
  console.log(`  ${canon} ${String(c).padEnd(25)} ${n} rows`);
}

// Membership rows: source / venue / notes shape (5 samples)
console.log("\nSample 5 Membership-type rows:");
const memberRows = rev.filter((r) => r.type === "Membership").slice(0, 5);
for (const r of memberRows) {
  console.log("  ", JSON.stringify({
    month: r.month, city: r.city, venue: r.venue,
    type: r.type, source: r.source, net: r.net, notes: r.notes,
  }));
}

console.log("\nSample 5 DPP-type rows:");
const dppRows = rev.filter((r) => r.type === "DPP").slice(0, 5);
for (const r of dppRows) {
  console.log("  ", JSON.stringify({
    month: r.month, city: r.city, venue: r.venue,
    type: r.type, source: r.source, net: r.net, notes: r.notes,
  }));
}

// Source distribution for Membership specifically
console.log("\nMembership rows — distinct `source` values:");
const memberSources = new Map();
for (const r of rev) {
  if (r.type !== "Membership") continue;
  memberSources.set(r.source ?? "(null)", (memberSources.get(r.source ?? "(null)") ?? 0) + 1);
}
for (const [s, n] of [...memberSources.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(s).padEnd(20)} ${n} rows`);
}

// Apr 2026 Membership rev per city — sanity output
console.log("\nApr 2026 Membership net by city (fin_revenue type='Membership'):");
const aprMemByCity = new Map();
for (const r of rev) {
  if (r.month !== "Apr 2026" || r.type !== "Membership") continue;
  aprMemByCity.set(r.city, (aprMemByCity.get(r.city) ?? 0) + Number(r.net ?? 0));
}
for (const c of CANON_CITIES) {
  const v = aprMemByCity.get(c) ?? 0;
  console.log(`  ${c.padEnd(15)} $${v.toFixed(2)}`);
}

// ─── fin_member_spots ───────────────────────────────────────────────
const { data: ms, error: msErr } = await sb
  .from("fin_member_spots")
  .select("*");
if (msErr) {
  console.error("fin_member_spots error:", msErr);
  process.exit(1);
}
console.log(`\n========================================`);
console.log(`fin_member_spots — ${ms.length} total rows`);
console.log(`========================================`);
console.log("Columns on sample row:", Object.keys(ms[0] ?? {}).join(", "));

const msCityCount = new Map();
const msMonthCount = new Map();
for (const r of ms) {
  msCityCount.set(r.city ?? "(null)", (msCityCount.get(r.city ?? "(null)") ?? 0) + 1);
  msMonthCount.set(r.month ?? "(null)", (msMonthCount.get(r.month ?? "(null)") ?? 0) + 1);
}
console.log(`\nDistinct fin_member_spots.city values (${msCityCount.size}):`);
for (const [c, n] of [...msCityCount.entries()].sort((a, b) => b[1] - a[1])) {
  const canon = CANON_CITIES.includes(c) ? "✓" : "  ";
  const inRev = cityCount.has(c) ? "rev✓" : "rev✗";
  console.log(`  ${canon} ${inRev}  ${String(c).padEnd(25)} ${n} rows`);
}
console.log(`\nDistinct fin_member_spots.month values (${msMonthCount.size}):`);
for (const [m, n] of [...msMonthCount.entries()].sort()) {
  console.log(`  ${String(m).padEnd(12)} ${n} rows`);
}

console.log("\nSample 5 fin_member_spots rows:");
for (const r of ms.slice(0, 5)) console.log("  ", JSON.stringify(r));

// City strings cross-check
console.log("\n=== City string cross-check ===");
const revCities = new Set(rev.map((r) => r.city).filter(Boolean));
const msCities = new Set(ms.map((r) => r.city).filter(Boolean));
console.log("In fin_revenue NOT in fin_member_spots:",
  [...revCities].filter((c) => !msCities.has(c)));
console.log("In fin_member_spots NOT in fin_revenue:",
  [...msCities].filter((c) => !revCities.has(c)));
console.log("Canonical NOT in fin_revenue:",
  CANON_CITIES.filter((c) => !revCities.has(c)));
console.log("Canonical NOT in fin_member_spots:",
  CANON_CITIES.filter((c) => !msCities.has(c)));

// ─── Proposed metric output (per-city per-month) ─────────────────────
console.log(`\n========================================`);
console.log(`Proposed metric: Member Spots — $X / N spots used  (Apr 2026)`);
console.log(`========================================`);
console.log("city          | membership $ | member_spots | dpp_spots | other_spots");
for (const c of CANON_CITIES) {
  const rev$ = aprMemByCity.get(c) ?? 0;
  const spots = ms.filter((r) => r.city === c && r.month === "Apr 2026");
  const mem = spots.reduce((s, r) => s + (Number(r.member_spots) || 0), 0);
  const dpp = spots.reduce((s, r) => s + (Number(r.dpp_spots) || 0), 0);
  const other = spots.reduce((s, r) => s + (Number(r.other_spots) || 0), 0);
  console.log(
    `  ${c.padEnd(13)} | $${rev$.toFixed(2).padStart(10)} | ${String(mem).padStart(12)} | ${String(dpp).padStart(9)} | ${String(other).padStart(11)}`,
  );
}
