import "server-only"; // no-op under --conditions=react-server
/* CHANGE LOG 2.0 — the rules behind the rebuilt page, asserted on values (2026-11-07).
 *
 *   • ONE IDENTITY PER PERSON: keyed on actor_email; "Ryan Mancuso" and "rmancuso@…" are one person.
 *   • EVERY STORED SOURCE HAS A LABEL: the old "From" filter compared four hardcoded names against
 *     ~100 stored strings and showed 0 for every one of them.
 *   • TEST rows (env staging) are listed under All and left out of every count.
 *   • Syncs are hidden unless asked for.
 *   • COLLAPSE: identical writes within a minute → "×N"; removals of one player within a minute
 *     collapse across matches → "Removed X from N matches".
 *   • The sentences: SATX600FP reads "Tried to create promo code SATX600FP" with the plain failure.
 *   • Paging: Load older carries on from the last row shown.
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/change-log-2-test.ts
 */
import { readFileSync } from "node:fs";
import { groupBySave, type LogRow } from "../src/lib/changeLogModel";
import {
  actorOf, areaOf, collapse, failureWords, present, sourceLabelOf, wallClock, describe, EMPTY_ENRICH, type Enrich,
} from "../src/lib/changeLogPresent";
import { shapePage, parseChangeLogQuery } from "../src/lib/changeLogQuery";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const EN: Enrich = {
  ...EMPTY_ENRICH,
  staffByEmail: { "rmancuso@playmatchday.com": "Ryan Mancuso", "dgarcia@playmatchday.com": "Deonna Garcia" },
  players: { "90487": "Pat Example", "1481": "Ryan Staging" },
  matches: {
    "20834": { field: "Soccer Central Field 4", name: "🎥 Soccer Central Field 4", start: "2026-11-23T21:00:00.000Z" },
    "20827": { field: "Soccer Central Field 4", name: "🎥 Soccer Central Field 4", start: "2026-11-16T21:00:00.000Z" },
    "20820": { field: "Soccer Central Field 4", name: "🎥 Soccer Central Field 4", start: "2026-11-09T21:00:00.000Z" },
  },
};
let n = 0;
const row = (o: Partial<LogRow>): LogRow => ({
  id: String(++n), saveId: o.saveId ?? `s${n}`, at: "2026-11-07T12:18:24Z", actorName: "rmancuso@playmatchday.com", actorEmail: "rmancuso@playmatchday.com",
  source: "player-lookup", env: "production", matchId: null, matchName: null, method: "POST", endpoint: "/x", body: {}, outcome: "landed",
  serverSaid: null, changes: [], resolved: null, resolvedBy: null, resolvedAt: null, ...o,
});
const items = (rows: LogRow[]) => {
  const email: Record<string, string | null> = {};
  for (const r of rows) email[r.saveId] = r.actorEmail ?? null;
  return collapse(present(groupBySave(rows), EN, email), EN);
};

console.log("— who: one identity per person —");
const a1 = actorOf({ actorName: "rmancuso@playmatchday.com", actorEmail: "rmancuso@playmatchday.com" }, EN);
const a2 = actorOf({ actorName: "Ryan Mancuso", actorEmail: "rmancuso@playmatchday.com" }, EN);
is("the email row and the display-name row are ONE person", a1.key === a2.key, true);
is("…shown as the first name with initials", [a1.name, a1.initials, a2.name], ["Ryan", "RM", "Ryan"]);
is("POSITIVE CONTROL: a different person is a different key", actorOf({ actorName: "dgarcia@playmatchday.com", actorEmail: "dgarcia@playmatchday.com" }, EN).key === a1.key, false);
is("system actors get fixed names", [
  actorOf({ actorName: "auto-send", actorEmail: null }, EN).name,
  actorOf({ actorName: "auto-send@clubhouse.system", actorEmail: "auto-send@clubhouse.system" }, EN).name,
  actorOf({ actorName: "system (out-of-hours auto-reply)", actorEmail: null }, EN).name,
], ["Support agent", "Support agent", "Out-of-hours auto-reply"]);
is("the two script rows keep their own names, not Ryan's", [
  actorOf({ actorName: "Field backfill (approved by Ryan Mancuso)", actorEmail: "rmancuso@playmatchday.com" }, EN).name,
  actorOf({ actorName: "Claude (seeded by script, at Ryan's instruction)", actorEmail: "rmancuso@playmatchday.com" }, EN).name,
], ["Field backfill", "Script"]);

