import "server-only"; // no-op under --conditions=react-server
// CHURN — the rebuilt model (2026-11-09, Figma sl6PTy5LhCVj1gF0HvGmuF 32:3).
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/churn-test.ts
//
// REWRITTEN WITH THE PAGE. The old suite (102 assertions) pinned the old page: the Window buttons, the Heavy
// threshold stepper, the nested-button tile, red past 270 days, the $ footer, and spentFromEv — which summed the
// last segment of growth_player_profile.ev as dollars when that segment is the FIELD ID ($4,136,976 over the
// default view). All of that is gone from the page, so those assertions went with it. What this suite holds now is
// runtime behaviour of lib/churnModel.ts on computed values:
//   · the usual field, and that a managed-only person is not a player
//   · the sentence: the days floor, "played since", city = the usual field's city, and the field filter counting
//     ONLY that field while "haven't played" stays their last match anywhere
//   · tiers 10+ / 3–9 / 1–2, Ex-manager at 10 managed, red past 180 days
//   · the table's columns and the CSV's columns are the same list, cell for cell
//   · spentFromEv no longer exists, so nothing can parse `ev` for money again

import * as model from "../src/lib/churnModel";
import {
  applyFilter, buildPeople, columns, daysGone, sortShown, tierCounts, tierOf, toCsv, isScrubbed,
  DAYS_RED, EX_MANAGER_MIN, type Display, type FieldRow,
} from "../src/lib/churnModel";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log("CHURN\n");
const TODAY = "2026-11-09";
const row = (p: number, v: number, label: string, city: string, matches: number, last: string, extra: Partial<FieldRow> = {}): FieldRow => ({
  person_id: p, venue_key: v, venue_label: label, city, matches, managed: 0, booking_cents: matches * 1000, membership_cents: 0,
  first_played: "2025-01-01", last_played: last, ever_member: false, ...extra,
});

// 1 plays mostly at NEMP (2), a little at Round Rock (4); last anywhere Jun 30.
// 2 plays at Round Rock only. 3 only managed. 4 left NEMP for Parmer (last at Parmer is recent).
const ROWS: FieldRow[] = [
  row(1, 2, "NEMP", "ATX", 40, "2026-06-30", { membership_cents: 5000, ever_member: true }),
  row(1, 4, "Round Rock", "ATX", 5, "2026-03-01", { managed: 12 }),
  row(2, 4, "Round Rock", "ATX", 2, "2026-05-01"),
  row(3, 4, "Round Rock", "ATX", 0, null as unknown as string, { managed: 30, last_played: null }),
  row(4, 2, "NEMP", "ATX", 9, "2026-02-01"),
  row(4, 63, "Parmer", "ATX", 3, "2026-10-20"),
  row(5, 11, "Soccer Central", "SATX", 12, "2026-04-15"),
];
const people = buildPeople(ROWS);
const P = (id: number) => people.find((p) => p.id === id)!;

console.log("people");
is("a managed-only person is not a player", people.some((p) => p.id === 3), false);
is("usual field = most matches", P(1).usual.label, "NEMP");
is("matches add up across fields", P(1).matches, 45);
is("managed adds up", P(1).managed, 12);
is("spent = booking + membership, all fields", P(1).spentCents, 45 * 1000 + 5000);
is("last played = latest anywhere", P(4).last, "2026-10-20");
{
  const tie = buildPeople([row(9, 2, "NEMP", "ATX", 5, "2026-01-01"), row(9, 4, "Round Rock", "ATX", 5, "2026-04-01")]);
  is("a tie goes to the more recent field", tie[0].usual.label, "Round Rock");
}

console.log("\nthe sentence");
const f = (o: Partial<model.Filter> = {}) => applyFilter(people, { days: 90, since: "2026-01-01", city: null, field: null, today: TODAY, ...o });
is("90 days, since Jan 1: 1, 2 and 5 (4 played Oct 20)", f().map((r) => r.id).sort(), [1, 2, 5]);
{
  // floor boundary: today − 90 = 2026-08-11 is IN (haven't played in 90 days means last <= today − 90)
  const edge = applyFilter(buildPeople([row(7, 2, "NEMP", "ATX", 1, "2026-08-11"), row(8, 2, "NEMP", "ATX", 1, "2026-08-12")]),
    { days: 90, since: "2026-01-01", city: null, field: null, today: TODAY });
  is("the floor day is in, the day after is out", edge.map((r) => r.id), [7]);
}
is("180+ leaves out anyone gone less than 180 days", f({ days: 180 }).map((r) => r.id).sort(), [1, 2, 5].filter((id) => daysGone(P(id).last, TODAY) >= 180));
is("since moves the lower bound", f({ since: "2026-05-01" }).map((r) => r.id).sort(), [1, 2]);
is("city is the usual field's city", f({ city: "SATX" }).map((r) => r.id), [5]);
{
  const atRR = f({ field: 4 });
  is("field: only people whose USUAL field it is", atRR.map((r) => r.id), [2]);
  const atNemp = f({ field: 2 });
  is("field: matches count only that field", atNemp.find((r) => r.id === 1)?.matches, 40);
  is("field: spent counts only that field", atNemp.find((r) => r.id === 1)?.spentCents, 40 * 1000 + 5000);
  is("field: someone who left it for another field is not gone", atNemp.some((r) => r.id === 4), false);
}

console.log("\ntiers, tags, days");
is("10 is Heavy, 9 and 3 Regular, 2 Tried it", [tierOf(10), tierOf(9), tierOf(3), tierOf(2), tierOf(1)], ["heavy", "regular", "regular", "tried", "tried"]);
is("tier counts", tierCounts(f()), { all: 3, heavy: 2, regular: 0, tried: 1 });
is("Ex-manager from 10 managed", [f().find((r) => r.id === 1)?.exManager, EX_MANAGER_MIN], [true, 10]);
is("red past 180 days", DAYS_RED, 180);
is("sorted by matches by default", sortShown(f(), "matches", "desc").map((r) => r.id), [1, 5, 2]);
is("sort by days gone ascending", sortShown(f(), "days", "asc").map((r) => r.id), [1, 2, 5]);

/** RFC 4180 fields of one line (quotes, doubled quotes, commas inside quotes). */
const parseLine = (l: string): string[] => {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
};

console.log("\nthe CSV is the table");
{
  const shown = sortShown(f(), "matches", "desc");
  const display: Display[] = shown.map((r) => ({ ...r, name: `P${r.id}`, phone: r.id === 2 ? null : "+15125550100", winback: { state: "none" } }));
  const cn = (c: string | null) => ({ ATX: "Austin", SATX: "San Antonio" } as Record<string, string>)[c ?? ""] ?? "";
  const csv = toCsv(display, false, cn).trim().split("\n");
  const cols = columns(false);
  is("header = the table's column labels", parseLine(csv[0]), cols.map((c) => c.label));
  is("one line per row (positive control: rows exist)", csv.length - 1, display.length);
  is("every cell = the table's cell (a date's comma is quoted, not a split)", csv.slice(1).map(parseLine), display.map((r) => cols.map((c) => c.cell(r, cn))));
  is("a field-scoped table says so in its headers", columns(true).filter((c) => /here/.test(c.label)).map((c) => c.label), ["Matches here", "Spent here"]);
  is("an empty list still has its header", toCsv([], false, cn).trim(), cols.map((c) => c.label).join(","));
}

console.log("\nno money from ev, ever again");
is("spentFromEv is gone from the model", "spentFromEv" in model, false);
is("deleted accounts are recognised", [isScrubbed("del_4a1b@playmatchday.com"), isScrubbed("rui@gmail.com")], [true, false]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
