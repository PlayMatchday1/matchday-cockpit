/* THE 2027 OPERATIONS PLAN'S ARITHMETIC, PINNED. Pure, sub-second, inside `npm run verify`.
 *
 * Ryan, 2026-10-02: "I do want a few assertions, because this page is arithmetic":
 *   1. seeded monthly city totals match the forecast — exactly per city, within 2 on the headline
 *   2. each city total equals the sum of its rows, including the forecast-base row
 *   3. adding then removing a field returns every total to its prior value
 *   4. the 2026 Daily Matches route returns the same payload before and after
 * (4) is a database read behind auth, so here it is the two filters that route applies, run over a
 * fixture that mixes 2026 and 2027 rows; the live before/after diff of the real route is a one-off
 * recorded in the report, not a suite.
 *
 * (1) is asserted twice: on the function that builds the seed, AND on the SQL file that will be
 * applied, parsed from disk — so a regenerated or hand-edited 0200 cannot drift from the forecast
 * without this going red.
 */
import fs from "node:fs";
import {
  PLAN_YEAR, RAMP_SPOTS, actualCounts, defaultRamp, estimateAt, fieldFlags, inPlan, isDefaultEstimate, planCounts,
  planMonthKeys, rollFields, splitByWeights, spotsToUnit, sumRollups, sumSpots, unitToSpots, actualSpots,
  type PlanField,
} from "@/lib/opsPlan";
import { FORECAST_CITIES, HEADLINE, seedEstimates } from "@/lib/opsPlanForecast";
import { rowBelongsToGoalYear, targetBelongsToGoalYear } from "@/lib/fieldGoals";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const yes = (n: string, c: boolean, d = "") => (c ? ok(n) : bad(n, d));
const KEYS = planMonthKeys(PLAN_YEAR);
const tenths = (x: number | null | undefined) => Math.round((x ?? 0) * 10);

/* ── fixtures: the seeded plan as PlanField rows, the shape the page rolls up ──────────────────── */
function seededFields(): Map<string, { mature: number; fields: PlanField[] }> {
  const out = new Map<string, { mature: number; fields: PlanField[] }>();
  for (const c of FORECAST_CITIES) {
    const s = seedEstimates(c);
    const toTargets = (est: (number | null)[]) => Object.fromEntries(est.map((v, i) => [KEYS[i], v]).filter(([, v]) => v != null && v !== 0));
    const fields: PlanField[] = s.fields.map((f, i) => ({
      key: `${c.name}-n${i}`, rowId: `${c.name}-n${i}`, name: `New field ${i + 1}`, kind: "slot", venueId: null, fieldId: null,
      cityId: c.name, role: "field", status: "planned", plannedType: "satellite", openMonth: f.open,
      targets: toTargets(f.est) as Record<string, number>, actual: {}, trailing: { spots: 0, matches: 0 },
    }));
    if (s.base) fields.push({
      key: `${c.name}-base`, rowId: `${c.name}-base`, name: "Existing fields (forecast base)", kind: "slot", venueId: null, fieldId: null,
      cityId: c.name, role: "forecast_base", status: "live", plannedType: null, openMonth: null,
      targets: Object.fromEntries(s.base.map((v, i) => [KEYS[i], v]).filter((_, i) => c.spots[i] !== 0)) as Record<string, number>,
      actual: {}, trailing: { spots: 0, matches: 0 },
    });
    out.set(c.name, { mature: c.mature, fields });
  }
  return out;
}

