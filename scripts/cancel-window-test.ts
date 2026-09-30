/* THE CANCEL WINDOW, AND WHAT THE CANCEL TAB LEFT BEHIND.
 *
 * TWO CHANGES, ONE SUITE.
 *
 * ONE — THE WINDOW FOLLOWED TODAY, NOT THE WEEK ON SCREEN. cancelPatterns anchors on the last four
 * FULLY COMPLETED weeks relative to a date, and that date was `new Date()`. Stepping back a week
 * left the window where it was, so a slot's own cancellation in the week being viewed counted
 * toward its own chip, and the chip stopped meaning anything you could state in one sentence. It
 * now anchors on the displayed week's MONDAY, which makes it "the four weeks before the week you
 * are looking at" at every step.
 *
 * TWO — THE CANCEL SECTION IS GONE and the history lives on the tiles. What must not go with it is
 * the SCALE (the tiles read it) and getCancelPatterns (the cities lens reads it). Pinned below.
 */
import { getCancelPatterns, rollUpSlotRisk, type CancelPatternsResult } from "@/lib/cancelPatterns";
import { mostRecentCompletedWeekMonday } from "@/lib/weekWindow";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const yes = (n: string, c: boolean, d = "") => (c ? ok(n) : bad(n, d));

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** The window a given displayed week resolves to, expressed as its two ends. */
const windowFor = (weekStart: string) => {
  const [y, m, d] = weekStart.split("-").map(Number);
  const newest = mostRecentCompletedWeekMonday(new Date(y, m - 1, d));
  return {
    from: ymd(new Date(newest.getFullYear(), newest.getMonth(), newest.getDate() - 21)),
    to: ymd(new Date(newest.getFullYear(), newest.getMonth(), newest.getDate() + 6)),
  };
};

console.log("\n— the window is the four weeks BEFORE the week on screen —");
{
  is("viewing 21 Sep, the window ends the day before it", windowFor("2026-09-21"), { from: "2026-08-24", to: "2026-09-20" });
  is("stepping back a week steps the window back", windowFor("2026-09-14"), { from: "2026-08-17", to: "2026-09-13" });
  is("  and again", windowFor("2026-09-07"), { from: "2026-08-10", to: "2026-09-06" });
  /* THE PROPERTY THAT MATTERS, stated once rather than per week: the window ENDS the day before
   * the displayed week begins, always. A chip can then only ever describe what came before. */
  for (const w of ["2026-01-05", "2026-06-01", "2026-09-21", "2026-11-02", "2026-12-28"]) {
    const { to } = windowFor(w);
    const [y, m, d] = w.split("-").map(Number);
    const dayBefore = ymd(new Date(y, m - 1, d - 1));
    if (to === dayBefore) ok(`  ${w}: the window ends ${to}, the day before the week starts`);
    else bad(`${w}: the window ends the day before the week starts`, `ends ${to}, wanted ${dayBefore}`);
  }
  /* AND IT IS EXACTLY FOUR WEEKS WIDE. 27 days inclusive between the two ends. */
  const { from, to } = windowFor("2026-09-21");
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  is("the window is four weeks wide", days, 28);
  /* NO LENIENT-SUNDAY BRANCH CAN FIRE. mostRecentCompletedWeekMonday treats Sunday specially — on
   * a Sunday it counts the just-finishing week as complete — and a Monday is never a Sunday. So
   * anchoring on the displayed week's Monday makes the anchor a pure function of that week, with
   * no branch that depends on which day the operator happens to open the page.
   *
   * A FIRST DRAFT OF THIS ASSERTED THAT A SUNDAY AND THE MONDAY AFTER IT DISAGREE. They do not:
   * getMonday(Sun 20 Sep) is 14 Sep and Mon 21 Sep minus seven is also 14 Sep, so both land on the
   * same anchor by different routes. The property worth pinning is determinism, not disagreement. */
  for (const m of ["2026-09-21", "2026-09-14", "2026-03-02", "2026-11-02"]) {
    const [y, mo, d] = m.split("-").map(Number);
    const anchor = new Date(y, mo - 1, d);
    const want = ymd(new Date(y, mo - 1, d - 7));
    if (ymd(mostRecentCompletedWeekMonday(anchor)) === want) ok(`  a Monday anchor is simply that Monday minus seven (${m} -> ${want})`);
    else bad(`a Monday anchor is that Monday minus seven (${m})`, `got ${ymd(mostRecentCompletedWeekMonday(anchor))} want ${want}`);
  }
  /* CONTROL: the lenient branch IS real, so "it cannot fire" is a claim about the anchor rather
   * than about a branch that does nothing. A Saturday and the Sunday after it disagree. */
  yes("  CONTROL: the Sunday branch is real — Sat 19 Sep and Sun 20 Sep resolve differently",
    ymd(mostRecentCompletedWeekMonday(new Date(2026, 8, 19))) !== ymd(mostRecentCompletedWeekMonday(new Date(2026, 8, 20))));
}

