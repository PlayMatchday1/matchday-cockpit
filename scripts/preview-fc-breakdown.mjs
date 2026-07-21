// Apr→May + May→Jun Field Costs per-venue with breakdown text.
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
  return r > 0 ? `+$${Math.abs(r).toLocaleString("en-US")}` : `-$${Math.abs(r).toLocaleString("en-US")}`;
};

const [venues, overrides, schedule] = await Promise.all([
  sb.from("fin_venues").select("*").then((r) => r.data),
  sb.from("fin_venue_cost_overrides").select("*").then((r) => r.data),
  sb.from("fin_schedule").select("*").then((r) => r.data),
]);

function findOverride(venueId, month) {
  return overrides.find((o) => o.venue_id === venueId && o.month === month) ?? null;
}
function infoFor(venue, month) {
  const ov = findOverride(venue.id, month);
  if (ov) {
    return {
      kind: "override",
      amount: Number(ov.override_amount),
      matchCount: 0,
      override: ov,
    };
  }
  if (venue.billing_type === "per_match") {
    const rate = Number(venue.per_match_rate ?? 0);
    const mc = schedule
      .filter((s) => s.venue === venue.venue_name && s.month === month)
      .reduce((sum, r) => sum + (Number(r.match_count) || 0), 0);
    return { kind: "per_match", amount: mc * rate, matchCount: mc, override: null };
  }
  if (venue.billing_type === "per_hour") {
    const rate = Number(venue.hourly_rate ?? 0);
    if (rate <= 0) {
      return { kind: "per_hour_no_fee", amount: 0, matchCount: 0, override: null };
    }
    const hrs = schedule
      .filter((s) => s.venue === venue.venue_name && s.month === month)
      .reduce((sum, r) => sum + (Number(r.total_hours) || 0), 0);
    return { kind: "per_hour_metered", amount: hrs * rate, matchCount: 0, totalHours: hrs, override: null };
  }
  if (venue.billing_type === "no_charge") {
    return { kind: "no_charge", amount: 0, matchCount: 0, override: null };
  }
  return { kind: "needs_override", amount: 0, matchCount: 0, override: null };
}
function compactCostBreakdown(info) {
  if (info.kind === "override") {
    if (info.amount === 0) return "Pre-paid";
    const r = (info.override?.reason ?? "").toLowerCase();
    if (r.includes("monthly_flat") || r.includes("monthly flat")) return "Monthly flat";
    if (r.includes("lump_sum") || r.includes("lump sum")) return "Lump sum";
    if (r.includes("profit_share") || r.includes("profit share")) return "Profit share";
    return "Override";
  }
  if (info.kind === "per_match") {
    if (info.matchCount === 0) return "—";
    const rate = info.amount / info.matchCount;
    const rateStr = Number.isInteger(rate) ? `$${rate}` : `$${rate.toFixed(2)}`;
    return `${info.matchCount} × ${rateStr}`;
  }
  if (info.kind === "per_hour_metered") return `${info.totalHours}h`;
  if (info.kind === "no_charge" || info.kind === "per_hour_no_fee") return "No fee";
  if (info.kind === "needs_override") return "Needs override";
  return "—";
}

function renderPair(fromMonth, toMonth, fromLbl, toLbl) {
  console.log(`\n=== ${fromLbl} → ${toLbl} ===`);
  const rows = [];
  for (const v of venues) {
    const fi = infoFor(v, fromMonth);
    const ti = infoFor(v, toMonth);
    if (fi.amount <= 0 && ti.amount <= 0) continue;
    rows.push({
      label: `${v.city} · ${v.venue_name}`,
      from: fi.amount,
      to: ti.amount,
      delta: ti.amount - fi.amount,
      fromBd: compactCostBreakdown(fi),
      toBd: compactCostBreakdown(ti),
    });
  }
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  // Apply $50 threshold + Other rollup like buildChildren does.
  const big = rows.filter((r) => Math.abs(r.delta) >= 50);
  const small = rows.filter((r) => Math.abs(r.delta) < 50 && Math.abs(r.delta) >= 0.5);
  for (const r of big) {
    console.log(
      `  ${r.label.padEnd(36)} ${fmt(r.from).padStart(9)} ${fmt(r.to).padStart(9)} ${fmtSig(r.delta).padStart(9)}`,
    );
    console.log(
      `      ${fromLbl}: ${r.fromBd.padEnd(20)} ${toLbl}: ${r.toBd}`,
    );
  }
  if (small.length > 0) {
    const oFrom = small.reduce((s, x) => s + x.from, 0);
    const oTo = small.reduce((s, x) => s + x.to, 0);
    const oDelta = oTo - oFrom;
    console.log(`  Other (${small.length} ${small.length === 1 ? "city" : "cities"})              ${fmt(oFrom).padStart(9)} ${fmt(oTo).padStart(9)} ${fmtSig(oDelta).padStart(9)}`);
  }
}

renderPair("Apr 2026", "May 2026", "Apr", "May");
renderPair("May 2026", "Jun 2026", "May", "Jun");
