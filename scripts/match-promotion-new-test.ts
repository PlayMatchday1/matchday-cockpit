import "server-only"; // no-op under --conditions=react-server
// MATCH PROMOTION — what counts as NEW, and what does not.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/match-promotion-new-test.ts
//
// WHY A SUITE FOR THIS. The badge is a claim made to marketing, and every way of getting it wrong
// looks exactly like getting it right on screen: a badge is a badge. The two decisions that carry
// the whole rule are invisible in the DOM —
//
//   1. THE PRIOR SLATE INCLUDES CANCELLED MATCHES. Measured on 2026-08-25 across 109 matches,
//      excluding them flagged 31 and 21 of those were slots that had been on the previous slate
//      and were called off. Bicentennial Park read as a NEW FIELD in Dallas having been scheduled
//      the week before. The fixtures below are that exact case.
//   2. THE TESTS NEST PER FIELD. NEMP on a Friday for the first time must flag even though other
//      Austin pitches played Fridays. A city-wide reading loses it, and lost 19 cases when
//      measured.
//
// The dates and venues here are the real ones from that measurement, so a reader can check the
// suite against docs/matchday-api-facts.md rather than against its own fixtures.

import {
  buildPriorSlate, newnessOf, newFlagOf, movedFromTime, priorTimesFor, currentTimesOf,
  NEW_FLAG_LABEL, NEW_FLAG_NOTE, NEW_LOOKBACK_WEEKS, NO_HISTORY,
  coverageCaption, coverageStateOf, coverageSummary,
  type NewFlag, type PromoMatch, type SlotLike, type EverSeen,
} from "../src/lib/matchPromotion";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const yes = (n: string, c: boolean, d = "") => (c ? ok(n) : bad(n, d));
const is = (n: string, got: unknown, want: unknown) =>
  got === want ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// Mon=0 … Sun=6, minutes from midnight — the shape fetchVeoWeek already hands back.
const MON = 0, TUE = 1, WED = 2, THU = 3, FRI = 4, SAT = 5, SUN = 6;
const at = (h: number, m = 0) => h * 60 + m;
const slot = (city: string, venue: string, dayIdx: number, minutes: number): SlotLike =>
  ({ city, venue, dayIdx, minutes });

console.log("\nTHE LABELS ARE THE THREE THE BRIEF NAMES, IN PRECEDENCE ORDER");
{
  is("field → NEW FIELD", NEW_FLAG_LABEL.field, "NEW FIELD");
  is("match → NEW MATCH", NEW_FLAG_LABEL.match, "NEW MATCH");
is("back → RETURNING SLATE", NEW_FLAG_LABEL.back, "RETURNING SLATE");
  is("time → NEW TIME", NEW_FLAG_LABEL.time, "NEW TIME");
  /* FOUR NOW, AND THE FOURTH IS NOT A KIND OF NEW. RETURNING is the opposite claim; it is in
 * this map because it renders as a badge, not because it belongs to the same family. */
is("there are exactly four", Object.keys(NEW_FLAG_LABEL).length, 4);
}

console.log("\nTHE THREE TESTS, NESTED PER FIELD");
{
  const prior = buildPriorSlate([
    slot("Austin", "NEMP", TUE, at(18, 30)),
    slot("Austin", "NEMP", THU, at(18, 30)),
    slot("Austin", "Hattrick", FRI, at(20)),
  ]);
  const n = (m: SlotLike) => newnessOf(m, prior);
  is("the same field, day and time is NOT new", n(slot("Austin", "NEMP", TUE, at(18, 30))), null);
  is("a field the city did not have is NEW FIELD", n(slot("Austin", "Onion Creek", TUE, at(18, 30))), "field");
  is("a known field on a weekday it did not run is NEW MATCH", n(slot("Austin", "NEMP", FRI, at(18, 30))), "match");
  is("a known field-weekday at another time is NEW TIME", n(slot("Austin", "NEMP", TUE, at(19, 30))), "time");
  // PRECEDENCE IS A NESTING. A new field has a new day and a new time by definition; reporting the
  // day would be true and useless.
  is("a new field on a new day at a new time reports FIELD, not DAY", n(slot("Austin", "STAR", SUN, at(21))), "field");
  is("a known field on a new day at a new time reports DAY, not TIME", n(slot("Austin", "NEMP", SAT, at(21))), "match");
}

console.log("\nPER FIELD, NOT PER CITY — the case a city-wide reading loses");
{
  // Austin played Fridays last week, but NOT at NEMP. NEMP on a Friday is new.
  const prior = buildPriorSlate([
    slot("Austin", "Hattrick", FRI, at(20)),
    slot("Austin", "NEMP", TUE, at(18, 30)),
  ]);
  is("NEMP on Friday is NEW MATCH even though Austin played a Friday", newnessOf(slot("Austin", "NEMP", FRI, at(18, 30)), prior), "match");
  is("...and Hattrick on that same Friday is not new at all", newnessOf(slot("Austin", "Hattrick", FRI, at(20)), prior), null);
  // The mirror case for time: 6:30 ran in the city, but not at Hattrick.
  is("Hattrick at 6:30 is NEW TIME even though 6:30 ran in the city", newnessOf(slot("Austin", "Hattrick", FRI, at(18, 30)), prior), "time");
}

