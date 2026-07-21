// Preview Apr → May Field Costs per-venue with from/to/delta — same
// shape the new drill-down will render.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)[1].trim();
const sb = createClient(url, key);

const fmt = (n) => "$" + Math.round(Number(n)).toLocaleString("en-US");
const fmtSig = (n) => {
  const r = Math.round(n);
  if (r === 0) return "$0";
  const abs = Math.abs(r).toLocaleString("en-US");
  return r > 0 ? `+$${abs}` : `-$${abs}`;
};

const [venues, overrides, schedule] = await Promise.all([
  sb.from("fin_venues").select("*").then((r) => r.data),
  sb.from("fin_venue_cost_overrides").select("*").then((r) => r.data),
  sb.from("fin_schedule").select("*").then((r) => r.data),
]);

function findOverride(venueId, month) {
  return overrides.find((o) => o.venue_id === venueId && o.month === month) ?? null;
}
function fieldCost(venue, month) {
  const ov = findOverride(venue.id, month);
  if (ov) return Number(ov.override_amount);
  if (venue.billing_type === "per_match") {
    const rate = Number(venue.per_match_rate ?? 0);
    const mc = schedule
      .filter((s) => s.venue === venue.venue_name && s.month === month)
      .reduce((sum, r) => sum + (Number(r.match_count) || 0), 0);
    return mc * rate;
  }
  if (venue.billing_type === "per_hour") {
    const rate = Number(venue.hourly_rate ?? 0);
    if (rate <= 0) return 0;
    const hrs = schedule
      .filter((s) => s.venue === venue.venue_name && s.month === month)
      .reduce((sum, r) => sum + (Number(r.total_hours) || 0), 0);
    return hrs * rate;
  }
  return 0;
}

const rows = venues
  .map((v) => {
    const apr = fieldCost(v, "Apr 2026");
    const may = fieldCost(v, "May 2026");
    return {
      name: `${v.city} · ${v.venue_name}`,
      from: apr,
      to: may,
      delta: may - apr,
    };
  })
  .filter((r) => Math.abs(r.delta) >= 0.5);

rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

console.log("All non-zero per-venue deltas, Apr → May, sorted by |Δ| desc:\n");
console.log(
  "VENUE                                       APR        MAY        Δ".padEnd(80) +
    "  bucket",
);
console.log("-".repeat(110));
const big = rows.filter((r) => Math.abs(r.delta) >= 50);
const small = rows.filter((r) => Math.abs(r.delta) < 50);
for (const r of big) {
  console.log(
    `${r.name.padEnd(40)} ${fmt(r.from).padStart(10)} ${fmt(r.to).padStart(10)} ${fmtSig(r.delta).padStart(10)}  individual`,
  );
}
if (small.length > 0) {
  const oFrom = small.reduce((s, x) => s + x.from, 0);
  const oTo = small.reduce((s, x) => s + x.to, 0);
  const oDelta = oTo - oFrom;
  const label = small.length === 1 ? "Other (1 city)" : `Other (${small.length} cities)`;
  console.log(
    `${label.padEnd(40)} ${fmt(oFrom).padStart(10)} ${fmt(oTo).padStart(10)} ${fmtSig(oDelta).padStart(10)}  rolled-up`,
  );
}

console.log("\nSpecial picks for the walkthrough:");
const up = big.find((r) => r.delta > 0);
const down = big.find((r) => r.delta < 0);
const zeroToSomething = big.find((r) => r.from === 0 && r.to !== 0);
const somethingToZero = big.find((r) => r.from !== 0 && r.to === 0);
console.log(`• Cost UP    : ${up?.name} ${fmt(up?.from)} → ${fmt(up?.to)} ${fmtSig(up?.delta)}`);
console.log(`• Cost DOWN  : ${down?.name} ${fmt(down?.from)} → ${fmt(down?.to)} ${fmtSig(down?.delta)}`);
console.log(`• 0 → ≠0     : ${zeroToSomething?.name ?? "(none)"} ${zeroToSomething ? `${fmt(zeroToSomething.from)} → ${fmt(zeroToSomething.to)} ${fmtSig(zeroToSomething.delta)}` : ""}`);
console.log(`• ≠0 → 0     : ${somethingToZero?.name ?? "(none)"} ${somethingToZero ? `${fmt(somethingToZero.from)} → ${fmt(somethingToZero.to)} ${fmtSig(somethingToZero.delta)}` : ""}`);
