/* FREE FIRST MATCH: SOLD OUT IS FULL AT THE FIELD'S MAX (Ryan, 2026-11-11). src/lib/freeFirstMatchModel.ts
 * capacityState, isSoldOut, soldOutByField, logMatches. Pure, asserted offline. Every zero has a presence
 * control beside it: the same match with the one fact changed counts. */
import { capacityState, isSoldOut, logMatches, soldOutByField, type MatchRow, type Person } from "../src/lib/freeFirstMatchModel";

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

console.log("\nthe card, the table and the log agree");
const T = "2026-11-11";
const person = (id: number) => ({ id } as unknown as Person);
const free = [person(1), person(2), person(3), person(4), person(5)];
const m = (id: number, field: string, booked: number, cap: number | null, fieldMax: number | null, players: number[], priceCents = 1200, day = "2026-11-08"): MatchRow => ({
  id, day, wall: `${day}T19:00`, city: "ATX", cityName: "Austin", field, booked, cap, fieldMax, priceCents, ffe: true,
  freePlayers: players.map((p) => ({ id: p, name: `P${p}` })),
});
const matches = [
  m(1, "NEMP", 22, 22, 40, [1]),            // full, can expand
  m(2, "NEMP", 40, 40, 40, [2, 3]),         // sold out: 2 spots lost
  m(3, "Friends Select", 18, 18, null, [4]), // no field max: old rule, 1 spot
  m(4, "NEMP", 30, 40, 40, [5]),            // not full
  m(5, "NEMP", 40, 40, 40, [9]),            // sold out but the player isn't a free claimant: nothing
  m(6, "NEMP", 40, 40, 40, [1], 1200, "2026-11-04"), // before launch: nothing
];
const lost = soldOutByField(matches, free, T);
is("card: 2 sold-out matches", lost.matches, 2);
is("card: 3 spots lost (2 at the max, 1 with no max set)", lost.spots, 3);
is("card: $36 lost", lost.cents, 3600);
is("card: full, can expand counted apart", lost.canExpand, { matches: 1, freePlayers: 1 });
is("card: one sold-out match judged by the old rule", lost.noFieldMax, 1);
const nemp = lost.rows.find((r) => r.field === "NEMP")!;
is("table: NEMP 1 sold out w/ free, 2 spots, 1 full can expand, max 40", [nemp.soldOutWithFree, nemp.spotsLost, nemp.fullCanExpand, nemp.fieldMax], [1, 2, 1, 40]);
const fs = lost.rows.find((r) => r.field === "Friends Select")!;
is("table: Friends Select carries no max (marked on the page)", [fs.soldOutWithFree, fs.fieldMax], [1, null]);
is("table and card agree on spots", lost.rows.reduce((a, r) => a + r.spotsLost, 0), lost.spots);
const log = logMatches(matches, free, T);
const by = new Map(log.map((x) => [x.id, x.capacity]));
is("log: the same three labels", [by.get(1), by.get(2), by.get(3), by.get(4)], ["full_can_expand", "sold_out", "sold_out_no_field_max", null]);
is("log: badges counted as sold out = the card's sold-out matches", log.filter((x) => x.soldOut).length, lost.matches);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail || pass === 0) process.exit(1);