console.log("\n— every stored source has a label (the old From filter showed 0 for all of them) —");
const STORED = ["Match panel", "Match panel · teams", "Match panel · reduce to 2 teams", "Master Schedule · copy to dates", "crm-send", "User admin · permissions",
  "Match panel · convert to 4 teams", "City manager · assign", "Apply fixed ladder", "Match panel · cancel", "gameday-fakes", "gameday-spots", "Master Schedule · delete cancelled match",
  "Apply new ladder", "Veo camera toggle", "Staff app · Adjust", "Player Lookup · credits", "stripe-people-sync", "User admin · delete account", "gameday-stepper",
  "Admin · User access · City Manager", "Staff app · Match", "crm-human-push", "fin-txn-sync", "Lapsed spots", "Match editor · credit everyone who paid", "Master Schedule drawer",
  "Player Lookup", "Finance · fin_txn field backfill", "Promo Codes", "Fields · update", "Manager Pay — Gusto alias", "Growth: test field", "player-lookup", "Match managers · add",
  "Match editor", "e2e-fakes-route", "Staff app · View as", "crm-auto-send", "offers:create", "pushes:test", "Player Chats · draft action", "Roster"];
const LABELS = new Set(["Player Lookup", "Gameday Ops", "Master Schedule", "Match editor", "Player Chats", "Player Chats · suggested reply", "Auto-send", "Staff app",
  "User admin", "Promo Codes", "Offers", "Push Notifications", "Lapsed Spots", "Pricing ladder", "Fields", "Stripe sync", "Finance sync", "Finance backfill", "Growth",
  "Manager Pay", "Partner Dashboards", "Field economics", "Migration", "Test run", "Roster"]);
const unlabelled = STORED.filter((s) => !LABELS.has(sourceLabelOf({ source: s })));
is("every common stored source maps to one of the labels (none passes through raw)", unlabelled, []);
is("POSITIVE CONTROL: an unknown source does pass through raw, so the check can fail", LABELS.has(sourceLabelOf({ source: "brand new thing" })), false);
is("player-lookup and Player Lookup are one label", [sourceLabelOf({ source: "player-lookup" }), sourceLabelOf({ source: "Player Lookup · credits" })], ["Player Lookup", "Player Lookup"]);
is("the draft action is the suggested reply", sourceLabelOf({ source: "Player Chats · draft action" }), "Player Chats · suggested reply");
is("Gameday Ops covers the match panel and the gameday steppers", [sourceLabelOf({ source: "Match panel · teams" }), sourceLabelOf({ source: "gameday-spots" })], ["Gameday Ops", "Gameday Ops"]);
is("crm-send is Player Chats, or the auto-reply, or Auto-send, by who sent it", [
  sourceLabelOf({ source: "crm-send", actorName: "dgarcia@playmatchday.com" }), sourceLabelOf({ source: "crm-send", actorName: "system (out-of-hours auto-reply)" }), sourceLabelOf({ source: "crm-send", actorName: "auto-send" }),
], ["Player Chats", "Out-of-hours auto-reply", "Auto-send"]);