console.log("\nA CANCELLED SLOT WAS STILL ON THE SLATE — the Bicentennial Park case");
{
  // Dallas, week of 2026-08-17: Bicentennial Park was SCHEDULED and CANCELLED. buildPriorSlate is
  // fed the slate, so the slot is present — which is the whole decision.
  const played = [slot("Dallas", "Crossbar Rowlett", TUE, at(20)), slot("Dallas", "Lowell H. Strike M.S.", WED, at(19))];
  const cancelledToo = [...played, slot("Dallas", "Bicentennial Park", TUE, at(19))];
  const thisWeek = slot("Dallas", "Bicentennial Park", TUE, at(19));
  is("built from PLAY ONLY, it reads as a new field — the wrong answer",
     newnessOf(thisWeek, buildPriorSlate(played)), "field");
  is("built from the SLATE, it is not new at all", newnessOf(thisWeek, buildPriorSlate(cancelledToo)), null);
  // CONTROL for that null: the slate build is not simply matching everything.
  is("  CONTROL — a genuinely absent field still flags against the same slate",
     newnessOf(slot("Dallas", "Majestic Gardens", TUE, at(19)), buildPriorSlate(cancelledToo)), "field");
}

console.log("\nA CITY WITH NO PRIOR SLATE IS ALL NEW — Warsaw's first week");
{
  const prior = buildPriorSlate([slot("Austin", "NEMP", TUE, at(18, 30))]);
  is("a city absent from the prior slate reports NEW FIELD",
     newnessOf(slot("Warsaw", "Hala Piłkarska Bemowo", MON, at(21, 30)), prior), "field");
  is("an empty slate makes everything a new field", newnessOf(slot("Austin", "NEMP", TUE, at(18, 30)), buildPriorSlate([])), "field");
  is("  CONTROL — the same match against its own slate is NOT new",
     newnessOf(slot("Austin", "NEMP", TUE, at(18, 30)), prior), null);
}

console.log("\nCITIES DO NOT LEAK INTO EACH OTHER");
{
  const prior = buildPriorSlate([slot("Houston", "ATH Katy", MON, at(21, 15))]);
  is("the same venue name in a different city is NEW FIELD there",
     newnessOf(slot("Dallas", "ATH Katy", MON, at(21, 15)), prior), "field");
  is("  CONTROL — in its own city it is not new", newnessOf(slot("Houston", "ATH Katy", MON, at(21, 15)), prior), null);
}

console.log("\nMINUTES ARE CLUSTERED, NOT EXACT — a move inside the window is the SAME slot");
{
  /* ── THIS SECTION REVERSES ITSELF, DELIBERATELY ──────────────────────────────────────────────
   * It read "MINUTES ARE EXACT - a fifteen-minute move is a move", and asserted that 8:00 against a
   * prior 8:30 is NEW TIME. That contract is gone. The CANCEL ROLLUP already treats times inside
   * SLOT_CLUSTER_GAP_MIN as one slot, which is why an 8:00 tile carries the 8:30 cancel history - so
   * the tile was saying "this slot has cancelled N of 4" and "this time is new" at the same moment,
   * and both could not be true. newnessOf now asks the same clusterMinutes the rollup asks.
   *
   * The OLD expected value is left in this comment on purpose: a reader should be able to see what
   * changed rather than find a suite that always said this. */
  const prior = buildPriorSlate([slot("Houston", "ATH Pearland", SAT, at(20, 30))]);
  // The real case: Saturday was 8:30 and is 8:00. Thirty minutes. WAS "time"; is now null.
  is("8:00 against a prior 8:30 is NOT new, being the same slot moved",
     newnessOf(slot("Houston", "ATH Pearland", SAT, at(20)), prior), null);
  is("  and it says so on hover instead of badging",
     priorTimesFor(slot("Houston", "ATH Pearland", SAT, at(20)), prior)?.times.join(","), "20:30");
  is("  CONTROL — 8:30 against 8:30 is not new either, and has nothing to report",
     `${newnessOf(slot("Houston", "ATH Pearland", SAT, at(20, 30)), prior)}/${priorTimesFor(slot("Houston", "ATH Pearland", SAT, at(20, 30)), prior)}`,
     "null/null");
  /* CONTROL: THE WINDOW HAS AN EDGE. A move far enough out is still a new time, or the rule above
   * would be "no time is ever new", which asserts nothing. */
  is("  CONTROL — 6:00 against 8:30, two and a half hours out, IS still NEW TIME",
     newnessOf(slot("Houston", "ATH Pearland", SAT, at(18)), prior), "time");
}

