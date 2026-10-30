/* STAFF APP PUSH: who is notified, what it says, and when a match is at risk (src/lib/appPush.ts).
 * Ryan, 2026-10-30. Pure rules, asserted offline; every refusal has a presence control beside it. */
import { atRiskNow, chatPushText, chatRecipients, finalRecipients, matchRecipients, matchRiskText, wallClockOf, type StaffRow } from "../src/lib/appPush";

let pass = 0, fail = 0;
const ok = (m: string) => { pass++; console.log(`  ok  ${m}`); };
const bad = (m: string, d = "") => { fail++; console.log(`  XX  ${m} ${d}`); };
const is = (m: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const staff: StaffRow[] = [
  { id: "admin", email: "ops@playmatchday.com", is_admin: true },
  { id: "chats", email: "cs@playmatchday.com", can_access_chats: true },
  { id: "noaccess", email: "fin@playmatchday.com" },
  { id: "waw", email: "waw@playmatchday.pl", can_access_chats: true, can_access_matchops: true, city_identifier: "WAW" },
  { id: "waw2", email: "jf@playmatchday.pl", can_access_chats: true, city_identifier: "WAW" },
  { id: "atx-cm", email: "cm@playmatchday.com", is_city_manager: true, city_identifier: "ATX" },
  { id: "svc", email: "clubhouse-e2e@playmatchday.com", is_admin: true, is_service_account: true },
  { id: "ops", email: "matchops@playmatchday.com", can_access_matchops: true },
  { id: "bad", email: "old@playmatchday.com", can_access_chats: true, can_access_matchops: true, city_identifier: "XYZ" },
];

console.log("\nplayer chat: the listing's rule");
is("unassigned thread: unconfined chat staff only", chatRecipients(staff, null).sort(), ["admin", "chats"]);
is("assigned to a Warsaw user: unconfined staff AND Warsaw staff", chatRecipients(staff, "waw2").sort(), ["admin", "chats", "waw", "waw2"]);
is("assigned to an unconfined user: no confined account", chatRecipients(staff, "chats").sort(), ["admin", "chats"]);
is("never a service account, never someone without Chats", chatRecipients(staff, "waw2").filter((x) => x === "svc" || x === "noaccess" || x === "ops"), []);
is("a confined account whose city is unknown gets nothing", chatRecipients(staff, "bad").includes("bad"), false);

console.log("\nmatch at risk: staff app Match Ops, city scope");
is("an Austin match: operators, admins and the Austin city manager", matchRecipients(staff, "Austin").sort(), ["admin", "atx-cm", "ops"]);
is("a Warsaw match: operators, admins and Warsaw Match Ops", matchRecipients(staff, "Warsaw").sort(), ["admin", "ops", "waw"]);
is("never a service account or an account without Match Ops", matchRecipients(staff, "Austin").filter((x) => ["svc", "noaccess", "chats"].includes(x)), []);
is("a match with no city reaches unconfined staff only", matchRecipients(staff, null).sort(), ["admin", "ops"]);

console.log("\nnever the person who caused it, and the test-only gate");
is("the cause is left out", finalRecipients(["admin", "chats"], staff, "admin", null), ["chats"]);
is("PRESENCE CONTROL: with no cause, both stay", finalRecipients(["admin", "chats"], staff, null, null), ["admin", "chats"]);
is("test-only: only the listed email", finalRecipients(["admin", "chats"], staff, null, ["cs@playmatchday.com"]), ["chats"]);
is("duplicates collapse", finalRecipients(["admin", "admin"], staff, null, null), ["admin"]);

console.log("\nwhat it says");
const long = "x".repeat(120);
is("title Player chat", chatPushText("Jordan", "hi").title, "Player chat");
is("body is first name, colon, first 80 characters", chatPushText("Jordan", long).body, `Jordan: ${"x".repeat(80)}`);
is("no name reads Player", chatPushText(null, "hi").body, "Player: hi");
is("match body: name · time · N short", matchRiskText("Bob Jones Park Field 6", "2026-10-30T20:00:00.000Z", 3), { title: "Match at risk", body: "Bob Jones Park Field 6 · 8:00 PM · 3 short" });
is("wall clock of a morning start", wallClockOf("2026-10-31T09:05:00.000Z"), "9:05 AM");

console.log("\nwhen a match is at risk: below minimum, inside the hour before auto-cancel");
const start = Date.parse("2026-10-30T23:00:00.000Z"); // auto-cancel 75 min before: 21:45; window 20:45 to 21:45
const m = { isCancelled: false, autoCanceled: true, autoCanceledMinutes: 75, startDateUtc: "2026-10-30T23:00:00.000Z", cushion: -2, capacity: 18 };
const at = (iso: string) => Date.parse(iso);
is("inside the window", atRiskNow(m, at("2026-10-30T21:00:00Z")), true);
is("at the window's first moment", atRiskNow(m, at("2026-10-30T20:45:00Z")), true);
is("a minute before the window", atRiskNow(m, at("2026-10-30T20:44:00Z")), false);
is("at auto-cancel itself (too late)", atRiskNow(m, at("2026-10-30T21:45:00Z")), false);
is("PRESENCE CONTROL: the same time, at the minimum (cushion 0), is not at risk", atRiskNow({ ...m, cushion: 0 }, at("2026-10-30T21:00:00Z")), false);
is("a cancelled match is not", atRiskNow({ ...m, isCancelled: true }, at("2026-10-30T21:00:00Z")), false);
is("a match that does not auto-cancel is not", atRiskNow({ ...m, autoCanceled: false }, at("2026-10-30T21:00:00Z")), false);
is("a match with no capacity is not", atRiskNow({ ...m, capacity: null }, at("2026-10-30T21:00:00Z")), false);
void start;

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