console.log("\n— 1. the seed builder: every city's rows sum to the forecast EXACTLY, every month —");
{
  let cells = 0, exact = 0;
  for (const c of FORECAST_CITIES) {
    const s = seedEstimates(c);
    KEYS.forEach((_, mi) => {
      cells++;
      const t = s.fields.reduce((a, f) => a + tenths(f.est[mi]), 0) + tenths(s.base?.[mi]);
      if (t === tenths(c.spots[mi])) exact++; else bad(`${c.name} ${KEYS[mi]}`, `rows ${t / 10} vs forecast ${c.spots[mi]}`);
    });
  }
  is("23 cities × 12 months, all exact", { cells, exact }, { cells: 276, exact: 276 });
  is("135 fields open in 2027, as the forecast says", FORECAST_CITIES.reduce((a, c) => a + seedEstimates(c).fields.length, 0), 135);
  const tot = KEYS.map((_, mi) => FORECAST_CITIES.reduce((a, c) => a + c.spots[mi], 0));
  const off = tot.map((t, i) => t - HEADLINE[i]);
  yes("every month within 2 spots of the forecast's headline", off.every((d) => Math.abs(d) <= 2), JSON.stringify(off));
  /* CONTROL: the tolerance is doing work. May and November are the workbook's display rounding
   * (Ryan, 2026-10-02) and are exactly 2 out — a tolerance of 1 would fail, so this is not vacuous. */
  is("CONTROL: May and Nov are the two months 2 out", [off[4], off[10]], [-2, 2]);
  const launch = FORECAST_CITIES.filter((c) => c.launch != null);
  yes("launch cities carry no forecast-base row", launch.every((c) => seedEstimates(c).base === null));
  yes("CONTROL: existing cities do carry one", FORECAST_CITIES.filter((c) => c.launch == null).every((c) => seedEstimates(c).base !== null));
  yes("no existing city's base row goes negative", FORECAST_CITIES.filter((c) => c.launch == null).every((c) => (seedEstimates(c).base ?? []).every((v) => v >= 0)));
  /* A 0 BEFORE LAUNCH IS NO ESTIMATE, NOT A ZERO. Richmond launches in December: eleven nulls. */
  const rich = seedEstimates(FORECAST_CITIES.find((c) => c.name === "Richmond")!);
  is("Richmond's fields estimate nothing before December", rich.fields.map((f) => f.est.slice(0, 11).every((v) => v == null)), [true, true]);
  is("…and split December's 29 spots, leftover to the earliest", rich.fields.map((f) => f.est[11]), [14.5, 14.5]);
  /* THE MATURE RATE: a Dallas field opening January reads 292.0 in December (Ryan's example). */
  const dal = seedEstimates(FORECAST_CITIES.find((c) => c.name === "Dallas / Fort Worth")!);
  is("a Dallas field opening Jan 2027 reads 292.0 in Dec 2027", dal.fields[0].est[11], 292);
  is("…and the forecast ramp's 14.3 in its opening month", dal.fields[0].est[0], 14.3);
}

