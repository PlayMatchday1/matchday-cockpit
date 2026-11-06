/* CANCEL REASONS (src/lib/cancelReasons.ts), Ryan 2026-11-06: Not enough players is a staff pick stored as
 * the same "players" the auto-cancels read as, counted with them; the chip list, the labels and the
 * inference. Pure, offline; every refusal has a presence control beside it. */
import { cancelReasonFor, REASON_HINT, REASON_LABEL, REASON_TAG, reasonLine, reasonProblem, STAFF_REASONS, type CancelFacts } from "../src/lib/cancelReasons";
import { ratesOf } from "../src/lib/healthModel";

let pass = 0, fail = 0;
const ok = (m: string) => { pass++; console.log(`  ok  ${m}`); };
const bad = (m: string, d = "") => { fail++; console.log(`  XX  ${m} ${d}`); };
const is = (m: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

console.log("\nthe chips");
is("Not enough players is the first chip, then the five as before", [...STAFF_REASONS], ["players", "weather", "manager", "facility", "slate_change", "other"]);
is("its label reads the same everywhere", [REASON_LABEL.players, REASON_TAG.players], ["Not enough players", "Not enough players"]);
is("every staff reason has a hint", STAFF_REASONS.every((r) => REASON_HINT[r].length > 0), true);

console.log("\nthe request check");
is("players needs no note", reasonProblem("players", ""), null);
is("players with a note is fine too", reasonProblem("players", "only 6 showed"), null);
is("other still needs a note", typeof reasonProblem("other", ""), "string");
is("an unknown reason is refused", typeof reasonProblem("auto", ""), "string");
is("presence control: weather is accepted", reasonProblem("weather", undefined), null);

console.log("\nthe reason a cancel reads as");
const facts = (over: Partial<CancelFacts> = {}): CancelFacts => ({ stored: null, loggedByClubhouse: false, autoCanceled: true, autoCanceledMinutes: 60, startDateUtc: "2026-11-06T01:00:00.000Z", updatedAt: "2026-11-06T00:00:30.000Z", realPlayers: 3, minPlayerCount: 10, ...over });
is("a MatchDay auto-cancel reads as players (inferred)", cancelReasonFor(facts()), "players");
is("a staff Not enough players is stored and wins", cancelReasonFor(facts({ stored: "players", loggedByClubhouse: true, updatedAt: "2026-11-05T20:00:00.000Z" })), "players");
is("presence control: a stored weather wins over the window", cancelReasonFor(facts({ stored: "weather", loggedByClubhouse: true })), "weather");
is("a Clubhouse cancel in the window with no stored reason is unknown, not players", cancelReasonFor(facts({ loggedByClubhouse: true })), "unknown");

console.log("\nHealth counts them together and in the rate");
const m = (id: number, cancelled: boolean) => ({ id, startDateUtc: "2026-11-05T01:00:00.000Z", isCancelled: cancelled, autoCanceled: true, autoCanceledMinutes: 60, minPlayerCount: 10, spots: { real: 3, capacity: 18, fake: 0 }, maxPlayerCount: 18, fieldId: 1, field: { title: "F", city: { name: "Austin" } } });
const inputs = { updatedAtOf: new Map([[1, "2026-11-05T00:00:30.000Z"], [2, "2026-11-04T20:00:00.000Z"], [3, "2026-11-04T20:00:00.000Z"]]), stored: new Map([[2, { reason: "players" as const }], [3, { reason: "slate_change" as const }]]), logged: new Set([2, 3]) };
const r = ratesOf([m(1, true), m(2, true), m(3, true)] as never, inputs as never, Date.parse("2026-11-06T12:00:00.000Z"));
is("one auto and one staff players cancel count as two under players", r.reasons.players, 2);
is("slate change is not a cancel in the rate; the two players cancels are", [r.canceled, r.slateChange], [2, 1]);
is("the line names them once, by the one label, largest first", reasonLine({ players: 2, weather: 1 }), "Not enough players 2 · Weather 1");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
