/* THE APP STORE REVIEW ACCOUNT, AND THE SESSION GAP ON SYNC ROUTES (Ryan, 2026-11-02).
 *
 * Pure, offline: the masker, the proxy's rule, the switch, the token claim, the GET wrapper, and two
 * estate-wide checks read off disk so the NEXT route somebody adds cannot quietly skip them:
 *   - every GET the review account can reach is wrapped by reviewMasked;
 *   - every route that verifies a Supabase session itself also checks app_users (admin for writes and
 *     syncs, staff for the two reads), and a sync GET alias that takes sessions answers cron only.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/review-account-test.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { maskForReview, reviewAccountSafe, reviewCredentials, reviewMasked, reviewMatchDetails, reviewRefusal, shortName, tokenEmail, REVIEW_EMAIL } from "../src/lib/reviewAccount";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ok  ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` : ${d}` : ""}`); console.log(`  XX  ${m}${d ? ` : ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const jwt = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

console.log("REVIEW ACCOUNT\n");

console.log("names");
is("first and last", shortName("Sam Rivera"), "Sam R.");
is("three words keep the first and the last initial", shortName("Ana de la Cruz"), "Ana C.");
is("one word stays", shortName("Sam"), "Sam");

console.log("\nthe masker, on the shapes the routes return");
const match = {
  match: { id: 20520, name: "Tuesday 7v7 at Zilker", fieldTitle: "Zilker Park Field 3", cityName: "Austin",
    manager: { firstName: "Jordan", lastName: "Blake", email: "jordan@example.com", phoneNumber: "+15125550123", phoneNumberVerifiedAt: "2026-01-01" } },
  teams: [{ name: "Team Blue" }],
  players: [{ playerId: 7, name: "Sam Rivera", phone: "+15125550199", bib: 4, checkin: "in", avatarUrl: "https://x/p.jpg" }],
  reviews: [{ name: "Ana Lopez", rating: 5, tags: ["Great vibe"], comment: "Loved it, call me on 512 555 0101" }],
  fields: [{ title: "Zilker Park Field 3", name: "Zilker" }],
  count: 14,
};
const m = maskForReview(match) as typeof match;
is("player name to first name plus last initial", m.players[0].name, "Sam R.");
is("player phone gone", m.players[0].phone, null);
is("player photo gone", m.players[0].avatarUrl, null);
is("manager first name kept, last name an initial", [m.match.manager.firstName, m.match.manager.lastName], ["Jordan", "B."]);
is("manager email and phone gone", [m.match.manager.email, m.match.manager.phoneNumber], [null, null]);
is("reviewer name masked", m.reviews[0].name, "Ana L.");
is("review comment hidden, stars and tags kept", [m.reviews[0].comment, m.reviews[0].rating, m.reviews[0].tags], ["Comment hidden", 5, ["Great vibe"]]);
is("match, team and field names stay real", [m.match.name, m.teams[0].name, m.fields[0].name, m.match.fieldTitle], ["Tuesday 7v7 at Zilker", "Team Blue", "Zilker", "Zilker Park Field 3"]);
is("counts and ids stay real", [m.count, m.match.id, m.players[0].bib], [14, 20520, 4]);
const board = maskForReview({ managers: { ranked: [{ name: "Jordan Blake", initials: "JB", comments: [{ name: "Ana Lopez", text: "Great ref", stars: 4 }] }] } }) as { managers: { ranked: { name: string; comments: { name: string; text: string; stars: number }[] }[] } };
is("reviews board comment text hidden", board.managers.ranked[0].comments[0].text, "Comment hidden");
is("reviews board names masked", [board.managers.ranked[0].name, board.managers.ranked[0].comments[0].name], ["Jordan B.", "Ana L."]);
const chat = maskForReview({ messages: [{ senderName: "Sam Rivera", text: "running late", sentAt: "2026-11-02T10:00:00Z", mediaUrl: "https://x/m.jpg" }], thread: { display_name: "Sam Rivera", last_message: "ok", phone: "+15125550199" } }) as { messages: { senderName: string; text: string; sentAt: string; mediaUrl: string | null }[]; thread: { display_name: string; last_message: string; phone: string | null } };
is("chat body hidden", chat.messages[0].text, "Message hidden");
is("chat sender masked, time kept", [chat.messages[0].senderName, chat.messages[0].sentAt], ["Sam R.", "2026-11-02T10:00:00Z"]);
is("chat media gone", chat.messages[0].mediaUrl, null);
is("thread name, preview and phone", [chat.thread.display_name, chat.thread.last_message, chat.thread.phone], ["Sam R.", "Message hidden", null]);
is("a match card's manager string is masked (Gameday, match screen, manager sheet)", maskForReview({ matches: [{ name: "ATX - Zilker 12", manager: "Jordan Blake", secondManager: "Ana Lopez" }] }),
  { matches: [{ name: "ATX - Zilker 12", manager: "Jordan B.", secondManager: "Ana L." }] });
is("a bare manager string on the manager sheet is masked", maskForReview({ manager: "Jordan Blake", options: [] }), { manager: "Jordan B.", options: [] });
{
  const details = reviewMatchDetails({
    match: { id: 1, cityName: "Austin", managerId: 5, manager: { id: 5, firstName: "Jordan", lastName: "Blake", lat: 30.1, lng: -97.7, currentLat: 30.2, currentLng: -97.8, currentZipCode: "78701", address: { street: "1 Main St", city: "Austin", country: "United States" }, creditAmount: 500, introMatchText: "hi" }, secondManager: null },
    fields: [{ city: "Austin" }, { city: "Houston" }, { city: null }],
    managers: [{ id: 5, name: "Jordan Blake" }],
    managersAllCities: [{ id: 9, name: "Pat Kim" }],
  });
  const shown = maskForReview(details) as { match: { manager: Record<string, unknown>; secondManager: unknown }; fields: unknown[]; managers: { name: string }[]; managersAllCities: unknown[] };
  is("Adjust: the manager keeps only id and a masked name (no coordinates, zip, address, credit or intro)", shown.match.manager, { id: 5, firstName: "Jordan", lastName: "B." });
  is("Adjust: no second manager stays null", shown.match.secondManager, null);
  is("Adjust: only the match's own city's fields", shown.fields, [{ city: "Austin" }]);
  is("Adjust: the city's managers stay, masked", shown.managers, [{ id: 5, name: "Jordan B." }]);
  is("Adjust: no other cities' managers", shown.managersAllCities, []);
}
is("a match chat sender is masked", (maskForReview({ last_message: { body: "hi", sent_by: "Sam Rivera" } }) as { last_message: { sent_by: string } }).last_message.sent_by, "Sam R.");
is("prefixed name keys too", maskForReview({ match: { manager_first_name: "Jordan", manager_last_name: "Blake", manager_display_name: "Jordan Blake", city_name: "Austin", field_title: "Zilker Park Field 3" } }), { match: { manager_first_name: "Jordan", manager_last_name: "B.", manager_display_name: "Jordan B.", city_name: "Austin", field_title: "Zilker Park Field 3" } });
is("a manager avatar on a match card is gone, the field cover stays", maskForReview({ matches: [{ managerAvatar: "https://x/a.jpg", coverUrl: "https://x/c.jpg" }] }), { matches: [{ managerAvatar: null, coverUrl: "https://x/c.jpg" }] });
is("notes hidden", (maskForReview({ player: { name: "Sam Rivera", note: "owes $10" } }) as { player: { note: string } }).player.note, "Note hidden");
is("an email or phone in free text is scrubbed", maskForReview({ detail: "changed to sam@x.com from (512) 555-0101 on 2026-11-02" }), { detail: "changed to hidden from hidden on 2026-11-02" });
is("a date is never taken for a phone", maskForReview({ from: "2026-11-02", to: "2026-11-08" }), { from: "2026-11-02", to: "2026-11-08" });
is("the input is not mutated", match.players[0].name, "Sam Rivera");

console.log("\nthe account must stay read only");
is("the Austin row with read grants is safe", reviewAccountSafe({ city_identifier: "ATX", can_access_matchops: true, can_access_chats: true }), true);
is("an admin flag is not", reviewAccountSafe({ city_identifier: "ATX", is_admin: true }), false);
is("a write grant is not", reviewAccountSafe({ city_identifier: "ATX", can_send_messages: true }), false);
is("another city is not", reviewAccountSafe({ city_identifier: "HOU" }), false);

console.log("\nthe proxy's rule");
is("a GET the app reads passes", reviewRefusal("GET", "/api/app/production/today"), null);
is("chat threads read passes", reviewRefusal("GET", "/api/crm/threads"), null);
is("match chat messages read passes", reviewRefusal("GET", "/api/match-chats/abc/messages"), null);
is("moving a player is refused", reviewRefusal("POST", "/api/app/production/matches/1/roster")?.status, 403);
is("a cancel is refused", reviewRefusal("POST", "/api/app/production/matches/1/cancel")?.status, 403);
is("a chat reply is refused", reviewRefusal("POST", "/api/crm/send")?.status, 403);
is("a match chat reply is refused", reviewRefusal("POST", "/api/match-chats/abc/reply")?.status, 403);
is("push registration is refused", reviewRefusal("POST", "/api/app/push-token")?.status, 403);
is("a sync GET is refused", reviewRefusal("GET", "/api/sync/play-installs")?.status, 403);
is("an auto-send tick GET is refused", reviewRefusal("GET", "/api/crm/auto-send/tick")?.status, 403);
is("manager pay is readable (2026-11-03)", reviewRefusal("GET", "/api/app/manager-pay"), null);
is("presence control: a manager pay write is still refused", reviewRefusal("POST", "/api/app/manager-pay").status, 403);
is("an iPhone data-through date is not a phone number", (maskForReview({ through: { iphone: "2026-10-31", android: "2026-10-30" } }) as { through: { iphone: unknown } }).through.iphone, "2026-10-31");
is("presence control: a phone number still is", (maskForReview({ player: { phone: "+15125550100" } }) as { player: { phone: unknown } }).player.phone, null);
is("a Lookup search row's name is first name and last initial", (maskForReview({ results: [{ id: 920, name: "Pat Example", city: "Austin", status: "ok", member: false }] }) as { results: { name: string }[] }).results[0].name, "Pat E.");
is("presence control: a city name in a results row is kept", (maskForReview({ results: [{ id: 920, name: "Pat Example", city: "Austin", member: false }] }) as { results: { city: string }[] }).results[0].city, "Austin");

console.log("\nthe switch and the token");
const env = { ...process.env };
process.env.APP_REVIEW_PHONE = ""; process.env.APP_REVIEW_CODE = "123456";
is("empty phone turns it off", reviewCredentials(), null);
process.env.APP_REVIEW_PHONE = "+15125550100"; process.env.APP_REVIEW_CODE = "";
is("empty code turns it off", reviewCredentials(), null);
process.env.APP_REVIEW_CODE = "12345";
is("a code that is not 6 digits turns it off", reviewCredentials(), null);
process.env.APP_REVIEW_CODE = "123456";
is("both set turns it on", reviewCredentials(), { phone: "+15125550100", code: "123456" });
process.env.APP_REVIEW_PHONE = env.APP_REVIEW_PHONE; process.env.APP_REVIEW_CODE = env.APP_REVIEW_CODE;
is("token email claim", tokenEmail(`Bearer ${jwt({ email: "App-Review@playmatchday.com" })}`), REVIEW_EMAIL);
is("a cron secret is no token", tokenEmail("Bearer not-a-jwt"), null);

void (async () => {
console.log("\nthe wrapper");
const handler = async () => Response.json({ players: [{ playerId: 1, name: "Sam Rivera" }] });
const wrapped = reviewMasked(handler);
const asReview = await (await wrapped(new Request("http://x/api", { headers: { authorization: `Bearer ${jwt({ email: REVIEW_EMAIL })}` } })))!.json();
const asStaff = await (await wrapped(new Request("http://x/api", { headers: { authorization: `Bearer ${jwt({ email: "someone@playmatchday.com" })}` } })))!.json();
is("the review account gets the masked body", asReview.players[0].name, "Sam R.");
is("anyone else gets the body untouched", asStaff.players[0].name, "Sam Rivera");

console.log("\nevery GET the review account can reach is masked");
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : f === "route.ts" ? [p] : []; });
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const reachable = ["src/app/api/app", "src/app/api/crm", "src/app/api/match-chats"].flatMap(walk)
  .filter((f) => /export\s+(async\s+function|const)\s+GET\b/.test(strip(readFileSync(f, "utf8"))))
  .filter((f) => reviewRefusal("GET", f.replace(/^src\/app/, "").replace(/\/route\.ts$/, "").replace(/\[[^\]]+\]/g, "x")) === null);
is("the list is not empty (positive control)", reachable.length > 10, true);
for (const f of reachable) {
  const code = strip(readFileSync(f, "utf8"));
  if (f.endsWith("api/app/me/route.ts")) { ok(`${f} (the account's own row, not masked)`); continue; }
  if (/export const GET = POST\b/.test(code) && code.includes("CRON_SECRET") && !/authenticate|getUser/.test(code)) { ok(`${f} (cron secret only, answers no session)`); continue; }
  if (/export const GET = reviewMasked\(/.test(code)) ok(f);
  else bad(f, "GET is not wrapped in reviewMasked");
}

console.log("\nevery route that verifies a session itself also checks app_users");
const sessionRoutes = walk("src/app/api").filter((f) => /auth\.getUser\(/.test(readFileSync(f, "utf8")));
is("the list is not empty (positive control)", sessionRoutes.length > 20, true);
const OWN_CHECK = new Set(["src/app/api/calendar/week/route.ts"]); // returns only the caller's own meetings, matched by their app_users email
for (const f of sessionRoutes) {
  const code = strip(readFileSync(f, "utf8"));
  if (OWN_CHECK.has(f)) { ok(`${f} (reads the caller's own calendar)`); continue; }
  if (/refuseUnless(Admin|Staff)\(/.test(code)) ok(f);
  else bad(f, "accepts any Supabase session");
  if (/export const GET = POST\b/.test(code)) bad(f, "a GET alias that takes sessions; use cronOnlyGet(POST)");
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.log(`  XX  ${f}`)); process.exit(1); }
if (pass === 0) { console.log("ZERO ASSERTIONS: that is a failure, not a pass"); process.exit(1); }
})();