console.log("\n— stepping back changes what a slot's chip says —");
{
  /* A SLOT THAT CANCELLED ONLY IN AUGUST reads 1/4 from a September week and nothing from an
   * October one, because the window has moved past it. Built from fixtures so the assertion does
   * not depend on production drifting. */
  const at = (iso: string) => new Date(iso);
  const row = (dateIso: string, cancelled: boolean) => ({
    city: "ATX", field: "Keswick Park", matchStart: at(dateIso), matchCanceled: cancelled,
    playerCanceledAt: null, paymentType: null, promocode: null, email: null,
  });
  const rows = [
    row("2026-08-31T20:00:00", true),    // a Monday in August
    row("2026-09-07T20:00:00", false),
    row("2026-09-14T20:00:00", false),
    row("2026-09-21T20:00:00", false),
  ] as never[];
  const aliases = new Map<string, string>();
  const chipAt = (weekStart: string) => {
    const [y, m, d] = weekStart.split("-").map(Number);
    const res = getCancelPatterns(rows, aliases, "patterns", new Date(y, m - 1, d));
    const risk = rollUpSlotRisk(res);
    const hit = [...risk.entries()].find(([k]) => k.startsWith("Keswick Park|0"));
    return hit ? hit[1].cancelCount : 0;
  };
  const sept = chipAt("2026-09-21"), octo = chipAt("2026-10-12");
  is("viewing 21 Sep, the August cancellation is inside the window", sept, 1);
  is("viewing 12 Oct, it has fallen out of it", octo, 0);
  yes("  CONTROL: the two weeks genuinely disagree, which is the point", sept !== octo);
  /* CONTROL: the fixture's cancellation is real, or both readings would be 0 for free. */
  const always = getCancelPatterns(rows, aliases, "patterns", new Date(2026, 8, 21));
  yes("  CONTROL: the fixture holds a cancellation at all",
    always.weeks.some((w) => w.byDay.some((d) => d.length > 0)));
}

console.log("\n— HOW LONG AGO, and the index-to-label mapping is asserted, not reasoned about —");
{
  /* ── WHICH WEEK IS INDEX 0 DEPENDS ON THE MODE, AND GETTING IT WRONG IS ONE WEEK OFF ────────
   * getCancelPatterns anchors on mostRecentCompletedWeekMonday in "patterns" and getMonday in
   * "live", so index 0 is the week BEFORE the anchor in one and the anchor's own week in the other.
   * Match Promotion passes "patterns" with the DISPLAYED week's Monday, so index 0 must be the week
   * immediately before the one on screen — "1W AGO". That is a fact about two helpers meeting, and
   * the only honest way to hold it is a dated fixture with one cancellation in a known week. */
  const at = (iso: string) => new Date(iso);
  const row = (dateIso: string, cancelled: boolean) => ({
    city: "ATX", field: "Keswick Park", matchStart: at(dateIso), matchCanceled: cancelled,
    playerCanceledAt: null, paymentType: null, promocode: null, email: null,
  });
  const aliases = new Map<string, string>();
  // Viewing the week of Mon 28 Sep 2026. The four weeks behind it are 21, 14, 7 Sep and 31 Aug.
  const view = new Date(2026, 8, 28);
  const agoFor = (cancelledOn: string) => {
    const rows = [row(cancelledOn, true)] as never[];
    const risk = rollUpSlotRisk(getCancelPatterns(rows, aliases, "patterns", view));
    const hit = [...risk.entries()].find(([k]) => k.startsWith("Keswick Park|0"));
    return hit ? hit[1].lastCancelWeeksAgo : null;
  };
  is("a cancellation in the week before the one on screen reads 1W AGO", agoFor("2026-09-21T20:00:00"), 1);
  is("  two weeks before reads 2W AGO", agoFor("2026-09-14T20:00:00"), 2);
  is("  three weeks before reads 3W AGO", agoFor("2026-09-07T20:00:00"), 3);
  is("  four weeks before reads 4W AGO", agoFor("2026-08-31T20:00:00"), 4);
  /* NOTHING OLDER IS MARKED, because nothing older is in the window at all — the slot does not
   * appear in the rollup, so there is no marker rather than a 5W one. */
  is("  and five weeks before is outside the window entirely", agoFor("2026-08-24T20:00:00"), null);
  /* CONTROL: the four readings are genuinely different, or a constant would pass all of them. */
  yes("  CONTROL: the four ages are four different numbers",
    new Set([agoFor("2026-09-21T20:00:00"), agoFor("2026-09-14T20:00:00"),
             agoFor("2026-09-07T20:00:00"), agoFor("2026-08-31T20:00:00")]).size === 4);

  /* ── THE PAIR THIS FEATURE EXISTS FOR ────────────────────────────────────────────────────────
   * Two slots with the SAME ratio and opposite decisions. Under the shipped tile they are the same
   * chip; the only thing that can separate them is when they last cancelled. */
  const pair = [
    // Recent: cancelled 21 Sep and 14 Sep -> 2/4, last one week ago.
    row("2026-09-21T20:00:00", true), row("2026-09-14T20:00:00", true),
    row("2026-09-07T20:00:00", false), row("2026-08-31T20:00:00", false),
    // Stale: cancelled 7 Sep and 31 Aug -> 2/4, last three weeks ago. A different field, same day.
    { ...row("2026-09-07T21:00:00", true), field: "Hattrick" },
    { ...row("2026-08-31T21:00:00", true), field: "Hattrick" },
    { ...row("2026-09-21T21:00:00", false), field: "Hattrick" },
    { ...row("2026-09-14T21:00:00", false), field: "Hattrick" },
  ] as never[];
  const risk = rollUpSlotRisk(getCancelPatterns(pair, aliases, "patterns", view));
  const one = [...risk.entries()].find(([k]) => k.startsWith("Keswick Park|0"))?.[1];
  const two = [...risk.entries()].find(([k]) => k.startsWith("Hattrick|0"))?.[1];
  yes("both slots of the pair are in the rollup", one != null && two != null);
  is("  they carry the SAME ratio, so the chip cannot tell them apart", one?.cancelCount, two?.cancelCount);
  is("  the recent one last cancelled 1 week ago", one?.lastCancelWeeksAgo, 1);
  is("  the stale one last cancelled 3 weeks ago", two?.lastCancelWeeksAgo, 3);
  yes("  CONTROL: which is the whole point — same ratio, different age",
    one?.cancelCount === two?.cancelCount && one?.lastCancelWeeksAgo !== two?.lastCancelWeeksAgo);

  /* THE MOST RECENT WINS WHEN TWO TIMES MERGE INTO ONE CLUSTER. They are the same slot seen either
   * side of a move, so the older of the pair is not an answer to "when did this slot last cancel". */
  const merged = [
    row("2026-09-21T20:00:00", true),   // 20:00, one week ago
    row("2026-09-07T20:20:00", true),   // 20:20 — inside the 40-minute cluster, three weeks ago
  ] as never[];
  const m = rollUpSlotRisk(getCancelPatterns(merged, aliases, "patterns", view));
  const only = [...m.values()][0];
  is("  a merged cluster reports the MOST RECENT of its times", only?.lastCancelWeeksAgo, 1);
  yes("  CONTROL: and the two really did merge into one slot", m.size === 1);
}

