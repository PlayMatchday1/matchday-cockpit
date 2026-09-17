import "server-only"; // no-op under --conditions=react-server
//
// §5 verification for the 2026 field cost load. MEASURED, NOT REASONED.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/field-cost-2026-verify.ts
//
// Every figure here comes out of the REAL canonicalVenueCost, imported from financeCosts.ts.
// scripts/diagnose-nemp.mjs carries a mirrored reimplementation of that function at line 143 and
// this deliberately does not reuse it: a mirror can agree with the page today and drift tomorrow,
// and the whole point of this file is to catch exactly that kind of divergence.
//
// THE BEFORE COLUMN COMES FROM THE BACKUP. fin_venue_cost_overrides_bak_20260916 holds the override
// set as it stood before the load, so before and after are the same code path over two override
// sets rather than two different calculations. That is what makes the month-shift arithmetic
// trustworthy: any difference is the data, never the method.
import { readFileSync } from "node:fs";

import { canonicalVenueCost, isEventSchedule } from "../src/lib/financeCosts";
import { resolveSplitRateVenueId } from "../src/lib/venueGroups";
import { venueCategory } from "../src/lib/venueResolver";
import { emptyMdapiMemberSpotIndex } from "../src/lib/financeStats";
import { buildPartnerPayoutsByVenueMonth, fetchAllEnabledPartnerDashboards } from "../src/lib/partnerStats";
import { fetchLegacyMatchRegistrations } from "../src/lib/mdapiMatchesRead";
import { createClient } from "@supabase/supabase-js";
import type { FinanceData, FinMasterSchedule, FinVenue } from "../src/lib/useFinanceData";
import type { Q2Month } from "../src/lib/financeStats";

let pass = 0;
let fail = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }),
);
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY };

