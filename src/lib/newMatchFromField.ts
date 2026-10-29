/* A NEW MATCH, STARTED FROM A FIELD — not copied from another match.
 *
 * WHY THIS EXISTS. Until now every match Clubhouse created was a COPY (copyMatch.ts, MatchEditor
 * create mode), so a city with fields and no matches had nothing to start from. Philadelphia
 * (field 2113, Friends Select School) was the case: the field existed, the first match could not be
 * made here.
 *
 * WHAT A COPY GOT FOR FREE, THIS HAS TO ASK FOR. A copy inherits its price and capacity from a
 * match somebody already set up. A blank match has no such source, and the one failure this path
 * must not repeat is production 18408: an absent registrationPrice, which the API defaults to 0,
 * sold 44 spots at $0. So:
 *
 *   REQUIRED, ARRIVING BLANK   name, description, price, min players, capacity now, and both format
 *                              totals, plus start and end. Measured 2026-10-28 on 805 production
 *                              matches (Sep 15 – Oct 28): capacity ran 18 / 36 / 40 / 22 / 16 / 14 and
 *                              the two format totals 22 / 18 / 0 / 14 … and 40 / 20 / 36 / 0 / 32 …,
 *                              in no combination a field's recommendedPlayerCount predicts (a field
 *                              recommending 18 carried 18/0/0, 36/18/36 and 18/18/36). Price ran
 *                              $12 / $8 / $9 / $5 / $15 / $39. There is no default to derive, so
 *                              there is none: the operator types each one.
 *
 *   PRE-FILLED, VISIBLE        the settings that ARE near-uniform on the same 805 rows, each shown in
 *                              the form and editable before anything is written:
 *                                type REGULAR 805/805 · category OPEN 775/805
 *                                autoCanceled true 785/805 · autoCanceledMinutes 75 785/805
 *                                isFreeMember true 755/805 · isAutoBump false 577/805
 *                                guestCount 10 564/805
 *
 *   ABSENT                     managers (assigned later, through the manager gate), the add-on spot
 *                              price (null on 775/805), the manager intro, and the fake ladder — the
 *                              create route fills the ladder from defaultLadder(capacity), the same
 *                              default every copy gets.
 *
 * TWO TEAMS. teamNumbers is write-only on the API and every create needs it; a new match opens as
 * two teams. Growth to four is the auto-bump path and its own total.
 *
 * WALL CLOCK. Start and end come from <input type="datetime-local"> as "YYYY-MM-DDTHH:MM" — local
 * time at the field — and get ":00.000Z" appended, the API's own (mislabelled) shape. No Date is
 * built here. */

import { EDITABLE_KEYS } from "./matchEditModel";

type Data = Record<string, unknown>;

export const NEW_MATCH_DEFAULTS: Readonly<Data> = {
  type: "REGULAR",
  category: "OPEN",
  autoCanceled: true,
  autoCanceledMinutes: 75,
  isFreeMember: true,
  isAutoBump: false,
  guestCount: 10,
};

/** The editable keys a new match must have typed into it. Labels are what the form calls them. */
export const NEW_MATCH_REQUIRED: readonly (readonly [string, string])[] = [
  ["name", "Name"],
  ["description", "Description"],
  ["registrationPrice", "Price"],
  ["minPlayerCount", "Min players"],
  ["maxPlayerCount", "Capacity now"],
  ["maxTeamSize2Team", "Max spots, 2 teams"],
  ["maxTeamSize4Team", "Max spots, 4 teams"],
];

export const NEW_MATCH_TEAMS = 2;

/** The match the editor opens on: every editable key, the field set, the defaults above, the rest
 *  null. Shaped like the detail route's pickMatch output so MatchEditor.ingest takes it unchanged. */
export function newMatchTemplate(field: { id: number; title: string; cityName: string | null }): Data {
  const m: Data = {};
  for (const k of EDITABLE_KEYS) m[k] = null;
  Object.assign(m, NEW_MATCH_DEFAULTS, { name: "", description: "", fieldId: field.id });
  return {
    ...m,
    id: null, startDate: null, endDate: null, isCancelled: false,
    teams: Array.from({ length: NEW_MATCH_TEAMS }, (_, i) => ({ teamNumber: i + 1, name: `Team ${i + 1}` })),
    fieldTitle: field.title, cityName: field.cityName, occupancy: 0,
  };
}

const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "")
  || (typeof v === "number" && !Number.isFinite(v));

/** The labels of every required value still missing. Empty means the body can be built. */
export function missingForNewMatch(state: Data, startAt: string, endAt: string): string[] {
  const out = NEW_MATCH_REQUIRED.filter(([k]) => blank(state[k])).map(([, label]) => label);
  if (!startAt) out.push("Start");
  if (!endAt) out.push("End");
  return out;
}

/** The create body. ONLY VALUES THE FORM HOLDS are sent — a null is left out, never sent as null,
 *  because what the API does with a null on a non-nullable number is not measured. Throws if a
 *  required value is missing, so a caller that skipped missingForNewMatch cannot post a $0 match. */
export function newMatchBody(state: Data, startAt: string, endAt: string): Data {
  const missing = missingForNewMatch(state, startAt, endAt);
  if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
  const out: Data = {};
  for (const k of EDITABLE_KEYS) if (!blank(state[k])) out[k] = state[k];
  out.registrationPrice = Number(state.registrationPrice);
  out.maxPlayerCount = Number(state.maxPlayerCount);
  out.fieldId = Number(state.fieldId);
  out.name = String(state.name).trim();
  out.description = String(state.description);
  out.type = String(state.type ?? "REGULAR");
  out.isFreeMember = state.isFreeMember === true;
  out.startDate = `${startAt}:00.000Z`;
  out.endDate = `${endAt}:00.000Z`;
  out.teamNumbers = NEW_MATCH_TEAMS;
  return out;
}
