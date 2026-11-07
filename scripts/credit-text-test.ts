import "server-only"; // no-op under --conditions=react-server
/* "TEXT THE PLAYERS" ON CREDIT EVERYONE WHO PAID (2026-11-07). A sentence that reaches real phones,
 * about real money, so the guards are on what a screenshot cannot show:
 *   • the approved default, word for word; {amount} as 9.00 so "${amount}" reads $9.00;
 *   • every placeholder filled per player; an unknown placeholder or an empty message BLOCKS;
 *   • day and time read off the wall-clock start (the field's own time), never shifted;
 *   • only players whose credit LANDED are texted; no phone, a STOP reply or a repeated phone is skipped;
 *   • the route checks the message BEFORE any credit, needs SEND MESSAGES, sends through Telnyx like the
 *     match panel, and logs the message as written with counts — never a phone or a filled text.
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/credit-text-test.ts
 */
import { readFileSync } from "node:fs";
import {
  DEFAULT_CREDIT_TEXT, amountText, creditTextCounter, creditTextProblem, fillCreditText, planCreditTexts, scrubDigits,
  unknownPlaceholders, wallClockParts,
} from "../src/lib/creditText";
import { describe, EMPTY_ENRICH } from "../src/lib/changeLogPresent";
import { groupBySave, type LogRow } from "../src/lib/changeLogModel";
import { textOptOuts } from "../src/lib/signupExport";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log("— the message —");
is("the approved default, word for word", DEFAULT_CREDIT_TEXT,
  "MatchDay: Hi {first name}, we added ${amount} credit to your account for {field} on {day} at {time}. It's ready to use on your next booking.");
is("{amount} is a number with two decimals and no dollar sign", [amountText(900), amountText(974), amountText(5)], ["9.00", "9.74", "0.05"]);
const v = { firstName: "Marco", cents: 900, field: "NEMP Field 12", startDate: "2026-11-07T19:00:00.000Z" };
is("the default, filled for one player", fillCreditText(DEFAULT_CREDIT_TEXT, v),
  "MatchDay: Hi Marco, we added $9.00 credit to your account for NEMP Field 12 on Sat, Nov 7 at 7:00 PM. It's ready to use on your next booking.");
is("each player gets their own amount", fillCreditText("${amount}", { ...v, cents: 1250 }), "$12.50");
is("no first name → 'there'", fillCreditText("Hi {first name}", { ...v, firstName: "  " }), "Hi there");
is("placeholders are case- and space-tolerant", fillCreditText("{First Name} {  amount }", v), "Marco 9.00");
// THE WALL-CLOCK TRAP: 7 PM at the field is stored 19:00Z; new Date() in Chicago would say 1 PM.
is("day and time read off the wall clock (the field's own time)", wallClockParts("2026-11-07T19:00:00.000Z"), { day: "Sat, Nov 7", time: "7:00 PM" });
is("POSITIVE CONTROL: new Date() on the same string in Chicago WOULD shift it",
  new Date("2026-11-07T19:00:00.000Z").toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }), "1:00 PM");

console.log("\n— what blocks a send —");
is("the default is sendable", creditTextProblem(DEFAULT_CREDIT_TEXT), null);
is("an empty message blocks", creditTextProblem("   \n "), "The message is empty. Write something before sending.");
is("an unknown placeholder blocks, naming it", creditTextProblem("Hi {name}, ${amount}"),
  "{name} isn't a placeholder this message can fill. Use {first name}, {amount}, {field}, {day} or {time}.");
is("…two of them, both named", unknownPlaceholders("{date} {first_name} {date}"), ["{date}", "{first_name}"]);
is("POSITIVE CONTROL: all five known placeholders pass", unknownPlaceholders("{first name}{amount}{field}{day}{time}"), []);
is("over 1,600 characters blocks", creditTextProblem("x".repeat(1601))?.startsWith("The message is 1601 characters"), true);

console.log("\n— the counter —");
const one = creditTextCounter(fillCreditText(DEFAULT_CREDIT_TEXT, v));
is("the default, filled, is one segment and no warning", [one.segments, one.warn], [1, false]);
const two = creditTextCounter("x".repeat(161));
is("past one segment warns", [two.segments, two.warn], [2, true]);

