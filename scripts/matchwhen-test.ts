/* MATCH WHEN — the guard on the drawer's DATE / START TIME / END TIME model.
 *
 * WHY THIS EXISTS AT ALL, under a policy where most changes get a browser look and a push: this
 * one changes what a match record says HAPPENED. A silent hour shift here moves kickoff for every
 * player holding a spot, and it is invisible on screen — the wall-clock label looks right in the
 * exact moment the underlying instant is wrong.
 *
 * WHAT IT IS AIMED AT. Not "does the function return a string" — the timezone trap. The samples
 * below deliberately include the two local clocks that do not exist or repeat (US spring-forward
 * 02:30 and fall-back 01:30), because those are the strings a local accessor mangles while a UTC
 * accessor carries through untouched. */

import {
  parseWall, buildWall, movePair, moveEnd, durationLabel, durationMin, whenError,
  wallInputsReady, wallRoundTrips, WALL_SAMPLES, wallMin, fromWallMin,
} from "../src/lib/matchWhen";
import { readFileSync } from "node:fs";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log("\nthe wall clock survives every round trip");
{
  const broken = wallRoundTrips(WALL_SAMPLES);
  is("every sample string rebuilds itself exactly", broken, []);
  // POSITIVE CONTROL: the checker must be able to FAIL. A round-trip test that cannot go red is
  // not evidence — it is the same zero an empty list gives.
  is("control: a string that does NOT round-trip is caught",
    wallRoundTrips(["2026-08-16T19:00:00.500Z"]), ["2026-08-16T19:00:00.500Z"]);
  is("the DST strings are actually in the sample set",
    WALL_SAMPLES.filter((s) => s.startsWith("2026-03-08") || s.startsWith("2026-11-01")).length, 2);

  // THE TRAP ITSELF, stated as an assertion rather than a comment: the labelled hour that comes
  // out is the labelled hour that went in, with no offset applied.
  is("19:00 reads back as 19:00, not 14:00 or 00:00", parseWall("2026-08-16T19:00:00.000Z"),
    { date: "2026-08-16", time: "19:00" });
  is("a wall minute difference is a plain clock difference",
    wallMin("2026-08-16T20:30:00.000Z") - wallMin("2026-08-16T19:00:00.000Z"), 90);
  is("fromWallMin builds the Z form the API returns",
    fromWallMin(wallMin("2026-08-16T19:00:00.000Z")), "2026-08-16T19:00:00.000Z");
}

console.log("\nan empty input never becomes a value");
{
  is("both halves required", wallInputsReady("2026-08-16", "19:00"), true);
  is("a cleared date is refused", wallInputsReady("", "19:00"), false);
  is("a cleared time is refused", wallInputsReady("2026-08-16", ""), false);
  is("a half-typed date is refused", wallInputsReady("2026-08", "19:00"), false);
  /* THE SHAPE THIS PREVENTS. buildWall("", "19:00") is "T19:00:00.000Z" — not empty, not a date,
   * and it passes any `if (!value)` check on its way to the wire. */
  is("control: the bad string really is what buildWall would produce", buildWall("", "19:00"), "T19:00:00.000Z");
  is("movePair refuses a half-empty pair", movePair("2026-08-16T19:00:00.000Z", "2026-08-16T20:00:00.000Z", "", "19:00"), null);
}

console.log("\nmoving the match keeps its length");
{
  const S = "2026-08-16T19:00:00.000Z", E = "2026-08-16T20:30:00.000Z";
  is("a date change moves the end with it", movePair(S, E, "2026-08-23", "19:00"),
    { startDate: "2026-08-23T19:00:00.000Z", endDate: "2026-08-23T20:30:00.000Z" });
  is("a start-time change moves the end with it", movePair(S, E, "2026-08-16", "21:00"),
    { startDate: "2026-08-16T21:00:00.000Z", endDate: "2026-08-16T22:30:00.000Z" });
  is("duration is preserved across a date move",
    durationMin(...(Object.values(movePair(S, E, "2026-08-23", "19:00")!) as [string, string])), 90);

  /* THE AFTER-MIDNIGHT MATCH, MOVED. It must NOT be clamped to the new start date — a 23:00
   * match that ends 00:30 still ends the following morning a week later. */
  const S2 = "2026-08-16T23:00:00.000Z", E2 = "2026-08-17T00:30:00.000Z";
  is("a cross-midnight match keeps its day gap when moved", movePair(S2, E2, "2026-08-23", "23:00"),
    { startDate: "2026-08-23T23:00:00.000Z", endDate: "2026-08-24T00:30:00.000Z" });
  is("…and is not clamped back to the start date",
    parseWall(movePair(S2, E2, "2026-08-23", "23:00")!.endDate).date !== "2026-08-23", true);

  // A move across a month and a year boundary, because that is where date arithmetic goes wrong.
  is("moving across a month end lands on the 1st", movePair(S, E, "2026-08-31", "23:30"),
    { startDate: "2026-08-31T23:30:00.000Z", endDate: "2026-09-01T01:00:00.000Z" });
  is("moving across a year end lands on Jan 1", movePair(S, E, "2026-12-31", "23:30"),
    { startDate: "2026-12-31T23:30:00.000Z", endDate: "2027-01-01T01:00:00.000Z" });
}