console.log("\nTHE MEASURED WEEK, REPRODUCED — 2026-08-24 against 2026-08-17");
{
  /* The eight slots the live rule flagged on 2026-08-25, with the prior-week context that makes
   * each verdict what it is. Warsaw's three are covered above (no prior slate). If this block ever
   * disagrees with docs/matchday-api-facts.md, one of the two is wrong and both are findable. */
  const prior = buildPriorSlate([
    // Austin NEMP ran Mon/Tue/Thu/Sat last week — never Friday, never Sunday.
    slot("Austin", "NEMP", MON, at(19, 30)), slot("Austin", "NEMP", MON, at(20, 30)),
    slot("Austin", "NEMP", TUE, at(18, 30)), slot("Austin", "NEMP", TUE, at(19, 30)),
    slot("Austin", "NEMP", THU, at(18, 30)), slot("Austin", "NEMP", SAT, at(19, 30)),
    // Houston ATH Pearland ran Saturday at 8:30.
    slot("Houston", "ATH Pearland", SAT, at(20, 30)),
    // San Antonio Soccer Central ran Sunday at 7 and 8, never 9.
    slot("San Antonio", "Soccer Central", SUN, at(19)), slot("San Antonio", "Soccer Central", SUN, at(20)),
  ]);
  const cases: [string, SlotLike, NewFlag | null][] = [
    ["Austin NEMP Fri 6:30", slot("Austin", "NEMP", FRI, at(18, 30)), "match"],
    ["Austin NEMP Fri 7:30", slot("Austin", "NEMP", FRI, at(19, 30)), "match"],
    ["Austin NEMP Fri 8:30", slot("Austin", "NEMP", FRI, at(20, 30)), "match"],
    ["Austin NEMP Sun 6:30", slot("Austin", "NEMP", SUN, at(18, 30)), "match"],
    ["Austin NEMP Sun 7:30", slot("Austin", "NEMP", SUN, at(19, 30)), "match"],
    // REVERSED with the clustered window: 8:00 against a prior 8:30 is thirty minutes, so it is the
    // same slot moved rather than a new time. WAS "time".
    ["Houston ATH Pearland Sat 8:00", slot("Houston", "ATH Pearland", SAT, at(20)), null],
    ["San Antonio Soccer Central Sun 9:00", slot("San Antonio", "Soccer Central", SUN, at(21)), "time"],
    // …and the ones that must stay quiet.
    ["Austin NEMP Tue 6:30 (unchanged)", slot("Austin", "NEMP", TUE, at(18, 30)), null],
    ["Houston ATH Pearland Sat 8:30 (unchanged)", slot("Houston", "ATH Pearland", SAT, at(20, 30)), null],
    ["San Antonio Soccer Central Sun 7:00 (unchanged)", slot("San Antonio", "Soccer Central", SUN, at(19)), null],
  ];
  for (const [label, m, want] of cases) is(label, newnessOf(m, prior), want);
  const flagged = cases.filter(([, m]) => newnessOf(m, prior) !== null).length;
  /* SIX, NOT SEVEN, and the one that dropped out is the ATH Pearland half-hour move. Soccer Central
   * Sun 9:00 against 7:00 is two hours and still flags, which is what keeps this count meaningful. */
  is("six of the ten reproduce as new, four as unchanged", flagged, 6);
}

/* ── COVERAGE ─────────────────────────────────────────────────────────────────────────────────
 * Both weeks have to be asserted here rather than in the browser: match_promotion_plan is empty in
 * production, so a screen check can only ever see the no-plans half. The half that cannot be
 * observed is exactly the half worth pinning. */
console.log("\nCOVERAGE — colour marks the exception, and content carries the distinction");
/* A PUSH IS ITS OWN ROW FROM 0176, so a planned match is a plan carrying one dated push rather
 * than a plan carrying a push_at. The ASSERTIONS below are unchanged — only the shape of the
 * fixture they are handed, which is the thing the migration moved. */
const pm = (city: string, dayIdx: number, pushAt: string | null): PromoMatch =>
  ({ city, dayIdx, venue: "V", minutes: 1140, apiId: 1, state: pushAt ? "planned" : "none",
     plan: pushAt
       ? { matchApiId: 1, comment: null, updatedBy: null, updatedAt: null,
           pushes: [{ id: 1, matchApiId: 1, channel: "wa", pushAt, topic: null,
                      promoCode: null, pushedAt: null, pushedBy: null }] }
       : null } as unknown as PromoMatch);
const days7 = Array.from({ length: 7 }, (_, i) => ({ dow: "x", date: i, iso: `d${i}`, today: false }));
{
  is("a day with no matches is 'none'", coverageStateOf([]), "none");
  is("a day with matches and no push is 'open'", coverageStateOf([pm("Austin", 0, null)]), "open");
  is("one push on the day makes it 'planned'", coverageStateOf([pm("Austin", 0, null), pm("Austin", 0, "2026-08-25T12:00:00Z")]), "planned");
  is("...and a push on its own does too", coverageStateOf([pm("Austin", 0, "2026-08-25T12:00:00Z")]), "planned");
}
{
  // THE WEEK NOBODY HAS STARTED — the live case on 2026-08-25, all 109 matches unplanned.
  const week = { days: days7, matches: [pm("Austin", 0, null), pm("Austin", 0, null), pm("Houston", 3, null)] };
  const s = coverageSummary(week);
  is("no push anywhere → anyPlanned is false", s.anyPlanned, false);
  is("...open days counted per city-day, not per match", s.openDays, 2);
  is("...and the match count is what the banner quotes", s.openMatches, 3);
  is("the caption says it ONCE, with the count", coverageCaption(s), "No pushes planned this week. 3 matches open.");
  is("...and it is singular for one", coverageCaption({ ...s, openMatches: 1 }), "No pushes planned this week. 1 match open.");
}
{
  // A WEEK WITH COVERAGE — now open is the exception and the caption changes shape.
  const week = { days: days7, matches: [
    pm("Austin", 0, "2026-08-25T12:00:00Z"), pm("Austin", 1, null), pm("Houston", 3, null), pm("Houston", 4, null),
  ] };
  const s = coverageSummary(week);
  is("one push anywhere → anyPlanned is true", s.anyPlanned, true);
  is("...covered days counted", s.plannedDays, 1);
  is("...open days counted", s.openDays, 3);
  is("the caption switches shape rather than repeating the banner",
     coverageCaption(s), "1 covered day · 3 days with matches and no push (3 matches).");
  is("  CONTROL — the two captions are not the same sentence",
     coverageCaption(s) === coverageCaption({ ...s, anyPlanned: false }), false);
}
{
  // THE DISTINCTION THIS VIEW EXISTS FOR must not depend on anyPlanned, because the colour does.
  const empty = coverageStateOf([]);
  const open = coverageStateOf([pm("Austin", 0, null)]);
  is("'no matches' and 'matches, no push' stay different states", empty === open, false);
  is("...and neither is 'planned'", empty === "planned" || open === "planned", false);
  // A city with no matches at all contributes nothing rather than reading as open.
  const s = coverageSummary({ days: days7, matches: [] });
  is("an empty week has no open days", s.openDays, 0);
  is("...no covered days", s.plannedDays, 0);
  is("...and reports zero matches open", s.openMatches, 0);
  is("  CONTROL — a non-empty week does report some", coverageSummary({ days: days7, matches: [pm("Austin", 0, null)] }).openMatches, 1);
}

