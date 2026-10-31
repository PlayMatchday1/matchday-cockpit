/* STAFF APP MATCH v2: which desktop path a team count takes, what the size stepper offers, how an
 * add's money is worded, and how a search term is read (src/lib/appMatchV2.ts). Ryan, 2026-10-30.
 * Pure rules, asserted offline; every refusal has a presence control beside it. */
import { moneyLine, phoneLast4, pickerCapacityWrites, searchTerm, sizeBounds, sizeRefusal, sizeWrites, teamsPath } from "../src/lib/appMatchV2";

let pass = 0, fail = 0;
const ok = (m: string) => { pass++; console.log(`  ok  ${m}`); };
const bad = (m: string, d = "") => { fail++; console.log(`  XX  ${m} ${d}`); };
const is = (m: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

console.log("\nteam count: the desktop's own path");
is("2 -> 4 is Convert to 4", teamsPath(2, 4), "convert-4");
is("4 -> 2 is Reduce to 2", teamsPath(4, 2), "reduce-2");
is("3 -> 2 is Reduce to 2", teamsPath(3, 2), "reduce-2");
is("2 -> 3 is the picker", teamsPath(2, 3), "picker");
is("3 -> 4 is the picker", teamsPath(3, 4), "picker");
is("4 -> 3 is the picker", teamsPath(4, 3), "picker");
is("no change is no path", teamsPath(3, 3), null);
is("5 teams is not offered", teamsPath(2, 5), null);

console.log("\npicker capacity: the desktop's teamCountWrites, diffed");
is("2 x 9 -> 3 teams writes 27 and no rung", pickerCapacityWrites({ maxPlayerCount: 18, maxTeamSize2Team: 18 }, 2, 3), { maxPlayerCount: 27 });
is("3 x 9 -> 4 teams raises a stale 4-team rung", pickerCapacityWrites({ maxPlayerCount: 27, maxTeamSize4Team: 22 }, 3, 4), { maxPlayerCount: 36, maxTeamSize4Team: 36 });
is("a higher saved 4-team rung is left alone", pickerCapacityWrites({ maxPlayerCount: 27, maxTeamSize4Team: 44 }, 3, 4), { maxPlayerCount: 36 });
is("a capacity that does not divide writes nothing beside the count", pickerCapacityWrites({ maxPlayerCount: 19 }, 2, 3), {});

console.log("\nteam size");
is("bounds start at the fullest team", sizeBounds(2, [8, 6]), { min: 8, max: 20 });
is("below the fullest team is refused", typeof sizeRefusal(2, 7, [8, 6]), "string");
is("presence control: the fullest team's own size is accepted", sizeRefusal(2, 8, [8, 6]), null);
is("a fraction is refused", typeof sizeRefusal(3, 7.5, [1]), "string");
is("3 teams writes the total only", sizeWrites({ maxPlayerCount: 27 }, 3, 8), { maxPlayerCount: 24 });
is("2 teams writes the stored size, raising the rung", sizeWrites({ maxPlayerCount: 18, maxTeamSize2Team: 18 }, 2, 10), { maxPlayerCount: 20, maxTeamSize2Team: 20 });
is("2 teams going down leaves a higher rung", sizeWrites({ maxPlayerCount: 20, maxTeamSize2Team: 20 }, 2, 9), { maxPlayerCount: 18 });

console.log("\nmoney after an add, from the row read back");
is("free", moneyLine({ paidStatus: "FREE", amount: 0, totalAmount: 0, creditAmount: 0 }), "Added · free");
is("charged", moneyLine({ paidStatus: "PAID", amount: 1200, totalAmount: 1200, creditAmount: 0 }), "Added · charged $12");
is("credit", moneyLine({ paidStatus: "PAID", totalAmount: 0, creditAmount: 900 }), "Added · $9 credit used");
is("not on the roster", moneyLine(null), "Added · not on the roster when read back");
is("unpaid, nothing charged, is said", moneyLine({ paidStatus: "WAITING", totalAmount: 0 }), "Added · waiting, nothing charged");

console.log("\nsearch terms");
is("an id", searchTerm("1483"), { kind: "id", id: "1483" });
is("a formatted phone", searchTerm("(512) 555-0188"), { kind: "phone", digits: "5125550188" });
is("a +1 phone", searchTerm("+1 512 555 0188"), { kind: "phone", digits: "5125550188" });
is("an email", searchTerm("ryan+devb@playmatchday.com"), { kind: "email", text: "ryan+devb@playmatchday.com" });
is("too short to search", searchTerm("ab"), null);
is("phone last four only", phoneLast4("+15125550188"), "0188");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
