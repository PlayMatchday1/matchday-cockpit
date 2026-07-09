import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync("/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const WANTED = [
  "ATH Katy", "ATH Pearland", "Hattrick", "KISC", "Lou Fusz Outdoor",
  "Majestic Gardens", "Onion Creek", "PRUMC", "Scissortail Park", "Soccer Central",
];

const { data: venues } = await sb
  .from("fin_venues")
  .select("id, venue_name, city, billing_type, per_match_rate, hourly_rate, cost_per_match, max_spots")
  .order("venue_name");
const { data: aliases } = await sb
  .from("fin_venue_aliases")
  .select("alias, canonical_venue");

const lookupByName = new Map();
for (const v of venues) lookupByName.set(v.venue_name.toLowerCase(), v);
for (const a of aliases) {
  const t = venues.find(v => v.venue_name === a.canonical_venue);
  if (t) lookupByName.set(a.alias.toLowerCase(), t);
}
function resolve(name) {
  const exact = lookupByName.get(name.toLowerCase());
  if (exact) return { match: exact, how: "exact" };
  const lc = name.toLowerCase();
  for (const v of venues) {
    const cn = v.venue_name.toLowerCase();
    if (cn.includes(lc) || lc.includes(cn)) return { match: v, how: `partial (canonical="${v.venue_name}")` };
  }
  for (const a of aliases) {
    const al = a.alias.toLowerCase();
    if (al.includes(lc) || lc.includes(al)) {
      const t = venues.find(v => v.venue_name === a.canonical_venue);
      if (t) return { match: t, how: `alias-partial (via "${a.alias}")` };
    }
  }
  return { match: null, how: "no match" };
}

console.log("=== 1. Venue resolution ===\n");
const resolved = [];
for (const w of WANTED) {
  const r = resolve(w);
  resolved.push({ wanted: w, ...r });
  if (!r.match) console.log(`  ${w.padEnd(22)} — NOT FOUND IN fin_venues`);
  else {
    console.log(
      `  ${w.padEnd(22)} → "${r.match.venue_name}"  city=${r.match.city}  billing=${r.match.billing_type}  ` +
      `pm=${r.match.per_match_rate ?? "—"}  hr=${r.match.hourly_rate ?? "—"}  cpm=${r.match.cost_per_match ?? "—"}  max=${r.match.max_spots ?? "—"}  (${r.how})`
    );
  }
}

// Print every venue's known aliases (so user sees what raw names route to canonical).
console.log("\n=== 1b. Aliases for resolved venues ===");
const matchedNames = new Set(resolved.filter(r => r.match).map(r => r.match.venue_name));
for (const name of matchedNames) {
  const als = aliases.filter(a => a.canonical_venue === name).map(a => a.alias);
  if (als.length) console.log(`  ${name}: [${als.join(", ")}]`);
}

// === 2. fin_schedule May 2026 — venue is the post-alias canonical text here ===
console.log("\n=== 2. fin_schedule May 2026 — rows per resolved canonical ===\n");
const { data: schedRows } = await sb
  .from("fin_schedule")
  .select("date, month, city, venue, match_count, total_hours, manual_entry")
  .eq("month", "May 2026");

const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
function dowOf(s){ const [y,m,d]=s.split("-").map(Number); return DOW[new Date(y,m-1,d,12).getDay()]; }

const byVenue = new Map();
for (const r of schedRows) {
  // fin_schedule.venue is text; we group by it directly and later cross-ref to canonical
  if (!byVenue.has(r.venue)) byVenue.set(r.venue, []);
  byVenue.get(r.venue).push(r);
}

