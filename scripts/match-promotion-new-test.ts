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
  buildPriorSlate, newnessOf, NEW_FLAG_LABEL,
  type NewFlag, type SlotLike,
} from "../src/lib/matchPromotion";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
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
  is("day → NEW DAY", NEW_FLAG_LABEL.day, "NEW DAY");
  is("time → NEW TIME", NEW_FLAG_LABEL.time, "NEW TIME");
  is("there are exactly three", Object.keys(NEW_FLAG_LABEL).length, 3);
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
  is("a known field on a weekday it did not run is NEW DAY", n(slot("Austin", "NEMP", FRI, at(18, 30))), "day");
  is("a known field-weekday at another time is NEW TIME", n(slot("Austin", "NEMP", TUE, at(19, 30))), "time");
  // PRECEDENCE IS A NESTING. A new field has a new day and a new time by definition; reporting the
  // day would be true and useless.
  is("a new field on a new day at a new time reports FIELD, not DAY", n(slot("Austin", "STAR", SUN, at(21))), "field");
  is("a known field on a new day at a new time reports DAY, not TIME", n(slot("Austin", "NEMP", SAT, at(21))), "day");
}

console.log("\nPER FIELD, NOT PER CITY — the case a city-wide reading loses");
{
  // Austin played Fridays last week, but NOT at NEMP. NEMP on a Friday is new.
  const prior = buildPriorSlate([
    slot("Austin", "Hattrick", FRI, at(20)),
    slot("Austin", "NEMP", TUE, at(18, 30)),
  ]);
  is("NEMP on Friday is NEW DAY even though Austin played a Friday", newnessOf(slot("Austin", "NEMP", FRI, at(18, 30)), prior), "day");
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

console.log("\nMINUTES ARE EXACT — a fifteen-minute move is a move");
{
  const prior = buildPriorSlate([slot("Houston", "ATH Pearland", SAT, at(20, 30))]);
  // The real case: Saturday was 8:30 last week and is 8:00 this week.
  is("8:00 against a prior 8:30 is NEW TIME", newnessOf(slot("Houston", "ATH Pearland", SAT, at(20)), prior), "time");
  is("  CONTROL — 8:30 against 8:30 is not new", newnessOf(slot("Houston", "ATH Pearland", SAT, at(20, 30)), prior), null);
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
    ["Austin NEMP Fri 6:30", slot("Austin", "NEMP", FRI, at(18, 30)), "day"],
    ["Austin NEMP Fri 7:30", slot("Austin", "NEMP", FRI, at(19, 30)), "day"],
    ["Austin NEMP Fri 8:30", slot("Austin", "NEMP", FRI, at(20, 30)), "day"],
    ["Austin NEMP Sun 6:30", slot("Austin", "NEMP", SUN, at(18, 30)), "day"],
    ["Austin NEMP Sun 7:30", slot("Austin", "NEMP", SUN, at(19, 30)), "day"],
    ["Houston ATH Pearland Sat 8:00", slot("Houston", "ATH Pearland", SAT, at(20)), "time"],
    ["San Antonio Soccer Central Sun 9:00", slot("San Antonio", "Soccer Central", SUN, at(21)), "time"],
    // …and the ones that must stay quiet.
    ["Austin NEMP Tue 6:30 (unchanged)", slot("Austin", "NEMP", TUE, at(18, 30)), null],
    ["Houston ATH Pearland Sat 8:30 (unchanged)", slot("Houston", "ATH Pearland", SAT, at(20, 30)), null],
    ["San Antonio Soccer Central Sun 7:00 (unchanged)", slot("San Antonio", "Soccer Central", SUN, at(19)), null],
  ];
  for (const [label, m, want] of cases) is(label, newnessOf(m, prior), want);
  const flagged = cases.filter(([, m]) => newnessOf(m, prior) !== null).length;
  is("seven of the ten reproduce as new, three as unchanged", flagged, 7);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