console.log("\nTHE WINDOW IS FOUR WEEKS, AND THESE ARE THE SLOTS THAT PROVE IT");
{
  /* ── WHY THIS SECTION EXISTS ────────────────────────────────────────────────────────────────
   * The window was ONE week, so a slot that ran three weeks, skipped one and came back read NEW MATCH
   * — the single week it was compared against was the one it missed. A wrong badge is worse than no
   * badge, because it is still believed.
   *
   * EVERY SLOT BELOW IS REAL, read off mdapi_matches on 2026-09-26 for the displayed week of
   * 2026-09-21 against the four prior weeks. w1 = Aug 24, w2 = Aug 31, w3 = Sep 7, w4 = Sep 14 — so
   * w4 is "last week" and was the ONLY week the old rule ever compared against. The four fields are
   * carried at their real weekdays and real kick-off times; nothing here is invented, which is what
   * lets a reader check the fixture against the database rather than against itself.
   *
   * THE MEASUREMENT: of 8 NEW MATCH / NEW TIME badges on that week, 4 and 4 were wrong. NEW FIELD had
   * none wrong — fields are the stable one, days and times are what drift. */
  is("the lookback is four weeks", NEW_LOOKBACK_WEEKS, 4);

  const LBJ = "LBJ Early College High School";
  const LOWELL = "Lowell H. Strike Middle School";
  const ROUNDROCK = "Stadium Field at Round Rock M.C.";
  const HATTRICK = "The Hattrick L.";

  const w1 = [ // Aug 24
    slot("Austin", LBJ, FRI, at(19, 30)), slot("Austin", LBJ, MON, at(20)),
    slot("Austin", LBJ, SAT, at(9, 30)), slot("Austin", LBJ, SUN, at(19, 30)),
    slot("Austin", LBJ, TUE, at(20)),
    slot("Dallas", LOWELL, MON, at(20)), slot("Dallas", LOWELL, THU, at(20)),
    slot("Dallas", LOWELL, TUE, at(20)),
    slot("Austin", HATTRICK, SAT, at(20)), slot("Austin", HATTRICK, FRI, at(20)),
  ];
  const w2 = [ // Aug 31
    slot("Austin", LBJ, FRI, at(19, 30)), slot("Austin", LBJ, MON, at(20)),
    slot("Austin", LBJ, SAT, at(9, 30)), slot("Austin", LBJ, SUN, at(19, 15)),
    slot("Austin", LBJ, TUE, at(20)),
    slot("Dallas", LOWELL, FRI, at(20)), slot("Dallas", LOWELL, THU, at(20)),
    slot("Dallas", LOWELL, WED, at(20)),
    slot("Austin", HATTRICK, SAT, at(20)), slot("Austin", HATTRICK, FRI, at(20)),
  ];
  const w3 = [ // Sep 7
    slot("Austin", LBJ, FRI, at(19, 30)), slot("Austin", LBJ, MON, at(20)),
    slot("Austin", LBJ, SAT, at(9, 30)), slot("Austin", LBJ, SUN, at(19)),
    slot("Dallas", LOWELL, MON, at(20)), slot("Dallas", LOWELL, THU, at(20)),
    slot("Dallas", LOWELL, TUE, at(20)),
    slot("Austin", ROUNDROCK, SUN, at(19)),
    slot("Austin", HATTRICK, SAT, at(19)), slot("Austin", HATTRICK, FRI, at(20)),
  ];
  /* LAST WEEK. Not one of the four returning slots is in it — that is the entire bug, as a fixture.
   * Every field IS here on some other day, which is why the old rule produced NEW MATCH and NEW TIME
   * rather than NEW FIELD: it could see the pitch, just not the slot. */
  const w4 = [ // Sep 14
    slot("Austin", LBJ, MON, at(20)), slot("Austin", LBJ, SAT, at(9, 30)),
    slot("Austin", LBJ, SUN, at(19)),
    slot("Dallas", LOWELL, FRI, at(20)), slot("Dallas", LOWELL, THU, at(20)),
    slot("Dallas", LOWELL, WED, at(20)),
    slot("Austin", ROUNDROCK, FRI, at(19)),
    slot("Austin", HATTRICK, SAT, at(19)), slot("Austin", HATTRICK, FRI, at(20)),
  ];

  const fourWeeks = buildPriorSlate([...w1, ...w2, ...w3, ...w4]);
  const lastWeekOnly = buildPriorSlate(w4);

  /* ── THE ASSERTION: A SLOT PRESENT IN ANY OF THE FOUR IS NOT NEW MATCH ──────────────────────── */
  // LBJ TUESDAY 20:00 — ran w1 and w2, two weeks off, back. Ryan's case, exactly.
  is("LBJ Tuesday 20:00, absent from the last two weeks, is NOT new",
     newnessOf(slot("Austin", LBJ, TUE, at(20)), fourWeeks), null);
  // LOWELL MONDAY 20:00 — alternating weeks: w1, w3, back in the displayed week.
  is("Lowell H. Strike Monday 20:00, alternating weeks, is NOT new",
     newnessOf(slot("Dallas", LOWELL, MON, at(20)), fourWeeks), null);
  // ROUND ROCK SUNDAY 19:00 — seen ONCE, three weeks back, and once is enough.
  is("Round Rock Sunday 19:00, seen once three weeks back, is NOT new",
     newnessOf(slot("Austin", ROUNDROCK, SUN, at(19)), fourWeeks), null);
  // HATTRICK SATURDAY 20:00 — ran w1 and w2 at 20:00, moved to 19:00 for w3 and w4, back at 20:00.
  is("The Hattrick L. Saturday 20:00, back after two weeks at 19:00, is NOT new",
     newnessOf(slot("Austin", HATTRICK, SAT, at(20)), fourWeeks), null);

  /* ── THE CASE THIS SUITE GOT WRONG TWICE, AND IT IS THE INTERESTING ONE ─────────────────────
   * LBJ FRIDAY ran at 19:30 in w1, w2 and w3, missed w4, came back at 19:00.
   *
   * ONE WEEK, EXACT MINUTES   NEW MATCH   wrong: the weekday ran three of the four weeks
   * FOUR WEEKS, EXACT MINUTES NEW TIME  what I asserted last commit, and still wrong
   * FOUR WEEKS, CLUSTERED     no badge  the cancel ramp already calls 19:00 and 19:30 one slot
   *
   * The second line is mine. I wrote "the fix does not silence this slot, it tells the truth about
   * it" and the truth was that a thirty-minute move is not a new time to anyone, least of all to a
   * page that was simultaneously showing that slot's 19:30 cancel history. The information is not
   * lost: it moved to the tooltip, which is where it always belonged. */
  is("LBJ Friday 19:00, back after three weeks at 19:30, is NOT new",
     newnessOf(slot("Austin", LBJ, FRI, at(19)), fourWeeks), null);
  is("  and the tooltip carries what the badge used to claim",
     priorTimesFor(slot("Austin", LBJ, FRI, at(19)), fourWeeks)?.times.join(","), "19:30");
  is("  CONTROL — the one-week window still called that same slot NEW MATCH, wrongly",
     newnessOf(slot("Austin", LBJ, FRI, at(19)), lastWeekOnly), "match");

  /* ── THE CONTROL: ABSENT FROM ALL FOUR STILL FLAGS ────────────────────────────────────────
   * Without these, every null above is satisfied by a slate that matches everything — which is what
   * a union across four weeks could quietly become. */
  is("CONTROL: Bob Jones Park Monday, a field absent from all four, is NEW FIELD",
     newnessOf(slot("Dallas", "Bob Jones Park", MON, at(20)), fourWeeks), "field");
  is("  CONTROL: Wheatley Heights, a field in a city absent from all four, is NEW FIELD",
     newnessOf(slot("San Antonio", "Wheatley Heights Sports Complex", WED, at(20, 30)), fourWeeks), "field");
  /* THE CONTROL THAT MATTERS MOST — a KNOWN field on a weekday absent from all four must still read
   * NEW MATCH. If widening the window had made the day test toothless, this is the line that goes red
   * and not one of the nulls above would. LBJ never ran a Wednesday in any of the four weeks. */
  is("  CONTROL: LBJ on a WEDNESDAY, absent from all four, is still NEW MATCH",
     newnessOf(slot("Austin", LBJ, WED, at(20)), fourWeeks), "match");
  is("  CONTROL: Lowell H. Strike on a SATURDAY, absent from all four, is still NEW MATCH",
     newnessOf(slot("Dallas", LOWELL, SAT, at(20)), fourWeeks), "match");
  // AND NEW TIME survives at the innermost level too.
  is("  CONTROL: LBJ Monday at 18:00, a time absent from all four, is still NEW TIME",
     newnessOf(slot("Austin", LBJ, MON, at(18)), fourWeeks), "time");

  /* ── THE OLD WINDOW GETTING IT WRONG ON THE SAME FIXTURES ─────────────────────────────────
   * The regression guard. Narrow the window back to one week and these are the badges that return,
   * so the suite states the wrong answers explicitly rather than only the right ones. */
  is("the ONE-week window called LBJ Tuesday NEW MATCH",
     newnessOf(slot("Austin", LBJ, TUE, at(20)), lastWeekOnly), "match");
  is("  and Lowell H. Strike Monday NEW MATCH",
     newnessOf(slot("Dallas", LOWELL, MON, at(20)), lastWeekOnly), "match");
  is("  and Round Rock Sunday NEW MATCH, a Sunday that had run three weeks back",
     newnessOf(slot("Austin", ROUNDROCK, SUN, at(19)), lastWeekOnly), "match");
  is("  and The Hattrick L. Saturday 20:00 NEW TIME",
     newnessOf(slot("Austin", HATTRICK, SAT, at(20)), lastWeekOnly), "time");
  is("  CONTROL: while a genuinely new field reads the same under either window",
     [newnessOf(slot("Dallas", "Bob Jones Park", MON, at(20)), lastWeekOnly),
      newnessOf(slot("Dallas", "Bob Jones Park", MON, at(20)), fourWeeks)].join(","), "field,field");

  /* ── THE UNION IS A UNION, not last-week-wins. A slot in the OLDEST week alone must count. ──── */
  is("a slot present ONLY in the oldest of the four weeks is not new",
     newnessOf(slot("Austin", LBJ, TUE, at(20)), buildPriorSlate(w1)), null);
  is("  CONTROL: and against that same single week, an absent weekday flags",
     newnessOf(slot("Austin", LBJ, WED, at(20)), buildPriorSlate(w1)), "match");
}

