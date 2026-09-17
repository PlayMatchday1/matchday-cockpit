import "server-only"; // no-op under --conditions=react-server
//
// EVERY VENUE THE SPLIT RESOLVER CAN ROUTE A MATCH TO.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/split-resolver-audit.ts
//
// THE CLASS OF BUG THIS EXISTS TO CLOSE. A match's venue is resolved in two steps: field_id through
// fin_venue_fields, and then resolveSplitRateVenueId, which can re-route the row to a DIFFERENT
// venue. No mdapi field links to a secondary leg, so any count that stops after step one attributes
// every match to the primary and the secondary looks empty. That is how $61,860 of modelled cost sat
// on two legs nobody was looking at, and how a report came to state that both legs carried zero 2026
// matches.
//
// So this audit does not ask "which venues have matches". It asks which venues the RESOLVER can
// name, by reading the pair list the resolver itself reads, and then reports what each one carries.
import { readFileSync } from "node:fs";

import { canonicalVenueCost } from "../src/lib/financeCosts";
import { COMBINE_BY_NAME, resolveSplitRateVenueId, groupVenues } from "../src/lib/venueGroups";
import { legPerMatchUnitCost, venueChargedMatchCountFor } from "../src/lib/financeStats";
import { venueCategory } from "../src/lib/venueResolver";
import { emptyMdapiMemberSpotIndex } from "../src/lib/financeStats";
import type { FinanceData, FinMasterSchedule, FinVenue } from "../src/lib/useFinanceData";
import type { Q2Month } from "../src/lib/financeStats";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }),
);
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY };

