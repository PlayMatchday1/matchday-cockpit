/* THE GAMEDAY STAT STRIP, THE RISK POPULATION AND THE METER — pure model only.
 *
 * WHAT THIS GUARDS. The fill percentage is the number an operator reads to judge a day, and the
 * wrong definition of it is plausible: averaging per-match percentages weights a 4-spot match the
 * same as a 40-spot one. On a day with one small full match that reads as a good day when it was
 * not. It is sum(real)/sum(capacity), and this suite computes the answer by hand.
 *
 * AND THE METER, because the notch is a claim about a number. A bar whose fill exceeds its track,
 * or a notch that does not sit at minimum/capacity, is a picture that disagrees with the figures
 * printed beside it.
 */
import { readFileSync } from "node:fs";
import {
  realFillPct, atRisk, meter, dayBucket, DAY_BUCKETS, FILTERING_TILES,
  realCount, fakeCount, capacity, short, shortBy, vsMinDelta, passesStrip, inCities, type ApiMatch,
} from "../src/lib/gamedayModel";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const near = (m: string, got: number, want: number, tol = 0.01) =>
  Math.abs(got - want) <= tol ? ok(`${m} (${got.toFixed(2)})`) : bad(m, `got ${got} want ~${want}`);

const NOW = Date.parse("2026-09-01T20:00:00.000Z");
/* A MATCH FIXTURE. startDateUtc is what kickoffMs parses; startDate is the wall-clock string. */
const mk = (o: Partial<ApiMatch> & { players: number; fakePlayers: number; cap: number; min: number; offsetMin: number }): ApiMatch => ({
  id: o.id ?? 1,
  name: o.name ?? "M",
  startDate: new Date(NOW + o.offsetMin * 60000).toISOString(),
  startDateUtc: new Date(NOW + o.offsetMin * 60000).toISOString(),
  maxPlayerCount: o.cap,
  minPlayerCount: o.min,
  isCancelled: o.isCancelled ?? false,
  _count: { players: o.players, fakePlayers: o.fakePlayers },
} as unknown as ApiMatch);

console.log("\nREAL SPOTS FILLED IS A RATIO OF SUMS, NOT AN AVERAGE OF RATIOS");
{
  /* THE CASE THAT SEPARATES THE TWO DEFINITIONS, chosen so they cannot coincide:
   *   a 4-spot match, 4 real   -> 100%
   *   a 40-spot match, 2 real  ->   5%
   * average of the two percentages = 52.5%. Ratio of sums = 6/44 = 13.64%. */
  const small = mk({ id: 1, players: 4, fakePlayers: 0, cap: 4, min: 2, offsetMin: 60 });
  const big = mk({ id: 2, players: 2, fakePlayers: 0, cap: 40, min: 9, offsetMin: 60 });
  const r = realFillPct([small, big]);
  near("6 real of 44 capacity is 13.64%", r.pct!, (6 / 44) * 100);
  is("  …carrying the raw sums so the tile can print them", [r.real, r.cap], [6, 44]);
  /* CONTROL: the average-of-percentages answer is 52.5%, and it must NOT be what came back. If the
   * two definitions agreed on this fixture the assertion above would prove nothing. */
  const avg = (100 + 5) / 2;
  near("  CONTROL: the average-of-percentages answer is a different number", avg, 52.5);
  is("  CONTROL: …and the function did not return it", Math.abs(r.pct! - avg) > 30, true);

  /* FAKES: OUT OF THE NUMERATOR, IN THE DENOMINATOR. A fake occupies a spot a real player could
   * have taken, so it belongs to capacity and never to fill. */
  const withFakes = mk({ id: 3, players: 14, fakePlayers: 11, cap: 18, min: 9, offsetMin: 60 });
  const rf = realFillPct([withFakes]);
  is("  a 14-filled match with 11 fakes has 3 real", realCount(withFakes), 3);
  near("  …so it is 3 of 18, not 14 of 18", rf.pct!, (3 / 18) * 100);
  is("  …and the fake count travels for the sub-label", rf.fake, 11);
  /* CONTROL: the filled-based answer is 77.8% and must not be what came back. This is the exact
   * shape of the bug that once made the board report filled as real. */
  is("  CONTROL: the filled-based answer is NOT returned", Math.round(rf.pct!) !== Math.round((14 / 18) * 100), true);

  // 0/0 IS NOT 0%. A day with no capacity has no fill to report, and "0%" is a claim about it.
  is("no capacity at all yields null, never 0%", realFillPct([]).pct, null);
  is("  …and a capacity-less match contributes to neither side",
    realFillPct([mk({ id: 4, players: 3, fakePlayers: 0, cap: 0, min: 2, offsetMin: 60 })]).pct, null);
  // CONTROL: adding one real match to that same list produces a real answer.
  near("  CONTROL: …but a real match beside it does",
    realFillPct([mk({ id: 4, players: 3, fakePlayers: 0, cap: 0, min: 2, offsetMin: 60 }),
                 mk({ id: 5, players: 5, fakePlayers: 0, cap: 10, min: 2, offsetMin: 60 })]).pct!, 50);
}