console.log("\n— NEW MATCH or NEW TIME: an addition is not a move —");
{
  /* THE PART THAT IS HARDER THAN IT LOOKS. "Is this time near a prior time" answers NO for both an
   * addition and a move, so it cannot tell them apart. The second question is whether a time the
   * slate held is still being run this week. */
  const prior = buildPriorSlate([
    slot("Austin", "Westlake", TUE, at(18)),   // 6:00 PM, and it is STILL running this week
    slot("Atlanta", "PRUMC", MON, at(18)),     // 6:00 PM, and it is GONE this week
  ]);
  // Westlake keeps 6:00 and gains 7:00 -> nothing dropped -> an addition.
  const westlake = currentTimesOf([slot("Austin", "Westlake", TUE, at(18)), slot("Austin", "Westlake", TUE, at(19))]);
  is("a time ADDED beside one still running is NEW MATCH",
    newFlagOf(slot("Austin", "Westlake", TUE, at(19)), prior, westlake), "match");
  is("  CONTROL: and the 6:00 that stayed is not tagged at all",
    newFlagOf(slot("Austin", "Westlake", TUE, at(18)), prior, westlake), null);
  /* ── A MOVE MEANS OUTSIDE THE SHARED CLUSTER WINDOW, AND THAT IS NOT A DETAIL ───────────────
   * The brief's illustration was PRUMC 6:00 PM -> 6:30 PM. THAT CASE CANNOT REACH THIS TEST, and
   * deliberately: SLOT_CLUSTER_GAP_MIN is 40 minutes and newness imports the SAME window the cancel
   * rollup keys on (see the import block in matchPromotion). A 30-minute shift is ONE SLOT to the
   * ramp, so `timeSeenNear` hits and the slot is not new at all — it gets `shiftedFrom` on the
   * tooltip instead, which is the shipped decision. Restating the window here so 6:30 could badge
   * would let one tile say "this slot cancelled 2 of 4" and "this time is new" at the same moment.
   *
   * So a MOVE is a kick-off that landed outside the window with the old one gone: 6:00 -> 8:00. */
  const prumc = currentTimesOf([slot("Atlanta", "PRUMC", MON, at(20))]);
  is("a time that MOVED outside the cluster window, with the old one gone, is NEW TIME",
    newFlagOf(slot("Atlanta", "PRUMC", MON, at(20)), prior, prumc), "time");
  is("  and the tooltip can name the time it left", movedFromTime(slot("Atlanta", "PRUMC", MON, at(20)), prior, prumc), "18:00");
  const near = currentTimesOf([slot("Atlanta", "PRUMC", MON, at(18, 30))]);
  is("  CONTROL: a 30-minute shift is inside the window, so it is not a move and not new",
    newFlagOf(slot("Atlanta", "PRUMC", MON, at(18, 30)), prior, near), null);
  yes("  …and it reports what it shifted from instead, which is where that information went",
    (priorTimesFor(slot("Atlanta", "PRUMC", MON, at(18, 30)), prior)?.times ?? []).includes("18:00"));
  is("  CONTROL: nothing to name when it was an addition",
    movedFromTime(slot("Austin", "Westlake", TUE, at(19)), prior, westlake), null);
  /* WITHOUT THE CURRENT WEEK THERE IS NO SECOND QUESTION, so the old behaviour stands: a time near
   * no prior time reads as a move. Every caller that does not pass `current` keeps what it had. */
  is("  with no current week supplied it falls back to the old reading",
    newFlagOf(slot("Austin", "Westlake", TUE, at(19)), prior), "time");
  /* A DRIFT INSIDE THE CLUSTER IS NOT A DISAPPEARANCE. 18:00 -> 18:15 is one slot to the cancel
   * ramp, so nothing went away and nothing is new. */
  const drift = currentTimesOf([slot("Atlanta", "PRUMC", MON, at(18, 15))]);
  is("a 15-minute drift is likewise neither an addition nor a move",
    newFlagOf(slot("Atlanta", "PRUMC", MON, at(18, 15)), prior, drift), null);
}

