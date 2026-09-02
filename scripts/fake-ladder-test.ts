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
  fakesWriteDiff, fakesWriteNote,
} from "../src/lib/fakeLadder";
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

console.log(`\nfake-ladder: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
