/* THE FAKE-SPOT LADDER.
 *
 * WHAT THIS GUARDS. A fake count is DERIVED, so a control that writes one writes to nothing and
 * the ladder overwrites it. Worse, a control that writes only the rung currently in force looks
 * correct for an hour and then silently reverses when the match crosses the next mark. Both
 * failures are invisible at the moment of the write and obvious to a player who sees a match
 * look full when it should have cancelled.
 */
import { readFileSync } from "node:fs";
import {
  RUNG_MARKS, RUNG_KEYS, rungKey, fakesFor, rungFor, markInForce, marksFrom,
  fakesWriteDiff, fakesWriteNote, defaultLadder, ladderDiff, planFixedLadder, isHandLadderEdit, FIXED_LADDER_SOURCE, type ChangeLogRow,
} from "../src/lib/fakeLadder";
import { buildCopyBody } from "../src/lib/copyMatch";
import { EDITABLE_KEYS } from "../src/lib/matchEditModel";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log("\nfake = capacity − rung − real, EXACTLY");
{
  /* PRODUCTION MATCH 18360 (ATH Katy), capacity 32, 1 real, all five rungs. If the formula were
   * an approximation one of these five would be off by one. */
  const CAP = 32, REAL = 1;
  for (const [rung, fake] of [[16, 15], [12, 19], [6, 25], [4, 27], [2, 29]] as [number, number][]) {
    is(`  rung ${rung} left -> ${fake} fake`, fakesFor(CAP, rung, REAL), fake);
    is(`    …and it inverts`, rungFor(CAP, fake, REAL), rung);
  }
  /* THE FLOOR IS THE ONLY QUALIFICATION. rung + real beyond capacity clamps to 0 rather than
   * going negative — a negative fake count would render as a negative number on the board. */
  is("a rung beyond capacity floors at zero fakes", fakesFor(18, 30, 0), 0);
  is("  …and with real players too", fakesFor(18, 14, 9), 0);
  is("  control: it is not clamping in the ordinary range", fakesFor(18, 4, 1), 13);
  // The inverse is clamped into the legal band at both ends.
  is("asking for more fakes than there is room for pins the rung at 0", rungFor(18, 99, 2), 0);
  is("asking for negative fakes pins the rung at capacity − real", rungFor(18, -5, 2), 16);
}

console.log("\nWHICH RUNG IS IN FORCE — measured on staging, not assumed");
{
  /* MEASURED 2026-09-02: six matches at six distances with distinct rung values, so the observed
   * fake count named the rung that had been applied. These six rows ARE that measurement. */
  is("30h out -> the 36h rung", markInForce(30), 36);
  is("20h out -> the 24h rung", markInForce(20), 24);
  is(" 9h out -> the 12h rung", markInForce(9), 12);
  is(" 5h out -> the  6h rung", markInForce(5), 6);
  is(" 2h out -> the  3h rung", markInForce(2), 3);
  is("30m out -> the  3h rung", markInForce(0.5), 3);
  // The boundaries, which the six samples above do not pin.
  is("exactly 24h is still the 24h rung", markInForce(24), 24);
  is("exactly 12h is still the 12h rung", markInForce(12), 12);
  is("exactly 3h is still the 3h rung", markInForce(3), 3);
  is("a match past kickoff stays on the 3h rung", markInForce(-1), 3);
  is("a week out is the 36h rung", markInForce(168), 36);
  /* CONTROL: it is not returning a constant. Five distinct answers across the range. */
  is("  control: the mapping really varies", new Set([30, 20, 9, 5, 2].map(markInForce)).size, 5);

  is("the later marks include the one in force", marksFrom(12), [12, 6, 3]);
  is("  …and the last mark has only itself", marksFrom(3), [3]);
  is("  …and the first has all five", marksFrom(36), [36, 24, 12, 6, 3]);
}