console.log("\n— areas —");
const ar = (o: Partial<LogRow>) => areaOf(row(o));
is("a removal is Roster", ar({ method: "DELETE", endpoint: "/admin/matches/user-matches/349322" }), "Roster");
is("a credit is Credits", ar({ method: "PUT", endpoint: "/admin/players/1481/profile", changes: [{ key: "creditAmount", field: "Credit balance", before: 0, after: 500 }] }), "Credits");
is("a promo code is Promo codes", ar({ endpoint: "/admin/promocodes", source: "Player Chats · draft action" }), "Promo codes");
is("a price change is Matches", ar({ method: "PUT", endpoint: "/admin/matches/20613", source: "Match panel" }), "Matches");
is("a team reshuffle from the match panel is Roster", ar({ method: "PUT", endpoint: "/admin/matches/20613", source: "Match panel · reduce to 2 teams" }), "Roster");
is("the extra areas", [ar({ endpoint: "/admin/strikes/strike-logs/1", method: "DELETE" }), ar({ endpoint: "/admin/users/4fd69a2a-4557-42b6-b77f-7a54d58e3b24/permissions", method: "PATCH" }),
  ar({ endpoint: "/admin/fields/2", source: "Fields · update" }), ar({ endpoint: "/admin/offers/campaigns", source: "offers:create" }), ar({ source: "Apply fixed ladder" }),
  ar({ source: "Growth: test field" }), ar({ source: "Lapsed spots", method: "DELETE", endpoint: "/admin/matches/user-matches/1" }), ar({ source: "stripe-people-sync", env: "prod" })],
  ["Strikes", "Staff access", "Fields", "Offers & pushes", "Pricing", "Growth", "Lapsed spots", "Syncs"]);

console.log("\n— what happened —");
const promo = row({ source: "Player Chats · draft action", endpoint: "/admin/promocodes", matchName: "SATX600FP", outcome: "failed",
  serverSaid: 'POST https://playmatchday.herokuapp.com/admin/promocodes: HTTP 403 — rejected, write did not land. Body: "{\\"message\\":\\"Promocode start date should be a future date\\",\\"errorCode\\":\\"PROMOCODE_START_DATE_PASSED\\",\\"statusCode\\":403}"',
  body: { code: "SATX600FP", discountType: "PERCENT", discountValue: 100, targetUserType: "ALL_USERS", targetMatchType: "TOTAL_USAGE", numberOfUsesPerUser: 3 } });
const [pi] = items([promo]);
is("SATX600FP reads as a sentence", [pi.what, pi.sub], ["Tried to create promo code SATX600FP", "100% off, all players"]);
is("…with the failure in plain words", pi.failure, "MatchDay refused it: the start date was already in the past.");
is("…area and source", [pi.area, pi.source, pi.outcome], ["Promo codes", "Player Chats · suggested reply", "failed"]);
const gave = items([row({ method: "PUT", endpoint: "/admin/players/90487/profile", source: "Player Lookup · credits",
  changes: [{ key: "creditAmount", field: "Credit balance", before: 0, after: 900 }, { key: "delta", field: "Adjustment", before: "—", after: "+900" }, { key: "reason", field: "Reason", before: "—", after: "match cancelled Oct 29" }] })])[0];
is("a credit: who, how much, why", [gave.what, gave.sub], ["Gave $9.00 credit to Pat Example", "Reason: match cancelled Oct 29"]);
const took = items([row({ method: "PUT", endpoint: "/admin/players/90487/profile", changes: [{ key: "creditAmount", field: "Credit balance", before: 900, after: 400 }] })])[0];
is("…and taking credit says so", took.what, "Took $5.00 credit from Pat Example");
const price = describe(groupBySave([row({ method: "PUT", endpoint: "/admin/matches/20820", source: "Master Schedule", matchId: 20820, changes: [{ key: "registrationPrice", field: "Price", before: 900, after: 1100 }] })])[0], EN);
is("a price change", price.what, "Changed Soccer Central Field 4 Nov 9 9:00 PM price from $9 to $11");
is("failures in plain words, every state", [failureWords("unknown", null), failureWords("notapplied", null), failureWords("failed", "HTTP 404")],
  ["MatchDay never answered, so it may or may not have happened.", "MatchDay accepted it, but a re-read shows nothing changed.", "MatchDay refused it (HTTP 404)."]);