console.log("\nthe end moves alone, and rolls past midnight rather than inverting");
{
  const S = "2026-08-16T19:00:00.000Z", E = "2026-08-16T20:30:00.000Z";
  is("a later end time stays on the same day", moveEnd(S, E, "21:15"), "2026-08-16T21:15:00.000Z");
  is("an end time before the start rolls to the next day", moveEnd(S, E, "00:30"), "2026-08-17T00:30:00.000Z");
  is("…so it never produces a negative duration", durationMin(S, moveEnd(S, E, "00:30")!) > 0, true);
  is("an end equal to the start also rolls forward", durationMin(S, moveEnd(S, E, "19:00")!), 1440);

  /* ── TWO ASSERTION BODIES CHANGED HERE, AND THIS IS THE ONLY PLACE ─────────────────────────
   * They asserted that a 34h match KEEPS its end date when the end time is edited, because the
   * date came from the previous end. That dependency is exactly what made the roll sticky:
   * <input type="time"> fires on PARTIAL values, one of those rolled production 18292's end to
   * the next day, and nothing ever rolled it back — the finishing keystroke inherited it and the
   * panel read 25h on a one-hour match.
   *
   * The offset-preserving middle ground was tried and MEASURED: it still lands at 25h, because
   * the day offset is itself poisoned by the same partial keystroke. Only dropping the dependency
   * on the previous end corrects.
   *
   * So the new truth, asserted below: a >48h end cannot be REACHED by typing a time. The stored
   * fixture is untouched — nothing rewrites an end that is not edited — but editing that match's
   * END TIME now yields under 48h. A time alone cannot express "three days later". */
  const LS = "2026-09-29T09:00:00.000Z", LE = "2026-09-30T19:15:00.000Z";
  is("editing a 34h match's END TIME now derives from the START's date",
    moveEnd(LS, LE, "20:00"), "2026-09-29T20:00:00.000Z");
  is("…which is 11h, not 34h — a time alone cannot say 'the day after tomorrow'",
    durationMin(LS, moveEnd(LS, LE, "20:00")!), 660);
  is("…and the stored pair is untouched until the end time is actually edited", [LS, LE],
    ["2026-09-29T09:00:00.000Z", "2026-09-30T19:15:00.000Z"]);

  /* ── THE BUG ITSELF, and the assertion most likely to have been left out ───────────────────
   * A partial keystroke that momentarily rolls, followed by a valid one. The second must CORRECT
   * the first, not inherit it. This is production 18292 exactly. */
  const PS = "2026-09-01T20:00:00.000Z", PE = "2026-09-01T20:45:00.000Z";
  const partial = moveEnd(PS, PE, "09:00")!;              // 9am is before an 8pm start -> rolls
  is("a partial keystroke does roll, as it must", partial, "2026-09-02T09:00:00.000Z");
  const corrected = moveEnd(PS, partial, "21:00")!;       // …and the NEXT keystroke corrects it
  is("…and the next keystroke CORRECTS it rather than inheriting the roll",
    corrected, "2026-09-01T21:00:00.000Z");
  is("…so 8pm -> 9pm is one hour, not twenty-five", durationMin(PS, corrected), 60);
  /* CONTROL: the correction is not a clamp — feed the SAME stale end an overnight time and it
   * still rolls. Without this, "corrected" could just mean "always same-day". */
  is("control: from the same stale end, 11pm -> 1am still rolls",
    moveEnd("2026-09-01T23:00:00.000Z", partial, "01:00"), "2026-09-02T01:00:00.000Z");
  is("control: …and that one is two hours",
    durationMin("2026-09-01T23:00:00.000Z", moveEnd("2026-09-01T23:00:00.000Z", partial, "01:00")!), 120);
  /* CONTROL: PURE. The same (start, time) gives the same answer from ANY previous end — which is
   * the property that makes a partial keystroke harmless. */
  const ends = [PE, partial, "2026-09-05T03:00:00.000Z", "2025-01-01T00:00:00.000Z"];
  is("control: the result is independent of the previous end",
    new Set(ends.map((e) => moveEnd(PS, e, "21:00"))).size, 1);

  is("moveEnd refuses an empty time", moveEnd(S, E, ""), null);
}

