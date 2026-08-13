// Phase 26 — the check-in model, unit-tested. Includes a LIVE idempotency proof against
// match_checkin_marks: the upsert that the optimistic-sync design rests on must leave ONE row.
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-checkin-model.ts
process.loadEnvFile(".env.local");

import { createClient } from "@supabase/supabase-js";
import {
  WEIGHT, LABEL, strikeValueFor, displayName, initials, avatarColor, matchesSearch,
  perTeamCapacity, filterPlayers, todoCount, markedCount, teamIsFinished, teamCollapsed,
  nextStatus, spotGrid, planMove, type CheckinPlayer,
} from "../src/lib/checkinModel";

let PASS = 0, FAIL = 0;
const ok = (n: string) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { FAIL++; console.log(`  XX  ${n} — ${d}`); };
const is = (n: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const P = (o: Partial<CheckinPlayer> & { userMatchId: number }): CheckinPlayer => ({
  playerId: o.userMatchId * 10, fullName: "X Y", team: 1, playerNumber: null, avatar: null,
  status: null, ...o,
});

console.log("weights — ours, and the number is stored not re-derived:");
is("late = 1", WEIGHT.late, 1);
is("no show = 2", WEIGHT.no_show, 2);
is("on time = 0", WEIGHT.ok, 0);
is("strikeValueFor mirrors the map", [strikeValueFor("ok"), strikeValueFor("late"), strikeValueFor("no_show")], [0, 1, 2]);
is("labels are the manager's words", [LABEL.ok, LABEL.late, LABEL.no_show], ["On time", "Late", "No show"]);

console.log("\nname shortening — like a person, never chopped mid-word:");
is("a short name is left alone", displayName("Ravi Chan"), { name: "Ravi Chan", guest: false });
is("a long name becomes First L.", displayName("Ravi Chandrasekaran"), { name: "Ravi C.", guest: false });
is("Marcus Oyelaran-Whyte → Marcus O., never 'Marcu…'", displayName("Marcus Oyelaran-Whyte").name, "Marcus O.");
is("a long SINGLE word is not initialised into nonsense", displayName("Chandrasekaranathan"), { name: "Chandrasekaranathan", guest: false });
is("a guest suffix is detected and stripped", displayName("Tom Weir (guest)"), { name: "Tom Weir", guest: true });
is("a long guest name shortens AND flags", displayName("Bartholomew Cunningham (guest)"), { name: "Bartholomew C.", guest: true });

console.log("\nsearch matches the FULL name even when the row shows a short one:");
is("full surname finds a shortened row", matchesSearch("Ravi Chandrasekaran", "chandrasek"), true);
is("the shortened form still matches", matchesSearch("Ravi Chandrasekaran", "ravi"), true);
is("a non-match is a non-match", matchesSearch("Ravi Chandrasekaran", "zzz"), false);
is("empty query matches everything", matchesSearch("Anyone", ""), true);

console.log("\navatars — same box, stable colour:");
is("two letters", initials("Marcus Oyelaran"), "MO");
is("one word gives one letter", initials("Pelé"), "P");
is("junk gives a placeholder, never a crash", initials("123 !!"), "?");
is("colour is stable for the same name", avatarColor("Marcus O") === avatarColor("Marcus O"), true);

console.log("\ncapacity — from the TOTAL fields ÷ team count (production 17522):");
is("4 teams: maxTeamSize4Team 36 ÷ 4 = 9 per team", perTeamCapacity({ teamCount: 4, maxTeamSize2Team: 18, maxTeamSize4Team: 36 }), 9);
is("2 teams: maxTeamSize2Team 18 ÷ 2 = 9 per side", perTeamCapacity({ teamCount: 2, maxTeamSize2Team: 18, maxTeamSize4Team: 36 }), 9);
is("a 2-team 20-total match is 10 a side (the mockup's stand-in, now derived)", perTeamCapacity({ teamCount: 2, maxTeamSize2Team: 20 }), 10);
is("falls back to maxPlayerCount when the sized field is absent", perTeamCapacity({ teamCount: 2, maxPlayerCount: 18 }), 9);
is("no capacity anywhere → null, never a guessed number", perTeamCapacity({ teamCount: 2 }), null);
is("zero teams → null, never a divide by zero", perTeamCapacity({ teamCount: 0, maxTeamSize2Team: 18 }), null);

console.log("\nthe to-do filter — the default, and it SHRINKS as work is done:");
{
  const ps = [P({ userMatchId: 1 }), P({ userMatchId: 2, status: "ok" }), P({ userMatchId: 3, status: "late" }), P({ userMatchId: 4, status: "no_show" })];
  is("todo shows only the unmarked", filterPlayers(ps, "todo").map((p) => p.userMatchId), [1]);
  is("all shows everyone", filterPlayers(ps, "all").length, 4);
  is("by status filters to that status", filterPlayers(ps, "late").map((p) => p.userMatchId), [3]);
  is("counts agree with the list", [markedCount(ps), todoCount(ps)], [3, 1]);
  // the shrink itself: marking the last unmarked player empties the to-do list
  const after = ps.map((p) => (p.userMatchId === 1 ? { ...p, status: "ok" as const } : p));
  is("marking the last one empties to-do", filterPlayers(after, "todo").length, 0);
  is("search composes with the filter", filterPlayers([P({ userMatchId: 9, fullName: "Ravi Chandrasekaran" }), P({ userMatchId: 8, fullName: "Tom Weir" })], "todo", "chandra").map((p) => p.userMatchId), [9]);
}

console.log("\ntap-again clears — the undo, same thumb position:");
is("tapping a different mark sets it", nextStatus("ok", "late"), "late");
is("tapping the SAME mark clears it", nextStatus("late", "late"), null);
is("tapping an unmarked player sets it", nextStatus(null, "no_show"), "no_show");

console.log("\nfinished teams collapse, and re-opening sticks:");
{
  const ps = [P({ userMatchId: 1, team: 1, status: "ok" }), P({ userMatchId: 2, team: 1, status: "late" }), P({ userMatchId: 3, team: 2 })];
  is("a fully-marked team is finished", teamIsFinished(ps, 1), true);
  is("a team with work left is not", teamIsFinished(ps, 2), false);
  is("an EMPTY team is not 'finished' (nothing was done)", teamIsFinished(ps, 3), false);
  is("finished collapses by default", teamCollapsed(ps, 1, new Set()), true);
  is("re-opening sticks", teamCollapsed(ps, 1, new Set([1])), false);
}

console.log("\nthe spot grid, and the swap plan (TWO writes, no transaction):");
{
  const a = P({ userMatchId: 1, team: 1, playerNumber: 3, fullName: "A" });
  const b = P({ userMatchId: 2, team: 2, playerNumber: 5, fullName: "B" });
  const grid = spotGrid([a, b], 1, 4);
  is("every spot 1..capacity exists", grid.map((s) => s.n), [1, 2, 3, 4]);
  is("the held spot carries its player", grid.find((s) => s.n === 3)?.who?.userMatchId, 1);
  is("an open spot is null, not missing", grid.find((s) => s.n === 1)?.who, null);

  const fill = planMove(b, 1, 1, null);
  is("moving to an OPEN spot is ONE write", { steps: fill.steps.length, isSwap: fill.isSwap }, { steps: 1, isSwap: false });
  const swap = planMove(b, 1, 3, a);
  is("moving onto an OCCUPIED spot is TWO writes, in order", { steps: swap.steps.length, isSwap: swap.isSwap }, { steps: 2, isSwap: true });
  is("step 1 moves the mover in", swap.steps[0], { userMatchId: 2, team: 1, playerNumber: 3 });
  is("step 2 sends the occupant to the mover's old spot", swap.steps[1], { userMatchId: 1, team: 2, playerNumber: 5 });
  is("dropping a player on their OWN spot is not a swap", planMove(a, 1, 3, a).isSwap, false);
}

// Top-level await is not available under the tsx/cjs transform the gate uses, so the live
// section runs inside main().
async function main() {
  // ── LIVE: the upsert idempotency the whole optimistic design rests on ──
  console.log("\nidempotency — the same mark twice leaves ONE row (live, against match_checkin_marks):");
  {
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const MATCH = -999999, PLAYER = -888888; // negative ids cannot collide with real data
    await sb.from("match_checkin_marks").delete().eq("match_id", MATCH);
    const row = { match_id: MATCH, player_id: PLAYER, status: "late", strike_value: 1, marked_by: "model-test" };
    await sb.from("match_checkin_marks").upsert(row, { onConflict: "match_id,player_id" });
    await sb.from("match_checkin_marks").upsert(row, { onConflict: "match_id,player_id" });
    await sb.from("match_checkin_marks").upsert(row, { onConflict: "match_id,player_id" });
    const after = await sb.from("match_checkin_marks").select("status,strike_value").eq("match_id", MATCH);
    is("three identical upserts leave exactly ONE row", (after.data ?? []).length, 1);
    // and a CHANGED status updates in place rather than adding a second row
    await sb.from("match_checkin_marks").upsert({ ...row, status: "no_show", strike_value: 2 }, { onConflict: "match_id,player_id" });
    const changed = await sb.from("match_checkin_marks").select("status,strike_value").eq("match_id", MATCH);
    is("re-marking updates in place", { n: (changed.data ?? []).length, row: (changed.data ?? [])[0] }, { n: 1, row: { status: "no_show", strike_value: 2 } });
    // clearing deletes — absence means unmarked, which is not a status value
    await sb.from("match_checkin_marks").delete().eq("match_id", MATCH).eq("player_id", PLAYER);
    const cleared = await sb.from("match_checkin_marks").select("status").eq("match_id", MATCH);
    is("clearing removes the row entirely", (cleared.data ?? []).length, 0);
    // the CHECK constraint refuses a status outside the allowlist
    const badIns = await sb.from("match_checkin_marks").insert({ match_id: MATCH, player_id: PLAYER, status: "maybe", strike_value: 0, marked_by: "model-test" });
    is("an unknown status is REFUSED by the DB, not just by the UI", !!badIns.error, true);
    await sb.from("match_checkin_marks").delete().eq("match_id", MATCH);
  }
}

main().then(() => {
  console.log(`\n${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}).catch((e) => { console.log('XX live section threw —', e?.message ?? e); process.exit(1); });
