/* MATCHDAY FORECAST, SEP 2026 — the 2027 Operations Plan's seed, as data, and the rule that turns it
 * into rows. ONE COPY: scripts/gen-ops-plan-seed.mts writes the seed SQL from this, and
 * scripts/ops-plan-test.ts asserts against it, inside `npm run verify`.
 *
 * Figures are Ryan's spec of 2026-10-02 (cities, regions, launch months, anchor slots, monthly spots,
 * mature rates, hires). The 2027 opening schedule is docs/mocks/2027-operations-plan-mock.html's.
 * The page never reads this file: once seeded, the plan lives in the database and is edited there.
 */
import { PLAN_YEAR, monthsBetween, planMonthKeys, rampAt, splitByWeights } from "./opsPlan";

export type ForecastCity = { region: string; name: string; launch: string | null; slots: number; mature: number;
  venueAliases: string[]; cityIds: string[]; spots: number[]; open27: number[] };
export const R = { ct: "central-texas", gw: "gulf-west-texas", pa: "pacific", se: "southeast", sw: "southwest", ea: "east", un: "unassigned" };
const Z = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
export const FORECAST_CITIES: ForecastCity[] = [
  { region: R.ct, name: "Austin", launch: null, slots: 4, mature: 728.7, venueAliases: ["Austin"], cityIds: ["ATX"],
    spots: [5472, 5230, 5897, 6086, 6465, 6327, 6687, 6795, 6668, 7004, 6468, 6802], open27: [0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0] },
  { region: R.ct, name: "Dallas / Fort Worth", launch: null, slots: 8, mature: 292.0, venueAliases: ["Dallas"], cityIds: ["DFW"],
    spots: [1349, 1409, 1975, 2162, 2476, 3015, 3337, 3634, 4047, 4367, 4741, 5521], open27: [3, 3, 3, 3, 3, 3, 3, 3, 3, 0, 0, 0] },
  { region: R.ct, name: "San Antonio", launch: null, slots: 3, mature: 306.7, venueAliases: ["San Antonio"], cityIds: ["SATX"],
    spots: [3139, 3018, 3436, 3495, 3713, 3711, 3900, 4003, 3976, 4390, 4349, 4738], open27: [1, 1, 1, 1, 0, 1, 0, 1, 0, 0, 0, 0] },
  { region: R.ct, name: "Oklahoma City", launch: null, slots: 1, mature: 359.4, venueAliases: ["OKC", "Oklahoma City"], cityIds: ["OKC"],
    spots: [547, 517, 580, 853, 902, 875, 1220, 1235, 1224, 1293, 1299, 1369], open27: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0] },
  { region: R.ct, name: "Waco - Temple - Bryan", launch: "2027-07-01", slots: 1, mature: 201.2, venueAliases: ["Waco - Temple - Bryan"], cityIds: [],
    spots: [0, 0, 0, 0, 0, 0, 29, 56, 121, 148, 152, 152], open27: [0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0] },
  { region: R.ct, name: "Tulsa", launch: "2027-11-01", slots: 1, mature: 623.2, venueAliases: ["Tulsa"], cityIds: [],
    spots: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 29, 56], open27: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0] },
  { region: R.gw, name: "Houston", launch: null, slots: 8, mature: 280.3, venueAliases: ["Houston", "HOU"], cityIds: ["HOU"],
    spots: [3358, 3300, 3785, 4309, 4781, 5621, 6520, 6280, 6593, 7144, 7374, 7696], open27: [0, 4, 4, 4, 3, 3, 2, 2, 2, 0, 0, 0] },
  { region: R.gw, name: "McAllen / Rio Grande Valley", launch: "2027-02-01", slots: 1, mature: 201.2, venueAliases: ["McAllen / Rio Grande Valley", "McAllen"], cityIds: [],
    spots: [0, 29, 56, 121, 162, 194, 255, 329, 425, 487, 539, 593], open27: [0, 2, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0] },
  { region: R.gw, name: "El Paso", launch: "2027-04-01", slots: 1, mature: 201.2, venueAliases: ["El Paso"], cityIds: ["ELP"],
    spots: [0, 0, 0, 29, 56, 121, 162, 194, 255, 315, 383, 398], open27: [0, 0, 0, 2, 0, 0, 1, 1, 1, 0, 0, 0] },
  { region: R.gw, name: "Corpus Christi", launch: "2027-07-01", slots: 1, mature: 201.2, venueAliases: ["Corpus Christi"], cityIds: [],
    spots: [0, 0, 0, 0, 0, 0, 29, 56, 121, 148, 152, 152], open27: [0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0] },
  { region: R.pa, name: "San Diego", launch: null, slots: 3, mature: 321.8, venueAliases: ["San Diego"], cityIds: [],
    spots: [695, 712, 859, 1314, 1605, 1763, 2256, 2346, 2795, 2881, 2891, 3026], open27: [0, 3, 3, 3, 3, 0, 0, 0, 0, 0, 0, 0] },
  { region: R.pa, name: "Fresno", launch: "2027-05-01", slots: 1, mature: 201.2, venueAliases: ["Fresno"], cityIds: [],
    spots: [0, 0, 0, 0, 29, 56, 121, 191, 279, 418, 556, 622], open27: [0, 0, 0, 0, 2, 0, 0, 3, 3, 0, 0, 0] },
  { region: R.se, name: "Atlanta", launch: null, slots: 5, mature: 306.7, venueAliases: ["Atlanta"], cityIds: ["ATL"],
    spots: [1149, 1090, 1348, 1365, 1483, 1702, 1962, 2204, 2377, 2629, 2699, 2844], open27: [0, 0, 0, 0, 3, 3, 3, 3, 2, 0, 0, 0] },
  { region: R.se, name: "Tampa", launch: "2027-06-01", slots: 4, mature: 517.7, venueAliases: ["Tampa"], cityIds: [],
    spots: [0, 0, 0, 0, 0, 29, 56, 121, 162, 180, 212, 226], open27: [0, 0, 0, 0, 0, 2, 0, 0, 1, 0, 0, 0] },
  { region: R.se, name: "Jacksonville", launch: "2027-09-01", slots: 1, mature: 201.2, venueAliases: ["Jacksonville"], cityIds: [],
    spots: [0, 0, 0, 0, 0, 0, 0, 0, 29, 56, 121, 148], open27: [0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0] },
  { region: R.se, name: "Nashville", launch: "2027-09-01", slots: 1, mature: 623.2, venueAliases: ["Nashville"], cityIds: [],
    spots: [0, 0, 0, 0, 0, 0, 0, 0, 29, 56, 121, 148], open27: [0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0] },
  { region: R.sw, name: "Phoenix", launch: "2027-05-01", slots: 4, mature: 517.7, venueAliases: ["Phoenix"], cityIds: [],
    spots: [0, 0, 0, 0, 29, 56, 121, 191, 279, 418, 556, 622], open27: [0, 0, 0, 0, 2, 0, 0, 3, 3, 0, 0, 0] },
  { region: R.sw, name: "Albuquerque", launch: "2027-08-01", slots: 1, mature: 201.2, venueAliases: ["Albuquerque"], cityIds: [],
    spots: [0, 0, 0, 0, 0, 0, 0, 29, 56, 121, 148, 152], open27: [0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0] },
  { region: R.ea, name: "Philadelphia", launch: null, slots: 5, mature: 95.7, venueAliases: ["Philadelphia"], cityIds: [],
    spots: [383, 370, 412, 398, 422, 408, 433, 438, 423, 449, 433, 459], open27: Z },
  { region: R.ea, name: "Washington DC", launch: "2027-08-01", slots: 1, mature: 623.2, venueAliases: ["Washington DC"], cityIds: [],
    spots: [0, 0, 0, 0, 0, 0, 0, 29, 56, 121, 148, 152], open27: [0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0] },
  { region: R.ea, name: "Baltimore", launch: "2027-10-01", slots: 1, mature: 623.2, venueAliases: ["Baltimore"], cityIds: [],
    spots: [0, 0, 0, 0, 0, 0, 0, 0, 0, 29, 56, 121], open27: [0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0] },
  { region: R.ea, name: "Richmond", launch: "2027-12-01", slots: 1, mature: 623.2, venueAliases: ["Richmond"], cityIds: [],
    spots: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 29], open27: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2] },
  { region: R.un, name: "St. Louis", launch: null, slots: 3, mature: 95.7, venueAliases: ["St. Louis"], cityIds: ["STL"],
    spots: [492, 517, 412, 398, 422, 408, 433, 438, 423, 449, 619, 647], open27: Z },
];
export const HEADLINE = [16585, 16193, 18760, 20530, 22547, 24287, 27520, 28568, 30339, 33103, 34044, 36674];
export const FORECAST_REGIONS = [
  { key: R.ct, name: "Central Texas", short: "Central TX", note: null },
  { key: R.gw, name: "Gulf Coast & West Texas", short: "Gulf & West TX", note: null },
  { key: R.pa, name: "Pacific", short: "Pacific", note: null },
  { key: R.se, name: "Southeast", short: "Southeast", note: null },
  { key: R.sw, name: "Southwest", short: "Southwest", note: null },
  { key: R.ea, name: "East", short: "East", note: null },
  { key: R.un, name: "Unassigned", short: "Unassigned", note: "No regional manager. City manager stays." },
];
export const FORECAST_HIRES = [
  { hire: "2026-11-01", run: "2027-02-01", role: "Regional manager, Central Texas", kind: "regional_manager", region: R.ct },
  { hire: "2027-01-01", run: "2027-04-01", role: "Regional manager, Gulf Coast & West Texas", kind: "regional_manager", region: R.gw },
  { hire: "2027-01-01", run: "2027-04-01", role: "Regional manager, Pacific", kind: "regional_manager", region: R.pa },
  { hire: "2027-04-01", run: "2027-07-01", role: "Regional manager, Southwest", kind: "regional_manager", region: R.sw },
  { hire: "2027-04-01", run: "2027-07-01", role: "Regional manager, Southeast", kind: "regional_manager", region: R.se },
  { hire: "2027-04-01", run: "2027-07-01", role: "Regional manager, East", kind: "regional_manager", region: R.ea },
  { hire: "2027-06-01", run: "2027-06-01", role: "HQ hire (role TBC)", kind: "hq", region: null },
  { hire: "2027-11-01", run: "2027-11-01", role: "HQ hire (role TBC)", kind: "hq", region: null },
];


