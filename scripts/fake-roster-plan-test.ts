/* THE FAKE-ROSTER PLANNER. Pure, so this is a node guard rather than a browser suite — it covers a
 * write that changes what a player sees on the match page, which is the bucket that gets checks.
 *
 * THE ASSERTION THIS FILE EXISTS FOR is "a real player is never in a removal plan". Everything else
 * here is arithmetic; that one is the safety property.
 */
import { planFakeRoster, fakePlanNote, type PlanRow } from "../src/lib/fakeRosterPlan";

let pass = 0, fail = 0;
const fails: string[] = [];
const ok = (n: string) => { pass++; };
const bad = (n: string, d = "") => { fail++; fails.push(`${n} — ${d}`); };
const is = (n: string, got: unknown, exp: unknown) =>
  JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`);
const yes = (n: string, got: boolean, d = "") => (got === true ? ok(n) : bad(n, d || "was false"));

let umId = 1000;
const fake = (team: number, playerNumber: number | null, extra: Partial<PlanRow> = {}): PlanRow =>
  ({ id: umId++, team, playerNumber, user: { isFakePlayer: true }, ...extra });
const real = (team: number, playerNumber: number | null, extra: Partial<PlanRow> = {}): PlanRow =>
  ({ id: umId++, team, playerNumber, user: { isFakePlayer: false }, ...extra });

// ── the production case, exactly as reported ────────────────────────────────────────────────────
// 18318: capacity 20, 7 real, 10 fakes sitting 4 in White Tee and 6 in Dark Tee. The operator sets
// "7 spots left", which is a target of 20 - 7 - 7 = 6 fakes, so four must go.
{
  umId = 1000;
  const whites = [1, 2, 3, 4].map((n) => fake(1, n));
  const darks = [1, 2, 3, 4, 5, 6].map((n) => fake(2, n));
  const reals = [5, 6, 7, 8].map((n) => real(1, n)).concat([7, 8, 9].map((n) => real(2, n)));
  const rows = [...whites, ...darks, ...reals];
  const p = planFakeRoster({ rows, capacity: 20, targetFakes: 6 });

  is("18318: counts 10 live fakes", p.liveFakes, 10);
  is("18318: counts 7 live reals", p.liveReal, 7);
  is("18318: adds nothing", p.add, 0);
  is("18318: removes exactly four", p.removes.length, 4);
  is("18318: and it is not a no-op", p.noop, false);
  is("18318: no refusal", p.refusal, null);

  // THE SAFETY PROPERTY. Every removed id must be one of the ten fake rows and none of the seven
  // real ones — asserted against the actual id sets, not against a count.
  const fakeIds = new Set([...whites, ...darks].map((r) => r.id));
  const realIds = new Set(reals.map((r) => r.id));
  is("18318: EVERY REMOVAL IS A FAKE", p.removes.filter((r) => !fakeIds.has(r.id)).map((r) => r.id), []);
  is("18318: NO REAL PLAYER IS IN THE PLAN", p.removes.filter((r) => realIds.has(r.id)).map((r) => r.id), []);

  // Team balance: 4/6 losing four should land 3/3, not 4/2 or 0/6.
  const left = { 1: 4, 2: 6 } as Record<number, number>;
  for (const r of p.removes) left[r.team]--;
  is("18318: the survivors are balanced 3/3", left, { 1: 3, 2: 3 });
  is("18318: three came from the fuller team", p.removes.filter((r) => r.team === 2).length, 3);

  // Deterministic: the same input twice gives the same plan.
  const q = planFakeRoster({ rows, capacity: 20, targetFakes: 6 });
  is("18318: the plan is deterministic", p.removes.map((r) => r.id), q.removes.map((r) => r.id));

  // Highest slot number goes first within a team.
  const darkRemoved = p.removes.filter((r) => r.team === 2).map((r) => r.playerNumber);
  is("18318: the highest slots go first", darkRemoved, [6, 5, 4]);

  yes("18318: the note names the counts and the teams", /removed 4 fakes \(10 to 6\)/.test(fakePlanNote(p, 6)));
}

// ── a real player is never removed even when the roster is ALL real ─────────────────────────────
{
  umId = 2000;
  const rows = [1, 2, 3, 4, 5].map((n) => real(1, n));
  const p = planFakeRoster({ rows, capacity: 18, targetFakes: 0 });
  is("all-real: zero fakes counted", p.liveFakes, 0);
  is("all-real: five reals counted", p.liveReal, 5);
  is("all-real: target 0 is already true", p.noop, true);
  is("all-real: NOTHING IS REMOVED", p.removes, []);
  // CONTROL: the same roster asked for a REDUCTION it cannot make must still not touch a real row.
  const q = planFakeRoster({ rows, capacity: 18, targetFakes: 0 });
  is("all-real CONTROL: still nothing removed", q.removes.length, 0);
}

// ── adding ──────────────────────────────────────────────────────────────────────────────────────
{
  umId = 3000;
  const rows = [...[1, 2].map((n) => fake(1, n)), ...[1, 2, 3].map((n) => real(2, n))];
  const p = planFakeRoster({ rows, capacity: 18, targetFakes: 9 });
  is("add: 2 fakes to 9 adds seven", p.add, 7);
  is("add: removes nothing", p.removes, []);
  yes("add: the note says added", /added 7 fakes \(2 to 9\)/.test(fakePlanNote(p, 9)));
}

// ── the ceiling is a refusal, not a clamp ───────────────────────────────────────────────────────
{
  umId = 4000;
  const rows = [...[1, 2].map((n) => fake(1, n)), ...[1, 2, 3, 4, 5].map((n) => real(2, n))];
  // capacity 10, five real -> at most five fakes. Asking for six must refuse.
  const p = planFakeRoster({ rows, capacity: 10, targetFakes: 6 });
  yes("ceiling: asking past capacity minus real REFUSES", p.refusal !== null);
  yes(`ceiling: the refusal states the arithmetic — "${p.refusal}"`, /capacity 10 less 5 real players leaves 5/.test(p.refusal ?? ""));
  is("ceiling: and plans NOTHING", [p.add, p.removes.length], [0, 0]);
  // CONTROL: one fewer is allowed, so the refusal is a boundary and not a blanket.
  const q = planFakeRoster({ rows, capacity: 10, targetFakes: 5 });
  is("ceiling CONTROL: exactly capacity minus real is allowed", q.refusal, null);
  is("ceiling CONTROL: ...and it adds three", q.add, 3);
}

// ── DEAD ROWS ARE NOT FAKES. This is the rosterRowCounts trap, on this feature. ──────────────────
{
  umId = 5000;
  const liveFakes = [1, 2].map((n) => fake(1, n));
  const dead = [
    fake(1, 3, { paidStatus: "WAITING" }),
    fake(1, 4, { isCancelled: true }),
    fake(2, 1, { canceledAt: "2026-09-01T00:00:00Z" }),
    fake(2, 2, { refunded: true }),
  ];
  const reals = [1, 2, 3].map((n) => real(2, n + 10));
  const p = planFakeRoster({ rows: [...liveFakes, ...dead, ...reals], capacity: 18, targetFakes: 1 });
  is("dead rows: only the two LIVE fakes are counted", p.liveFakes, 2);
  is("dead rows: only the three live reals are counted", p.liveReal, 3);
  is("dead rows: one removal, not five", p.removes.length, 1);
  const deadIds = new Set(dead.map((r) => r.id));
  is("dead rows: NO DEAD ROW IS EVER REMOVED", p.removes.filter((r) => deadIds.has(r.id)).map((r) => r.id), []);
  // CONTROL: without the rosterRowCounts filter this roster reads as six fakes, so the numbers
  // above are not what a naive count produces.
  is("dead rows CONTROL: the raw fake-flagged row count really is 6", [...liveFakes, ...dead].length, 6);
}

// ── isFakePlayer on the row itself, not only under .user ────────────────────────────────────────
{
  umId = 6000;
  const rows: PlanRow[] = [
    { id: 6001, team: 1, playerNumber: 1, isFakePlayer: true },
    { id: 6002, team: 1, playerNumber: 2, user: { isFakePlayer: true } },
    { id: 6003, team: 2, playerNumber: 1, user: { isFakePlayer: false } },
  ];
  const p = planFakeRoster({ rows, capacity: 18, targetFakes: 0 });
  is("both fake shapes are recognised", p.liveFakes, 2);
  is("...and both are removable", p.removes.length, 2);
  is("...and the real row is not", p.removes.filter((r) => r.id === 6003), []);
}

// ── a null playerNumber sorts LAST, so it is removed first ──────────────────────────────────────
{
  umId = 7000;
  const rows = [fake(1, 5), fake(1, null), fake(1, 2)];
  const p = planFakeRoster({ rows, capacity: 18, targetFakes: 2 });
  is("null slot: exactly one removal", p.removes.length, 1);
  is("null slot: the null-slot row goes first", p.removes[0].playerNumber, null);
}

// ── a fake with no usable user-match id cannot be named, so the plan refuses ─────────────────────
{
  const rows: PlanRow[] = [
    { id: 0, team: 1, playerNumber: 1, user: { isFakePlayer: true } },
    { team: 1, playerNumber: 2, user: { isFakePlayer: true } } as PlanRow,
  ];
  const p = planFakeRoster({ rows, capacity: 18, targetFakes: 0 });
  is("unnamed rows: two fakes counted", p.liveFakes, 2);
  yes("unnamed rows: REFUSES rather than guessing at a row", p.refusal !== null);
  is("unnamed rows: and plans no deletes", p.removes, []);
}

// ── a negative target is not a number of players ────────────────────────────────────────────────
{
  umId = 8000;
  const p = planFakeRoster({ rows: [fake(1, 1)], capacity: 18, targetFakes: -1 });
  yes("negative target refuses", p.refusal !== null);
  is("negative target plans nothing", [p.add, p.removes.length], [0, 0]);
}

// ── no capacity (a special event, maxPlayerCount 0/null) skips the ceiling but nothing else ─────
{
  umId = 9000;
  const rows = [1, 2, 3].map((n) => fake(1, n));
  const p = planFakeRoster({ rows, capacity: 0, targetFakes: 1 });
  is("no capacity: the ceiling does not fire", p.refusal, null);
  is("no capacity: two removals planned", p.removes.length, 2);
}

console.log(`fake-roster-plan: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