console.log("\n— what the cancel section was not allowed to take with it —");
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const view = strip(readFileSync("src/components/MatchPromotionView.tsx", "utf8"));
  const mob = strip(readFileSync("src/components/MatchPromotionMobile.tsx", "utf8"));
  // POSITIVE CONTROL FIRST: the files were read and still hold code, or every absence below is free.
  yes("control: the view was read", /export default function MatchPromotionView|function MatchPromotionView/.test(view) || view.length > 5000);
  yes("control: the phone view was read", /export default function MatchPromotionMobile/.test(mob));

  yes("the cancel grid is gone", !/function CancelGrid/.test(view));
  yes("  and so is the hook that fed it", !/function useCancelRanking/.test(view));
  yes("  and the phone's ranking block", !/function Ranking\(/.test(mob));
  /* THE SCALE SURVIVES, IN THE CONSTANTS THE TILES OWN. TIER was a second encoding of exactly
   * these four pairs for the grid's pills; the pairs themselves are what must not be lost. */
  for (const hex of ["#F4C430", "#E8862A", "#D9452F", "#8F2A17"]) {
    if (view.includes(hex)) ok(`  the ramp keeps ${hex}`);
    else bad(`the ramp keeps ${hex}`, "A TILE COLOUR WENT WITH THE GRID");
  }
  for (const ink of ["#3A2A00", "#2E1B00"]) {
    if (view.includes(ink)) ok(`  and its ink ${ink}`);
    else bad(`the ramp keeps its ink ${ink}`, "");
  }
  yes("  the tiles read them through RAMP_HEX and RAMP_INK", /RAMP_HEX/.test(view) && /RAMP_INK/.test(view));
  /* THE PHONE KEEPS THE SAME FOUR, so one metric cannot grow two scales across two surfaces. */
  yes("the phone row keeps the same four colours",
    ["#F4C430", "#E8862A", "#D9452F", "#8F2A17"].every((h) => mob.includes(h)));

  /* getCancelPatterns ITSELF IS UNTOUCHED, and so is the cities card that reads it. */
  const lib = readFileSync("src/lib/cancelPatterns.ts", "utf8");
  yes("getCancelPatterns still exists", /export function getCancelPatterns/.test(lib));
  yes("  and still defaults its anchor to today for every other caller",
    /now: Date = new Date\(\)/.test(lib));
  const card = readFileSync("src/components/CancelPatterns.tsx", "utf8");
  yes("the cities cancellations card still reads it", /getCancelPatterns/.test(card));
  yes("  and still renders the STREAK, which the tile chip does not carry", /\bstreak\b/.test(card));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