console.log("\n— 1b. the SQL that will be applied, parsed from disk —");
{
  const sql = fs.readFileSync("supabase/migrations/0200_ops_plan_2027_seed.sql", "utf8");
  const rowCity = new Map<string, string>();
  for (const m of sql.matchAll(/INSERT INTO public\.field_goal_rows \(id, slot_name, city, plan_year, sort_order\) VALUES \('([0-9a-f-]{36})', '(?:[^']|'')*', '((?:[^']|'')*)', (\d+),/g)) {
    if (Number(m[3]) !== PLAN_YEAR) bad("a seeded slot row not created for 2027", m[1]);
    rowCity.set(m[1], m[2].replace(/''/g, "'"));
  }
  const sums = new Map<string, number>();
  let tuples = 0;
  for (const stmt of sql.matchAll(/INSERT INTO public\.field_goal_targets \(row_id, month, goal_spots\) VALUES ([^;]+);/g)) {
    for (const t of stmt[1].matchAll(/\('([0-9a-f-]{36})', '(\d{4}-\d{2}-01)', (-?[\d.]+)\)/g)) {
      tuples++;
      const city = rowCity.get(t[1]);
      if (!city) { bad("a target on a row the seed did not create", t[1]); continue; }
      const k = `${city}|${t[2]}`;
      sums.set(k, (sums.get(k) ?? 0) + tenths(Number(t[3])));
    }
  }
  yes("CONTROL: the file parses to targets at all", tuples > 1000, `${tuples} tuples`);
  is("144 slot rows created for 2027 (135 planned + 9 base)", rowCity.size, 144);
  let exact = 0;
  for (const c of FORECAST_CITIES) KEYS.forEach((k, mi) => { if ((sums.get(`${c.name}|${k}`) ?? 0) === tenths(c.spots[mi])) exact++; else bad(`SQL ${c.name} ${k}`, `${(sums.get(`${c.name}|${k}`) ?? 0) / 10} vs ${c.spots[mi]}`); });
  is("every city-month in the SQL sums to the forecast", exact, 276);
  yes("the SQL writes no goal_daily", !/field_goal_targets \([^)]*goal_daily/.test(sql));
  yes("the SQL checks itself before committing", sql.includes("seed check:") && /commit;\s*$/.test(sql));
}

console.log("\n— 2. a city total is the sum of its rows, a region the sum of its cities —");
{
  const seeded = seededFields();
  let exact = 0;
  for (const c of FORECAST_CITIES) {
    const { mature, fields } = seeded.get(c.name)!;
    const roll = rollFields(fields, { mature }, KEYS, KEYS[11], 670);
    KEYS.forEach((k, mi) => {
      const rowsSum = fields.reduce((a, f) => a + tenths(estimateAt(f, k, mature)), 0);
      const want = c.spots[mi] === 0 ? null : c.spots[mi];
      if (JSON.stringify(roll.est[mi]) === JSON.stringify(want) && (want == null || rowsSum === tenths(want))) exact++;
      else bad(`${c.name} ${k}`, `rollup ${roll.est[mi]} rows ${rowsSum / 10} forecast ${c.spots[mi]}`);
    });
  }
  is("all 276 city-months: rollup = sum of rows = forecast (a launch month before launch is a dash)", exact, 276);
  const ct = ["Austin", "Dallas / Fort Worth", "San Antonio", "Oklahoma City", "Waco - Temple - Bryan", "Tulsa"]
    .map((n) => { const s = seeded.get(n)!; return rollFields(s.fields, { mature: s.mature }, KEYS, KEYS[11], 670); });
  const region = sumRollups(ct, 12);
  is("Central Texas December is the sum of its six cities", region.est[11], 6802 + 5521 + 4738 + 1369 + 152 + 56);
  is("Tulsa before November is a dash, not 0", seeded.get("Tulsa") && rollFields(seeded.get("Tulsa")!.fields, { mature: 623.2 }, KEYS, KEYS[11], 670).est.slice(0, 10), Array(10).fill(null));
  is("a month nothing estimates sums to null", sumSpots([null, undefined, null]), null);
  is("CONTROL: a real zero is still a zero", sumSpots([0, null]), 0);
}

console.log("\n— 3. adding then removing a field returns every total to where it was —");
{
  const seeded = seededFields();
  const all = () => sumRollups([...seeded.entries()].map(([, s]) => rollFields(s.fields, { mature: s.mature }, KEYS, KEYS[11], 670)), 12);
  const before = all();
  const dal = seeded.get("Dallas / Fort Worth")!;
  const added: PlanField = {
    key: "added", rowId: "added", name: "New field", kind: "slot", venueId: null, fieldId: null, cityId: "Dallas / Fort Worth",
    role: "field", status: "planned", plannedType: "anchor", openMonth: "2027-03-01", targets: {}, actual: {}, trailing: { spots: 0, matches: 0 },
  };
  dal.fields.push(added);
  const withIt = all();
  is("adding a March field moves March by the ramp's first month", tenths(withIt.est[2]) - tenths(before.est[2]), tenths(RAMP_SPOTS[0]));
  is("…and December by its tenth month", tenths(withIt.est[11]) - tenths(before.est[11]), tenths(RAMP_SPOTS[9]));
  is("…and leaves February alone", withIt.est[1], before.est[1]);
  is("…and adds one planned anchor by December", withIt.plan.anchors - before.plan.anchors, 1);
  yes("its estimates are the default ramp, not typed", isDefaultEstimate(added, "2027-05-01") && !isDefaultEstimate(added, "2027-02-01"));
  added.status = "removed";
  const after = all();
  is("removed: every month's estimate is back exactly", after.est, before.est);
  is("removed: plan counts are back", after.plan, before.plan);
  /* CONTROL: the comparison can fail — with the field in, the totals genuinely differed. */
  yes("CONTROL: with the field in, the totals differed", JSON.stringify(withIt.est) !== JSON.stringify(before.est));
  // removing a SEEDED field and restoring it
  const target = dal.fields[0];
  target.status = "removed";
  const dropped = all();
  yes("removing a seeded field lowers the total", tenths(dropped.est[11]) < tenths(before.est[11]));
  target.status = "planned";
  is("restoring it puts every month back", all().est, before.est);
}

console.log("\n— the dash, the threshold and the flags —");
{
  const live = (spots: number, matches: number, extra: Partial<PlanField> = {}): PlanField => ({
    key: `v${spots}`, rowId: null, name: "Venue", kind: "venue", venueId: 1, fieldId: null, cityId: "x", role: "field", status: "live",
    plannedType: "anchor", openMonth: null, targets: {}, actual: { "2027-01-01": { spots, matches } }, trailing: { spots, matches }, ...extra,
  });
  is("670 exactly is an anchor", actualCounts([live(670, 20)], 670), { fields: 1, anchors: 1, satellites: 0 });
  is("669 is a satellite", actualCounts([live(669, 20)], 670), { fields: 1, anchors: 0, satellites: 1 });
  is("nothing played in 30 days is not an actual field", actualCounts([live(0, 0)], 670), { fields: 0, anchors: 0, satellites: 0 });
  is("an unplanned field playing counts as actual", actualCounts([live(900, 9, { role: "unplanned", status: null })], 670).fields, 1);
  yes("…and is in no plan", !inPlan(live(900, 9, { role: "unplanned", status: null })));
  is("a month with no matches is a dash", actualSpots([live(0, 0)], "2027-01-01"), null);
  is("CONTROL: a month with a match is its spots", actualSpots([live(40, 1)], "2027-01-01"), 40);
  const planned: PlanField = { ...live(0, 0), kind: "slot", status: "planned", plannedType: "satellite", openMonth: "2027-04-01" };
  is("plan as of March does not count an April field", planCounts([planned], "2027-03-01").fields, 0);
  is("plan as of April does", planCounts([planned], "2027-04-01"), { fields: 1, anchors: 0, satellites: 1 });
  is("a planned field past its month with nothing played is late", fieldFlags(planned, 670, "2027-05-01"), ["late"]);
  is("CONTROL: not late in its own opening month", fieldFlags(planned, 670, "2027-04-01"), []);
  is("a planned anchor running below threshold is flagged", fieldFlags(live(300, 10), 670, "2027-05-01"), ["anchor-below"]);
  is("a planned satellite at anchor volume is flagged", fieldFlags(live(900, 10, { plannedType: "satellite" }), 670, "2027-05-01"), ["satellite-at-anchor"]);
  is("the base row has no flags and no counts", [fieldFlags({ ...planned, role: "forecast_base" }, 670, "2027-12-01"), planCounts([{ ...planned, role: "forecast_base" }], "2027-12-01").fields], [[], 0]);
  is("default ramp before opening is null, then the forecast ramp", defaultRamp("2027-11-01", 500).slice(9), [null, 14.3, 28.1]);
  is("a split sums exactly, leftover to the earliest", splitByWeights(29, [14.3, 14.3]), [14.5, 14.5]);
  is("a split with a negative leftover still sums", splitByWeights(56, [28.1, 28.1]).reduce((a, b) => a + b, 0), 56);
  is("31 days: 18 spots a day for a month is 1 a day", spotsToUnit(18 * 31, 31, "day"), 1);
  is("typing 1 a day in January stores 558 spots", unitToSpots(1, 31, "day"), 558);
  is("typing 7 a week in February stores 504 spots", unitToSpots(7, 28, "week"), 504);
}

console.log("\n— 4. the 2026 route's two filters: a 2027 row never reaches the 2026 page —");
{
  const rows = [
    { id: "a", venue_id: 1, plan_year: null }, { id: "b", slot_name: "Fort Worth 1", plan_year: null },
    { id: "c", slot_name: "New field 1", plan_year: 2027 }, { id: "d", slot_name: "Existing fields (forecast base)", plan_year: 2027 },
    { id: "e", venue_id: 2 /* before 0199: no plan_year column at all */ },
  ];
  const kept = rows.filter((r) => rowBelongsToGoalYear(r as Record<string, unknown>, 2026)).map((r) => r.id);
  is("2026 rows, shared venue rows and pre-0199 rows stay; 2027 rows go", kept, ["a", "b", "e"]);
  const targets = [
    { row_id: "a", month: "2026-12-01", goal_daily: 3.2 }, { row_id: "a", month: "2027-03-01", goal_daily: null },
    { row_id: "c", month: "2027-07-01", goal_daily: null }, { row_id: "b", month: "2026-10-01", goal_daily: "1.50" },
  ];
  const keptT = targets.filter((t) => targetBelongsToGoalYear(t, 2026)).map((t) => `${t.row_id}${t.month}`);
  is("2026 goal_daily targets stay; 2027 spot estimates go, even on a shared venue row", keptT, ["a2026-12-01", "b2026-10-01"]);
  yes("CONTROL: the 2026 set the filter must preserve is not empty", keptT.length === 2 && kept.length === 3);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
