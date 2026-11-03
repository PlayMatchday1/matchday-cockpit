/* STAFF APP MATCH v2: which desktop path a team count takes, what the size stepper offers, how an
 * add's money is worded, and how a search term is read (src/lib/appMatchV2.ts). Ryan, 2026-10-30.
 * Pure rules, asserted offline; every refusal has a presence control beside it. */
import { detailsMatch, overflowFakes, reduceSizes, moneyLine, phoneLast4, pickerCapacityWrites, searchTerm, sizeBounds, sizeRefusal, sizeWrites, teamsPath } from "../src/lib/appMatchV2";

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
is("bounds start at the team with the most real players, up to 12", sizeBounds(2, [8, 6]), { min: 8, max: 12 });
is("never below 6 a side", sizeBounds(2, [3, 2]), { min: 6, max: 12 });
is("5 a side is refused", typeof sizeRefusal(2, 5, [1, 1]), "string");
is("13 a side is refused", typeof sizeRefusal(2, 13, [1, 1]), "string");
is("presence control: 12 a side is accepted", sizeRefusal(2, 12, [1, 1]), null);
is("below a team's real players is refused", typeof sizeRefusal(2, 7, [8, 6]), "string");
is("presence control: that team's own real count is accepted", sizeRefusal(2, 8, [8, 6]), null);
is("all the real players must fit too", typeof sizeRefusal(2, 7, [7, 7], 15), "string");
is("presence control: 14 real fit 2 x 7", sizeRefusal(2, 7, [7, 7], 14), null);
is("a fraction is refused", typeof sizeRefusal(3, 7.5, [1]), "string");
const P = (userMatchId: number, team: number, bib: number, fake: boolean) => ({ userMatchId, team, bib, fake });
const nine = [...[1, 2, 3, 4, 5, 6, 7].map((b) => P(b, 1, b, false)), P(8, 1, 8, true), P(9, 1, 9, true), ...[1, 2, 3, 4, 5].map((b) => P(20 + b, 2, b, false))];
is("9 to 8 a side takes one fake off the full team, highest bib first", overflowFakes(nine, 8), [9]);
is("9 to 7 takes both of that team's fakes", overflowFakes(nine, 7), [9, 8]);
is("presence control: a size that fits takes nothing", overflowFakes(nine, 9), []);
is("real players alone overflowing is null, never a real removal", overflowFakes(nine, 6), null);
const leftover = [P(1, 1, 1, false), P(2, 1, 10, true), P(3, 1, 12, true), P(4, 1, 2, true)];
is("a fake on a bib above the new size comes off even when the team fits", overflowFakes(leftover, 9), [3, 2]);
is("presence control: at 12 a side those bibs stay", overflowFakes(leftover, 12), []);
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

console.log("\nreduce to 2: the sizes offered");
is("5 real: 6 to 12 (6 is the desktop's floor)", reduceSizes(5), { sizes: [6, 7, 8, 9, 10, 11, 12], reason: null });
is("15 real: from 8 (fits 15) up to 12", reduceSizes(15), { sizes: [8, 9, 10, 11, 12], reason: null });
is("not capped at the current size: 9v9 to 12v12 are offered", reduceSizes(10).sizes.slice(-4), [9, 10, 11, 12]);
is("presence control: 24 real fit 2 x 12 exactly", reduceSizes(24).sizes, [12]);
is("25 real: nothing fits, and it says why", reduceSizes(25).sizes, []);
is("…with a reason", typeof reduceSizes(25).reason, "string");
is("13 a side is never offered", reduceSizes(1).sizes.includes(13), false);

console.log("\nAdjust payload: the match's people, for every account");
{
  const m = detailsMatch({ id: 1, cityName: "Austin", managerId: 5, manager: { id: 5, firstName: "Jordan", lastName: "Blake", lat: 30.1, lng: -97.7, currentLat: 30.2, currentLng: -97.8, zipCode: "78701", currentZipCode: "78701", coordinatesUpdatedAt: "2026-10-09", address: { street: "1 Main St", city: "Austin", country: "United States" }, creditAmount: 500 }, secondManager: { id: 7, firstName: "Ana", lastName: "Lopez", lat: 30.3 } });
  is("the manager keeps only id and name", m.manager, { id: 5, firstName: "Jordan", lastName: "Blake" });
  is("the second manager keeps only id and name", m.secondManager, { id: 7, firstName: "Ana", lastName: "Lopez" });
  is("the match's own keys stay", [m.id, m.cityName, (m as Record<string, unknown>).managerId], [1, "Austin", 5]);
  const flat = JSON.stringify(m);
  is("no coordinates, zip, address or credit anywhere", ["lat", "lng", "Lat", "Lng", "ZipCode", "zipCode", "address", "creditAmount", "coordinates"].filter((k) => flat.includes(`${k}"`)), []);
  is("no manager stays null", detailsMatch({ id: 2, manager: null, secondManager: undefined }).manager, null);
  is("no second manager stays null", detailsMatch({ id: 2, manager: null }).secondManager, null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