console.log("\nWRITING ONLY THE RUNG IN FORCE IS A LIE");
{
  const CAP = 18, REAL = 3;
  // A typical ladder: plenty of fakes at every mark.
  const ladder = { fakeSpotLeft36h: 2, fakeSpotLeft24h: 2, fakeSpotLeft12h: 2, fakeSpotLeft6h: 2, fakeSpotLeft3h: 2 };
  /* STRIP THE FAKES TO ZERO AT 19 HOURS OUT. The 24h rung is in force; 12h, 6h and 3h would all
   * put the fakes straight back as the match crosses them. */
  const w = fakesWriteDiff(ladder, CAP, REAL, 19, 0);
  is("  the 24h rung is in force at 19h", w.mark, 24);
  is("  zero fakes means a rung of capacity − real", w.targetRung, 15);
  is("  EVERY later rung is raised too", Object.keys(w.diff).sort(),
    ["fakeSpotLeft12h", "fakeSpotLeft24h", "fakeSpotLeft3h", "fakeSpotLeft6h"]);
  is("  …to the same value", [...new Set(Object.values(w.diff))], [15]);
  is("  …and the EARLIER rung is untouched, being already past",
    Object.keys(w.diff).includes("fakeSpotLeft36h"), false);
  /* THE CONTROL THAT MAKES THIS LOAD-BEARING: with only the in-force rung written, the ladder
   * re-inflates at the very next mark. Computed here rather than asserted by eye. */
  const onlyInForce = { ...ladder, fakeSpotLeft24h: 15 };
  is("  CONTROL: writing only the 24h rung leaves 12h re-inflating to 13 fakes",
    fakesFor(CAP, onlyInForce.fakeSpotLeft12h, REAL), 13);
  is("  …while the full write holds it at 0",
    fakesFor(CAP, { ...ladder, ...w.diff }.fakeSpotLeft12h, REAL), 0);

  /* ONLY CHANGED FIELDS. A rung already high enough cannot re-inflate, so it stays out of the body. */
  const already = { fakeSpotLeft36h: 2, fakeSpotLeft24h: 15, fakeSpotLeft12h: 15, fakeSpotLeft6h: 2, fakeSpotLeft3h: 2 };
  const w2 = fakesWriteDiff(already, CAP, REAL, 19, 0);
  is("  rungs already at the target are not in the diff", Object.keys(w2.diff).sort(),
    ["fakeSpotLeft3h", "fakeSpotLeft6h"]);
  is("  control: …and the diff is not empty when something must move", Object.keys(w2.diff).length > 0, true);
  const w3 = fakesWriteDiff({ ...already, fakeSpotLeft6h: 15, fakeSpotLeft3h: 15 }, CAP, REAL, 19, 0);
  is("  a ladder already at the target writes NOTHING", Object.keys(w3.diff), []);

  /* ADDING FAKES LOWERS THE RUNG. The same function, the other direction. */
  const add = fakesWriteDiff(ladder, CAP, REAL, 19, 10);
  is("  ten fakes means a rung of 5", add.targetRung, 5);
  is("  …and raising only what is below it", Object.keys(add.diff).sort(),
    ["fakeSpotLeft12h", "fakeSpotLeft24h", "fakeSpotLeft3h", "fakeSpotLeft6h"]);
  is("  …to 5", [...new Set(Object.values(add.diff))], [5]);

  /* AT THE LAST MARK there is nothing later to raise, and the note says so by omission. */
  const late = fakesWriteDiff(ladder, CAP, REAL, 1, 0);
  is("  inside 3h only the 3h rung moves", Object.keys(late.diff), ["fakeSpotLeft3h"]);
  is("  …and nothing later was raised", late.laterRaised, []);
  is("  the note says what happened", fakesWriteNote(0, w.laterRaised), "fakes set to 0 · later rungs raised to match");
  is("  …and stays quiet when nothing later moved", fakesWriteNote(0, []), "fakes set to 0");
}

