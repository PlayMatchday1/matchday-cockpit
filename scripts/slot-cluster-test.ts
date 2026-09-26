/* THE SLOT KEY THE TILE COLOUR IS BUILT ON.
 *
 * cancelPatterns keys a slot on (canonical_field, day_of_week, time_of_day), so a slate time that
 * moves by half an hour orphans its own history and a chronically cancelled slot renders clean.
 * The first proposal was to drop time entirely. MEASURED over the four-week window the function
 * itself uses (2026-08-24 to 2026-09-21, 429 matches), that is worse than the problem:
 *
 *     15 min    2 pairs    a slot that DRIFTED
 *     30 min    3 pairs    a slot that DRIFTED
 *     60 min   18 pairs    BACK-TO-BACK matches
 *    120 min    9 pairs    BACK-TO-BACK matches
 *
 * 5 of 32 are drift; 27 are different matches on one evening. So times are CLUSTERED, not dropped,
 * and the two real shapes in that data are what this suite pins.
 */
import {
  SLOT_CLUSTER_GAP_MIN, SLOT_CLUSTER_SPAN_MIN, clusterMinutes, slotRiskKey, rollUpSlotRisk,
  type CancelPatternsResult, type CancelSlot,
} from "@/lib/cancelPatterns";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const yes = (n: string, c: boolean, d = "") => (c ? ok(n) : bad(n, d));

const hm = (h: number, m = 0) => h * 60 + m;

console.log("\n— the two shapes that actually exist in the data —");
{
  /* THE CASES RYAN NAMED. These are the ones that matter: if either merges, the colour reports one
   * slot dying where three died, and the whole feature is misinformation. */
  is("Soccer Central Friday 19:00 / 20:00 / 21:00 stays THREE slots",
    clusterMinutes([hm(19), hm(20), hm(21)]).length, 3);
  is("NEMP 18:30 / 19:30 / 20:30 stays THREE slots",
    clusterMinutes([hm(18, 30), hm(19, 30), hm(20, 30)]).length, 3);
  /* AND THE DRIFT CASES IT IS MEANT TO RESCUE, from the same window. */
  is("KISC Friday 20:00 / 20:30 is ONE slot that moved", clusterMinutes([hm(20), hm(20, 30)]).length, 1);
  is("Round Rock Friday 19:00 / 19:15 is ONE slot", clusterMinutes([hm(19), hm(19, 15)]).length, 1);
  is("LBJ Sunday 19:00 / 19:15 / 19:30 is ONE slot across three points",
    clusterMinutes([hm(19), hm(19, 15), hm(19, 30)]).length, 1);
  is("Crockett Tuesday 18:45 / 19:00 is ONE slot", clusterMinutes([hm(18, 45), hm(19)]).length, 1);
  /* STAR TUESDAY IS THE CLINCHER. It cancelled at BOTH 19:30 and 20:30 inside the window. Two
   * slots dying, not one dying twice as hard, so they must not merge. */
  is("STAR Tuesday 19:30 / 20:30 stays TWO slots", clusterMinutes([hm(19, 30), hm(20, 30)]).length, 2);
}

console.log("\n— the span cap, which is not the gap rule —");
{
  /* SINGLE-LINK CLUSTERING CHAINS. 19:00, 19:35, 20:10 is two 35-minute steps, each inside the
   * 40-minute gap, and a gap rule alone merges all three into a 70-minute group — reproducing the
   * back-to-back merge the gap rule exists to prevent. */
  const chain = clusterMinutes([hm(19), hm(19, 35), hm(20, 10)]);
  is("19:00 / 19:35 / 20:10 does NOT chain into one group", chain.length, 2);
  is("  the first two merge, the third starts over", chain.map((g) => g.length), [2, 1]);
  /* CONTROL: every step in that chain IS inside the gap, so it is the SPAN doing the work here
   * and not the gap. Without this control the assertion above would pass on a gap of 30. */
  yes("  CONTROL: both steps are inside the gap, so the span is what split it",
    hm(19, 35) - hm(19) <= SLOT_CLUSTER_GAP_MIN && hm(20, 10) - hm(19, 35) <= SLOT_CLUSTER_GAP_MIN);
  yes("  CONTROL: and the full width exceeds the span", hm(20, 10) - hm(19) > SLOT_CLUSTER_SPAN_MIN);
  /* THE WIDEST OBSERVED DRIFT STILL FITS. LBJ's three points span 30, well inside 45. */
  yes("the widest drift actually observed (30 min) is still inside the span", 30 <= SLOT_CLUSTER_SPAN_MIN);
  /* AND THE NARROWEST OBSERVED BACK-TO-BACK IS STILL REFUSED. */
  yes("the narrowest back-to-back actually observed (60 min) is outside the gap", 60 > SLOT_CLUSTER_GAP_MIN);
}

