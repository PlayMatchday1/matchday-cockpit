/* FREE FIRST MATCH: SOLD OUT IS FULL AT THE FIELD'S MAX (Ryan, 2026-11-11). src/lib/freeFirstMatchModel.ts
 * capacityState, isSoldOut, and the Lost tile and field table that summarize() builds on them. Pure, asserted
 * offline. Every zero has a presence control beside it: the same match with the one fact changed counts.
 *
 * 2026-11-21 redesign: soldOutByField and logMatches were removed with the page's old card and free match log.
 * "the rule" below is unchanged. "the tile and the table agree" ports the old card/table section onto
 * summarize() with the same six matches and the same expected spots, dollars and no-max count; the log
 * assertions went with the log. New: a first-match CODE spot on a sold-out match counts (Ryan, 2026-11-21). */
import { capacityState, isSoldOut, summarize, type Base, type BaseMatch, type FirstTimer } from "../src/lib/freeFirstMatchModel";

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
  ({ id, day, matchId, city: "ATX", fieldKey: "", group, spotCents: 1200, paidDays: [], firstCents: 0, spend: [] });
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
  leaves: [], ratings: [], plays: [],
};
const v = summarize(base, { from: "2026-11-05", to: "2026-11-11" });
is("tile: 3 sold-out matches with a free first-timer", v.lost.matches, 3);
is("tile: 4 spots lost (2 at the max, 1 with no max set, 1 code)", v.lost.spots, 4);
is("tile: $48 lost", v.lost.cents, 4800);
is("tile: one sold-out match judged by the old rule", v.lost.noMaxMatches, 1);
const nemp = v.fields.find((r) => r.field === "NEMP")!;
is("table: NEMP 2 sold out of 4 played in range, 2 free on full", [nemp.soldOut, nemp.matches, nemp.freeOnFull], [2, 4, 2]);
const fs = v.fields.find((r) => r.field === "Friends Select")!;
is("table: Friends Select is flagged no max", [fs.soldOut, fs.noMax], [1, true]);
is("table and tile agree on spots", v.fields.reduce((a, r) => a + r.freeOnFull, 0), v.lost.spots);
is("table and tile agree on dollars", v.fields.reduce((a, r) => a + r.lostCents, 0), v.lost.cents);
is("presence control: the paid first-timer's match is sold out and in the table", nemp.matches >= 3 && isSoldOut(base.matches[4]), true);
is("table sorted by money lost", v.fields.map((r) => r.lostCents), [...v.fields.map((r) => r.lostCents)].sort((a, b) => b - a));
is("50% sold out but no upcoming match to switch: no Turn off? tag", nemp.turnOff, false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail || pass === 0) process.exit(1);