console.log("\nTHE RUNG FIELDS ARE EDITABLE, AND THE LADDER NEED NOT BE MONOTONIC");
{
  for (const k of RUNG_KEYS) is(`  ${k} is in EDITABLE_KEYS`, (EDITABLE_KEYS as readonly string[]).includes(k), true);
  is("  control: five of them, in ladder order", RUNG_KEYS,
    ["fakeSpotLeft36h", "fakeSpotLeft24h", "fakeSpotLeft12h", "fakeSpotLeft6h", "fakeSpotLeft3h"]);
  is("  control: the marks match the keys", RUNG_MARKS.map(rungKey), RUNG_KEYS);
  /* A NON-MONOTONIC LADDER IS THE WHOLE POINT of stripping fakes near kickoff — the 3h rung ends
   * up ABOVE the earlier ones. The write helper must be willing to produce one. */
  const w = fakesWriteDiff({ fakeSpotLeft36h: 2, fakeSpotLeft24h: 2, fakeSpotLeft12h: 2, fakeSpotLeft6h: 2, fakeSpotLeft3h: 2 }, 18, 3, 1, 0);
  is("  stripping fakes inside 3h raises 3h above every earlier rung", w.diff.fakeSpotLeft3h, 15);
  is("  control: …and the earlier rungs are left at 2, i.e. non-monotonic", Object.keys(w.diff), ["fakeSpotLeft3h"]);

  /* THE EDITOR MUST NOT REFUSE THAT SHAPE. */
  const panel = readFileSync("src/components/MatchPanel.tsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  is("  the monotonic ladder check is gone from the editor", /ladderBreak/.test(panel), false);
}

console.log("\nTHE DEFAULT LADDER (2026-10-24): fixed 12 / 8 / 8 / 6 / 6, each capped at capacity");
{
  /* COMPUTED, NOT RESTATED: the fake count at each mark on an empty match comes out of fakesFor —
   * the formula reproduced on production 18360 above — fed the default rung. */
  const L = defaultLadder(18)!;
  is("  capacity 18 -> 12 / 8 / 8 / 6 / 6", RUNG_KEYS.map((k) => L[k]), [12, 8, 8, 6, 6]);
  is("  fakes on an EMPTY 18 at 36 / 24 / 12 / 6 / 3h", RUNG_KEYS.map((k) => fakesFor(18, L[k], 0)), [6, 10, 10, 12, 12]);
  is("  real players replace fakes one for one (4 real at 12h -> 6 fakes)", fakesFor(18, L.fakeSpotLeft12h, 4), 6);
  is("  …and never below zero (12 real at 12h)", fakesFor(18, L.fakeSpotLeft12h, 12), 0);
  is("  CAPPED AT CAPACITY: a 10 reads 10 / 8 / 8 / 6 / 6", RUNG_KEYS.map((k) => defaultLadder(10)![k]), [10, 8, 8, 6, 6]);
  is("  …a 7 reads 7 / 7 / 7 / 6 / 6", RUNG_KEYS.map((k) => defaultLadder(7)![k]), [7, 7, 7, 6, 6]);
  is("  …so a capped rung means zero fakes there", fakesFor(10, defaultLadder(10)!.fakeSpotLeft36h, 0), 0);
  is("  a big match is not scaled up (capacity 28 -> 12 at 36h)", defaultLadder(28)!.fakeSpotLeft36h, 12);
  is("  no capacity -> no ladder (special event)", [defaultLadder(0), defaultLadder(null), defaultLadder("")], [null, null, null]);
}

console.log("\nTHE ONE-OFF BULK ACTION'S PLAN — what the preview counts and the write route re-checks");
{
  const NOW = Date.parse("2026-11-01T18:00:00.000Z");
  const at = (h: number) => new Date(NOW + h * 3_600_000).toISOString();
  /* startDate is WALL CLOCK; for a fixture the day it names is all that matters. */
  const wall = (h: number) => at(h).slice(0, 10) + "T19:00:00.000Z";
  const OLD = { fakeSpotLeft36h: 16, fakeSpotLeft24h: 16, fakeSpotLeft12h: 15, fakeSpotLeft6h: 16, fakeSpotLeft3h: 18 };
  const FIX = defaultLadder(18)!;
  const M = (h: number, extra: Record<string, unknown> = {}) => ({ maxPlayerCount: 18, isCancelled: false, startDateUtc: at(h), startDate: wall(h), ...OLD, ...extra });
  is("  48h out (Nov 3), old ladder -> change", planFixedLadder(M(48), NOW).status, "change");
  /* THE START DATE: Oct 24 – Nov 1 were set by hand. Compared on the WALL-CLOCK day. */
  is("  Nov 1 wall-clock day -> before the start date", planFixedLadder(M(48, { startDate: "2026-11-01T21:00:00.000Z" }), NOW).status, "beforeFrom");
  is("  Nov 2 wall-clock day -> in scope", planFixedLadder(M(48, { startDate: "2026-11-02T08:00:00.000Z" }), NOW).status, "change");
  is("  unreadable startDate -> skipped, never assumed in scope", planFixedLadder(M(48, { startDate: null }), NOW).status, "beforeFrom");
  is("  a later start date can be passed", planFixedLadder(M(48), NOW, { fromYmd: "2026-11-10" }).status, "beforeFrom");
  /* THE 36H RULE (Ryan, 2026-10-23): never change a fake a player can already see. */
  is("  36.2h out -> change", planFixedLadder(M(36.2), NOW).status, "change");
  is("  EXACTLY 36h out -> skipped", planFixedLadder(M(36), NOW).status, "inside36h");
  is("  36h 04m out -> skipped (inside the 5-minute margin)", planFixedLadder(M(36 + 4 / 60), NOW).status, "inside36h");
  is("  10h out -> skipped, fakes may be showing", planFixedLadder(M(10, { startDate: "2026-11-02T08:00:00.000Z" }), NOW).status, "inside36h");
  is("  unreadable kickoff -> skipped, never assumed far enough away", planFixedLadder(M(48, { startDateUtc: null }), NOW).status, "inside36h");
  is("  cancelled -> skipped", planFixedLadder(M(48, { isCancelled: true }), NOW).status, "cancelled");
  is("  no capacity -> skipped", planFixedLadder(M(48, { maxPlayerCount: 0 }), NOW).status, "nocap");
  is("  already on the fixed ladder -> unchanged, nothing sent", planFixedLadder(M(48, FIX), NOW).status, "unchanged");
  is("  HAND-EDITED -> skipped and listed", planFixedLadder(M(48), NOW, { handEdited: true }).status, "handEdited");
  is("  control: the same match without the hand edit WOULD change", planFixedLadder(M(48), NOW, { handEdited: false }).status, "change");

  /* THE DIFF IS THE BODY: only the rungs that differ. */
  is("  diff carries the five rungs that differ", planFixedLadder(M(48), NOW).diff,
    { fakeSpotLeft36h: 12, fakeSpotLeft24h: 8, fakeSpotLeft12h: 8, fakeSpotLeft6h: 6, fakeSpotLeft3h: 6 });
  is("  …and only those (36h already 12)", planFixedLadder(M(48, { fakeSpotLeft36h: 12 }), NOW).diff,
    { fakeSpotLeft24h: 8, fakeSpotLeft12h: 8, fakeSpotLeft6h: 6, fakeSpotLeft3h: 6 });
  is("  a null stored rung is a difference, not zero", ladderDiff({ ...FIX, fakeSpotLeft6h: null }, FIX), { fakeSpotLeft6h: 6 });

  /* THE PREVIEW COUNT, on a mixed fixture with a known answer. */
  const fixture: [Record<string, unknown>, boolean][] = [
    [M(48), false], [M(120), false], [M(37), false], [M(36), false], [M(30), false],
    [M(48, { startDate: "2026-10-31T19:00:00.000Z" }), false],
    [M(48, { isCancelled: true }), false], [M(48, { maxPlayerCount: null }), false], [M(72, FIX), false], [M(60), true],
  ];
  const counts: Record<string, number> = {};
  for (const [m, h] of fixture) { const st = planFixedLadder(m, NOW, { handEdited: h }).status; counts[st] = (counts[st] ?? 0) + 1; }
  is("  preview counts: 3 change · 2 inside 36h · 1 before start · 1 hand-edited · 1 cancelled · 1 no cap · 1 unchanged", counts,
    { change: 3, inside36h: 2, beforeFrom: 1, cancelled: 1, nocap: 1, unchanged: 1, handEdited: 1 });
}

console.log("\nWHAT COUNTS AS CHANGED BY HAND (change_log rows)");
{
  const row = (o: Record<string, unknown>) => ({ match_id: 1, source: "Match editor", method: "PUT", endpoint: "/admin/matches/1", outcome: "landed", request_body: {}, ...o }) as ChangeLogRow;
  is("  a landed PUT that sent a rung -> hand edit", isHandLadderEdit(row({ request_body: { fakeSpotLeft12h: 6 } })), true);
  is("  …an UNKNOWN one too (it may have landed)", isHandLadderEdit(row({ outcome: "unknown", request_body: { fakeSpotLeft3h: 9 } })), true);
  is("  Spots left now's roster write -> hand edit", isHandLadderEdit(row({ source: "gameday-spots", method: "POST", endpoint: "/admin/matches/1/batch/fake-players", request_body: { totalFakes: 2 } })), true);
  is("  …and its removal form", isHandLadderEdit(row({ source: "gameday-spots", method: "DELETE", endpoint: "/admin/matches/user-matches/{3 rows}", request_body: { removes: [1, 2, 3] } })), true);
  is("  NOT: a price edit with no rung", isHandLadderEdit(row({ request_body: { registrationPrice: 1500 } })), false);
  is("  NOT: a failed rung write", isHandLadderEdit(row({ outcome: "failed", request_body: { fakeSpotLeft12h: 6 } })), false);
  is("  NOT: this action's own write", isHandLadderEdit(row({ source: FIXED_LADDER_SOURCE, request_body: { fakeSpotLeft12h: 8 } })), false);
  is("  NOT: the retired 2026-10-23 bulk action's write", isHandLadderEdit(row({ source: "Apply new ladder", request_body: { fakeSpotLeft12h: 15 } })), false);
  is("  NOT: a create (Copy match carries a ladder)", isHandLadderEdit(row({ method: "POST", endpoint: "/admin/matches", request_body: { fakeSpotLeft12h: 6 } })), false);
}

console.log("\nA NEW MATCH GETS THE DEFAULT LADDER");
{
  const SRC = { name: "n", description: "d", type: "REGULAR", startDate: "2026-11-04T19:30:00.000Z", endDate: "2026-11-04T21:00:00.000Z",
    fieldId: 1, maxPlayerCount: 22, isFreeMember: false, teams: [{}, {}],
    fakeSpotLeft36h: 16, fakeSpotLeft24h: 12, fakeSpotLeft12h: 6, fakeSpotLeft6h: 4, fakeSpotLeft3h: 2 };
  const body = buildCopyBody(SRC, { iso: "2026-11-11" });
  is("  a copy carries the default ladder, not the source's rungs",
    RUNG_KEYS.map((k) => body[k]), [12, 8, 8, 6, 6]);
  is("  …capped at the copy's capacity (8)", RUNG_KEYS.map((k) => buildCopyBody({ ...SRC, maxPlayerCount: 8 }, { iso: "2026-11-11" })[k]), [8, 8, 8, 6, 6]);
  is("  control: the source's own rungs really were different", RUNG_KEYS.map((k) => (SRC as Record<string, unknown>)[k]), [16, 12, 6, 4, 2]);
  /* THE CREATE ROUTE FILLS ANY RUNG A CALLER LEAVES OUT. Source-level, because the route's fill sits
   * between an HTTP request and a MatchDay write — not reachable inside the gate. */
  const route = readFileSync("src/app/api/matchday/[env]/matches/create/route.ts", "utf8");
  is("  the create route fills absent rungs from defaultLadder(payload.maxPlayerCount)",
    /defaultLadder\(payload\.maxPlayerCount\)/.test(route), true);
  // NEGATIVE: a rung the caller DID send is never overwritten wholesale.
  is("  …and never overwrites a rung the caller sent", /Object\.assign\(payload,\s*ladder\)/.test(route), false);
  /* STEP TWO OF A COPY MUST NOT PUT THE SOURCE'S LADDER BACK. */
  const editor = readFileSync("src/app/(internal)/match-ops/matches/[id]/MatchEditor.tsx", "utf8");
  is("  the editor's copy overlay skips the rung keys", /if \(RUNG_KEYS\.includes\(k\)\) continue;/.test(editor), true);
}

console.log(`\nfake-ladder: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