/* ── THE SEED'S ESTIMATES FOR ONE CITY (Ryan, 2026-10-02) ──────────────────────────────────────
 * Its planned 2027 fields, earliest-opened first, each with its estimate for every plan month;
 * and, for an existing city, the forecast-base remainder.
 *   · existing city: each new field carries its ramp (city mature rate from the 12th month); the
 *     base row is the city's spots minus those ramps, NOT clamped.
 *   · launch city: no base row; each month's spots split across the open fields in proportion to
 *     their ramp, at a tenth, leftover to the earliest-opened.
 * Either way the rows sum to the city's spots EXACTLY, in tenths. ops-plan-test asserts it. */
export type SeedField = { open: string; est: (number | null)[] };
export function seedEstimates(c: ForecastCity): { fields: SeedField[]; base: number[] | null } {
  const keys = planMonthKeys(PLAN_YEAR);
  const opens: string[] = [];
  c.open27.forEach((k, mi) => { for (let j = 0; j < k; j++) opens.push(keys[mi]); });
  const ramps = opens.map((o) => keys.map((k) => rampAt(monthsBetween(o, k), c.mature)));
  if (c.launch != null) {
    const est = opens.map(() => keys.map(() => null as number | null));
    keys.forEach((_, mi) => {
      if (c.spots[mi] === 0) return;
      const open = ramps.map((r, i) => ({ i, w: r[mi] ?? 0 })).filter((x) => x.w > 0);
      const parts = splitByWeights(c.spots[mi], open.map((x) => x.w));
      open.forEach((x, k) => { est[x.i][mi] = parts[k]; });
    });
    return { fields: opens.map((o, i) => ({ open: o, est: est[i] })), base: null };
  }
  const base = keys.map((_, mi) =>
    (Math.round(c.spots[mi] * 10) - ramps.reduce((a, r) => a + Math.round((r[mi] ?? 0) * 10), 0)) / 10);
  return { fields: opens.map((o, i) => ({ open: o, est: ramps[i] })), base };
}
