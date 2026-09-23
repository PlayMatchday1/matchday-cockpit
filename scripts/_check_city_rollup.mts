/* READ ONLY. Builds the page's rows exactly as /api/growth/field-goals does, off production, then
 * runs the real cityRollup() over them and checks the city rows against the three tiles and against
 * the year chart's own October. Writes nothing. */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import {
  GOAL_YEAR, MONTH_LABELS, cityRollup, cityTotals, countsTowardGoals, dailyAverage, daysElapsed,
  matchMonthIndex, monthKey, ramp, rowCountsTowardTotals, rowKeyForField, NO_CITY,
  type RollupRow,
} from "../src/lib/fieldGoals";

const env = readFileSync("/Users/ryanmancuso/Code/matchday-cockpit/.env.local", "utf8");
const rd = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, "m"))?.[1].trim().replace(/^['"]|['"]$/g, "") ?? "";
const sb = createClient(rd("NEXT_PUBLIC_SUPABASE_URL"), rd("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); c ? pass++ : fail++; };

async function all<T>(make: () => { range: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }> }): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await make().range(f, f + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

const year = GOAL_YEAR, now = new Date();
type M = { field_id: number | null; field_title: string | null; city_identifier: string | null; start_date: string; player_count: number | null; is_cancelled: boolean | null };
const raw = await all<M>(() => sb.from("mdapi_matches")
  .select("field_id, field_title, city_identifier, start_date, player_count, is_cancelled")
  .gte("start_date", `${year}-01-01T00:00:00`).lt("start_date", `${year + 1}-01-01T00:00:00`)
  .is("deleted_at", null).order("api_id") as never);
ok(raw.length !== 1000, `matches read: ${raw.length} (a flat 1000 would be a truncated page)`);
const matches = raw.filter(countsTowardGoals);

const links = await all<{ fin_venue_id: number; mdapi_field_id: number }>(() => sb.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id") as never);
const venues = await all<{ id: number; venue_name: string | null; city: string | null }>(() => sb.from("fin_venues").select("id, venue_name, city") as never);
const venueOf = new Map(links.map((l) => [l.mdapi_field_id, l.fin_venue_id]));
const venueById = new Map(venues.map((v) => [v.id, v]));

type Acc = { key: string; name: string; city: string | null; spots: number[]; per: number[] };
const acc = new Map<string, Acc>();
for (const m of matches) {
  const mi = matchMonthIndex(m.start_date, year);
  if (mi == null) continue;
  const fieldId = m.field_id as number;
  const key = rowKeyForField(fieldId, venueOf);
  const vid = venueOf.get(fieldId) ?? null;
  const a = acc.get(key) ?? {
    key, name: vid != null ? (venueById.get(vid)?.venue_name ?? `Venue ${vid}`) : (m.field_title ?? `Field ${fieldId}`),
    city: vid != null ? (venueById.get(vid)?.city ?? null) : (m.city_identifier ?? null),
    spots: new Array(12).fill(0), per: new Array(12).fill(0),
  };
  a.spots[mi] += m.player_count ?? 0; a.per[mi] += 1; acc.set(key, a);
}

const goalRows = await all<Record<string, unknown>>(() => sb.from("field_goal_rows").select("*") as never);
const targets = await all<{ row_id: string; month: string; goal_daily: number }>(() => sb.from("field_goal_targets").select("row_id, month, goal_daily") as never);
const storedByKey = new Map<string, { id: string; notCounted: boolean }>();
for (const r of goalRows) {
  const k = r.venue_id != null ? `v${r.venue_id}` : r.field_id != null ? `f${r.field_id}` : null;
  if (k) storedByKey.set(k, { id: r.id as string, notCounted: r.not_counted === true });
}
const monthsOf = (rowId: string | null): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const t of targets) if (rowId && t.row_id === rowId) out[String(t.month).slice(0, 10)] = Number(t.goal_daily);
  return out;
};
const cellsOf = (spots: number[], per: number[]) => spots.map((s, i) => {
  const { days, of, partial } = daysElapsed(i, year, now);
  return { month: monthKey(year, i), label: MONTH_LABELS[i], spots: s, matches: per[i], days, daysInMonth: of, partial, daily: dailyAverage(s, days) };
});

const rows: RollupRow[] = [...acc.values()].map((a) => {
  const st = storedByKey.get(a.key);
  return { key: a.key, kind: "existing" as const, name: a.name, city: a.city,
    notCounted: st?.notCounted === true, monthly: cellsOf(a.spots, a.per), targets: monthsOf(st?.id ?? null) };
});
const slots: RollupRow[] = goalRows.filter((r) => r.slot_name != null && String(r.slot_name).trim() !== "").map((r) => ({
  key: `s${r.id}`, kind: "slot" as const, name: r.slot_name as string, city: (r.city as string | null) ?? null,
  notCounted: r.not_counted === true,
  monthly: cellsOf(new Array(12).fill(0), new Array(12).fill(0)), targets: monthsOf(r.id as string),
}));
const allRows = [...rows, ...slots];
const cur = now.getMonth();

// ── THE TILES, computed the way the component computes them ────────────────────────────────────
const counted = allRows.filter(rowCountsTowardTotals);
const tSep = counted.reduce((s, r) => s + (r.monthly[cur]?.daily ?? 0), 0);
const tDec = counted.reduce((s, r) => s + (r.targets[monthKey(year, 11)] ?? 0), 0);
const tGap = tDec - tSep;
console.log(`\nTILES  Sep ${tSep.toFixed(1)}  Dec ${tDec.toFixed(1)}  Gap ${tGap.toFixed(1)}\n`);

const cities = cityRollup(allRows, year, cur, "gap");
const tot = cityTotals(cities);
console.log("City            Sep    Oct    Nov    Dec    Gap   fields");
for (const c of cities) {
  console.log(`${c.city.padEnd(14)} ${c.sep.toFixed(1).padStart(5)} ${c.oct.toFixed(1).padStart(6)} ${c.nov.toFixed(1).padStart(6)} ${c.dec.toFixed(1).padStart(6)} ${c.gapDaily.toFixed(1).padStart(6)}   ${c.existing}${c.slots ? ` +${c.slots} new` : ""}${c.noGoal ? ` · ${c.noGoal} no goal` : ""}  [${c.fields.length} in drawer]`);
}
console.log(`${"All MatchDay".padEnd(14)} ${tot.sep.toFixed(1).padStart(5)} ${tot.oct.toFixed(1).padStart(6)} ${tot.nov.toFixed(1).padStart(6)} ${tot.dec.toFixed(1).padStart(6)} ${tot.gapDaily.toFixed(1).padStart(6)}   ${tot.existing} +${tot.slots} new\n`);

// ── 1. THE CITY ROWS SUM TO THE TILES ──────────────────────────────────────────────────────────
ok(Math.abs(tot.sep - tSep) < 0.05, `the Sep column sums to ${tot.sep.toFixed(1)}, matching the tile's ${tSep.toFixed(1)}`);
ok(Math.abs(tot.dec - tDec) < 0.05, `  the Dec column sums to ${tot.dec.toFixed(1)}, matching the tile's ${tDec.toFixed(1)}`);
ok(Math.abs(tot.gapDaily - tGap) < 0.05, `  the Gap column sums to ${tot.gapDaily.toFixed(1)}, matching the tile's ${tGap.toFixed(1)}`);
ok(Math.abs((tot.dec - tot.sep) - tot.gapDaily) < 1e-9, "  CONTROL: gap is Dec minus Sep, not a fourth number");
ok(cities.length > 1, `  CONTROL: ${cities.length} city rows, so the sum is not one row wearing a total`);

// ── 2. OCTOBER AGREES WITH THE YEAR CHART, WHICH IS THE SUM OF THE ROWS' OWN RAMPS ─────────────
const chartMonth = (i: 9 | 10) => counted.reduce((s, r) => {
  const typed = r.targets[monthKey(year, i)];
  if (typed != null) return s + typed;
  const sep = r.monthly[cur]?.daily ?? 0;
  const dec = r.targets[monthKey(year, 11)] ?? null;
  return s + (ramp(sep, dec)[i - 9] ?? 0);
}, 0);
const chartOct = chartMonth(9), chartNov = chartMonth(10);
ok(Math.abs(tot.oct - chartOct) < 1e-9, `the city Oct ${tot.oct.toFixed(2)} equals the year chart's Oct ${chartOct.toFixed(2)}`);
ok(Math.abs(tot.nov - chartNov) < 1e-9, `  and Nov ${tot.nov.toFixed(2)} equals ${chartNov.toFixed(2)}`);
// CONTROL: the aggregate ramp §2 proposed is a DIFFERENT number on this data, which is the reason
// for the construction above. If these ever coincide the control has stopped controlling.
const aggOct = tSep + (tDec - tSep) / 3;
ok(Math.abs(aggOct - chartOct) > 0.02,
  `  CONTROL: ramping the aggregate gives ${aggOct.toFixed(2)}, ${Math.abs(aggOct - chartOct).toFixed(2)} away, so the construction is not a free choice`);

// ── 3. EVERY CITY'S DRAWER SUMS TO THE CITY ROW ────────────────────────────────────────────────
let drawerOk = 0;
for (const c of cities) {
  const fSep = c.fields.reduce((s, f) => s + (f.sep ?? 0), 0);
  const fDec = c.fields.reduce((s, f) => s + (f.dec ?? 0), 0);
  const fOct = c.fields.reduce((s, f) => s + (f.oct ?? 0), 0);
  const good = Math.abs(fSep - c.sep) < 1e-9 && Math.abs(fDec - c.dec) < 1e-9 && Math.abs(fOct - c.oct) < 1e-9;
  if (good) drawerOk++;
  else console.log(`   MISMATCH ${c.city}: fields Sep ${fSep.toFixed(3)} vs row ${c.sep.toFixed(3)}, Dec ${fDec.toFixed(3)} vs ${c.dec.toFixed(3)}, Oct ${fOct.toFixed(3)} vs ${c.oct.toFixed(3)}`);
}
ok(drawerOk === cities.length, `all ${cities.length} drawers sum to their city row on Sep, Oct and Dec (${drawerOk} of ${cities.length})`);
const biggest = cities.reduce((a, c) => (c.fields.length > a.fields.length ? c : a));
ok(biggest.fields.length >= 5, `  CONTROL: the largest drawer holds ${biggest.fields.length} fields (${biggest.city}), so the sum is not over an empty list`);

// ── 4. NULLS ARE ABSENCES, NOT ZEROS ───────────────────────────────────────────────────────────
const newFields = cities.flatMap((c) => c.fields).filter((f) => f.kind === "slot");
ok(newFields.length > 0 && newFields.every((f) => f.sep === null),
  `all ${newFields.length} new fields carry a null September, so they render a dash and not 0.0`);
const noGoalFields = cities.flatMap((c) => c.fields).filter((f) => f.dec === null);
ok(noGoalFields.every((f) => f.gapDaily === null),
  `  all ${noGoalFields.length} fields with no December target carry a null gap, so they read "no goal"`);
const withGoal = cities.flatMap((c) => c.fields).filter((f) => f.dec != null);
ok(withGoal.length > 0 && withGoal.every((f) => f.gapDaily != null),
  `  CONTROL: all ${withGoal.length} fields that DO have a target carry a gap`);

// ── 5. THE NO-CITY BUCKET ──────────────────────────────────────────────────────────────────────
const bucket = cities.find((c) => !c.hasCity);
ok(cities.at(-1) === bucket || bucket === undefined, `the ${NO_CITY} row is last under gap order`);
if (bucket) {
  console.log(`\n${NO_CITY}: ${bucket.fields.length} rows, Dec ${bucket.dec.toFixed(1)} of ${tot.dec.toFixed(1)} (${(bucket.dec / tot.dec * 100).toFixed(1)}% of the goal)`);
  for (const f of bucket.fields) console.log(`   ${f.name}  dec=${f.dec ?? "(none)"}`);
}
ok(cities.filter((c) => !c.hasCity).length <= 1, `  CONTROL: at most one bucket, so a blank and a null did not split into two`);

// ── 6. FIELD MODE IS UNCHANGED: one field's figures read the same in both grains ────────────────
const probe = counted.find((r) => r.kind === "existing" && (r.monthly[cur]?.daily ?? 0) > 0.5 && r.targets[monthKey(year, 11)] != null);
if (probe) {
  const inField = { sep: probe.monthly[cur].daily, dec: probe.targets[monthKey(year, 11)], oct: ramp(probe.monthly[cur].daily, probe.targets[monthKey(year, 11)])[0] };
  const inCity = cities.flatMap((c) => c.fields).find((f) => f.key === probe.key)!;
  ok(Math.abs((inCity.sep ?? -1) - inField.sep) < 1e-9 && Math.abs((inCity.dec ?? -1) - inField.dec) < 1e-9 && Math.abs((inCity.oct ?? -1) - (inField.oct ?? -1)) < 1e-9,
    `${probe.name} reads the same in both grains: Sep ${inField.sep.toFixed(2)} Oct ${(inField.oct ?? 0).toFixed(2)} Dec ${inField.dec.toFixed(2)}`);
} else ok(false, "no probe field found, so item 6 could not be checked");

// ── 7. SORTS ───────────────────────────────────────────────────────────────────────────────────
const gapOrder = cityRollup(allRows, year, cur, "gap").filter((c) => c.hasCity).map((c) => c.gapDaily);
ok(gapOrder.every((g, i) => i === 0 || gapOrder[i - 1] >= g), `gap order is descending (${gapOrder.map((g) => g.toFixed(1)).join(" ")})`);
const nameOrder = cityRollup(allRows, year, cur, "name").filter((c) => c.hasCity).map((c) => c.city);
ok(nameOrder.join() === [...nameOrder].sort((a, b) => a.localeCompare(b)).join(), `A-Z order is alphabetical (${nameOrder.join(", ")})`);
ok(gapOrder.length === nameOrder.length && nameOrder.join() !== cityRollup(allRows, year, cur, "gap").filter((c) => c.hasCity).map((c) => c.city).join(),
  "  CONTROL: the two orders differ, so the sort argument is actually read");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
