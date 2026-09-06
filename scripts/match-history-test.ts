import "server-only"; // no-op under --conditions=react-server
/* ONE PLAYER'S MATCH HISTORY: the four states, the merge, and the charge join.
 *
 * THE ONE THAT MATTERS MOST IS THE KEY. stripePayments folded metadata.matchId and
 * metadata.userMatchId into a single field named `matchId`, so a charge carrying only a
 * userMatchId stored a USER-MATCH id under a MATCH id's name. Joined against a match api_id that
 * puts a real dollar amount on the wrong match — and nothing looks broken, because the number is
 * real and the row is real and only the pairing is wrong. Both ids are small integers from
 * overlapping ranges, so the collision is not exotic: the test below uses 18321, which is a real
 * match, arriving as a userMatchId.
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/match-history-test.ts
 */
import { readFileSync } from "node:fs";
import {
  MATCH_STATE_LABEL, MATCH_STATE_TONE, attachCharges, chargeLabel, isCancelled, mergeHistory,
  sortHistory, type ChargeLike, type HistoryRow, type MirrorRow,
} from "../src/lib/matchHistory";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const yes = (n: string, c: boolean, d = "") => (c ? ok(n) : bad(n, d));

const R = (over: Partial<HistoryRow> = {}): HistoryRow => ({
  umId: 1, matchId: 100, name: "A match", startDate: "2026-09-05T20:00:00.000Z",
  startDateUtc: "2026-09-06T01:00:00.000Z", team: null, num: null, price: 1299, charged: null,
  userStatus: null, state: "played", removable: false, mirrorOnly: false, ...over,
});
const C = (over: Partial<ChargeLike> = {}): ChargeLike => ({
  id: "ch_1", amount: 1624, status: "succeeded", created: "2026-09-05T18:00:00.000Z",
  card: "visa ••1216", matchId: null, userMatchId: null, isMembership: false, ...over,
});

console.log("— four states, because four different things happen —");
is("the four are named", Object.keys(MATCH_STATE_LABEL).sort(), ["club_cancelled", "played", "player_cancelled", "upcoming"]);
is("he cancelled, and we cancelled, read differently",
  [MATCH_STATE_LABEL.player_cancelled, MATCH_STATE_LABEL.club_cancelled], ["They cancelled", "We cancelled"]);
// NEITHER CANCELLATION IS RED. Amber at most for his decision; informational for ours.
is("his cancellation is amber — it may carry a strike", MATCH_STATE_TONE.player_cancelled, "amber");
is("ours is informational — he did nothing wrong", MATCH_STATE_TONE.club_cancelled, "info");
yes("neither is red", !Object.values(MATCH_STATE_TONE).includes("red" as never));
is("both still answer 'this did not happen'", [isCancelled("player_cancelled"), isCancelled("club_cancelled")], [true, true]);
is("…and played and upcoming do not", [isCancelled("played"), isCancelled("upcoming")], [false, false]);

console.log("\n— the merge: the mirror fills gaps, it never overwrites —");
const api = [R({ matchId: 100, name: "API row", price: 1299 })];
const mirror: MirrorRow[] = [
  { matchId: 100, name: "mirror's version", startDate: null, startDateUtc: null, state: "played" },
  { matchId: 18321, name: "Parmer Stadium", startDate: "2026-09-05T20:00:00.000Z", startDateUtc: "2026-09-06T01:00:00.000Z", state: "club_cancelled" },
];
const merged = mergeHistory(api, mirror);
is("a match the API already sent is NOT replaced by the mirror's copy",
  merged.find((m) => m.matchId === 100)?.name, "API row");
is("…and keeps the API's price", merged.find((m) => m.matchId === 100)?.price, 1299);
is("a match the API omitted is added", merged.find((m) => m.matchId === 18321)?.name, "Parmer Stadium");
is("…marked as coming from the mirror", merged.find((m) => m.matchId === 18321)?.mirrorOnly, true);
is("…and the API's rows are not", merged.find((m) => m.matchId === 100)?.mirrorOnly, false);
/* NOT $0.00. The mirror does not know what a booking cost, and zero is a claim about money. The
 * merged row starts as "not looked for" (prints nothing); once charges HAVE been looked for and
 * none matched, it says so in words. */