console.log("\n— RETURNING SLATE: not on last week's slate, but on an earlier one (Ryan, 2026-10-05) —");
{
  /* THE RULE CHANGED ON 2026-10-05. It was an interception (fire only where a NEW test fired and the
   * venue-day had ANY history). Now: the SLOT — venue + weekday + time cluster — was not on the
   * immediately prior week's slate but has been on some earlier one, and it beats no-tag too.
   * History is keyed at the time-cluster level, so an added time is still NEW MATCH. */
  const prior = buildPriorSlate([slot("Austin", "NEMP", MON, at(19))]);  // the last 4 weeks
  const lastWeek = prior;                                                 // ...and last week, here the same
  const hist: EverSeen = {
    venues: new Set(["Austin|Stony Point", "Austin|NEMP"]),
    venueDay: new Set(["Austin|Stony Point|2", "Austin|NEMP|0"]),
    venueDayTimes: new Map([["Austin|Stony Point|2", new Set([at(19, 30)])], ["Austin|NEMP|0", new Set([at(19)])]]),
  };
  const stony = slot("Austin", "Stony Point", WED, at(19, 30));
  /* WITHOUT HISTORY THIS READS NEW FIELD — the 4-week slate has never seen Stony Point. Asserting
   * it first is what proves RETURNING fired rather than that no tag happened to apply. */
  is("without history the slot reads NEW FIELD", newnessOf(stony, prior), "field");
  is("  with history (same time cluster) and a last-week slate it reads RETURNING SLATE", newnessOf(stony, prior, hist, new Map(), lastWeek), "back");
  is("  and newFlagOf still reports what was displaced", newFlagOf(stony, prior), "field");

  /* A known field on a weekday the 4-week window never saw, which HAS run that weekday-and-time
   * further back. */
  const nempWed = slot("Austin", "NEMP", WED, at(19));
  is("a venue-day that ran long ago reads NEW MATCH without history", newnessOf(nempWed, prior), "match");
  const histWed: EverSeen = { ...hist, venueDay: new Set([...hist.venueDay, "Austin|NEMP|2"]),
    venueDayTimes: new Map([...hist.venueDayTimes, ["Austin|NEMP|2", new Set([at(19)])]]) };
  is("  and RETURNING SLATE with it", newnessOf(nempWed, prior, histWed, new Map(), lastWeek), "back");

  // A slot that WAS on last week's slate is untagged, history or not.
  is("a slot on last week's slate stays untagged even though it has history",
    newnessOf(slot("Austin", "NEMP", MON, at(19)), prior, hist, new Map(), lastWeek), null);
  // A move to a time NEVER run before is still NEW TIME: the new time's cluster has no history.
  const cur = currentTimesOf([slot("Austin", "NEMP", MON, at(20))]);
  is("a move to a never-run time is still NEW TIME, not RETURNING", newnessOf(slot("Austin", "NEMP", MON, at(20)), prior, hist, cur, lastWeek), "time");
  is("  CONTROL: the venue-day IS in history, so it is the time cluster that decided",
    hist.venueDay.has("Austin|NEMP|0"), true);
  // A genuinely new field keeps its badge.
  is("a field nothing has ever run is still NEW FIELD",
    newnessOf(slot("Austin", "Brand New Pitch", FRI, at(19)), prior, hist, new Map(), lastWeek), "field");
  is("  CONTROL: NO_HISTORY changes nothing for it", newnessOf(slot("Austin", "Brand New Pitch", FRI, at(19)), prior, NO_HISTORY), "field");
  // Without a last-week slate RETURNING never fires (callers that do not have one keep the NEW tags).
  // (It reads NEW MATCH, not NEW FIELD: the venue is in history, so the venue is not new.)
  is("  CONTROL: history alone, no last-week slate, does not fire RETURNING", newnessOf(stony, prior, hist), "match");
}