async function all<T = Record<string, unknown>>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${BASE}/rest/v1/${path}`, { headers: { ...H, Range: `${from}-${from + 999}`, "Range-Unit": "items" } });
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    const rows = (await res.json()) as T[];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug"];
const MONTHS = MON.map((m) => `${m} 2026`) as Q2Month[];
const money = (n: number) => (n < 0 ? "-" : "") + "$" +
  Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const venuesRaw = await all("fin_venues?select=*&order=id");
  const links = await all("fin_venue_fields?select=*");
  const overrides = await all("fin_venue_cost_overrides?select=*");
  const venues = venuesRaw.map((v) => ({
    ...v,
    raw_venue_name: (v.raw_venue_name as string) ?? (v.venue_name as string),
    charge_on_cancel: v.charge_on_cancel !== false,
    bills_per_reservation: v.bills_per_reservation === true,
  })) as unknown as FinVenue[];
  const V = new Map(venues.map((v) => [v.id, v]));
  const venueFields = new Map<number, number>(links.map((l) => [Number(l.mdapi_field_id), Number(l.fin_venue_id)]));
  const countsAsRegular = new Set<number>(links.filter((l) => l.counts_as_regular_play === true).map((l) => Number(l.mdapi_field_id)));

  const win = "&start_date=gte.2026-01-01&start_date=lte.2026-08-31T23:59:59&deleted_at=is.null";
  const raw = await all(`mdapi_matches?select=api_id,field_id,start_date,start_date_utc,is_cancelled,max_player_count,field_title,city_identifier${win}&order=api_id`);

  const toRow = (r: Record<string, unknown>): FinMasterSchedule => {
    const startDate = r.start_date ? String(r.start_date) : "";
    const matchDate = startDate ? new Date(startDate).toISOString().slice(0, 10) : "";
    const fid = r.field_id == null ? null : Number(r.field_id);
    const cap = r.max_player_count == null ? null : Math.round(Number(r.max_player_count) || 0);
    let venue_id = fid != null ? (venueFields.get(fid) ?? null) : null;
    if (venue_id != null && matchDate) venue_id = resolveSplitRateVenueId(venue_id, matchDate, venues, cap);
    return {
      id: String(r.api_id), city: String(r.city_identifier ?? ""), venue: "",
      match_date: matchDate, match_time: startDate.slice(11, 16),
      month: matchDate ? `${MON[Number(matchDate.slice(5, 7)) - 1] ?? "?"} ${matchDate.slice(0, 4)}` : "",
      max_spots: 0, mdapi_field_id: fid, venue_id, duration_hours: 1,
      category: fid != null && countsAsRegular.has(fid) ? "regular" : venueCategory(r.field_title ? String(r.field_title) : null),
      field_title: r.field_title ? String(r.field_title) : "",
      start_utc_ms: r.start_date_utc ? Date.parse(String(r.start_date_utc)) : null,
    } as FinMasterSchedule;
  };
  const mapped = raw.map(toRow);
  const data = {
    revenue: [], expenses: [], managerPay: [], memberSpots: [], members: [], pricing: [],
    venueAliases: new Map(), venueFieldLinks: [], config: {}, mdapiMemberSpots: emptyMdapiMemberSpotIndex(),
    masterSchedule: mapped.filter((_, i) => raw[i].is_cancelled !== true),
    cancelledSchedule: mapped.filter((_, i) => raw[i].is_cancelled === true),
    venues, venueFields, overrides, partnerDashboards: [], partnerPayoutsByVenueMonth: new Map(),
  } as unknown as FinanceData;

  // ── WHICH VENUES CAN THE RESOLVER NAME ────────────────────────────────────────────────────────
  // Read from the resolver's own config rather than a list retyped here. COMBINE_BY_NAME is
  // exported precisely so no second copy of the pair list can drift from it.
  console.log("=== THE RESOLVER'S OWN PAIR LIST (src/lib/venueGroups.ts, COMBINE_BY_NAME) ===");
  console.log(`  ${COMBINE_BY_NAME.length} pairs registered\n`);
  const routable = new Set<number>();
  for (const pair of COMBINE_BY_NAME) {
    for (const nm of [pair.primary, pair.secondary]) {
      const hits = venues.filter((v) => v.raw_venue_name === nm);
      for (const v of hits) routable.add(v.id);
      console.log(`  ${nm.padEnd(30)} -> ${hits.map((v) => `venue ${v.id} [${v.city}]`).join(", ") || "NO VENUE ROW"}`);
    }
  }
  // A secondary leg is only reachable by routing, never by a field link. Prove which is which.
  console.log("\n=== EVERY ROUTABLE VENUE, AND WHETHER A FIELD LINKS TO IT DIRECTLY ===");
  console.log("venue                              linked fields   2026 matches   modelled cost   kind");
  const secondaries = new Set(COMBINE_BY_NAME.map((p) => p.secondary));
  for (const id of [...routable].sort((a, b) => a - b)) {
    const v = V.get(id)!;
    const linked = links.filter((l) => Number(l.fin_venue_id) === id).map((l) => l.mdapi_field_id);
    let matches = 0, cost = 0;
    const kinds = new Set<string>();
    for (const m of MONTHS) {
      const c = canonicalVenueCost(data, id, m);
      matches += c.matchCount; cost += c.amount; kinds.add(c.kind);
    }
    const isSecondary = secondaries.has(v.raw_venue_name);
    console.log(`${(v.venue_name + " (" + id + ")").padEnd(34)} ${(linked.length ? linked.join(",") : "NONE").padEnd(15)} ${String(matches).padStart(12)} ${money(cost).padStart(15)}   ${[...kinds].join("/")}${isSecondary ? "   <- SECONDARY, reachable ONLY by routing" : ""}`);
  }

  // Is anything else re-routing matches? A row whose venue_id is not the one its field links to has
  // been moved by the resolver; group those by destination so a third mechanism cannot hide.
  console.log("\n=== EVERY MATCH WHOSE VENUE DIFFERS FROM ITS FIELD LINK ===");
  const moved = new Map<string, number>();
  mapped.forEach((s, i) => {
    const linkTo = s.mdapi_field_id != null ? (venueFields.get(s.mdapi_field_id) ?? null) : null;
    if (linkTo !== s.venue_id) {
      const k = `${linkTo == null ? "unlinked" : `${V.get(linkTo)?.venue_name} (${linkTo})`} -> ${s.venue_id == null ? "DROPPED (special event)" : `${V.get(s.venue_id)?.venue_name} (${s.venue_id})`}`;
      moved.set(k, (moved.get(k) ?? 0) + 1);
      void i;
    }
  });
  for (const [k, n] of [...moved.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
  const destinations = new Set([...moved.keys()].map((k) => k.split(" -> ")[1]).filter((d) => !d.startsWith("DROPPED")));
  console.log(`\n  distinct re-route destinations: ${destinations.size} -> ${[...destinations].join("; ")}`);

  // ── THE COST PAGE, WHICH IS A DIFFERENT COLUMN ────────────────────────────────────────────────
  // legPerMatchUnitCost order: the leg's own cost_per_match, THEN a secondary leg's per_match_rate,
  // THEN the primary's cost_per_match. So zeroing per_match_rate only reaches the Cost page on a
  // secondary leg whose cost_per_match is null. That is venue 23 and not venue 53.
  console.log("\n=== THE COST PAGE PER-MATCH PATH, PER LEG ===");
  const groups = groupVenues(venues);
  for (const g of groups.filter((x) => x.legs.some((l) => routable.has(l.id)))) {
    const primary = g.legs[0];
    console.log(`  group "${g.displayName}"`);
    let unitTotal = 0, matchTotal = 0;
    for (const leg of g.legs) {
      const cpm = legPerMatchUnitCost(leg, primary);
      const n = MONTHS.reduce((t, m) => t + venueChargedMatchCountFor(data, leg.id, m), 0);
      unitTotal += cpm * n; matchTotal += n;
      const src = leg.cost_per_match != null ? "own cost_per_match"
        : leg.id !== primary.id && leg.per_match_rate != null ? "SECONDARY fallback to per_match_rate"
        : "primary cost_per_match";
      console.log(`    leg ${String(leg.id).padStart(2)} ${leg.venue_name.padEnd(28)} unit $${String(cpm).padStart(4)} x ${String(n).padStart(4)} matches = ${money(cpm * n).padStart(12)}   via ${src}`);
    }
    console.log(`    group per-match normalized cost Jan-Aug: ${money(unitTotal)} over ${matchTotal} matches` +
      `${matchTotal ? ` = ${money(unitTotal / matchTotal)} per match` : ""}`);
  }
}

main().catch((e) => { console.error("AUDIT FAILED:", e.message); process.exit(1); });