console.log("\n— the hole in the distribution the constants sit in —");
{
  /* FORTY IS NOT A TUNING PARAMETER. It sits in a gap in the measured data: drift stops at 30 and
   * back-to-back starts at 60. These assert the constants stay inside that hole, so moving either
   * one out of it fails here rather than silently changing which slots merge. */
  yes(`the gap is above the widest drift (30) and below the narrowest back-to-back (60): ${SLOT_CLUSTER_GAP_MIN}`,
    SLOT_CLUSTER_GAP_MIN > 30 && SLOT_CLUSTER_GAP_MIN < 60);
  yes(`the span is above the widest drift (30) and below the narrowest chain it must refuse (70): ${SLOT_CLUSTER_SPAN_MIN}`,
    SLOT_CLUSTER_SPAN_MIN >= 30 && SLOT_CLUSTER_SPAN_MIN < 70);
  /* A 45-MINUTE PAIR IS OUTSIDE THE EVIDENCE. Asserted so the behaviour is at least DEFINED and
   * anyone who meets one finds this note rather than guessing. With a 40-minute gap it splits. */
  is("a 45-minute pair, which the data has never shown, splits", clusterMinutes([hm(19), hm(19, 45)]).length, 2);
}

console.log("\n— degenerate inputs —");
{
  is("no times is no clusters", clusterMinutes([]), []);
  is("one time is one cluster", clusterMinutes([hm(20)]), [[hm(20)]]);
  is("a repeated time collapses", clusterMinutes([hm(20), hm(20), hm(20)]), [[hm(20)]]);
  is("unsorted input sorts first", clusterMinutes([hm(21), hm(19), hm(20)]).map((g) => g[0]), [hm(19), hm(20), hm(21)]);
}

console.log("\n— the key every time in a cluster resolves to —");
{
  const clusters = clusterMinutes([hm(20), hm(20, 30)]);
  is("both halves of a moved slot key the same",
    [slotRiskKey("KISC", 4, hm(20), clusters), slotRiskKey("KISC", 4, hm(20, 30), clusters)],
    ["KISC|4|1200", "KISC|4|1200"]);
  /* CONTROL: and two back-to-back matches do NOT, or the key is doing nothing. */
  const sc = clusterMinutes([hm(19), hm(20), hm(21)]);
  const keys = [hm(19), hm(20), hm(21)].map((m) => slotRiskKey("Soccer Central", 4, m, sc));
  is("  CONTROL: three back-to-back matches key three ways", new Set(keys).size, 3);
  /* A TIME OUTSIDE EVERY CLUSTER KEYS ON ITSELF rather than snapping to a neighbour. */
  is("a time in no cluster keys on itself", slotRiskKey("KISC", 4, hm(23), clusters), "KISC|4|1380");
}

console.log("\n— the rollup over getCancelPatterns' own output —");
{
  const slot = (canonicalField: string, dowIdx: number, timeMinutes: number, cancelCount: 1 | 2 | 3 | 4, bookedCount: number): CancelSlot => ({
    canonicalField, venueCode: canonicalField.slice(0, 4).toUpperCase(),
    dow: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][dowIdx], dowIdx,
    time: `${Math.floor(timeMinutes / 60)}:${String(timeMinutes % 60).padStart(2, "0")}`,
    timeMinutes, streak: cancelCount, cancelCount, bookedCount,
  });
  const wk = (slots: CancelSlot[]): CancelPatternsResult["weeks"][number] => {
    const byDay: CancelSlot[][] = [[], [], [], [], [], [], []];
    for (const s of slots) byDay[s.dowIdx].push(s);
    return { weekStart: new Date(), weekEnd: new Date(), rangeLabel: "", byDay };
  };
  const result: CancelPatternsResult = {
    weeks: [
      wk([slot("KISC", 4, hm(20), 2, 5), slot("Soccer Central", 4, hm(19), 1, 3)]),
      wk([slot("KISC", 4, hm(20, 30), 1, 4), slot("Soccer Central", 4, hm(21), 3, 9)]),
    ],
    totalSlots: 4, chronicCount: 0,
  };
  const risk = rollUpSlotRisk(result);
  is("the moved KISC slot rolls into ONE entry", [...risk.keys()].filter((k) => k.startsWith("KISC")).length, 1);
  const kisc = risk.get("KISC|4|1200")!;
  /* THE COUNT IS THE MAX, NOT THE SUM. The same slot seen either side of a move cancelled in at
   * most 2 of the 4 weeks; adding 2 and 1 would invent a fifth week. */
  is("  and takes the MAX of the four-week counts, not their sum", kisc.cancelCount, 2);
  is("  while the booked counts DO add, being different matches", kisc.booked, 9);
  is("  and it remembers both times it was seen at", kisc.times.sort(), ["20:00", "20:30"]);
  /* CONTROL: Soccer Central's two do NOT roll together. */
  is("CONTROL: Soccer Central's 19:00 and 21:00 stay two entries",
    [...risk.keys()].filter((k) => k.startsWith("Soccer Central")).length, 2);
  is("  CONTROL: and keep their own counts", [risk.get("Soccer Central|4|1140")!.cancelCount, risk.get("Soccer Central|4|1260")!.cancelCount], [1, 3]);
  /* CONTROL: an empty result yields an empty map rather than throwing. */
  is("CONTROL: an empty window rolls up to nothing",
    rollUpSlotRisk({ weeks: [], totalSlots: 0, chronicCount: 0 }).size, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
