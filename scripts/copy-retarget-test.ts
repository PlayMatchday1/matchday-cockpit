/* COPY-TO-DATES — the retarget rules, and the one that fails SILENTLY.
 *
 * WHY THIS IS IN THE MANDATORY SET when most view work is not: a copy is a live match on
 * production MatchDay that a player can register against the moment it exists. Getting endDate
 * wrong does not throw and does not look wrong — a match that ends before it starts, or one whose
 * end was truncated back from the next day, renders as a perfectly ordinary card in the grid. The
 * only place that error is visible is here.
 *
 * NO Date IS EVER BUILT FROM A MATCH STRING. startDate carries a Z it does not mean; it is local
 * wall clock at the pitch. All arithmetic is on a UTC calendar, which cannot shift.
 */
import { retargetStart, retargetPair, durationMinutes, buildCopyBody, COPY_FIELDS } from "../src/lib/copyMatch";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(m); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const S = "2026-09-04T20:00:00.000Z";        // Fri 4 Sep, 8:00 PM
const E = "2026-09-04T21:30:00.000Z";        // ends 9:30 PM — 90 minutes

console.log("\nTHE START: the date and the time are swapped inside the string");
is("  the day moves, the time is kept", retargetStart(S, "2026-09-18"), "2026-09-18T20:00:00.000Z");
is("  a picked time replaces exactly five characters", retargetStart(S, "2026-09-18", "19:30"), "2026-09-18T19:30:00.000Z");
is("  the seconds and the Z are carried over untouched", retargetStart(S, "2026-10-02").slice(16), S.slice(16));
is("  control — the string really did change", retargetStart(S, "2026-09-18") === S, false);

console.log("\nTHE END IS SHIFTED BY THE START'S DELTA, NEVER RETARGETED");
{
  const r = retargetPair(S, E, "2026-09-18");
  is("  same time, 14 days on: both move together", [r.startDate, r.endDate],
    ["2026-09-18T20:00:00.000Z", "2026-09-18T21:30:00.000Z"]);
  is("  …and the fixture keeps its 90 minutes", durationMinutes(r.startDate, r.endDate), 90);
}
{
  /* THE CASE THAT FAILS SILENTLY. 8:00 PM → 11:30 PM pushes an end across midnight that was not
   * there before. Pinning the end to the picked date gives 2026-09-18T01:00 — an end BEFORE its
   * own start, and a card that looks entirely normal in the grid. */
  const r = retargetPair(S, E, "2026-09-18", "23:30");
  is("  8:00 PM → 11:30 PM pushes the end into the NEXT DAY", r.endDate, "2026-09-19T01:00:00.000Z");
  is("  …and the duration is still 90 minutes", durationMinutes(r.startDate, r.endDate), 90);
  is("  control — retargeting the end instead would put it BEFORE the start",
    durationMinutes(r.startDate, retargetStart(E, "2026-09-18", "01:00")) as number < 0, true);
}
{
  /* THE MIRROR CASE: a source that ALREADY crosses midnight. Retargeting the end collapses it onto
   * the picked date and truncates the fixture by a day. */
  const s2 = "2026-09-04T23:30:00.000Z", e2 = "2026-09-05T01:00:00.000Z";
  is("  control — the source's end is already on the following day", e2.slice(0, 10) !== s2.slice(0, 10), true);
  const r = retargetPair(s2, e2, "2026-09-18");
  is("  a midnight-crossing fixture keeps its end on the day after ITS OWN start", r.endDate, "2026-09-19T01:00:00.000Z");
  is("  …and its 90 minutes", durationMinutes(r.startDate, r.endDate), 90);
  const wrong = retargetStart(e2, "2026-09-18");
  is("  control — retargeting that end collapses it to a negative duration",
    (durationMinutes(r.startDate, wrong) as number) < 0, true);
}
{
  // Moving EARLIER across a month boundary, so the delta is negative and the calendar rolls back.
  const r = retargetPair(S, E, "2026-08-28", "06:00");
  is("  an earlier date and time still holds the length", durationMinutes(r.startDate, r.endDate), 90);
  is("  …and lands on the picked day", r.startDate.slice(0, 10), "2026-08-28");
}
{
  // A month boundary forward, which is the "copy this Friday through October" case.
  const r = retargetPair(S, E, "2026-10-02");
  is("  a next-month date crosses the boundary cleanly", [r.startDate.slice(0, 10), r.endDate.slice(0, 10)],
    ["2026-10-02", "2026-10-02"]);
}
is("  an unparseable pair is left alone rather than invented",
  retargetPair("nonsense", E, "2026-09-18").endDate, E);

console.log("\nTHE BODY: retargeted, or byte for byte");
{
  const src = { name: "Fri night", startDate: S, endDate: E, fieldId: 41, registrationPrice: 1500,
    maxPlayerCount: 20, minPlayerCount: 10, isFreeMember: false, type: "OPEN", description: "",
    teams: [{}, {}], id: 18744, starRating: 4.6, isCancelled: false, players: [1, 2, 3] };
  const same = buildCopyBody(src);
  is("  with NO target the dates are byte for byte, as before", [same.startDate, same.endDate], [S, E]);
  const moved = buildCopyBody(src, { iso: "2026-09-18", hhmm: "19:30" });
  is("  with a target the start is retargeted", moved.startDate, "2026-09-18T19:30:00.000Z");
  is("  …and the end shifted by the same delta", moved.endDate, "2026-09-18T21:00:00.000Z");
  is("  …keeping the 90 minutes", durationMinutes(String(moved.startDate), String(moved.endDate)), 90);

  /* THE $0 REGRESSION CHECK. 18408 was copied with a nine-key body, landed with no price because
   * the API defaults an absent one to 0, and sold 44 spots at $0 against $15 siblings. Retargeting
   * must not narrow the body. */
  is("  retargeting carries the price", moved.registrationPrice, 1500);
  is("  …the capacity and the minimum", [moved.maxPlayerCount, moved.minPlayerCount], [20, 10]);
  is("  …and every key the untargeted body carried",
    Object.keys(same).filter((k) => !(k in moved)), []);
  is("  control — the body is not a spread of the source",
    ["id", "starRating", "isCancelled", "players"].filter((k) => k in moved), []);
  is("  teamNumbers is derived from the teams array", moved.teamNumbers, 2);
  is("  control — COPY_FIELDS is still the 27 the route accepts", COPY_FIELDS.length, 27);
}

/* THE RUNNER READS THIS LINE. Its shape is the contract — a suite with no summary is reported as
 * ZERO ASSERTIONS and fails, which is the guard against a rotted mock passing silently. */
console.log(`\ncopy-retarget: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