console.log("\nAT RISK = STILL TO COME AND SHORT ON REAL PLAYERS");
{
  const soonShort = mk({ id: 1, players: 14, fakePlayers: 11, cap: 18, min: 9, offsetMin: 60 });  // 3 real vs 9
  const soonOk = mk({ id: 2, players: 12, fakePlayers: 0, cap: 18, min: 9, offsetMin: 60 });
  const liveShort = mk({ id: 3, players: 3, fakePlayers: 0, cap: 18, min: 9, offsetMin: -30 });
  const doneShort = mk({ id: 4, players: 3, fakePlayers: 0, cap: 18, min: 9, offsetMin: -200 });
  const cxShort = mk({ id: 5, players: 3, fakePlayers: 0, cap: 18, min: 9, offsetMin: 60, isCancelled: true });
  is("a still-to-come match short on real players is at risk", atRisk(soonShort, NOW), true);
  is("  …and it is short by 6, not by 0 — FAKES DO NOT COUNT toward the minimum", shortBy(soonShort), 6);
  is("a still-to-come match that meets its minimum is not", atRisk(soonOk, NOW), false);
  /* THE THREE CONTROLS THAT MAKE "at risk" MEAN SOMETHING. Each is short by the same margin and
   * must NOT be at risk — otherwise the banner would shout about matches nobody can affect. */
  is("  CONTROL: an in-play match is not at risk, however short", atRisk(liveShort, NOW), false);
  is("  CONTROL: a finished match is not at risk", atRisk(doneShort, NOW), false);
  is("  CONTROL: a cancelled match is not at risk", atRisk(cxShort, NOW), false);
  is("  CONTROL: …and all three really are short", [short(liveShort), short(doneShort), short(cxShort)], [true, true, true]);
}

console.log("\nTHE SECTIONS, AND ONLY THREE TILES FILTER");
{
  is("still to come", dayBucket(mk({ players: 0, fakePlayers: 0, cap: 18, min: 9, offsetMin: 60 }), NOW), "soon");
  is("in play", dayBucket(mk({ players: 0, fakePlayers: 0, cap: 18, min: 9, offsetMin: -30 }), NOW), "live");
  is("finished", dayBucket(mk({ players: 0, fakePlayers: 0, cap: 18, min: 9, offsetMin: -200 }), NOW), "done");
  is("cancelled is its own bucket", dayBucket(mk({ players: 0, fakePlayers: 0, cap: 18, min: 9, offsetMin: 60, isCancelled: true }), NOW), "cx");
  /* FOUR SECTIONS, NOT THE THREE THE SPEC ASKED FOR — a deliberate deviation. On a live board 10
   * of 24 matches were cancelled; with three sections the footer read "24 of 24" above 14 rows and
   * ten matches were nowhere on the page. Cancelled is collapsed by default, but it exists. */
  is("  control: the sections are in render order, cancelled last", DAY_BUCKETS.map((b) => b.k), ["soon", "live", "done", "cx"]);
  is("  control: every bucket dayBucket can return has a section",
    ["soon", "live", "done", "cx"].filter((k) => !DAY_BUCKETS.some((b) => b.k === k)), []);
  /* ALL MATCHES AND REAL SPOTS FILLED ARE DISPLAY-ONLY. A tile that looks like a filter and does
   * not filter is the same defect as a button that does nothing. */
  is("only three tiles filter", [...FILTERING_TILES], ["risk", "soon", "live"]);
  is("  control: 'all' is not one of them", FILTERING_TILES.includes("all" as never), false);
  is("  control: nor is 'fill'", FILTERING_TILES.includes("fill" as never), false);
}