console.log("\n— who gets a text —");
const plan = planCreditTexts([
  { userId: 1, cents: 900, firstName: "A", phoneE164: "+14348259300", optedOut: false },
  { userId: 2, cents: 900, firstName: "B", phoneE164: null, optedOut: false },
  { userId: 3, cents: 900, firstName: "C", phoneE164: "+15125550100", optedOut: true },
  { userId: 4, cents: 900, firstName: "D", phoneE164: "+14348259300", optedOut: false },
  { userId: 5, cents: 1200, firstName: "E", phoneE164: "+15125550101", optedOut: false },
]);
is("sent: the reachable ones, each once", plan.send.map((c) => c.userId), [1, 5]);
is("skipped, with the reason", plan.skipped, [{ userId: 2, reason: "no phone" }, { userId: 3, reason: "opted out" }, { userId: 4, reason: "same phone as another player" }]);
const opt = textOptOuts(
  [{ thread_id: "t1", body: "STOP", sent_at: "2026-11-01T00:00:00Z" }, { thread_id: "t2", body: "stop", sent_at: "2026-11-01T00:00:00Z" }, { thread_id: "t2", body: "START", sent_at: "2026-11-02T00:00:00Z" }],
  [{ id: "t1", phone_number: "+15125550100", player_id: 3 }, { id: "t2", phone_number: "+15125550101", player_id: 5 }],
);
is("a STOP reply opts the player out; a later START undoes it (the export's own rule)", [opt.players.has(3), opt.players.has(5)], [true, false]);
is("errors never carry a phone number to the log", scrubDigits("Telnyx 40300: +1 434-825-9300 blocked"), "Telnyx 40300: [number] blocked");

console.log("\n— the route —");
const strip = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const route = strip(readFileSync("src/app/api/matchday/[env]/matches/[id]/credit-all/route.ts", "utf8"));
is("texting is on", /const NOTIFY_ENABLED = true;/.test(route), true);
const checkAt = route.indexOf("creditTextProblem(message)"), loopAt = route.indexOf("for (const target of view.plan.pay)");
is("the message is checked BEFORE the first credit", checkAt > 0 && loopAt > 0 && checkAt < loopAt, true);
is("…and SEND MESSAGES, read fresh from app_users, before the first credit", route.indexOf('can(me.data as never, "sendMessages"') > 0 && route.indexOf('can(me.data as never, "sendMessages"') < loopAt, true);
is("only the LANDED credits are texted", /const landed = results\.filter\(\(r\) => r\.verdict === "LANDED"\);\s*const notified = notify \? await textLanded\(\{[^}]*landed/.test(route), true);
is("the send is the match panel's: Telnyx, one message per player, filled per player", /telnyx\.messages\.send\(\{\s*from: from!, to: c\.phoneE164!,\s*text: fillCreditText\(a\.message,/.test(route), true);
const notifyRoute = strip(readFileSync("src/app/api/match-chats/[chatId]/notify/route.ts", "utf8"));
is("POSITIVE CONTROL: the match panel's send is Telnyx messages.send from TELNYX_FROM_NUMBER", /telnyx\.messages\.send\(/.test(notifyRoute) && /TELNYX_FROM_NUMBER/.test(notifyRoute) && /TELNYX_FROM_NUMBER/.test(route), true);
is("opt-outs come from Player Chats STOP replies", /textOptOuts\(/.test(route), true);
const logCall = route.slice(route.indexOf("supabaseLogStore().insert({", route.indexOf("async function textLanded")));
const logBody = logCall.slice(0, logCall.indexOf("});"));
is("POSITIVE CONTROL: the text's log row was found", /endpoint: "\/sms\/credit-text"/.test(logBody), true);
is("logged under the credit run (same save id) with the message as written and the counts", /saveId: a\.saveId/.test(logBody) && /body: \{ message: a\.message, players: ids\.length, sent, failed, skipped, skipped_reasons: reasons \}/.test(logBody), true);
is("…and never a phone, a name or a filled text", /phone|firstName|fillCreditText|E164/i.test(logBody), false);

console.log("\n— in the Change Log —");
let n = 0;
const row = (o: Partial<LogRow>): LogRow => ({ id: String(++n), saveId: "run1", at: "2026-11-07T20:00:00Z", actorName: "rmancuso@playmatchday.com", source: "Match editor · credit everyone who paid", env: "staging",
  matchId: 1, matchName: "NEMP Field 12", method: "PUT", endpoint: "/admin/players/1481/profile", body: {}, outcome: "landed", serverSaid: null, changes: [], ...o });
const entry = groupBySave([
  row({ at: "2026-11-07T20:00:02Z", method: "POST", endpoint: "/sms/credit-text", changes: [{ key: "text", field: "Text the players", before: "—", after: "1 sent · 0 failed · 0 skipped" }, { key: "message", field: "Message (as written)", before: "—", after: DEFAULT_CREDIT_TEXT }] }),
  row({ changes: [{ key: "creditAmount", field: "Credit balance", before: 0, after: 900 }] }),
])[0];
is("a run with a text reads as one sentence with the counts", [describe(entry, EMPTY_ENRICH).what, describe(entry, EMPTY_ENRICH).sub], ["Credited 1 player $9.00 for NEMP Field 12 and texted them", "Texts: 1 sent · 0 failed · 0 skipped"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
