/* STAFF APP MATCH v2: which desktop path a team count takes, what the size stepper offers, how an
 * add's money is worded, and how a search term is read (src/lib/appMatchV2.ts). Ryan, 2026-10-30.
 * Pure rules, asserted offline; every refusal has a presence control beside it. */
import { detailsMatch, overflowFakes, reduceSizes, moneyLine, phoneLast4, pickerCapacityWrites, searchTerm, sizeBounds, sizeRefusal, sizeWrites, teamChangeSizes, teamsPath } from "../src/lib/appMatchV2";

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

console.log("\nevery team count change: 6 to 12 a side (Ryan, 2026-11-05)");
{
  const T = (...reals: number[]) => reals.map((real, i) => ({ teamNumber: i + 1, real }));
  // THE BUG: a 2-team match at 11 going to 4 was offered 11 and nothing else.
  is("2 -> 4 with 3 real players: every size from 6 to 12", teamChangeSizes("convert-4", 4, 3, T(2, 1)).sizes, [6, 7, 8, 9, 10, 11, 12]);
  is("2 -> 4 with 22 real players: still every size, 4 x 6 holds 22", teamChangeSizes("convert-4", 4, 22, T(11, 11)).sizes, [6, 7, 8, 9, 10, 11, 12]);
  is("2 -> 4 with 26 real: never below what holds them, so from 7", teamChangeSizes("convert-4", 4, 26, T(13, 13)).sizes, [7, 8, 9, 10, 11, 12]);
  is("convert-4 deals every team again, so a full team of 11 does not block 6 a side", teamChangeSizes("convert-4", 4, 11, T(11, 0)).sizes[0], 6);
  is("2 -> 3 (the picker): nobody moves, so never below the fullest team that stays", teamChangeSizes("picker", 3, 12, T(9, 3)).sizes, [9, 10, 11, 12]);
  is("4 -> 3 (the picker): team 4 goes, teams 1 to 3 keep their players", teamChangeSizes("picker", 3, 14, T(4, 4, 4, 2)).sizes, [6, 7, 8, 9, 10, 11, 12]);
  is("…and the team that goes still has to fit somewhere: 25 real over 3 teams is 9 a side", teamChangeSizes("picker", 3, 25, T(6, 6, 6, 7)).sizes[0], 9);
  is("3 -> 4 (the picker): the new team is empty, the others keep theirs", teamChangeSizes("picker", 4, 21, T(7, 7, 7)).sizes, [7, 8, 9, 10, 11, 12]);
  is("4 -> 2 is the reduce rule: 15 real from 8 a side", teamChangeSizes("reduce-2", 2, 15, T(4, 4, 4, 3)).sizes, [8, 9, 10, 11, 12]);
  is("a team fuller than 12 that stays: nothing, with the reason", [teamChangeSizes("picker", 3, 13, T(13, 0)).sizes, typeof teamChangeSizes("picker", 3, 13, T(13, 0)).reason], [[], "string"]);
  is("49 real over 4 teams: nothing, with the reason", typeof teamChangeSizes("convert-4", 4, 49, T(25, 24)).reason, "string");
  is("presence control: the reason is null when something is offered", teamChangeSizes("convert-4", 4, 3, T(2, 1)).reason, null);
}

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
