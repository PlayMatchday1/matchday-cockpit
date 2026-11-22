/* FREE FIRST MATCH: SOLD OUT IS FULL AT THE FIELD'S MAX (Ryan, 2026-11-11). src/lib/freeFirstMatchModel.ts
 * capacityState, isSoldOut, and the Lost tile and field table that summarize() builds on them. Pure, asserted
 * offline. Every zero has a presence control beside it: the same match with the one fact changed counts.
 *
 * 2026-11-21 redesign: soldOutByField and logMatches were removed with the page's old card and free match log.
 * "the rule" below is unchanged. "the tile and the table agree" ports the old card/table section onto
 * summarize() with the same six matches and the same expected spots, dollars and no-max count; the log
 * assertions went with the log. New: a first-match CODE spot on a sold-out match counts (Ryan, 2026-11-21).
 *
 * 2026-11-22 simple v2: the "Turn off?" tag was removed with the page's tag, replaced by the amber dot
 * (usually sells out, 40%+). New: "the boxes add up" — every info box and the list behind it equal the number
 * on the page (Ryan: "The box must always add up to the number shown"). */
import { capacityState, isSoldOut, listFor, summarize, type Base, type BaseMatch, type FirstTimer } from "../src/lib/freeFirstMatchModel";

let pass = 0, fail = 0;
const ok = (m: string) => { pass++; console.log(`  ok  ${m}`); };
const bad = (m: string, d = "") => { fail++; console.log(`  XX  ${m} ${d}`); };
const is = (m: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

console.log("\nthe rule");
is("22/22 on a field whose max is 40: full, can expand", capacityState({ booked: 22, cap: 22, fieldMax: 40 }), "full_can_expand");
is("40/40 on a field whose max is 40: sold out", capacityState({ booked: 40, cap: 40, fieldMax: 40 }), "sold_out");
is("above the field max (a cap set higher than Field Ops): sold out", capacityState({ booked: 40, cap: 40, fieldMax: 36 }), "sold_out");
is("21/22 on a field whose max is 40: nothing", capacityState({ booked: 21, cap: 22, fieldMax: 40 }), null);
is("no field max, 18/18: the old rule, marked", capacityState({ booked: 18, cap: 18, fieldMax: null }), "sold_out_no_field_max");
is("no field max, 17/18: nothing", capacityState({ booked: 17, cap: 18, fieldMax: null }), null);
is("no field max and no cap: nothing", capacityState({ booked: 5, cap: null, fieldMax: null }), null);
is("a field max of 0 is no max", capacityState({ booked: 18, cap: 18, fieldMax: 0 }), "sold_out_no_field_max");
is("full, can expand is not sold out", isSoldOut({ booked: 22, cap: 22, fieldMax: 40 }), false);
is("presence control: full at the field max is sold out", isSoldOut({ booked: 40, cap: 40, fieldMax: 40 }), true);
is("the fallback counts as sold out", isSoldOut({ booked: 18, cap: 18, fieldMax: null }), true);

console.log("\nthe tile and the table agree");
const T = "2026-11-12";
const NOW = Date.parse("2026-11-12T06:00:00Z");
const m = (id: number, field: string, booked: number, cap: number | null, fieldMax: number | null, priceCents = 1200, day = "2026-11-08"): BaseMatch => ({
  id, day, wall: `${day}T19:00`, startMs: Date.parse(`${day}T19:00:00Z`), city: "ATX", fieldKey: `ATX|${field}`, fieldName: field,
  booked, cap, fieldMax, priceCents, ffe: true,
});
const ft = (id: number, matchId: number, group: FirstTimer["group"] = "free", day = "2026-11-08"): FirstTimer =>
  ({ id, day, matchId, city: "ATX", fieldKey: "", group, spotCents: 1200, paidDays: [], firstCents: 0, spend: [] as [number, number, number][] });
const base: Base = {
  generatedAt: "", today: T, nowMs: NOW, mirrorSyncedAt: null, cities: [{ code: "ATX", name: "Austin" }],
  matches: [
    m(1, "NEMP", 22, 22, 40),            // full, can expand
    m(2, "NEMP", 40, 40, 40),            // sold out: 2 spots lost
    m(3, "Friends Select", 18, 18, null), // no field max: old rule, 1 spot
    m(4, "NEMP", 30, 40, 40),            // not full
    m(5, "NEMP", 40, 40, 40),            // sold out but its player paid for the first match: nothing
    m(6, "NEMP", 40, 40, 40, 1200, "2026-11-04"), // before launch: nothing
    m(7, "Crossbar", 20, 20, 20),        // sold out, a first-match CODE spot: counts
  ],
  people: [ft(1, 1), ft(2, 2), ft(3, 2), ft(4, 3), ft(5, 4), ft(9, 5, "paid"), ft(10, 6, "free", "2026-11-04"), ft(11, 7, "code")],
  names: {},
};
const v = summarize(base, { from: "2026-11-05", to: "2026-11-11" });
is("tile: 3 sold-out matches with a free first-timer", v.money.lost.matches, 3);
is("tile: 4 spots lost (2 at the max, 1 with no max set, 1 code)", v.money.lost.spots, 4);
is("tile: $48 lost", v.money.lost.cents, 4800);
is("tile: one sold-out match judged by the old rule", v.money.lost.noMaxMatches, 1);
const nemp = v.fields.find((r) => r.field === "NEMP")!;
is("table: NEMP 2 sold out of 4 played in range, 2 free on full", [nemp.soldOut, nemp.matches, nemp.freeOnFull], [2, 4, 2]);
const fs = v.fields.find((r) => r.field === "Friends Select")!;
is("table: Friends Select is flagged no max", [fs.soldOut, fs.noMax], [1, true]);
is("table and tile agree on spots", v.fields.reduce((a, r) => a + r.freeOnFull, 0), v.money.lost.spots);
is("table and tile agree on dollars", v.fields.reduce((a, r) => a + r.lostCents, 0), v.money.lost.cents);
is("presence control: the paid first-timer's match is sold out and in the table", nemp.matches >= 3 && isSoldOut(base.matches[4]), true);
is("table sorted by money lost", v.fields.map((r) => r.lostCents), [...v.fields.map((r) => r.lostCents)].sort((a, b) => b - a));
is("NEMP sells out on 50% (2 of 4): the amber dot", nemp.usually, true);
const cross = v.fields.find((r) => r.field === "Crossbar")!;
is("presence control: Crossbar sells out on 100%: the dot too", cross.usually, true);


console.log("\nthe boxes add up");
{
  // A fuller world: free, paid and code first-timers with spending and refunds, on and off sold-out matches.
  // Today Nov 30, so the Nov 8 players have had their 7 days; the refund falls inside the Nov 5 – 11 range.
  const b2: Base = {
    ...base, today: "2026-11-30", nowMs: Date.parse("2026-11-30T06:00:00Z"),
    people: [
      { ...ft(1, 2), paidDays: [3, 9], firstCents: 0, spend: [[3, 1300, 0], [3, 1300, 1300], [9, 650, 0]] },
      { ...ft(2, 2), paidDays: [], spend: [] },
      { ...ft(3, 4), paidDays: [5], spend: [[5, 1300, 0]] },
      { ...ft(11, 7, "code"), paidDays: [], spend: [] },
      { ...ft(20, 6, "paid", "2026-10-31"), paidDays: [2], firstCents: 1300, spend: [[2, 1300, 0]] },
      { ...ft(21, 6, "code", "2026-11-01"), paidDays: [], spend: [] },
    ],
    names: { 1: "Ana A", 2: "Ben B", 3: "Cy C", 11: "Dee D", 20: "Eve E", 21: "Fay F" },
  };
  const o = { from: "2026-11-05", to: "2026-11-11" };
  const vv = summarize(b2, o);
  const sumCol = (l: { rows: (string | number)[][] }, i: number) => Math.round(l.rows.reduce((a, r) => a + Number(String(r[i]).replace(/[$,]/g, "")), 0) * 100);
  const nl = listFor(b2, o, "new");
  is("new players: the list has the since-launch players the tile shows", nl.rows.filter((r) => r[0] === "Since launch").length, vv.newPlayers.after);
  is("new players: …and the before players the box shows", nl.rows.filter((r) => r[0] === "Before").length, vv.newPlayers.before);
  is("control: there are players in both periods", vv.newPlayers.after > 0 && vv.newPlayers.before > 0, true);
  const c7 = listFor(b2, o, "came", "7");
  is("come back (7): the list is every player with the window, all groups", c7.rows.length, vv.came[7].free.judged + vv.came[7].paid.judged + vv.came[7].code.judged);
  is("come back (7): its free Yes rows are the box's free paid-2nd", c7.rows.filter((r) => r[0] === "Free first match" && r[4] === "Yes").length, vv.came[7].free.hits);
  is("control: some free player paid a 2nd match", vv.came[7].free.hits > 0, true);
  const pb = listFor(b2, o, "paidback");
  is("paid back: the list's net column sums to the tile", sumCol(pb, 7), vv.money.paidBack.cents);
  is("paid back: charged − refunded = the tile", vv.money.paidBack.charged - vv.money.paidBack.refunded, vv.money.paidBack.cents);
  is("paid back: the list's paid matches sum to the box", pb.rows.reduce((a, r) => a + Number(r[4]), 0), vv.money.paidBack.paidMatches);
  is("control: a refund was subtracted", vv.money.paidBack.refunded, 1300);
  const lo = listFor(b2, o, "lost");
  is("lost: the list's Lost column sums to the tile", sumCol(lo, 8), vv.money.lost.cents);
  is("lost: the list's free spots sum to the box", lo.rows.reduce((a, r) => a + Number(r[7]), 0), vv.money.lost.spots);
  is("lost: the price breakdown sums to the tile", vv.money.lost.byPrice.reduce((a, x) => a + x.cents, 0), vv.money.lost.cents);
  is("control: something was lost", vv.money.lost.cents > 0, true);
  for (const r of vv.fields) {
    const fl = listFor(b2, o, "field", r.key);
    is(`field ${r.field}: matches, sold out, free spots and lost match the row`,
      [fl.rows.length, fl.rows.filter((x) => x[4] === "Yes").length, fl.rows.reduce((a, x) => a + Number(x[5]), 0), sumCol(fl, 7)],
      [r.matches, r.soldOut, r.freeOnFull, r.lostCents]);
  }
  is("fields: the rows' lost sums to the tile", vv.fields.reduce((a, r) => a + r.lostCents, 0), vv.money.lost.cents);
  const co = listFor(b2, o, "cohorts");
  is("comparison: the list has every player of the three columns", co.rows.length, vv.cohorts.paid.players + vv.cohorts.free.players + vv.cohorts.code.players);
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail || pass === 0) process.exit(1);
