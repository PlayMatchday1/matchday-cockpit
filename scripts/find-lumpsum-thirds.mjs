// Find any venue whose Q2 overrides look like a lump sum spread evenly
// across Apr/May/Jun: same amount in all three months and/or a reason
// mentioning "lump_sum" or "1/3".
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(
  "/Users/ryanmancuso/Desktop/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const fmt = (n) => "$" + Math.round(Number(n)).toLocaleString("en-US");

const { data: overrides } = await sb.from("fin_venue_cost_overrides").select("*");
const { data: venues } = await sb.from("fin_venues").select("id,venue_name,city,billing_type");
const venueById = new Map(venues.map((v) => [v.id, v]));

const Q2 = ["Apr 2026", "May 2026", "Jun 2026"];
// Group overrides by venue; only consider venues with at least one Q2 row.
const byVenue = new Map();
for (const o of overrides) {
  if (!Q2.includes(o.month)) continue;
  if (!byVenue.has(o.venue_id)) byVenue.set(o.venue_id, []);
  byVenue.get(o.venue_id).push(o);
}

const flatThirdsCandidates = [];
const reasonHits = [];
for (const [vid, rows] of byVenue) {
  const v = venueById.get(vid);
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  const aprAmt = Number(byMonth.get("Apr 2026")?.override_amount ?? null);
  const mayAmt = Number(byMonth.get("May 2026")?.override_amount ?? null);
  const junAmt = Number(byMonth.get("Jun 2026")?.override_amount ?? null);
  const allThree = byMonth.has("Apr 2026") && byMonth.has("May 2026") && byMonth.has("Jun 2026");

  // Pattern 1: identical amount across all 3 months and amount > 0.
  const isFlatThirds =
    allThree &&
    aprAmt > 0 &&
    Math.abs(aprAmt - mayAmt) < 0.5 &&
    Math.abs(mayAmt - junAmt) < 0.5;

  // Pattern 2: any row's reason mentions lump_sum or 1/3 of.
  const reasonHit = rows.some(
    (r) =>
      /lump[_ ]?sum/i.test(r.reason ?? "") ||
      /1\s*\/\s*3/i.test(r.reason ?? "") ||
      /thirds?/i.test(r.reason ?? "") ||
      /spread/i.test(r.reason ?? ""),
  );

  if (isFlatThirds) flatThirdsCandidates.push({ vid, v, rows, aprAmt, mayAmt, junAmt });
  else if (reasonHit) reasonHits.push({ vid, v, rows });
}

console.log(`\n=== Pattern 1: identical amount across Apr+May+Jun (lump-sum spread suspects) ===\n`);
if (flatThirdsCandidates.length === 0) {
  console.log("(none)");
} else {
  for (const c of flatThirdsCandidates) {
    console.log(
      `venue_id=${c.vid}  ${c.v?.city ?? "?"} · ${c.v?.venue_name ?? "?"}  billing=${c.v?.billing_type ?? "?"}`,
    );
    for (const r of c.rows.sort((a, b) => Q2.indexOf(a.month) - Q2.indexOf(b.month))) {
      console.log(
        `  ${r.month.padEnd(10)}  ${fmt(r.override_amount).padStart(10)}   reason="${r.reason ?? ""}"`,
      );
    }
    console.log(`  → if this is a lump sum, full Q2 = ${fmt(c.aprAmt * 3)}\n`);
  }
}

console.log(`=== Pattern 2: reason mentions lump_sum / 1/3 / thirds / spread (NOT flat-equal) ===\n`);
if (reasonHits.length === 0) {
  console.log("(none beyond the flat-equal set above)");
} else {
  for (const c of reasonHits) {
    console.log(
      `venue_id=${c.vid}  ${c.v?.city ?? "?"} · ${c.v?.venue_name ?? "?"}  billing=${c.v?.billing_type ?? "?"}`,
    );
    for (const r of c.rows.sort((a, b) => Q2.indexOf(a.month) - Q2.indexOf(b.month))) {
      console.log(
        `  ${r.month.padEnd(10)}  ${fmt(r.override_amount).padStart(10)}   reason="${r.reason ?? ""}"`,
      );
    }
    console.log("");
  }
}
