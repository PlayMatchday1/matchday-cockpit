/* STAFF APP PUSH: who is notified, what it says, and when a match is at risk (src/lib/appPush.ts).
 * Ryan, 2026-10-30. Pure rules, asserted offline; every refusal has a presence control beside it. */
import { DRAFT_SETTLE_MS, humanPushText, humanRecipients, settledHuman, waitStartOf, type WaitMsg } from "../src/lib/appPushHumanRules";
import { NO_DRAFT_YET } from "../src/lib/crmAttention";
import { atRiskNow, chatPushText, chatRecipients, finalRecipients, matchRecipients, matchRiskText, waitingCounts, wallClockOf, type StaffRow } from "../src/lib/appPush";

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

console.log("\nthe badge: each person's waiting chats, by the listing's scope");
const counts = waitingCounts(staff, [null, null, "waw2"], ["admin", "waw", "noaccess"]);
is("unconfined admin: every waiting thread (3)", counts.get("admin"), 3);
is("Warsaw: only the thread assigned in Warsaw (1)", counts.get("waw"), 1);
is("no Chats access: 0", counts.get("noaccess"), 0);

console.log("\nNEEDS A HUMAN push (appPushHuman, 2026-10-31): who");
is("assigned: the assignee only", humanRecipients(staff, "chats"), ["chats"]);
is("  assigned to a confined account: that account (it can open its own thread)", humanRecipients(staff, "waw2"), ["waw2"]);
is("  assigned to a service account: nobody", humanRecipients(staff, "svc"), []);
is("unassigned: unconfined admins and chat staff, never confined, service or no-access", humanRecipients(staff, null), ["admin", "chats"]);

console.log("\nwhen a wait begins: only a staff reply ends one");
const M = (direction: WaitMsg["direction"], at: string, by: string | null = null, media: string | null = null): WaitMsg => ({ direction, sent_at: `2026-10-31T${at}:00Z`, sent_by_user_id: by, media_kind: media });
is("first player message of a burst", waitStartOf([M("inbound", "10:00"), M("inbound", "10:01")]), "2026-10-31T10:00:00Z");
is("a bot reply (no sender) does not start a new wait", waitStartOf([M("inbound", "10:00"), M("outbound", "10:02"), M("inbound", "10:05")]), "2026-10-31T10:00:00Z");
is("  control: a staff reply does", waitStartOf([M("inbound", "10:00"), M("outbound", "10:02", "staff1"), M("inbound", "10:05")]), "2026-10-31T10:05:00Z");
is("a strike holding reply (bot, outbound last) keeps the wait", waitStartOf([M("inbound", "10:00"), M("outbound", "10:02")]), "2026-10-31T10:00:00Z");
is("nothing from the player since the staff reply: no wait", waitStartOf([M("inbound", "10:00"), M("outbound", "10:02", "staff1")]), null);
is("a reaction is not a message", waitStartOf([M("outbound", "09:00", "s"), M("inbound", "10:00", null, "reaction"), M("inbound", "10:03")]), "2026-10-31T10:03:00Z");

console.log("\nsettled: the section a push follows");
const T = Date.parse("2026-10-31T10:00:00Z");
const att = (section: "human" | "auto_sending", reason: string | null, enteredAgoMs: number) => ({ section, reason, hold_until: null, entered_at: new Date(T - enteredAgoMs).toISOString() });
is("a decided reason pushes at once", settledHuman(att("human", "Category other always goes to a person.", 0), T, true), true);
is("No draft yet waits for the draft", settledHuman(att("human", NO_DRAFT_YET, 60e3), T, true), false);
is("  control: once the draft is overdue it pushes", settledHuman(att("human", NO_DRAFT_YET, DRAFT_SETTLE_MS), T, true), true);
is("  and at once when there is no model key", settledHuman(att("human", NO_DRAFT_YET, 0), T, false), true);
is("Auto-sending never pushes", settledHuman(att("auto_sending", null, 3600e3), T, true), false);
is("a strike dispute owed a person pushes", settledHuman(att("human", "Strike dispute: check with the match manager", 0), T, true), true);

console.log("\nwhat it says");
is("name, city, reason", humanPushText({ first_name: "Bryan", last_name: "Ortiz", preferable_city_normalized: "ATX" }, "+15125550100", "Category other always goes to a person."),
  { title: "Needs a human", body: "Bryan O. · ATX · Category other always goes to a person." });
is("no linked player: last four digits, no city", humanPushText(null, "+15125550404", "Draft ready").body, "Number ending 0404 · Draft ready");
const longReason = humanPushText(null, "+15125550404", "Claude couldn't be reached: " + "x".repeat(400)).body;
is("a long reason is cut to 120 characters", longReason.length <= "Number ending 0404 · ".length + 120 && longReason.endsWith("…"), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