// THE WALL-CLOCK TRAP: 9 PM at the pitch is stored 21:00Z. Through new Date() in Chicago it would read 3 PM.
is("match times are WALL CLOCK, read off the string", wallClock("2026-11-09T21:00:00.000Z"), "Mon, Nov 9 · 9:00 PM");
is("POSITIVE CONTROL: new Date() on the same string in Chicago WOULD shift it",
  new Date("2026-11-09T21:00:00.000Z").toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }), "3:00 PM");

console.log("\n— collapse —");
const rem = (id: number, match: number, at: string, player = "David Ordonez Palacios", actor = "rmancuso@playmatchday.com") => row({
  method: "DELETE", endpoint: `/admin/matches/user-matches/${id}`, matchId: match, matchName: "🎥 Soccer Central Field 4", at, actorName: actor, actorEmail: actor,
  changes: [{ key: "remove", field: "Remove from match", before: player, after: "—" }] });
const four = items([rem(349322, 20834, "2026-11-07T12:18:36Z"), rem(349321, 20827, "2026-11-07T12:18:32Z"), rem(349320, 20820, "2026-11-07T12:18:28Z"), rem(349319, 20813, "2026-11-07T12:18:24Z")]);
is("four removals of one player in 12 seconds, four matches → ONE row", four.length, 1);
is("…reading 'Removed {player} from N matches at {field}'", four[0].what, "Removed David Ordonez Palacios from 4 matches at Soccer Central Field 4");
const three = items([rem(1, 20834, "2026-11-07T12:18:36Z"), rem(2, 20827, "2026-11-07T12:18:32Z"), rem(3, 20820, "2026-11-07T12:18:28Z")]);
is("…the match dates, wall clock, under the sentence", three[0].sub, "Mon, Nov 23 · 9:00 PM; Mon, Nov 16 · 9:00 PM; Mon, Nov 9 · 9:00 PM");
const mixedFields = items([rem(1, 20834, "2026-11-07T12:18:36Z"), { ...rem(2, 999, "2026-11-07T12:18:32Z"), matchName: "Other Field" }]);
is("…and across different fields, no field named", mixedFields[0].what, "Removed David Ordonez Palacios from 2 matches");
is("…each match date in the details", three[0].members.length, 3);
is("…no ×N pill on a cross-match removal (the sentence says N)", three[0].pill, null);
is("a removal over a minute later is its own row", items([rem(1, 20834, "2026-11-07T12:20:00Z"), rem(2, 20827, "2026-11-07T12:18:30Z")]).length, 2);
is("another player is its own row", items([rem(1, 20834, "2026-11-07T12:18:36Z"), rem(2, 20827, "2026-11-07T12:18:32Z", "Someone Else")]).length, 2);
is("another person removing the same player is their own row", items([rem(1, 20834, "2026-11-07T12:18:36Z"), rem(2, 20827, "2026-11-07T12:18:32Z", "David Ordonez Palacios", "dgarcia@playmatchday.com")]).length, 2);
const same = (at: string) => row({ method: "POST", endpoint: "/admin/push-notifications/messages/57/test", source: "pushes:test", at, changes: [{ key: "title", field: "title", before: null, after: "ZZ" }] });
const twice = items([same("2026-11-06T21:42:52Z"), same("2026-11-06T21:42:46Z")]);
is("identical writes by one person within a minute → one row ×2", [twice.length, twice[0].pill], [1, "×2 in 1 min"]);