console.log("\n— RETURNING beats no-tag: the week of Oct 5 —");
{
  /* Ryan's examples. Four weeks Sep 7 .. Sep 28; Austin LBJ Mon/Tue/Wed 20:00 and Dallas Lowell H.
   * Strike Thu/Fri 20:00 ran in earlier weeks, were ABSENT from the Sep 28 week, and are back on
   * Oct 5. They are inside the four-week window, so the NEW tests say nothing — the old rule left
   * them untagged. The new rule reads RETURNING. */
  const LBJ = "LBJ Early College High School", LOWELL = "Lowell H. Strike Middle School";
  const sep7 = [slot("Austin", LBJ, MON, at(20)), slot("Austin", LBJ, TUE, at(20)), slot("Austin", LBJ, WED, at(20)),
    slot("Dallas", LOWELL, THU, at(20)), slot("Dallas", LOWELL, FRI, at(20))];
  const sep14 = sep7, sep21 = sep7;
  const sep28 = [slot("Austin", LBJ, SAT, at(9, 30)), slot("Dallas", LOWELL, MON, at(20))];  // the five slots absent
  const four = buildPriorSlate([...sep7, ...sep14, ...sep21, ...sep28]);
  const last = buildPriorSlate(sep28);
  const histOf = (rows: SlotLike[]): EverSeen => {
    const h: EverSeen = { venues: new Set(), venueDay: new Set(), venueDayTimes: new Map() };
    for (const r of rows) {
      h.venues.add(`${r.city}|${r.venue}`); h.venueDay.add(`${r.city}|${r.venue}|${r.dayIdx}`);
      const k = `${r.city}|${r.venue}|${r.dayIdx}`; (h.venueDayTimes.get(k) ?? h.venueDayTimes.set(k, new Set()).get(k)!).add(r.minutes);
    }
    return h;
  };
  const hist = histOf([...sep7, ...sep14, ...sep21, ...sep28]);
  for (const [city, venue, d, label] of [["Austin", LBJ, MON, "LBJ Mon"], ["Austin", LBJ, TUE, "LBJ Tue"], ["Austin", LBJ, WED, "LBJ Wed"],
    ["Dallas", LOWELL, THU, "Lowell Thu"], ["Dallas", LOWELL, FRI, "Lowell Fri"]] as const) {
    const m = slot(city, venue, d, at(20));
    is(`${label} 8pm, absent from the Sep 28 week, reads RETURNING SLATE`, newnessOf(m, four, hist, new Map(), last), "back");
    is(`  CONTROL: ${label} 8pm had no NEW tag to displace (inside the 4-week window)`, newFlagOf(m, four), null);
  }
  is("CONTROL: Lowell Mon 8pm, ON the Sep 28 slate, stays untagged", newnessOf(slot("Dallas", LOWELL, MON, at(20)), four, hist, new Map(), last), null);
  /* CANCELLED COUNTS AS ON THE SLATE. A Sep 28 match that was cancelled is still in `last` (the
   * week is fetched with cancelled included), so it cannot read RETURNING. */
  const lastWithCancelled = buildPriorSlate([...sep28, slot("Austin", LBJ, MON, at(20))]);
  is("CONTROL: LBJ Mon 8pm cancelled on Sep 28 is still on the slate, so no RETURNING",
    newnessOf(slot("Austin", LBJ, MON, at(20)), four, hist, new Map(), lastWithCancelled), null);
}

