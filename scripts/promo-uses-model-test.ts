import "server-only"; // no-op under --conditions=react-server
// The promo USES model — the arithmetic that answers "is somebody working this code".
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/promo-uses-model-test.ts

import { groupUses, summarise, byTime, money, loggableUsesSummary, type UseRow } from "../src/lib/promoUsesModel";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) => (got === want ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const eq = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

// deleted rows KEEP their player id (Part 0) — pass deleted:true, not a null id.
const R = (id: number, playerId: number | null, at: string, extra: Partial<UseRow> = {}): UseRow => ({
  id, playerId, deleted: false, name: playerId ? `P${playerId}` : null,
  email: playerId ? `p${playerId}@x.com` : null, phone: playerId ? "+15125550142" : null,
  at, matchId: 1, match: "NEMP - Field 13", kickoff: "Thu Aug 13, 6:30 PM", city: "ATX",
  amountCents: 1500, ...extra,
});

console.log("\nDISTINCT USERS, not distinct rows");
{
  // 5 uses by one person, 2 by another, 1 by a third = 8 rows / 3 people
  const rows = [
    R(1, 4471, "2026-08-13T21:04"), R(2, 4471, "2026-08-13T20:58"), R(3, 4471, "2026-08-12T19:22"),
    R(4, 4471, "2026-08-12T19:19"), R(5, 4471, "2026-08-11T10:41"),
    R(6, 9902, "2026-08-12T16:30"), R(7, 9902, "2026-08-11T15:02"),
    R(8, 3310, "2026-08-11T11:47"),
  ];
  const s = summarise(rows, 2);
  is("8 redemptions", s.total, 8);
  is("...by 3 distinct accounts, not 8", s.distinctUsers, 3);
  is("...averaging 2.7 uses each", s.usesPerUser.toFixed(1), "2.7");
  eq("the heaviest user sorts FIRST", groupUses(rows, 2).map((g) => g.uses), [5, 2, 1]);
}

console.log("\nTHE BREACH MARKER — only when a PERSON exceeds the cap");
{
  // TOMBALL, the real case: 10 redemptions, cap 2, but TEN different people.
  const tomball = Array.from({ length: 10 }, (_, i) => R(i + 1, 1000 + i, `2026-08-1${i % 5}T10:00`));
  const s = summarise(tomball, 2);
  is("10 redemptions", s.total, 10);
  is("...across 10 distinct accounts", s.distinctUsers, 10);
  is("NO BREACH — 10 uses against a cap of 2 is fine when it is 10 people", s.breach, false);
  is("...and nobody is listed as a breacher", s.breachers.length, 0);
}
{
  const rows = [R(1, 7, "2026-08-13T10:00"), R(2, 7, "2026-08-12T10:00"), R(3, 7, "2026-08-11T10:00")];
  const s = summarise(rows, 2);
  is("3 uses by ONE account against a cap of 2 IS a breach", s.breach, true);
  is("...naming the one account", s.breachers.map((g) => g.playerId).join(","), "7");
  is("...and the money it cost", money(s.breachWorthCents), "$45.00");
}
{
  // the boundary — a cap of 2 PERMITS 2
  is("exactly at the cap is NOT a breach", summarise([R(1, 7, "a"), R(2, 7, "b")], 2).breach, false);
  is("one over the cap IS", summarise([R(1, 7, "a"), R(2, 7, "b"), R(3, 7, "c")], 2).breach, true);
  // MUTATION: the >= boundary error that would cry wolf on every compliant account
  const groups = groupUses([R(1, 7, "a"), R(2, 7, "b")], 2);
  is("MUTATION — a >= comparison would flag a compliant account", groups[0].uses >= 2, true);
  is("...while the correct > comparison does not", groups[0].overCap, false);
}

console.log("\nA DELETED ACCOUNT IS A FINDING, NOT AN ERROR");
{
  const D = (id: number, at: string) => R(id, 88213, at, { deleted: true, name: null, email: null, phone: null });
  const rows = [D(6, "2026-08-13T08:12"), D(7, "2026-08-12T07:55"), R(8, 9902, "2026-08-12T16:30")];
  const g = groupUses(rows, 2);
  const dead = g.find((x) => x.deleted)!;
  is("a deleted account still forms a group", !!dead, true);
  is("...marked deleted rather than blank", dead.deleted, true);
  is("...keeping a reference to whatever id survived", dead.deletedRef?.startsWith("user "), true);
  is("...and KEEPING its redemptions", dead.rows.length, 2);
  is("...with its name null rather than an empty string pretending to be a name", dead.name, null);
  is("a deleted account counts toward DISTINCT USERS — it is still one person", summarise(rows, 2).distinctUsers, 2);
  // two DIFFERENT deleted accounts must not merge into one
  const two = groupUses([R(1, 111, "a", { deleted: true }), R(2, 222, "b", { deleted: true })], 2);
  is("two different deleted rows do not collapse into one bucket", two.length, 2);
}
{
  // a deleted account can itself breach — that is the case most worth catching
  const s = summarise([1, 2, 3].map((i) => R(i, 88213, `2026-08-1${i}`, { deleted: true, name: null })), 2);
  is("a deleted account's uses GROUP on its surviving id and CAN breach", s.breach, true);
  is("...as one account, not three", s.distinctUsers, 1);
}

console.log("\nNEWEST FIRST in both views");
{
  const rows = [R(1, 7, "2026-08-11T10:00"), R(2, 7, "2026-08-13T10:00"), R(3, 7, "2026-08-12T10:00")];
  eq("within a person group", groupUses(rows, 5)[0].rows.map((r) => r.id), [2, 3, 1]);
  eq("and in the by-time view", byTime(rows).map((r) => r.id), [2, 3, 1]);
}
{
  const rows = [R(1, 7, "2026-08-13T10:00"), R(2, 88213, "2026-08-14T10:00", { deleted: true })];
  eq("THE BY-TIME VIEW KEEPS DELETED ROWS — dropping them would make the views disagree",
    byTime(rows).map((r) => r.id), [2, 1]);
  is("...and there are still two of them", byTime(rows).length, 2);
}

console.log("\nTHE MONEY is shown per group");
{
  const rows = [R(1, 7, "a"), R(2, 7, "b"), R(3, 9, "c", { amountCents: 750 })];
  const g = groupUses(rows, 5);
  is("a group's worth is the sum of its rows", money(g[0].worthCents), "$30.00");
  is("...and a discounted spot counts at what it was worth", money(g[1].worthCents), "$7.50");
  is("the total is the sum of everything", money(summarise(rows, 5).worthCents), "$37.50");
  is("a free (100%) spot still has a face value to report", money(1500), "$15.00");
}

console.log("\nPII — displayed on screen, NEVER in change_log");
{
  const rows = [R(1, 4471, "a"), R(2, 4471, "b"), R(3, 4471, "c")];
  const s = summarise(rows, 2);
  const logged = loggableUsesSummary(21494, s);
  const blob = JSON.stringify(logged);
  is("the group carries the email for the SCREEN", groupUses(rows, 2)[0].email, "p4471@x.com");
  is("...and the phone", groupUses(rows, 2)[0].phone, "+15125550142");
  is("the LOGGED object carries no email", /@/.test(blob), false);
  is("...no phone", /\+?1?\d{10,}/.test(blob), false);
  is("...no name", /P4471/.test(blob), false);
  is("...but DOES carry the offending player id, which is the point", blob.includes("4471"), true);
  is("...and the counts", logged.redemptions, 3);
  // MUTATION — prove the assertion can fail
  const mutated = JSON.stringify({ ...logged, who: "P4471 p4471@x.com +15125550142" });
  is("MUTATION — planting the email in the payload makes the check FAIL", /@/.test(mutated), true);
  is("MUTATION — and the phone check too", /\+?1?\d{10,}/.test(mutated), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
