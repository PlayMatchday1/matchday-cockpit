import "server-only"; // no-op under --conditions=react-server
// The match panel's roster edits, tested where the rules actually live.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/roster-edit-model-test.ts
//
// The browser suite proves the WIRING (no request until Save, the guard, the layout). This proves
// the RULES: what counts as a change, what order the writes go in, how a shuffled team sorts, what
// a duplicate spot does, and that no logged payload can carry a phone number.

import {
  emptyPending, normalizePending, pendingCount, effectiveRow, sortedTeam, spotsOfTeam,
  planMove, savePlan, clearApplied, teamCountConsequence,
  type Pending, type RosterOrigin, type EditRow,
} from "../src/lib/rosterEditModel";
import { phoneLast4 } from "../src/lib/changeLog";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const eq = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
const is = (n: string, got: unknown, want: unknown) => (got === want ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const row = (umId: number, team: number, playerNumber: number | null, name: string, phone: string | null = "+15125550000", fake = false): EditRow =>
  ({ umId, team, playerNumber, name, phone, fake });

// A 2-team match whose API order is deliberately shuffled — the real shape measured on production,
// where 55 of 95 teams came back out of order.
const ORIGIN: RosterOrigin = {
  teams: [{ id: 91, teamNumber: 1, name: "White" }, { id: 92, teamNumber: 2, name: "Green" }],
  rows: [
    row(1, 1, 9, "Wanda Nine"), row(2, 1, 4, "Wes Four"), row(3, 1, 5, "Will Five"),
    row(4, 1, 1, "Wynn One"), row(5, 1, 2, "Wade Two"), row(6, 1, 3, "Wren Three"),
    row(7, 2, 1, "Gina One"), row(8, 2, 2, "Gus Two"), row(9, 2, 4, "Gwen Four"),
  ],
};
const P = () => emptyPending();

console.log("\nRULE 1 — the diff IS the request body: a value returned to itself is not a change");
{
  const p = normalizePending({ ...P(), moves: { 2: { team: 1, playerNumber: 4 } } }, ORIGIN);
  eq("a move onto the row's OWN current team+spot is dropped", p.moves, {});
  is("...so it does not count", pendingCount({ ...P(), moves: { 2: { team: 1, playerNumber: 4 } } }, ORIGIN), 0);
}
{
  const p = normalizePending({ ...P(), names: { 91: "White" } }, ORIGIN);
  eq("a rename to the COMMITTED name is dropped", p.names, {});
  eq("...and a rename with only whitespace is dropped", normalizePending({ ...P(), names: { 91: "   " } }, ORIGIN).names, {});
  eq("a genuine rename survives, trimmed", normalizePending({ ...P(), names: { 91: "  Whites  " } }, ORIGIN).names, { 91: "Whites" });
}
is("teamCount equal to the current count is not a change", normalizePending({ ...P(), teamCount: 2 }, ORIGIN).teamCount, null);
is("teamCount different from the current count IS a change", normalizePending({ ...P(), teamCount: 4 }, ORIGIN).teamCount, 4);
{
  // a move for a row that is also being REMOVED is a wasted write against a real player
  const p = normalizePending({ ...P(), moves: { 3: { team: 2, playerNumber: 7 } }, removes: [3] }, ORIGIN);
  eq("a move on a row that is also being removed is dropped", Object.keys(p.moves), []);
  is("...and the removal stands", p.removes.length, 1);
}
{
  // team count applies FIRST, so a move into a team that is about to be deleted can never work
  const p = normalizePending({ ...P(), teamCount: 2, moves: { 1: { team: 4, playerNumber: 1 } } }, ORIGIN);
  eq("a move into a team a pending count reduction deletes is dropped", Object.keys(p.moves), []);
}
is("a removal for an unknown user-match is dropped", normalizePending({ ...P(), removes: [999] }, ORIGIN).removes.length, 0);

console.log("\nRULE 2 — save ORDER, because the writes are not atomic");
{
  const p: Pending = { teamCount: 4, moves: { 5: { team: 2, playerNumber: 7 } }, removes: [1], names: { 91: "Whites" } };
  const plan = savePlan(p, ORIGIN);
  eq("the plan is teamCount → move → remove → rename, in that order", plan.map((w) => w.kind), ["shape", "move", "remove", "teams"]);
  is("TEAM COUNT IS FIRST — a move to team 3 is invalid while the match still has two teams", plan[0].kind, "shape");
  is("renames are LAST — the only edit that cannot invalidate another", plan[plan.length - 1].kind, "teams");
  eq("the shape write sends teamNumbers and nothing else", (plan[0] as { fields: unknown }).fields, { teamNumbers: 4 });
  is("every write carries a human label for its own outcome line", plan.every((w) => typeof w.label === "string" && w.label.length > 0), true);
}
{
  const p: Pending = { teamCount: null, moves: { 6: { team: 2, playerNumber: 8 }, 2: { team: 2, playerNumber: 9 } }, removes: [5, 3], names: {} };
  const plan = savePlan(p, ORIGIN);
  eq("moves and removals are ordered deterministically, so a retry walks the same sequence",
    plan.map((w) => `${w.kind}:${(w as { umId: number }).umId}`), ["move:2", "move:6", "remove:3", "remove:5"]);
}
is("an empty pending state plans no writes", savePlan(P(), ORIGIN).length, 0);

console.log("\nclearApplied — forget what is now reality, never undo it");
{
  let p: Pending = { teamCount: 4, moves: { 5: { team: 2, playerNumber: 7 } }, removes: [1], names: { 91: "Whites" } };
  const plan = savePlan(p, ORIGIN);
  p = clearApplied(p, plan[0]);
  is("the applied team count stops being pending", p.teamCount, null);
  is("...and the untouched move is still pending", Object.keys(p.moves).length, 1);
  p = clearApplied(p, plan[1]);
  is("the applied move stops being pending", Object.keys(p.moves).length, 0);
  is("...while the removal and rename remain, for a deliberate retry", p.removes.length + Object.keys(p.names).length, 2);
}

console.log("\nITEM 5 — each team sorts by spot ascending, nulls last, collisions visible");
{
  const s = sortedTeam(ORIGIN, P(), 1);
  eq("White renders 1..N in order despite the API returning 9,4,5,1,2,3", s.map((x) => x.spot), [1, 2, 3, 4, 5, 9]);
  eq("...and the names follow their spots", s.map((x) => x.row.name), ["Wynn One", "Wade Two", "Wren Three", "Wes Four", "Will Five", "Wanda Nine"]);
  eq("Green sorts too", sortedTeam(ORIGIN, P(), 2).map((x) => x.spot), [1, 2, 4]);
  is("no row is marked as colliding when every spot is unique", s.some((x) => x.collision), false);
}
{
  const withNull: RosterOrigin = { ...ORIGIN, rows: [...ORIGIN.rows, row(10, 1, null, "Nula Nospot")] };
  const s = sortedTeam(withNull, P(), 1);
  eq("a NULL playerNumber sorts LAST, not as zero", s.map((x) => x.spot), [1, 2, 3, 4, 5, 9, null]);
  is("...it is the final row, not the first", s[s.length - 1].row.name, "Nula Nospot");
  is("...and it is not treated as a collision with anything", s.some((x) => x.collision), false);
}
{
  // Measured on production: 0 of 95 teams have a duplicate among the rows the panel renders (every
  // duplicate in the raw payload came from hidden WAITING retries). It is rare, which is exactly
  // why it must be marked — a rare wrong state that renders as normal survives forever.
  const dup: RosterOrigin = { ...ORIGIN, rows: [...ORIGIN.rows, row(11, 1, 3, "Dee Dupe")] };
  const s = sortedTeam(dup, P(), 1);
  eq("two rows sharing a spot BOTH render — neither is silently dropped", s.filter((x) => x.spot === 3).map((x) => x.row.name), ["Wren Three", "Dee Dupe"]);
  eq("...they are ADJACENT", s.map((x) => x.spot), [1, 2, 3, 3, 4, 5, 9]);
  eq("...and BOTH are marked as a collision", s.filter((x) => x.collision).map((x) => x.row.umId), [6, 11]);
  is("...while the rows around them are not", s.filter((x) => x.collision).length, 2);
}
{
  // "Pending moves sort into their NEW position immediately, so the list reads the way it will
  // look after Save" — the whole point of staging.
  const p = { ...P(), moves: { 1: { team: 1, playerNumber: 6 } } };  // Wanda 9 → 6
  eq("a pending move sorts into its NEW position at once", sortedTeam(ORIGIN, p, 1).map((x) => x.spot), [1, 2, 3, 4, 5, 6]);
  is("...and the moved row is marked", sortedTeam(ORIGIN, p, 1).find((x) => x.row.umId === 1)?.moved, true);
  const cross = { ...P(), moves: { 1: { team: 2, playerNumber: 6 } } };  // Wanda → team 2
  eq("a pending CROSS-TEAM move leaves the old team", sortedTeam(ORIGIN, cross, 1).map((x) => x.row.umId), [4, 5, 6, 2, 3]);
  eq("...and appears in the new one, in spot order", sortedTeam(ORIGIN, cross, 2).map((x) => x.spot), [1, 2, 4, 6]);
}
{
  const p = { ...P(), removes: [4] };
  is("a row pending removal still RENDERS (struck through), rather than vanishing before Save",
    sortedTeam(ORIGIN, p, 1).some((x) => x.row.umId === 4 && x.removed), true);
}

console.log("\nthe move picker — one control, two steps, swap and open spot the same gesture");
{
  const spots = spotsOfTeam(ORIGIN, P(), 2, 6);
  eq("the grid offers every spot up to the team's capacity", spots.map((s) => s.n), [1, 2, 3, 4, 5, 6]);
  eq("...naming who holds each one", spots.map((s) => s.who?.name ?? null), ["Gina One", "Gus Two", null, "Gwen Four", null, null]);
  is("an OCCUPIED spot is offered, not blocked — picking it is the swap", spots.find((s) => s.n === 1)?.who?.name, "Gina One");
}
{
  const p = planMove(P(), ORIGIN, ORIGIN.rows[0], 2, 3);   // Wanda (t1 #9) → team 2 spot 3, empty
  eq("moving into an EMPTY spot stages ONE move", Object.keys(p.moves), ["1"]);
  eq("...to exactly where it was aimed", p.moves[1], { team: 2, playerNumber: 3 });
}
{
  const p = planMove(P(), ORIGIN, ORIGIN.rows[0], 2, 1);   // Wanda (t1 #9) → team 2 spot 1, held by Gina
  eq("moving onto an OCCUPIED spot stages TWO moves — it is a swap", Object.keys(p.moves).sort(), ["1", "7"]);
  eq("...the mover takes the target spot", p.moves[1], { team: 2, playerNumber: 1 });
  eq("...and the occupant takes the mover's old place", p.moves[7], { team: 1, playerNumber: 9 });
  const plan = savePlan(p, ORIGIN);
  is("a swap is TWO separate writes — the API has no swap and no transaction", plan.length, 2);
}
{
  // moving a player back to where they came from, in two steps, must leave NOTHING pending
  let p = planMove(P(), ORIGIN, ORIGIN.rows[0], 2, 3);
  p = planMove(p, ORIGIN, ORIGIN.rows[0], 1, 9);
  is("a move OUT and back again is not a change", pendingCount(p, ORIGIN), 0);
}

console.log("\nthe consequence line, stated BEFORE the click");
{
  const line = teamCountConsequence(ORIGIN, P(), 1)!;
  is("dropping to 1 team names the team removed", line.includes("Team 2 is removed"), true);
  is("...and counts the players who move", line.includes("3 players move to team 1"), true);
  is("...and refuses to claim it knows where the server puts them", line.includes("the SERVER decides where"), true);
  is("growing the team count says nobody moves", teamCountConsequence(ORIGIN, P(), 4)!.includes("Nobody moves"), true);
  is("the current count has no consequence to state", teamCountConsequence(ORIGIN, P(), 2), null);
  const withMove = { ...P(), teamCount: 4, moves: { 1: { team: 4, playerNumber: 1 } } };
  is("a reduction warns that it will drop pending moves into removed teams",
    teamCountConsequence(ORIGIN, withMove, 2)?.includes("pending move") ?? false, false); // 2 is the current count → no line
  is("...and does warn when the reduction is real",
    teamCountConsequence({ ...ORIGIN, teams: [...ORIGIN.teams, { id: 93, teamNumber: 3, name: "Blue" }, { id: 94, teamNumber: 4, name: "Black" }] }, withMove, 2)!.includes("pending move"), true);
}

console.log("\neffectiveRow — what the UI draws is what Save will send");
{
  const p = { ...P(), moves: { 2: { team: 2, playerNumber: 5 } }, removes: [3] };
  eq("a moved row reports its NEW place", effectiveRow(ORIGIN.rows[1], p, ORIGIN), { team: 2, playerNumber: 5, moved: true, removed: false });
  eq("a removed row reports itself removed", effectiveRow(ORIGIN.rows[2], p, ORIGIN), { team: 1, playerNumber: 5, moved: false, removed: true });
  eq("an untouched row reports the server's values", effectiveRow(ORIGIN.rows[0], p, ORIGIN), { team: 1, playerNumber: 9, moved: false, removed: false });
}

console.log("\nPII — a phone is shown on screen and NEVER logged");
{
  // The panel now renders a full phone number. change_log has different access rules and a longer
  // life than the panel, and the standing rule there is last-4 via phoneLast4(). These assert that
  // NOTHING the save plan produces can carry a phone — the plan IS what becomes the request body
  // and the change labels, so if a number cannot appear here it cannot reach the log.
  const phoned: RosterOrigin = {
    teams: ORIGIN.teams,
    rows: [row(1, 1, 1, "Wynn One", "+15125551234"), row(2, 1, 2, "Wade Two", "+15125559876")],
  };
  const p: Pending = { teamCount: 4, moves: { 1: { team: 2, playerNumber: 3 } }, removes: [2], names: { 91: "Whites" } };
  const plan = savePlan(p, phoned);
  const serialised = JSON.stringify(plan);
  const phones = phoned.rows.map((r) => r.phone!);

  is("the plan covers every pending edit (so this is not vacuously clean)", plan.length, 4);
  is("no full phone number appears anywhere in the write plan",
    phones.some((ph) => serialised.includes(ph)), false);
  is("...nor any 7+ digit run that could be one",
    /\d{7,}/.test(serialised.replace(/"umId":\d+|"teamId":\d+/g, "")), false);
  is("the plan DOES carry the name, which is what a log entry is allowed to say",
    serialised.includes("Wynn One") && serialised.includes("Wade Two"), true);

  // MUTATION: put a phone where the code must never put one, and prove the assertion goes red.
  // Without this, "no phone found" could mean the check simply cannot see one.
  const mutated = JSON.stringify(plan.map((w) => ({ ...w, label: `${w.label} ${phones[0]}` })));
  is("MUTATION — the same check FAILS when a phone is planted in the plan",
    phones.some((ph) => mutated.includes(ph)), true);
  is("MUTATION — and the digit-run check catches it too", /\d{7,}/.test(mutated.replace(/"umId":\d+|"teamId":\d+/g, "")), true);

  // and the sanctioned form is still what the log rule asks for
  is("phoneLast4 is what a log may hold instead", phoneLast4("+15125551234"), "1234");
}
{
  // ...and the SERVER half. The client cannot send a phone, but the route builds change_log's
  // `changes` itself from the players payload — which DOES carry phoneNumber now. Assert on the
  // source: the phone may be read only in the GET mapping, never anywhere the POST handler
  // (recordWrite, the change labels, nameOf) can reach.
  const src = readFileSync("src/app/api/matchday/[env]/roster/[matchId]/route.ts", "utf8");
  const postHalf = src.slice(src.indexOf("export async function POST"));
  is("the roster route DOES read the phone (so this is not vacuous)", /phoneNumber/.test(src), true);
  is("...only in GET — the POST half, which is what builds change_log, never touches it",
    /phone/i.test(postHalf), false);
  is("the change labels are built from names, which a log entry may hold", /nameOf\(/.test(postHalf), true);

  // MUTATION: put a phone read into the POST half and prove the assertion goes red.
  const mutatedPost = postHalf.replace("const nameOf =", "const leak = (p) => p.user?.phoneNumber;\n  const nameOf =");
  is("MUTATION — the same check FAILS when the POST half reads a phone", /phone/i.test(mutatedPost), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