console.log("\nTHE METER IS A PICTURE OF THE NUMBERS BESIDE IT");
{
  const m = mk({ players: 14, fakePlayers: 11, cap: 18, min: 9, offsetMin: 60 });   // 3 real, 11 fake
  const g = meter(m)!;
  near("real width is 3/18", g.realPct, (3 / 18) * 100);
  near("fake width is 11/18", g.fakePct, (11 / 18) * 100);
  near("the notch sits at 9/18", g.minPct, 50);
  is("  real + fake never exceeds the track", g.realPct + g.fakePct <= 100.0001, true);

  /* OVERFULL: a roster beyond capacity must not paint past the track and out of the cell. */
  const over = mk({ players: 30, fakePlayers: 10, cap: 18, min: 9, offsetMin: 60 });
  const go = meter(over)!;
  is("an over-capacity match still fits the track", go.realPct + go.fakePct <= 100.0001, true);
  is("  control: …and it really is over capacity", realCount(over) + fakeCount(over) > capacity(over)!, true);

  /* THE LABEL CLAMP. A minimum of 0 or of capacity would hang the text off the end of the track. */
  is("a zero minimum clamps its label to 12%", meter(mk({ players: 1, fakePlayers: 0, cap: 18, min: 0, offsetMin: 60 }))!.labelPct, 12);
  is("a minimum at capacity clamps to 88%", meter(mk({ players: 1, fakePlayers: 0, cap: 18, min: 18, offsetMin: 60 }))!.labelPct, 88);
  /* CONTROL: the clamp must NOT fire in the ordinary middle of the range, or every notch would be
   * mislabelled by a few percent and the label would stop sitting over the notch it describes. */
  is("  CONTROL: a mid-range minimum is NOT clamped", meter(m)!.labelPct, meter(m)!.minPct);
  is("  CONTROL: …and that value is inside the clamp band", g.minPct > 12 && g.minPct < 88, true);

  is("no capacity means no meter, rather than a divide by zero",
    meter(mk({ players: 3, fakePlayers: 0, cap: 0, min: 9, offsetMin: 60 })), null);

  /* THE DELTA CHIP IS real − min, SIGNED. The one relationship the row prints three ways. */
  is("delta is real minus minimum", vsMinDelta(m), 3 - 9);
  is("  …positive when over", vsMinDelta(mk({ players: 12, fakePlayers: 0, cap: 18, min: 9, offsetMin: 60 })), 3);
  is("  …zero at the minimum", vsMinDelta(mk({ players: 9, fakePlayers: 0, cap: 18, min: 9, offsetMin: 60 })), 0);
}

console.log("\nCITY AND BUCKET FILTERS COMPOSE — neither widens the other");
{
  const city = (name: string) => ({ field: { city: { name } } });
  const austinLive = { ...mk({ id: 1, players: 9, fakePlayers: 0, cap: 18, min: 9, offsetMin: -30 }), ...city("Austin") } as ApiMatch;
  const austinSoon = { ...mk({ id: 2, players: 9, fakePlayers: 0, cap: 18, min: 9, offsetMin: 60 }), ...city("Austin") } as ApiMatch;
  const houstonLive = { ...mk({ id: 3, players: 9, fakePlayers: 0, cap: 18, min: 9, offsetMin: -30 }), ...city("Houston") } as ApiMatch;
  const all = [austinLive, austinSoon, houstonLive];
  const compose = (cs: string[], k: Parameters<typeof passesStrip>[2]) =>
    all.filter((m) => inCities(m, new Set(cs))).filter((m) => passesStrip(m, NOW, k)).map((m) => m.id);

  is("Austin + In play is Austin matches in play and nothing else", compose(["Austin"], "live"), [1]);
  /* THE THREE CONTROLS THAT MAKE THAT MEAN SOMETHING. Each relaxes ONE half and must return more —
   * if any of them returned [1] too, the composition above would be passing by accident. */
  is("  CONTROL: Austin alone returns both Austin matches", compose(["Austin"], null), [1, 2]);
  is("  CONTROL: In play alone returns both in-play matches", compose([], "live"), [1, 3]);
  is("  CONTROL: neither filter returns all three", compose([], null), [1, 2, 3]);
  is("  a combination matching nothing returns nothing, rather than falling back to all",
    compose(["Houston"], "soon"), []);

  // The display-only tiles pass everything — the board does not offer them as filters at all.
  is("  'all' passes everything", compose([], "all"), [1, 2, 3]);
  is("  'fill' passes everything", compose([], "fill"), [1, 2, 3]);
}