console.log("\nthe duration readout is a value, not a sentence");
{
  is("an hour and a half", durationLabel("2026-08-16T19:00:00.000Z", "2026-08-16T20:30:00.000Z"), "1h 30m");
  is("a whole hour has no minutes", durationLabel("2026-08-16T19:00:00.000Z", "2026-08-16T20:00:00.000Z"), "1h");
  is("under an hour is minutes only", durationLabel("2026-08-16T19:00:00.000Z", "2026-08-16T19:45:00.000Z"), "45m");
  is("across midnight", durationLabel("2026-08-16T23:00:00.000Z", "2026-08-17T00:30:00.000Z"), "1h 30m");
  is("an inverted pair shows nothing rather than a negative", durationLabel("2026-08-16T20:00:00.000Z", "2026-08-16T19:00:00.000Z"), null);
  is("a missing end shows nothing", durationLabel("2026-08-16T19:00:00.000Z", null), null);
  is("it is one short line, not a sentence",
    /^[0-9hm ]+$/.test(durationLabel("2026-08-16T19:00:00.000Z", "2026-08-16T20:30:00.000Z")!), true);
}

console.log("\nthe inversion block — the ONLY guard there is");
{
  /* THE API DOES NOT VALIDATE THE PAIR. Proven on staging 2557 this phase: PUT {endDate} set one
   * hour BEFORE startDate returned 2xx and read back inverted. Nothing downstream stops this. */
  is("end before start is blocked", !!whenError("2026-08-16T20:00:00.000Z", "2026-08-16T19:00:00.000Z"), true);
  is("end equal to start is blocked", !!whenError("2026-08-16T19:00:00.000Z", "2026-08-16T19:00:00.000Z"), true);
  is("a normal pair is not blocked", whenError("2026-08-16T19:00:00.000Z", "2026-08-16T20:30:00.000Z"), null);
  is("a cross-midnight pair is not blocked", whenError("2026-08-16T23:00:00.000Z", "2026-08-17T00:30:00.000Z"), null);
  is("nothing to compare is not an error", whenError(null, null), null);
  is("the message names what to do", /later/i.test(whenError("2026-08-16T20:00:00.000Z", "2026-08-16T19:00:00.000Z")!), true);
}

console.log("\nthe panel wiring");
{
  const src = readFileSync("src/components/MatchPanel.tsx", "utf8");
  // POSITIVE CONTROL: we are reading the file we think we are.
  if (/data-testid="mp-start"/.test(src)) ok("control: MatchPanel.tsx was actually read");
  else bad("control: MatchPanel.tsx was actually read", "every check below would pass on an empty string");

  if (/data-testid="mp-end"/.test(src)) ok("the END TIME input is on the panel");
  else bad("the END TIME input is on the panel");
  if (/data-testid="mp-duration"/.test(src)) ok("the derived duration readout is on the panel");
  else bad("the derived duration readout is on the panel");

  /* NEVER GATED. The whole point of the change: Retool WEB blocks this once players have joined,
   * Retool MOBILE does not, and the API sides with mobile. A `disabled` that creeps onto this
   * input would quietly restore the behaviour we removed. */
  const endInput = src.match(/data-testid="mp-end"[^>]*>/)?.[0] ?? "";
  if (endInput && !/disabled/.test(endInput)) ok("END TIME carries no disabled attribute");
  else bad("END TIME carries no disabled attribute", `input tag: ${endInput.slice(0, 120)}`);
  /* POSITIVE CONTROL for the absence above: the SAME extraction, run against a tag that IS
   * disabled, must find it. Without this, a regex that stopped matching the input at all would
   * report "no disabled attribute" and read as a pass. */
  const fake = '<input type="time" data-testid="mp-end" disabled />';
  const fakeTag = fake.match(/data-testid="mp-end"[^>]*>/)?.[0] ?? "";
  if (fakeTag && /disabled/.test(fakeTag)) ok("control: the same check finds a disabled attribute when there is one");
  else bad("control: the same check finds a disabled attribute when there is one", `extracted ${JSON.stringify(fakeTag)}`);

  // The Save must be blocked, on the PATH and not only on the button.
  if (/if \(whenError\([\s\S]{0,120}?\)\) return;/.test(src)) ok("doSave refuses an inverted pair before sending");
  else bad("doSave refuses an inverted pair before sending", "a disabled button is the only guard");
  /* SELECTOR PATH ONLY. The expression gained `|| !!shapeErr` when the team-count control learned
   * to refuse a capacity that does not divide by the team count. The CLAIM is unchanged — the Save
   * control is disabled on a wall-clock error — so this asserts that whenErr is one of the
   * disabling conditions rather than pinning the whole expression, which is what made it brittle. */
  if (/disabled=\{[^}]*!!whenErr[^}]*\}/.test(src)) ok("…and the Save control is disabled too");
  else bad("…and the Save control is disabled too");

  /* NO SECOND COPY OF THE WALL HELPERS. They moved to the lib; a private copy drifting from the
   * tested one is how two surfaces start disagreeing about when a match is. */
  if (!/^function (wallMin|fromWallMin|parseWall|buildWall)\(/m.test(src)) ok("the panel has no private copy of the wall helpers");
  else bad("the panel has no private copy of the wall helpers", "they are tested in the lib, not here");
  if (/from "@\/lib\/matchWhen"/.test(src)) ok("…it imports them from the tested module");
  else bad("…it imports them from the tested module");
}

console.log(`\nmatchwhen: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