is("a merged row starts with no charge looked for", chargeLabel(merged.find((m) => m.matchId === 18321)!), null);
is("…and after looking and finding none it says so, never $0.00",
  chargeLabel(attachCharges(merged, []).find((m) => m.matchId === 18321)!), "no charge found");
is("…and its price is not dressed up as a charge", merged.find((m) => m.matchId === 18321)?.price, 0);
// The mirror holds one row per REGISTRATION, so a player who booked two spots has two rows.
const dupes = mergeHistory([], [mirror[1], { ...mirror[1] }, { ...mirror[1] }]);
is("three registrations on one match make ONE row", dupes.length, 1);

console.log("\n— the played count does not move —");
const playedOf = (rows: readonly HistoryRow[]) => rows.filter((m) => m.state === "played").length;
is("merging cancelled rows in leaves the played count alone", playedOf(merged), playedOf(api));
is("…even when several are merged", playedOf(mergeHistory(api, [
  mirror[1], { ...mirror[1], matchId: 2 }, { ...mirror[1], matchId: 3 },
])), 1);

console.log("\n— ordering is by the INSTANT, never by the label —");
const rows = sortHistory([
  R({ matchId: 1, startDate: "2026-01-01T20:00:00.000Z", startDateUtc: "2026-01-02T02:00:00.000Z", state: "played" }),
  R({ matchId: 2, startDate: "2026-09-05T20:00:00.000Z", startDateUtc: "2026-09-06T01:00:00.000Z", state: "club_cancelled" }),
  R({ matchId: 3, startDate: "2026-05-01T20:00:00.000Z", startDateUtc: "2026-05-02T01:00:00.000Z", state: "upcoming" }),
]);
is("newest first", rows.map((r) => r.matchId), [2, 3, 1]);
// A wall-clock sort would give the same answer here BY LUCK; the point is which field is read.
yes("…and the field read is startDateUtc",
  /Date\.parse\(b\.startDateUtc \?\? ""\)/.test(readFileSync("src/lib/matchHistory.ts", "utf8")));

console.log("\n— THE CHARGE JOIN, and the key that is not what it says —");
{
  const row = R({ matchId: 18321, umId: 55 });
  // A charge that genuinely carries a MATCH id joins.
  const byMatch = attachCharges([row], [C({ matchId: "18321" })]);
  is("a matchId charge joins to the match row", byMatch[0].charge?.id, "ch_1");
  is("…and says which key it joined on", byMatch[0].charge?.via, "matchId");
  is("…and the row prints the amount", chargeLabel(byMatch[0]), "$16.24");

  /* THE ONE THIS EXISTS FOR. The SAME number arrives as a userMatchId. It must not join to the
   * match — that is a real amount on the wrong row, invisible on screen. */
  const wrongKey = attachCharges([R({ matchId: 18321, umId: 55 })], [C({ userMatchId: "18321" })]);
  is("the same number arriving as a userMatchId does NOT join to the match", wrongKey[0].charge, null);
  is("…and the row says so rather than showing a zero", chargeLabel(wrongKey[0]), "no charge found");
  // CONTROL: it DOES join when it lands on the row whose umId it names.
  const rightRow = attachCharges([R({ matchId: 999, umId: 18321 })], [C({ userMatchId: "18321" })]);
  is("control — the same charge joins to the row whose umId it names", rightRow[0].charge?.via, "userMatchId");

  // A charge with NEITHER key joins to nothing at all.
  is("a charge with no key joins to nothing", attachCharges([row], [C()])[0].charge, null);
  // A membership charge belongs to no match, whatever ids ride along with it.
  is("a membership charge never lands on a match row",
    attachCharges([row], [C({ matchId: "18321", isMembership: true })])[0].charge, null);
}

console.log("\n— what the row prints for money —");
is("no charge FOUND is not $0.00", chargeLabel(R({ charge: null })), "no charge found");
is("not looked for prints nothing at all", chargeLabel(R({ charge: undefined })), null);
is("a failed charge says failed", chargeLabel(R({ charge: { id: "c", amount: 866, status: "failed", created: "", card: null, via: "matchId" } })), "$8.66 · failed");
is("a succeeded one is just the money", chargeLabel(R({ charge: { id: "c", amount: 866, status: "succeeded", created: "", card: null, via: "matchId" } })), "$8.66");
{
  // A failed retry and a successful charge on the same booking: the row shows the one that worked.
  const both = attachCharges([R({ matchId: 17353 })], [
    C({ id: "ch_fail", matchId: "17353", status: "failed", amount: 866 }),
    C({ id: "ch_ok", matchId: "17353", status: "succeeded", amount: 866 }),
  ]);
  is("a successful charge outranks a failed retry of the same booking", both[0].charge?.id, "ch_ok");
}
is("charges not looked for leave the row saying nothing", attachCharges([R()], null)[0].charge, undefined);