// PostgREST caps a response at 1000 rows, and mdapi_matches over eight months is far past that.
// A silent truncation here would understate every match count and therefore every modelled cost,
// so page explicitly rather than trusting one request.
async function all<T = Record<string, unknown>>(path: string): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${BASE}/rest/v1/${path}`, {
      headers: { ...H, Range: `${from}-${from + PAGE - 1}`, "Range-Unit": "items" },
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    const rows = (await res.json()) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug"];
const MONTHS = MON.map((m) => `${m} 2026`) as Q2Month[];
const RECONCILED = [8, 11, 2, 7, 13, 4, 54, 3, 9, 15, 21, 17, 20, 16, 6, 19, 65, 12, 10, 64, 22];
const FREE = [5, 55];
const IN_SCOPE = [...RECONCILED, ...FREE];
const LABEL_OF: Record<number, string> = {
  8: "ATH Pearland", 11: "Soccer Central", 2: "NEMP", 7: "ATH Katy", 13: "Bicentennial", 4: "RRMPC",
  54: "Strike", 3: "Hattrick Leander", 9: "KISC", 15: "Majestic", 21: "Scissortail",
  17: "Hammond Park", 20: "Centennial Commons", 16: "PRUMC", 6: "Stony Point", 19: "Lou Indoor",
  65: "Ann Richards", 12: "STAR", 10: "PAC Global", 64: "Zipp Family", 22: "Galatzan Park",
  5: "Onion Creek", 55: "LBJ Early College HS",
};
const money = (n: number) => (n < 0 ? "-" : "") + "$" +
  Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cents = (n: number) => Math.round(n * 100);

// ── BUILD ONE FinanceData, TWICE OVER THE SAME SCHEDULE ─────────────────────────────────────────
const supabase = createClient(BASE, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function build() {
  const venuesRaw = await all("fin_venues?select=*&order=id");
  const links = await all("fin_venue_fields?select=*");
  const liveOv = await all("fin_venue_cost_overrides?select=*");
  const bakOv = await all("fin_venue_cost_overrides_bak_20260916?select=*");
  const dashRaw = await all("partner_dashboards?select=*");

  const venues = venuesRaw.map((v) => ({
    ...v,
    raw_venue_name: (v.raw_venue_name as string) ?? (v.venue_name as string),
    charge_on_cancel: v.charge_on_cancel !== false,
    bills_per_reservation: v.bills_per_reservation === true,
  })) as unknown as FinVenue[];

  const venueFields = new Map<number, number>(
    links.map((l) => [Number(l.mdapi_field_id), Number(l.fin_venue_id)]),
  );
  // THE PER-LINK EXCEPTION. A link flagged counts_as_regular_play forces "regular" even when the
  // title reads like an event; without it those matches drop out of the cost calc entirely.
  const countsAsRegular = new Set<number>(
    links.filter((l) => l.counts_as_regular_play === true).map((l) => Number(l.mdapi_field_id)),
  );

  // Jan 1 to Aug 31 2026, both halves of mdapi_matches. deleted_at is excluded: a hard-deleted
  // match is not a thing we were billed for.
  const win = "&start_date=gte.2026-01-01&start_date=lte.2026-08-31T23:59:59&deleted_at=is.null";
  const cols = "api_id,field_id,start_date,start_date_utc,is_cancelled,max_player_count,field_title,city_identifier";
  const raw = await all(`mdapi_matches?select=${cols}${win}&order=api_id`);

  const toRow = (r: Record<string, unknown>): FinMasterSchedule => {
    const startDate = r.start_date ? String(r.start_date) : "";
    const matchDate = startDate ? new Date(startDate).toISOString().slice(0, 10) : "";
    const mdapiFieldId = r.field_id == null ? null : Number(r.field_id);
    const maxPlayerCount = r.max_player_count == null ? null : Math.round(Number(r.max_player_count) || 0);
    let venue_id = mdapiFieldId != null ? (venueFields.get(mdapiFieldId) ?? null) : null;
    // Split-rate routing through the REAL resolver: ATH Katy by day of week, Soccer Central by
    // capacity. A row whose capacity marks it a special event comes back null and drops from cost.
    if (venue_id != null && matchDate) {
      venue_id = resolveSplitRateVenueId(venue_id, matchDate, venues, maxPlayerCount);
    }
    const category = mdapiFieldId != null && countsAsRegular.has(mdapiFieldId)
      ? "regular"
      : venueCategory(r.field_title ? String(r.field_title) : null);
    return {
      id: String(r.api_id),
      city: String(r.city_identifier ?? ""),
      venue: "",
      match_date: matchDate,
      match_time: startDate.slice(11, 16),
      month: matchDate ? `${MON[Number(matchDate.slice(5, 7)) - 1] ?? "?"} ${matchDate.slice(0, 4)}` : "",
      max_spots: 0,
      mdapi_field_id: mdapiFieldId,
      venue_id,
      duration_hours: 1,
      category,
      field_title: r.field_title ? String(r.field_title) : "",
      start_utc_ms: r.start_date_utc ? Date.parse(String(r.start_date_utc)) : null,
    } as FinMasterSchedule;
  };

  const mapped = raw.map(toRow);
  const masterSchedule = mapped.filter((_, i) => raw[i].is_cancelled !== true);
  const cancelledSchedule = mapped.filter((_, i) => raw[i].is_cancelled === true);

  // Venues 3 (Hattrick) and 10 (PAC Global) are profit_share with enabled dashboards. Stub this map
  // and canonicalVenueCost returns needs_override / $0 for both, silently understating the BEFORE
  // total at the only two venues in scope whose model is not rate x matches. Both inputs come from
  // the SAME fetchers the hook uses, so the payout is the one the partner page renders.
  const partnerDashboards = await fetchAllEnabledPartnerDashboards(supabase);
  const regs = await fetchLegacyMatchRegistrations(supabase, {
    fromDate: "2026-01-01",
    toDate: "2026-08-31",
  });
  const finRev = await all("fin_revenue?select=date,type,gross,source,venue,notes");
  const payouts = buildPartnerPayoutsByVenueMonth(
    partnerDashboards,
    venues as unknown as { id: number; venue_name: string; billing_type: string }[],
    venueFields,
    regs as never,
    finRev as never,
    new Date("2026-09-16T23:59:59Z"),
  );
  void dashRaw;

  const shell = {
    revenue: [], expenses: [], managerPay: [], memberSpots: [], members: [], pricing: [],
    venueAliases: new Map<string, string>(), venueFieldLinks: [], config: {},
    mdapiMemberSpots: emptyMdapiMemberSpotIndex(),
    masterSchedule, cancelledSchedule, venues, venueFields,
    partnerDashboards, partnerPayoutsByVenueMonth: payouts,
  };
  return {
    after: { ...shell, overrides: liveOv } as unknown as FinanceData,
    before: { ...shell, overrides: bakOv } as unknown as FinanceData,
    counts: { raw: raw.length, alive: masterSchedule.length, cxl: cancelledSchedule.length, regs: regs.length },
    liveOv, bakOv, venues,
  };
}

async function main() {
const { after, before, counts, liveOv, bakOv, venues } = await build();

console.log(`mdapi_matches Jan-Aug 2026: ${counts.raw} rows (${counts.alive} alive, ${counts.cxl} cancelled)`);
console.log(`match_registrations in window: ${counts.regs}`);
console.log(`overrides: live ${liveOv.length}, backup ${bakOv.length}\n`);

// A HARNESS THAT MEASURES NOTHING PASSES EVERY TEST. Prove the schedule actually loaded and that
// the model path works at all before trusting a single figure below.
console.log("=== 0. THE HARNESS ITSELF ===");
ok("the schedule is not empty", counts.alive > 0, `${counts.alive} alive rows`);
ok("pagination did not silently truncate at 1000", counts.raw > 1000, `${counts.raw} rows`);
const modelProbe = canonicalVenueCost(before, 8, "Jan 2026");
ok("CONTROL: the model path computes a non-override figure somewhere",
  modelProbe.kind === "per_match" && modelProbe.amount > 0,
  `ATH Pearland Jan 2026 before = ${modelProbe.kind} ${money(modelProbe.amount)} on ${modelProbe.matchCount} matches`);

// ── 1. THE TOTAL, TO THE CENT ───────────────────────────────────────────────────────────────────
console.log("\n=== 1. THE 21 RECONCILED VENUES, JAN-AUG, THROUGH canonicalVenueCost ===");
let total = 0;
for (const id of RECONCILED) for (const m of MONTHS) total += canonicalVenueCost(after, id, m).amount;
ok("equals 170466.41 to the cent", cents(total) === 17046641, money(total));

// ── 2. ROW COUNT AND DUPLICATES ─────────────────────────────────────────────────────────────────
console.log("\n=== 2. 168 ROWS, NO DUPLICATES ===");
const inWindow = liveOv.filter((o) => RECONCILED.includes(Number(o.venue_id)) && MONTHS.includes(o.month as Q2Month));
const keys = inWindow.map((o) => `${o.venue_id}|${o.month}`);
ok("168 rows for the 21 venues x 8 months", inWindow.length === 168, `${inWindow.length}`);
ok("zero duplicates on (venue_id, month)", new Set(keys).size === keys.length, `${keys.length} rows, ${new Set(keys).size} keys`);
const freeRows = liveOv.filter((o) => FREE.includes(Number(o.venue_id)) && MONTHS.includes(o.month as Q2Month));
ok("16 rows for the two free venues", freeRows.length === 16, `${freeRows.length}`);
ok("every free row is zero with the free reason",
  freeRows.every((o) => Number(o.override_amount) === 0 && String(o.reason).startsWith("Free field, no charge")),
  `${freeRows.filter((o) => Number(o.override_amount) === 0).length}/16 zero`);

// ── 3. EVERY CELL READS AS AN OVERRIDE ──────────────────────────────────────────────────────────
// This is also what makes item 1 sound: kind "override" means the amount came from the override
// row and the schedule was never consulted for it.
console.log("\n=== 3. EVERY CELL READS kind: override ===");
const notOverride: string[] = [];
for (const id of IN_SCOPE) for (const m of MONTHS) {
  const c = canonicalVenueCost(after, id, m);
  if (c.kind !== "override") notOverride.push(`${LABEL_OF[id]} ${m} = ${c.kind}`);
}
ok("all 184 in-scope cells read override", notOverride.length === 0, notOverride.slice(0, 4).join("; ") || "none missed");
// The negative control: the same assertion against the BEFORE data must fail, or it proves nothing.
let beforeOverrides = 0;
for (const id of IN_SCOPE) for (const m of MONTHS) if (canonicalVenueCost(before, id, m).kind === "override") beforeOverrides++;
ok("CONTROL: before the load only 22 of 184 read override", beforeOverrides === 22, `${beforeOverrides}`);

// ── 4. THE NEGATIVE ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 4. BICENTENNIAL JUNE ===");
const bi = canonicalVenueCost(after, 13, "Jun 2026");
ok("reads minus $895.00", cents(bi.amount) === -89500, `${money(bi.amount)}, kind ${bi.kind}`);

// ── 4b. PER-VENUE BEFORE AND AFTER, AND THE MONTH SHIFTS ────────────────────────────────────────
console.log("\n=== 4b. PER-VENUE JAN-AUG, BEFORE AND AFTER ===");
console.log("venue                            before        after        delta   row-level   shift?");
let tB = 0, tA = 0;
const shifted: { id: number; left: string[]; landed: string[]; rowLevel: number; delta: number }[] = [];
for (const id of IN_SCOPE) {
  let b = 0, a = 0, rowLevel = 0;
  const left: string[] = [], landed: string[] = [];
  for (const m of MONTHS) {
    const cb = canonicalVenueCost(before, id, m);
    const ca = canonicalVenueCost(after, id, m);
    b += cb.amount; a += ca.amount;
    // The row-level diff is only what a reader comparing override rows would see: cells that
    // carried an override BEFORE. Money landing where no override existed is invisible to it.
    if (cb.kind === "override") {
      rowLevel += ca.amount - cb.amount;
      if (cb.amount !== 0 && ca.amount === 0) left.push(`${m} ${money(cb.amount)}`);
    } else if (ca.amount !== 0) {
      landed.push(`${m} ${money(ca.amount)}`);
    }
  }
  tB += b; tA += a;
  const delta = a - b;
  const isShift = left.length > 0 && landed.length > 0;
  if (isShift) shifted.push({ id, left, landed, rowLevel, delta });
  console.log(`${(LABEL_OF[id] + " (" + id + ")").padEnd(30)}${money(b).padStart(13)}${money(a).padStart(13)}` +
    `${money(delta).padStart(13)}${money(rowLevel).padStart(12)}   ${isShift ? "SHIFT" : ""}`);
}
console.log(`${"TOTAL".padEnd(30)}${money(tB).padStart(13)}${money(tA).padStart(13)}${money(tA - tB).padStart(13)}`);
ok("the after total is the reconciled figure plus the two free venues at zero", cents(tA) === 17046641, money(tA));

console.log("\n  month shifts, each naming where the money left and where it landed:");
for (const s of shifted) {
  console.log(`  ${LABEL_OF[s.id]} (${s.id})`);
  for (const l of s.left) console.log(`     left   ${l}`);
  for (const g of s.landed) console.log(`     landed ${g}`);
  console.log(`     row-level diff shows ${money(s.rowLevel)}, the venue actually moves ${money(s.delta)}`);
}
// A MONTH SHIFT IS NOT THE SAME THING AS A DELTA THE ROW-LEVEL DIFF MISSES, and the first cut of
// this assertion treated them as one. Nearly every venue's delta exceeds its row-level moves,
// because most of these venue-months had NO override before and were carrying a modelled figure
// that the load replaces. That is the load working, not money moving between months.
// A shift is the narrower thing: an override in one month goes to zero WHILE money lands in a
// different month that carried no override, so the movement is invisible to a row-level reader.
ok("every shift moves money between distinct months",
  shifted.every((s) => {
    const leftMonths = new Set(s.left.map((x) => x.split(" ").slice(0, 2).join(" ")));
    const landedMonths = s.landed.map((x) => x.split(" ").slice(0, 2).join(" "));
    return s.left.length > 0 && s.landed.length > 0 && landedMonths.every((m) => !leftMonths.has(m));
  }),
  `${shifted.length} shifts, no month both loses and gains`);
// CONTROL: a venue with no override before the load must show a row-level diff of exactly zero,
// which is what proves that column counts only pre-existing override cells rather than all change.
const noOvBefore = IN_SCOPE.filter((id) => !bakOv.some((o) => Number(o.venue_id) === id && MONTHS.includes(o.month as Q2Month)));
ok("CONTROL: venues with no prior override show a zero row-level diff",
  noOvBefore.every((id) => {
    let rl = 0;
    for (const m of MONTHS) {
      const cb = canonicalVenueCost(before, id, m);
      if (cb.kind === "override") rl += canonicalVenueCost(after, id, m).amount - cb.amount;
    }
    return rl === 0;
  }),
  `${noOvBefore.length} such venues`);
ok("the per-venue table accounts for the whole in-scope movement",
  cents(tA - tB) === cents(IN_SCOPE.reduce((t, id) => t + MONTHS.reduce((u, m) =>
    u + canonicalVenueCost(after, id, m).amount - canonicalVenueCost(before, id, m).amount, 0), 0)),
  money(tA - tB));

// ── 5. CASH FLOW'S FIELD COSTS LINE, PER MONTH ──────────────────────────────────────────────────
console.log("\n=== 5. FIELD COSTS PER MONTH, WHOLE ESTATE, BEFORE AND AFTER ===");
const ACTUALS = [22453.50, 27196.00, 16776.00, 16324.09, 16863.05, 34493.36, 27093.42, 9266.99];
console.log("month     before        after     in-scope   other venues   csv actual");
let eB = 0, eA = 0;
MONTHS.forEach((m, i) => {
  let b = 0, a = 0, scoped = 0;
  for (const v of venues) {
    b += canonicalVenueCost(before, v.id, m).amount;
    const amt = canonicalVenueCost(after, v.id, m).amount;
    a += amt;
    if (IN_SCOPE.includes(v.id)) scoped += amt;
  }
  eB += b; eA += a;
  console.log(`${MON[i]}  ${money(b).padStart(12)} ${money(a).padStart(12)} ${money(scoped).padStart(12)} ${money(a - scoped).padStart(14)} ${money(ACTUALS[i]).padStart(12)}`);
});
console.log(`TOT  ${money(eB).padStart(12)} ${money(eA).padStart(12)}`);

// ── 6. THE WHOLE-ESTATE TOTAL, AND WHAT IS STILL MODELLED ───────────────────────────────────────
console.log("\n=== 6. WHAT IS STILL MODELLED AT VENUES WITH NO RULING ===");
const others = venues.filter((v) => !IN_SCOPE.includes(v.id));
const rows: { id: number; name: string; amt: number; matches: number }[] = [];
for (const v of others) {
  let amt = 0, matches = 0;
  for (const m of MONTHS) { const c = canonicalVenueCost(after, v.id, m); amt += c.amount; matches += c.matchCount; }
  if (amt !== 0 || matches > 0) rows.push({ id: v.id, name: v.venue_name, amt, matches });
}
rows.sort((a, b) => b.matches - a.matches);
let stillModelled = 0;
for (const r of rows) {
  stillModelled += r.amt;
  console.log(`  venue ${String(r.id).padStart(3)} ${r.name.slice(0, 32).padEnd(32)} ${money(r.amt).padStart(11)}  ${String(r.matches).padStart(4)} matches`);
}
console.log(`  ${"still modelled, no ruling".padEnd(42)} ${money(stillModelled).padStart(11)}`);
console.log(`  ${"whole estate Jan-Aug, after".padEnd(42)} ${money(eA).padStart(11)}`);
ok("the free venues now contribute zero",
  FREE.every((id) => MONTHS.reduce((t, m) => t + canonicalVenueCost(after, id, m).amount, 0) === 0),
  FREE.map((id) => `${LABEL_OF[id]}=${money(MONTHS.reduce((t, m) => t + canonicalVenueCost(after, id, m).amount, 0))}`).join(" "));

// ── 7. SEPTEMBER IS UNTOUCHED ───────────────────────────────────────────────────────────────────
console.log("\n=== 7. SEPTEMBER AND EVERY OVERRIDE OUTSIDE SCOPE ===");
const sepLive = liveOv.filter((o) => o.month === "Sep 2026");
const sepBak = bakOv.filter((o) => o.month === "Sep 2026");
const k = (o: Record<string, unknown>) => `${o.venue_id}|${o.month}|${Number(o.override_amount)}|${o.reason}`;
ok("September rows are byte-identical to the backup",
  JSON.stringify(sepLive.map(k).sort()) === JSON.stringify(sepBak.map(k).sort()),
  `${sepBak.length} before, ${sepLive.length} after: ${sepLive.map((o) => `${o.venue_id} ${money(Number(o.override_amount))}`).join(", ")}`);
const outBak = bakOv.filter((o) => !(IN_SCOPE.includes(Number(o.venue_id)) && MONTHS.includes(o.month as Q2Month)));
const outLive = liveOv.filter((o) => !(IN_SCOPE.includes(Number(o.venue_id)) && MONTHS.includes(o.month as Q2Month)));
ok("every override outside the loaded window is unchanged",
  JSON.stringify(outBak.map(k).sort()) === JSON.stringify(outLive.map(k).sort()),
  `${outBak.length} rows`);

// ── 7b. SOCCER CENTRAL, BOTH HALVES ─────────────────────────────────────────────────────────────
console.log("\n=== 7b. SOCCER CENTRAL 11 AND ITS TWIN 53 ===");
// THE PREMISE THIS ITEM WAS WRITTEN ON IS FALSE, AND IT CAME FROM MY OWN EARLIER REPORT.
// The brief says both twins carry zero 2026 matches, so nothing is stranded outside the override on
// venue 11. Measured, both twins carry real volume, because NO mdapi field links to either twin:
// all four Soccer Central fields link to venue 11 and all ATH Katy fields to venue 7, and the split
// resolver then re-routes rows by capacity (Soccer Central, >22 players) and by day of week (ATH
// Katy, Sunday). A count that reads fin_venue_fields without replaying that routing sees every
// match on the primary leg and the twin looks empty. That is the error in the earlier report.
const t53 = MONTHS.reduce((t, m) => t + canonicalVenueCost(after, 53, m).amount, 0);
const m53 = MONTHS.reduce((t, m) => t + canonicalVenueCost(after, 53, m).matchCount, 0);
const t11 = MONTHS.reduce((t, m) => t + canonicalVenueCost(after, 11, m).amount, 0);
const t23 = MONTHS.reduce((t, m) => t + canonicalVenueCost(after, 23, m).amount, 0);
const m23 = MONTHS.reduce((t, m) => t + canonicalVenueCost(after, 23, m).matchCount, 0);
console.log(`  venue 11 Soccer Central       : ${money(t11).padStart(12)}  (override, the bank figure for the whole facility)`);
console.log(`  venue 53 Soccer Central Tourn.: ${money(t53).padStart(12)}  on ${m53} matches at $180, STILL MODELLED`);
console.log(`  venue  7 ATH Katy             : ${money(MONTHS.reduce((t, m) => t + canonicalVenueCost(after, 7, m).amount, 0)).padStart(12)}  (override)`);
console.log(`  venue 23 ATH Katy Sunday      : ${money(t23).padStart(12)}  on ${m23} matches at $160, STILL MODELLED`);
console.log(`  FINDING: ${money(t53 + t23)} sits on the two twin legs with no override and no bank figure behind it.`);
console.log(`  Soccer Central across both legs after the load: ${money(t11 + t53)} against a reconciled ${money(t11)}.`);
const jul11 = canonicalVenueCost(after, 11, "Jul 2026");
console.log(`  Jul 2026, Cash Flow (canonicalVenueCost, venue 11): ${money(jul11.amount)} (${jul11.kind}, ${jul11.matchCount} matches)`);
console.log(`  Jul 2026, Field Costs ledger (11 + 53 combined)   : ${money(jul11.amount + canonicalVenueCost(after, 53, "Jul 2026").amount)}`);
console.log(`  Those two are EXPECTED to disagree. Do not reconcile them against each other.`);
// What must be true, and is: the load stayed inside its scope. Neither twin was written to, which
// is correct per the brief, and is also why the strand above is Ryan's call and not mine to fix.
ok("the load wrote nothing to either twin",
  !liveOv.some((o) => [53, 23].includes(Number(o.venue_id))),
  "venues 53 and 23 carry no override rows at all");
ok("the twins were untouched by this load",
  JSON.stringify(bakOv.filter((o) => [53, 23].includes(Number(o.venue_id)))) ===
  JSON.stringify(liveOv.filter((o) => [53, 23].includes(Number(o.venue_id)))),
  "identical before and after");

console.log(`\n${"=".repeat(60)}\nPASS ${pass}  FAIL ${fail}`);
if (fails.length) { console.log("FAILURES:\n" + fails.map((f) => "  - " + f).join("\n")); process.exit(1); }
}

main().catch((e) => { console.error("HARNESS FAILED:", e.message); process.exit(1); });