console.log("\n— an added time is NEW MATCH, not RETURNING: OKC Scissortail Tue 9pm —");
{
  /* THE INTERCEPTION BUG. History keyed only on venue|day matched Tue 9pm against the Tuesday 8pm
   * that ran last week and relabelled the addition RETURNING. Keyed at the time cluster, 9pm has no
   * history (60 minutes from 8pm is past SLOT_CLUSTER_GAP_MIN), so it stays NEW MATCH. */
  const SCI = "Scissortail Park";
  const lastWeek = buildPriorSlate([slot("Oklahoma City", SCI, TUE, at(20))]);
  const four = lastWeek;
  const hist: EverSeen = { venues: new Set([`Oklahoma City|${SCI}`]), venueDay: new Set([`Oklahoma City|${SCI}|${TUE}`]),
    venueDayTimes: new Map([[`Oklahoma City|${SCI}|${TUE}`, new Set([at(20)])]]) };
  const cur = currentTimesOf([slot("Oklahoma City", SCI, TUE, at(20)), slot("Oklahoma City", SCI, TUE, at(21))]);
  is("OKC Scissortail Tue 9pm, added beside 8pm, reads NEW MATCH", newnessOf(slot("Oklahoma City", SCI, TUE, at(21)), four, hist, cur, lastWeek), "match");
  is("  CONTROL: and Tue 8pm, which ran last week, is untagged", newnessOf(slot("Oklahoma City", SCI, TUE, at(20)), four, hist, cur, lastWeek), null);
  /* AND THE OLD KEYING WOULD HAVE GOT IT WRONG: with history at venue|day only — a 9pm "time" that
   * sits in the 8pm's day — the slot would have matched. Shown by putting 9pm into history. */
  const histWith9: EverSeen = { ...hist, venueDayTimes: new Map([[`Oklahoma City|${SCI}|${TUE}`, new Set([at(20), at(21)])]]) };
  is("  CONTROL: if 9pm HAD run before (and not last week), it would read RETURNING", newnessOf(slot("Oklahoma City", SCI, TUE, at(21)), four, histWith9, cur, lastWeek), "back");
}

console.log("\n— a venue that ran before is not a NEW FIELD —");
{
  const prior = buildPriorSlate([slot("Austin", "NEMP", MON, at(19))]);
  const hist: EverSeen = { venues: new Set(["Austin|Stony Point"]), venueDay: new Set(["Austin|Stony Point|2"]),
    venueDayTimes: new Map([["Austin|Stony Point|2", new Set([at(19, 30)])]]) };
  // Stony Point ran Wednesdays long ago; a FRIDAY slot there has never run. Known venue, new slot.
  is("Stony Point on a never-run Friday reads NEW MATCH, not NEW FIELD",
    newnessOf(slot("Austin", "Stony Point", FRI, at(19)), prior, hist, new Map(), prior), "match");
  is("  CONTROL: without history it reads NEW FIELD", newnessOf(slot("Austin", "Stony Point", FRI, at(19)), prior), "field");
}

console.log("\n— the four labels, and the one that is not a kind of new —");
{
  is("back → RETURNING SLATE", NEW_FLAG_LABEL.back, "RETURNING SLATE");
  is("field → NEW FIELD", NEW_FLAG_LABEL.field, "NEW FIELD");
  is("match → NEW MATCH", NEW_FLAG_LABEL.match, "NEW MATCH");
  is("time → NEW TIME", NEW_FLAG_LABEL.time, "NEW TIME");
  yes("every tag carries a one-line note for the key",
    (["back", "field", "match", "time"] as NewFlag[]).every((k) => (NEW_FLAG_NOTE[k] ?? "").length > 10));
  yes("  and RETURNING's note says it is NOT new, which is the whole distinction",
    /not new/i.test(NEW_FLAG_NOTE.back));
  yes("  CONTROL: while the three that mean new do not say that", 
    !["field", "match", "time"].some((k) => /not new/i.test(NEW_FLAG_NOTE[k as NewFlag])));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
