import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local","utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

async function paginateAll(q, pageSize = 1000) {
  let from = 0, all = [];
  for (;;) {
    const { data, error } = await q.range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

const CITY_ABBR_TO_COCKPIT = {
  ATX: "Austin", HOU: "Houston", SATX: "San Antonio", DFW: "Dallas",
  ATL: "Atlanta", OKC: "OKC", STL: "St. Louis", ELP: "El Paso",
};
const DELETED = "Deleted Account Revenue";
function cityFromAbbr(raw) {
  const t = (raw ?? "").trim();
  if (!t) return null;
  return CITY_ABBR_TO_COCKPIT[t] ?? null;
}

// === Replicate the exact route logic ===
console.log("=== Build emailToCity map (route logic, simulated locally) ===");

const memberRows = await paginateAll(sb.from("mdapi_subscriptions").select("member_email, city_identifier").order("membership_id"));
const emailToCity = new Map();
let primaryCount = 0;
for (const m of memberRows) {
  if (m.member_email) {
    emailToCity.set(m.member_email.toLowerCase().trim(), cityFromAbbr(m.city_identifier) ?? DELETED);
    primaryCount++;
  }
}
console.log(`  After PRIMARY (mdapi_subscriptions): ${emailToCity.size} entries`);

const userRows = await paginateAll(
  sb.from("mdapi_users").select("email, preferable_city_normalized")
    .not("email","is",null).not("preferable_city_normalized","is",null).order("id")
);
let fallbackCount = 0;
for (const u of userRows) {
  if (!u.email) continue;
  const email = u.email.toLowerCase().trim();
  if (emailToCity.has(email)) continue;
  emailToCity.set(email, cityFromAbbr(u.preferable_city_normalized) ?? DELETED);
  fallbackCount++;
}
console.log(`  After FALLBACK (mdapi_users): added ${fallbackCount} entries (total ${emailToCity.size})`);

// === Distribution of values in the final map ===
const valHist = new Map();
for (const v of emailToCity.values()) valHist.set(v, (valHist.get(v) ?? 0) + 1);
console.log("\n=== Final map value distribution ===");
for (const [v, n] of [...valHist.entries()].sort((a,b)=>b[1]-a[1])) {
  console.log(`  ${v.padEnd(28)} ${n}`);
}

// === Sanity check: how many of the entries map to DELETED (i.e., are useless)? ===
const usefulCount = [...emailToCity.values()].filter(v => v !== DELETED).length;
const uselessCount = emailToCity.size - usefulCount;
console.log(`\n  Entries that resolve to a real city: ${usefulCount}`);
console.log(`  Entries that resolve to DELETED (useless): ${uselessCount}`);

// === Probe the raw preferable_city_normalized values to see what's UNRECOGNIZED ===
console.log("\n=== mdapi_users.preferable_city_normalized value histogram (top 20) ===");
const cityHist = new Map();
for (const u of userRows) {
  const c = (u.preferable_city_normalized ?? "").trim();
  cityHist.set(c, (cityHist.get(c) ?? 0) + 1);
}
for (const [c, n] of [...cityHist.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 20)) {
  const resolves = cityFromAbbr(c);
  console.log(`  ${JSON.stringify(c).padEnd(20)} ${n}  → ${resolves ?? "(unrecognized → DELETED)"}`);
}