console.log("\nTHE STEPPER IS KEYED ON A PERMISSION, NOT ON A PROP");
{
  const board = readFileSync("src/components/GamedayBoard.tsx", "utf8");
  const code = board.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  /* THE PROXY THIS REPLACES. `canEditMin = !onOpenMatch` inferred write capability from whether a
   * callback was passed. The day someone wires onOpenMatch into /city/gameday for any reason, the
   * stepper goes live for a tier that must never reach a write and nothing in the diff looks
   * wrong. THIS ASSERTION FAILS IF THE PROXY COMES BACK - that is the whole point of it. */
  is("  the stepper is gated on the EDIT MATCHES right", /const canEditMin = canEditMatches\(appUser\);/.test(code), true);
  is("  control: the onOpenMatch proxy is GONE", /const canEditMin = !onOpenMatch/.test(code), false);
  is("  control: ...and no variant of it survives", /canEditMin\s*=\s*[^;]*onOpenMatch/.test(code), false);
  is("  the permission comes from the shared helper, not a local re-derivation",
    /import \{ useAuth, canEditMatches \} from "@\/lib\/useAuth"/.test(board), true);
  /* IT IS THE SAME PERMISSION THE WRITE ROUTE ENFORCES. If these two ever key on different things
   * the UI and the server disagree about who may write, which is how a 403 becomes a mystery. */
  const route = readFileSync("src/app/api/matchday/[env]/matches/[id]/route.ts", "utf8");
  is("  control: the write route enforces the same right server-side", /auth\.canEditMatches/.test(route), true);

  /* BOTH BUTTONS ARE DISABLED WHEN THE RIGHT IS ABSENT - not hidden, so the operator can see the
   * control exists and read why it is unavailable from its title. */
  is("  minus is disabled without the right", /disabled=\{!canEdit \|\| shownMin <= 2\}/.test(code), true);
  is("  plus is disabled without the right", /disabled=\{!canEdit \|\| shownMin >= cap\}/.test(code), true);
  is("  ...and the reason names the missing permission", /EDIT MATCHES is required to change a match minimum/.test(code), true);

  /* AN ADJUSTMENT IS NOT A RESCUE. The mechanism is real < min: 9 -> 7 with 3 real still cancels,
   * so the green affordance appears only when the shortfall actually reaches zero. */
  is("  the save button turns green only when the shortfall clears",
    /className=\{"gpri" \+ \(shortNow === 0 \? " ok" : ""\)\}/.test(code), true);
  is("  ...and the headline flips on the same condition", /shortNow > 0/.test(code), true);
  is("  ...with the two-outcome title spelled out", /the auto-cancel will still fire/.test(code), true);

  /* THE WRITE ITSELF. One attempt, the diff as the body, and a verdict read back rather than
   * inferred from a 2xx. */
  is("  the body is only the changed field", /changes: \{ minPlayerCount: next \}/.test(code), true);
  is("  a 2xx alone is never treated as landed", /const outcome = String\(j\?\.outcome/.test(code), true);
  is("  UNKNOWN refetches rather than mutating local state", /UNKNOWN - refetching rather than guessing|UNKNOWN — refetching rather than guessing/.test(code), true);
  is("  control: there is no retry anywhere in the save", /retry|attempt\s*\+\+|for \(let a = 0/.test(code), false);

  /* THE EDITOR IS THE SINGLE SOURCE OF TRUTH ONCE OPEN. */
  is("  opening the editor discards any pending stepper value", /setPendingMin\(\{\}\);/.test(code), true);
  is("  closing it re-reads the match", /setDrawerId\(null\);\s*void load\(date, true\);/.test(code), true);

  /* THE BACKTICK TRAP, GUARDED. This component's CSS is a template literal; one backtick in a CSS
   * comment ends the stylesheet and the rest becomes JavaScript. It has cost a broken build before. */
  /* THE SLICE MUST BE THE CSS LITERAL AND NOTHING ELSE. The first version of this ran to the
   * file's LAST backtick-semicolon and swept up every template literal in the JSX below it, so it
   * reported backticks that were not in the stylesheet at all. The literal ends at the first
   * newline-backtick-semicolon after it starts. */
  const cssStart = board.indexOf("const CSS = `") + "const CSS = `".length;
  const cssEnd = board.indexOf("\n`;", cssStart);
  const inner = board.slice(cssStart, cssEnd);
  is("  no backtick inside the CSS template literal", inner.includes("`"), false);
  is("  control: the slice really is the stylesheet", inner.includes(".gdo .grow{") && inner.length > 2000, true);
}

console.log(`\ngameday-strip: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
