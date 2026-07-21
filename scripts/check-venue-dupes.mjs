import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

// Pull every (city, venue_name) and look for dupes in JS (PostgREST
// can't run GROUP BY ... HAVING directly without an RPC).
const { data, error } = await sb
  .from("fin_venues")
  .select("id, city, venue_name");
if (error) { console.error(error); process.exit(1); }

const counts = new Map();
for (const r of data) {
  const key = `${r.city}|||${r.venue_name}`;
  if (!counts.has(key)) counts.set(key, []);
  counts.get(key).push(r.id);
}

const dupes = [...counts.entries()].filter(([, ids]) => ids.length > 1);
console.log(`Total fin_venues rows: ${data.length}`);
console.log(`Distinct (city, venue_name) pairs: ${counts.size}`);
console.log(`Duplicate pairs: ${dupes.length}`);
if (dupes.length === 0) {
  console.log("\nSafe to apply unique index — no (city, venue_name) collisions.");
} else {
  console.log("\nDUPLICATES (would block unique index):");
  for (const [k, ids] of dupes) {
    const [city, name] = k.split("|||");
    console.log(`  city=${JSON.stringify(city)}  venue_name=${JSON.stringify(name)}  ids=[${ids.join(", ")}]`);
  }
}

// Also probe fin_venue_aliases column shape — the report flagged
// ambiguity between (alias, canonical_venue) vs (alias_name, canonical_name).
console.log("\n=== fin_venue_aliases sample (column probe) ===");
const aliasProbe = await sb.from("fin_venue_aliases").select("*").limit(2);
if (aliasProbe.error) console.error(aliasProbe.error);
else {
  console.log("rows:", aliasProbe.data.length);
  if (aliasProbe.data[0]) console.log("columns:", Object.keys(aliasProbe.data[0]).join(", "));
  for (const r of aliasProbe.data) console.log(" ", JSON.stringify(r));
}