console.log("\n— counts, TEST, syncs, filters, paging —");
const mix = items([
  promo,
  row({ at: "2026-11-07T06:26:00Z", env: "staging", method: "PUT", endpoint: "/admin/players/1481/profile", changes: [{ key: "creditAmount", field: "Credit balance", before: 500, after: 0 }] }),
  row({ at: "2026-11-07T06:25:00Z", env: "staging", outcome: "failed", method: "PUT", endpoint: "/admin/players/1481/profile", changes: [{ key: "creditAmount", field: "Credit balance", before: 0, after: 500 }] }),
  row({ at: "2026-11-07T05:00:00Z", env: "prod", source: "stripe-people-sync", actorName: "cron", actorEmail: null, endpoint: "/api/sync/stripe-people" }),
  row({ at: "2026-11-07T04:00:00Z", outcome: "unknown", method: "POST", endpoint: "/admin/user-matches", source: "Match panel", matchId: 20834, actorName: "dgarcia@playmatchday.com", actorEmail: "dgarcia@playmatchday.com", changes: [{ key: "move", field: "Move", before: "team 1 #2", after: "team 2 #6" }] }),
]).sort((x, y) => (x.at < y.at ? 1 : -1));
const Q = (qs = "") => parseChangeLogQuery(new URL(`http://x/?tz=America/Chicago${qs}`));
const p0 = shapePage(mix, Q(), 6);
is("TEST rows are left out of every count; syncs hidden; the rest counted", p0.counts, { all: 2, needs: 1, failed: 1 });
is("…but TEST rows ARE listed under All (5 shown: 2 TEST + 2 real + 0 syncs… and the sync is hidden)", [p0.items.length, p0.items.filter((i) => i.test).length, p0.items.some((i) => i.sync)], [4, 2, false]);
is("POSITIVE CONTROL: Show syncs lists it (and still doesn't count TEST)", [shapePage(mix, Q("&syncs=1"), 6).items.some((i) => i.sync), shapePage(mix, Q("&syncs=1"), 6).counts.all], [true, 3]);
is("Failed lists only real failures, never a TEST failure", shapePage(mix, Q("&outcome=failed"), 6).items.map((i) => i.what), ["Tried to create promo code SATX600FP"]);
is("Needs checking lists the open one", shapePage(mix, Q("&outcome=needs"), 6).items.map((i) => i.actor.name), ["Deonna"]);
is("Person filters on the identity key", shapePage(mix, Q("&person=dgarcia%40playmatchday.com"), 6).items.length, 1);
is("Area filters", shapePage(mix, Q("&area=Promo%20codes"), 6).items.map((i) => i.area), ["Promo codes"]);
is("Search matches the code", shapePage(mix, Q("&q=satx600"), 6).items.length, 1);
is("…and the person's name", shapePage(mix, Q("&q=deonna"), 6).items.length, 1);
is("the day count leaves TEST out", Object.entries(p0.dayCounts).sort(), [["2026-11-06", 1], ["2026-11-07", 1]]);
const pg = shapePage(mix, Q("&limit=10"), 6);
is("no more pages when all fit", pg.nextBefore, null);
const many = Array.from({ length: 25 }, (_, i) => items([row({ at: new Date(Date.parse("2026-11-07T12:00:00Z") - i * 120_000).toISOString(), method: "DELETE", endpoint: `/admin/matches/${i}` })])[0]);
const first = shapePage(many, Q("&limit=10"), 25), second = shapePage(many, Q(`&limit=10&before=${encodeURIComponent(first.nextBefore!)}`), 25);
is("Load older carries on from the last row shown, with no row twice", [first.items.length, second.items.length, second.items.some((x) => first.items.some((y) => y.id === x.id))], [10, 10, false]);

console.log("\n— the route —");
const route = readFileSync("src/app/api/changelog/route.ts", "utf8");
is("GET filters and pages on the server", /runChangeLogQuery\(/.test(route) && !/\.list\(500\)/.test(route), true);
is("…behind the same Tech gate, for both GET and POST", (route.match(/authenticateCapability\(req, "tech"\)/g) ?? []).length, 2);
is("…and the resolve POST is unchanged: it records a finding, never a MatchDay write", /supabaseLogStore\(\)\.resolve\(/.test(route) && !/apiWrite|recordWrite/.test(route), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