for (const w of WANTED) {
  const r = resolved.find(x => x.wanted === w);
  if (!r?.match) continue;
  const canonical = r.match.venue_name;
  // Collect all schedule rows whose venue == canonical OR matches any alias
  const aliasList = aliases.filter(a => a.canonical_venue === canonical).map(a => a.alias);
  const allKeys = [canonical, ...aliasList];
  const rows = [];
  for (const k of allKeys) {
    const list = byVenue.get(k);
    if (list) rows.push(...list);
  }
  if (rows.length === 0) { console.log(`--- ${canonical} (${w}) — NO May 2026 fin_schedule rows`); continue; }
  rows.sort((a,b)=>a.date.localeCompare(b.date));
  const byDow = new Map();
  let total = 0;
  for (const row of rows) {
    const d = dowOf(row.date);
    if (!byDow.has(d)) byDow.set(d, { dates: [], counts: [], hours: [] });
    byDow.get(d).dates.push(row.date);
    byDow.get(d).counts.push(row.match_count ?? 0);
    byDow.get(d).hours.push(row.total_hours);
    total += row.match_count ?? 0;
  }
  console.log(`--- ${canonical} (${w}) — ${rows.length} schedule rows, ${total} total matches`);
  for (const d of DOW) {
    const v = byDow.get(d);
    if (!v) continue;
    const dc = [...new Set(v.counts)].sort((a,b)=>a-b).join("/");
    const dh = [...new Set(v.hours.map(h => h ?? "null"))].join("/");
    console.log(`   ${d}: ${v.dates.length} weeks · match_count=${dc} · total_hours=${dh} · dates=${v.dates.join(",")}`);
  }
}

// === 3. mdapi_matches May 2026 distinct DOW × time per venue ===
console.log("\n=== 3. mdapi_matches May 2026 distinct slots (DOW HH:MM) per venue ===\n");
const { data: matches } = await sb
  .from("mdapi_matches")
  .select("start_date, field_title, name, is_cancelled")
  .gte("start_date", "2026-05-01")
  .lt("start_date", "2026-06-01");

function venueOfTitle(title) {
  if (!title) return null;
  const lc = title.toLowerCase();
  // exact alias match wins
  for (const a of aliases) if (a.alias.toLowerCase() === lc) return a.canonical_venue;
  for (const v of venues) if (v.venue_name.toLowerCase() === lc) return v.venue_name;
  // longest-substring fallback
  let best = null;
  for (const v of venues) {
    const cn = v.venue_name.toLowerCase();
    if (lc.includes(cn) && (!best || cn.length > best.len)) best = { name: v.venue_name, len: cn.length };
  }
  for (const a of aliases) {
    const al = a.alias.toLowerCase();
    if (lc.includes(al) && (!best || al.length > best.len)) best = { name: a.canonical_venue, len: al.length };
  }
  return best?.name ?? null;
}

const slotsByVenue = new Map();
const titleByVenue = new Map();
for (const m of matches) {
  const v = venueOfTitle(m.field_title);
  if (!v || !matchedNames.has(v)) continue;
  const dt = new Date(m.start_date);
  if (isNaN(dt.getTime())) continue;
  const dow = DOW[dt.getDay()];
  const slot = `${dow} ${String(dt.getHours()).padStart(2,"0")}:${String(dt.getMinutes()).padStart(2,"0")}`;
  if (!slotsByVenue.has(v)) slotsByVenue.set(v, new Map());
  const inner = slotsByVenue.get(v);
  const key = `${slot}|${m.name ?? ""}`;
  inner.set(key, (inner.get(key) ?? 0) + 1);
  if (!titleByVenue.has(v)) titleByVenue.set(v, new Set());
  titleByVenue.get(v).add(m.field_title);
}

for (const w of WANTED) {
  const r = resolved.find(x => x.wanted === w);
  if (!r?.match) continue;
  const canonical = r.match.venue_name;
  const inner = slotsByVenue.get(canonical);
  const titles = [...(titleByVenue.get(canonical) ?? [])];
  if (!inner) { console.log(`--- ${canonical} (${w}) — NO May 2026 mdapi_matches`); continue; }
  console.log(`--- ${canonical} (${w}) — ${inner.size} distinct (DOW × time × subfield)  feed-titles=[${titles.join(" | ")}]`);
  const sorted = [...inner.entries()].sort((a,b) => {
    const [dowA, timeA] = a[0].split("|")[0].split(" ");
    const [dowB, timeB] = b[0].split("|")[0].split(" ");
    const di = DOW.indexOf(dowA) - DOW.indexOf(dowB);
    return di !== 0 ? di : timeA.localeCompare(timeB);
  });
  for (const [k, n] of sorted) {
    const [slot, sub] = k.split("|");
    console.log(`    ${slot}  ${sub ? `[${sub}]  ` : ""}× ${n} matches`);
  }
}