console.log("\n— the contracts —");
const noComments = (x: string) => x.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const STRIPE = noComments(readFileSync("src/lib/stripePayments.ts", "utf8"));
/userMatchId: string \| null/.test(STRIPE) && /const userMatchId =/.test(STRIPE)
  ? ok("stripePayments carries the two ids as separate fields")
  : bad("the two ids are still folded into one");
/* PER LINE, because the two consts sit next to each other and a multi-line window matches the
 * gap between them. What must not exist is ONE assignment reading both. */
(() => {
  const offending = STRIPE.split("\n").filter((l) => /const (matchId|userMatchId) =/.test(l) && /meta\.matchId/.test(l) && /meta\.userMatchId/.test(l));
  return offending.length === 0;
})()
  ? ok("…and no single key assignment falls one back to the other")
  : bad("matchId still absorbs userMatchId");
/isMembership: !matchId && !userMatchId/.test(STRIPE)
  ? ok("a userMatchId-only charge is still a MATCH charge, not a membership one")
  : bad("splitting the keys turned match charges into membership charges");

const PROFILE = noComments(readFileSync("src/lib/playerProfile.ts", "utf8"));
/const playerCancelled = um\.isCancelled === true;/.test(PROFILE) && /const clubCancelled = m\.isCancelled === true;/.test(PROFILE)
  ? ok("the two cancellations are read separately in the mapping")
  : bad("um.isCancelled and m.isCancelled are still one condition");
!/um\.isCancelled === true \|\| m\.isCancelled === true/.test(PROFILE.replace(/const cancelled = playerCancelled \|\| clubCancelled;/, ""))
  ? ok("…and the old collapsed OR is gone")
  : bad("the collapsed OR survives");

const LOOKUP = noComments(readFileSync("src/app/api/lookup/[env]/route.ts", "utf8"));
/loadMirrorHistory/.test(LOOKUP) ? ok("Player Lookup supplies the mirror rows too") : bad("Player Lookup gets no cancelled-match rows");
/* ONE QUERY, NOT TWO. The first version had Player Lookup reading mdapi_matches.name and the pane
 * reading field_title, so the same cancelled match was "🎥 Parmer Stadium - Premier" on one screen
 * and "PARMER Stadium" on the other. The merge rules were shared; the query feeding them was not. */
{
  const CTX2 = noComments(readFileSync("src/app/api/crm/threads/[id]/context/route.ts", "utf8"));
  /loadMirrorHistory\(supabase/.test(CTX2) && /loadMirrorHistory\(makeServerClient\(\)/.test(LOOKUP)
    ? ok("…and both surfaces run the SAME mirror query, so a match cannot have two names")
    : bad("the two surfaces build their mirror rows separately");
}
!/fetchPlayerPayments/.test(LOOKUP)
  ? ok("…and does NOT read Stripe on the profile call — its charges stay on their own request")
  : bad("the profile call now blocks on Stripe");

const PLOOKUP = noComments(readFileSync("src/components/PlayerLookup.tsx", "utf8"));
/attachCharges\(p\.matches/.test(PLOOKUP)
  ? ok("…and applies the SAME charge join client-side when they land")
  : bad("Player Lookup does not attach charges to its match rows");
/isCancelled\(m\.state\)/.test(PLOOKUP)
  ? ok("its filter buckets treat both cancellations as cancelled, so the counts do not move")
  : bad("bucketOf no longer recognises a cancellation");
/MATCH_STATE_LABEL\[m\.state\]/.test(PLOOKUP)
  ? ok("…while the row itself names which cancellation it was")
  : bad("the row still prints the raw state");
/fmtWhen\(m\.startDate\)/.test(PLOOKUP) && !/fmtWhen\(m\.startDateUtc\)/.test(PLOOKUP)
  ? ok("Player Lookup prints the wall clock, never the instant")
  : bad("Player Lookup formats the true-UTC field as a date");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
