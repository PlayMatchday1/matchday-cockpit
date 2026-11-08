import "server-only"; // no-op under --conditions=react-server
/* PLAYER CHATS 2.0 — the guards that move with the rebuild (2026-11-06).
 *
 * MOSTLY RUNTIME. The queue's buckets and order, the wait colours, the WhatsApp window pill and the
 * closed-window sentence, the credit presets and the line added to the reply, the next match and
 * its WALL-CLOCK time, the app-activity line: all computed in src/lib/inbox2Model.ts and asserted
 * here on values, with a positive control beside every absence.
 *
 * SOURCE PAIRINGS ONLY WHERE AN HTTP BOUNDARY HIDES THE BEHAVIOUR (CLAUDE.md, "Source-text
 * assertions"): which route Give credit writes through and with which race guard, that Cancel spot
 * is a link and never a roster write, that the new files never call a send route themselves, that
 * the strip and the panel share ONE context read, and that match dates pair startDate with the
 * wall-clock formatter. Each is asserted positive AND negative.
 *
 * The single realtime subscription across the feature is pinned by crm-characterize-test, whose
 * walk covers this folder; the bell's placement by crm-push-test.
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/chats-inbox2-test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  activityLine, appendLine, bucket, closedWindowText, creditReplyLine, dayDivider, dollars, initials, membershipLevel,
  nextMatch, presetRaw, waitTone, waitingCount, wallClockWhen, windowPill, CREDIT_PRESETS_CENTS, WHATSAPP_WINDOW_MS,
  statsCells, fmtMinutes, detailsPrefKey, readDetailsPref,
  type Section,
} from "../src/lib/inbox2Model";
import { validateAdjustment } from "../src/lib/creditsModel";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const NOW = Date.parse("2026-11-06T21:00:00.000Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

console.log("— the queue: Needs reply holds only threads waiting on us —");
{
  const rows = [
    { id: "a", last_message_at: ago(6), waiting_since: ago(6), s: "human" as Section },
    { id: "b", last_message_at: ago(5), waiting_since: ago(42), s: "human" as Section },
    { id: "c", last_message_at: ago(18), waiting_since: null, s: "human" as Section },
    { id: "w1", last_message_at: ago(120), s: null as Section },
    { id: "w2", last_message_at: ago(300), s: null as Section },
    { id: "h", last_message_at: ago(3), waiting_since: ago(9), s: "auto_sending" as Section },
  ];
  const by = (r: { s: Section }) => r.s;
  const needs = bucket(rows, "needs", by);
  is("Needs reply: the human rows, longest wait first (by waiting_since, else last message)", needs.rows.map((r) => r.id), ["b", "c", "a"]);
  is("…the Auto-sending group is separate, on top", needs.auto.map((r) => r.id), ["h"]);
  is("…and NO Waiting row is inside Needs reply (Ryan 2026-11-06, Q2)", needs.rows.concat(needs.auto).filter((r) => r.s === null).length, 0);
  const waiting = bucket(rows, "waiting", by);
  is("POSITIVE CONTROL: the same rows DO contain Waiting threads, and Waiting lists them newest first", waiting.rows.map((r) => r.id), ["w1", "w2"]);
  is("…and Waiting holds no thread a person owes", waiting.rows.filter((r) => r.s !== null).length, 0);
  is("Done lists everything it was given, newest first", bucket(rows, "done", by).rows.map((r) => r.id), ["h", "b", "a", "c", "w1", "w2"]);
  is("Waiting's count is the server's open minus awaiting", waitingCount({ open: 40, awaiting: 7 }), 33);
  is("…never negative", waitingCount({ open: 3, awaiting: 5 }), 0);
}

console.log("\n— the wait's colour: over 30m red, over 10m amber —");
is("6 minutes is plain", waitTone(ago(6), NOW), "plain");
is("exactly 10 minutes is not over 10", waitTone(ago(10), NOW), "plain");
is("11 minutes is amber", waitTone(ago(11), NOW), "amber");
is("exactly 30 minutes is still amber", waitTone(ago(30), NOW), "amber");
is("42 minutes is red", waitTone(ago(42), NOW), "red");
is("an unreadable time is plain, not red", waitTone("nope", NOW), "plain");

console.log("\n— the WhatsApp window pill and the closed-window sentence —");
is("SMS has no pill (no window)", windowPill("sms", 5_000), null);
is("21 hours left", windowPill("whatsapp", 21 * 3600e3 + 59 * 60e3), { text: "WhatsApp · window open 21h", open: true });
is("under an hour shows minutes", windowPill("whatsapp", 45 * 60e3), { text: "WhatsApp · window open 45m", open: true });
is("closed", windowPill("whatsapp", 0), { text: "WhatsApp · window closed", open: false });
is("the window the copy speaks of is 24 hours", WHATSAPP_WINDOW_MS, 24 * 3600e3);
{
  const t = closedWindowText("Marco", new Date(NOW - 2 * 86_400_000 - 3600e3).toISOString(), NOW);
  is("frame 3's sentence, 2 days ago", t, "Marco last wrote 2 days ago, so WhatsApp only allows a template. Free text opens again when they reply.");
  is("…no pronoun guessed from a name", /\b(he|she|him|her)\b/i.test(t), false);
  is("POSITIVE CONTROL: the pronoun pattern does find one when there is one", /\b(he|she|him|her)\b/i.test("when he replies"), true);
  is("never wrote: says so instead of inventing a date", closedWindowText("Sam", null, NOW).startsWith("Sam hasn't written to us on WhatsApp"), true);
}

console.log("\n— Give credit: presets, the amount sent, the line added to the reply —");
is("the frame's presets: $5, $9, $15", CREDIT_PRESETS_CENTS.map(dollars), ["$5", "$9", "$15"]);
for (const c of CREDIT_PRESETS_CENTS) {
  const v = validateAdjustment({ raw: presetRaw(c), reason: "Match cancelled Oct 29", beforeCents: 0, playerName: "Test", canEdit: true });
  is(`preset ${dollars(c)} validates to +${c} cents through the SAME validator Player Lookup uses`, [v.ok, v.deltaCents], [true, c]);
}
is("a preset with no reason does not validate", validateAdjustment({ raw: presetRaw(900), reason: "", beforeCents: 0, playerName: "T", canEdit: true }).ok, false);
is("the line added to the reply", creditReplyLine(900), "$9 credit is on your account.");
is("…cents when there are cents", creditReplyLine(950), "$9.50 credit is on your account.");
is("appended on its own line, never replacing the reply", appendLine("Hi Marco, sorry about that.", creditReplyLine(900)), "Hi Marco, sorry about that.\n$9 credit is on your account.");
is("…into an empty box it is the whole text", appendLine("  ", "x"), "x");

console.log("\n— the player strip —");
is("membership and level together (Q6)", membershipLevel(false, 3), "Casual · Level 3");
is("…a member with no level", membershipLevel(true, null), "Member");
is("initials", initials("Marco Ruiz"), "MR");
{
  const ms = [
    { matchId: 1, name: "Played", startDate: "2026-11-01T19:00:00Z", startDateUtc: "2026-11-02T01:00:00Z", state: "played" },
    { matchId: 3, name: "Later", startDate: "2026-11-12T19:00:00Z", startDateUtc: "2026-11-13T01:00:00Z", state: "upcoming" },
    { matchId: 2, name: "NEMP", startDate: "2026-11-06T19:00:00Z", startDateUtc: "2026-11-07T01:00:00Z", state: "upcoming" },
    { matchId: null, name: "No id", startDate: "2026-11-06T08:00:00Z", startDateUtc: "2026-11-06T14:00:00Z", state: "upcoming" },
  ];
  is("next match: the soonest UPCOMING one with a match id, ordered by the true instant", nextMatch(ms)?.name, "NEMP");
  is("…and none when nothing is upcoming", nextMatch(ms.filter((m) => m.state === "played")), null);
}
// THE WALL-CLOCK TRAP: 7 PM at the pitch is stored 2026-11-06T19:00Z. Through new Date() in
// Chicago it would print 1 PM; read off the string it prints 7 PM.
is("wall clock: 'Today 7:00 PM', read off the string", wallClockWhen("2026-11-06T19:00:00Z", "2026-11-06"), "Today 7:00 PM");
is("POSITIVE CONTROL: new Date() on the same string in Chicago WOULD shift it",
  new Date("2026-11-06T19:00:00Z").toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }), "1:00 PM");
is("tomorrow", wallClockWhen("2026-11-07T08:30:00Z", "2026-11-06"), "Tomorrow 8:30 AM");
is("within the week: the weekday", wallClockWhen("2026-11-10T12:00:00Z", "2026-11-06"), "Tue 12:00 PM");
is("further out: the date", wallClockWhen("2026-11-20T00:15:00Z", "2026-11-06"), "Nov 20 12:15 AM");

console.log("\n— the app-activity line —");
{
  const item = (id: string, minAgo: number, failed: boolean, background: string | null = null) => ({ id, ts: ago(minAgo), failed, background });
  is("a failure in the last 7 days wins, in red", activityLine([item("ok1", 5, false), item("f", 60, true)], NOW), { item: item("f", 60, true), failed: true });
  is("a failure older than 7 days does not", activityLine([item("ok1", 5, false), item("old", 8 * 1440, true)], NOW)?.item.id, "ok1");
  is("background requests are not 'the latest action'", activityLine([item("bg", 1, false, "rechecked"), item("ok1", 5, false)], NOW)?.item.id, "ok1");
  is("nothing at all is null, not a made-up line", activityLine([], NOW), null);
}
is("day divider: today", dayDivider(new Date().toISOString(), new Date()), "TODAY");

console.log("\n— the boundaries: routes the new files call (source pairings, both ways) —");
const strip = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const DIR = "src/app/(internal)/match-ops/player-chats/v2";
const files = readdirSync(DIR).filter((f) => /\.tsx?$/.test(f)).map((f) => ({ f, src: strip(readFileSync(join(DIR, f), "utf8")) }));
const all = files.map((x) => x.src).join("\n");
const credit = files.find((x) => x.f === "GiveCreditPanel.tsx")?.src ?? "";
is("POSITIVE CONTROL: the folder was read (Inbox2, Queue2, the strip, the panel, Give credit)", ["Inbox2.tsx", "Queue2.tsx", "PlayerStrip.tsx", "DetailsPanel.tsx", "GiveCreditPanel.tsx"].every((f) => files.some((x) => x.f === f)), true);
is("Give credit writes through the guarded credits route Player Lookup uses",
  /authFetch\(`\/api\/matchday\/\$\{ENV\}\/players\/\$\{playerId\}\/credits`/.test(credit), true);
is("…with the race guard (expectedBeforeCents: balanceCents) and the shared validator",
  /expectedBeforeCents: balanceCents/.test(credit) && /validateAdjustment\(/.test(credit), true);
is("…in exactly ONE request (no retry path)", (credit.match(/authFetch\(/g) ?? []).length, 1);
is("…and the line reaches the reply only after LANDED", /if \(j\.landed\) \{[\s\S]{0,300}onAddLine\(creditReplyLine\(amount\)\)/.test(credit), true);
is("no other v2 file writes credits", files.filter((x) => x.f !== "GiveCreditPanel.tsx" && /\/players\/\$\{[^}]+\}\/credits/.test(x.src)).map((x) => x.f), []);
const sendRe = /\/api\/crm\/send/;
is("POSITIVE CONTROL: the send pattern finds the Composer's send", sendRe.test(strip(readFileSync("src/app/(internal)/match-ops/player-chats/components/Composer.tsx", "utf8"))), true);
is("no v2 file calls a send route itself (every send is the Composer's)", files.filter((x) => sendRe.test(x.src)).map((x) => x.f), []);
is("Cancel spot is a LINK to the match panel of the next match", /href=\{`\/match-ops\/match-panel\/\$\{next\.matchId\}`\}/.test(all), true);
const rosterWrite = /\/roster\/|user-matches|refund-and-cancel/;
is("POSITIVE CONTROL: the roster pattern finds Player Lookup's remove", rosterWrite.test(readFileSync("src/components/PlayerLookup.tsx", "utf8")), true);
is("…and no v2 file touches the roster route or a user-match", files.filter((x) => rosterWrite.test(x.src)).map((x) => x.f), []);
is("ONE context read per thread, shared by the strip and the panel", (all.match(/\/api\/crm\/threads\/\$\{threadId\}\/context/g) ?? []).length, 1);
is("POSITIVE CONTROL: match dates in the panel pair startDate with the wall-clock formatter", /dayOf\(m\.startDate \?\? m\.startDateUtc\)/.test(all), true);
is("…the strip formats next.startDate, never next.startDateUtc", /wallClockWhen\(next\.startDate,/.test(all) && !/wallClockWhen\(next\.startDateUtc/.test(all), true);
is("severe account actions stay on Player Lookup (no Suspend / Expel / Remove from / Add to a match)", /\b(Suspend|Expel|Remove from|Add to a match)\b/.test(all), false);
is("POSITIVE CONTROL: that pattern finds them where they live", /\b(Suspend|Expel)\b/.test(readFileSync("src/components/PlayerLookup.tsx", "utf8")), true);
{
  const composer = strip(readFileSync("src/app/(internal)/match-ops/player-chats/components/Composer.tsx", "utf8"));
  const start = composer.indexOf('if (variant === "v2")');
  // ends where the old layout's return begins (its compact class string is unique to it)
  const v2 = start < 0 ? "" : composer.slice(start, composer.indexOf('"relative border-t border-cream-line bg-cream px-2 py-2"', start));
  is("POSITIVE CONTROL: the Composer has a 2.0 layout", v2.length > 500, true);
  is("2.0: a closed window shows the template picker, not the text box (the expired branch comes first)",
    v2.indexOf("windowExpired ? (") > 0 && v2.indexOf("windowExpired ? (") < v2.indexOf('data-testid="crm-composer"'), true);
  is("2.0: Send is the same submitText, disabled on a closed window", /onClick=\{\(\) => void submitText\(\)\}/.test(v2) && /disabled=\{sending \|\| !body\.trim\(\) \|\| !appUserId \|\| !canSendMessages \|\| windowExpired\}/.test(v2), true);
  is("2.0: the layout makes no request of its own", /fetch\(/.test(v2), false);
}
{
  const choice = strip(readFileSync("src/lib/chatsInboxChoice.ts", "utf8"));
  is("the switch is per staff id, per browser, and only an explicit \"1\" turns 2.0 on",
    /`crm:inbox2:v1:\$\{appUserId\}`/.test(choice) && /=== "1"/.test(choice), true);
}

console.log("\n— fixes of 2026-11-07 (Ryan's use on production) —");
{
  const inbox = strip(readFileSync(join(DIR, "Inbox2.tsx"), "utf8"));
  const goFn = inbox.slice(inbox.indexOf("const go = useCallback"), inbox.indexOf("const setTab"));
  // 1. THE TABS. In a production build router.replace dropped ?tab= / ?view= while a thread was open,
  //    so Waiting and Done did nothing. The tabs write the URL the way the provider writes ?threadId.
  is("POSITIVE CONTROL: the tab writer was found", goFn.length > 50, true);
  is("1. tabs write the URL with history.replaceState, state null (so Next syncs useSearchParams)", /window\.history\.replaceState\(null,/.test(goFn), true);
  is("1. …never passing Next's own state through (Next skips syncing a state that carries __NA)", /replaceState\(window\.history\.state/.test(goFn), false);
  is("POSITIVE CONTROL: that state pattern does find the provider's threadId writer", /replaceState\(window\.history\.state/.test(readFileSync("src/lib/crmConversation.tsx", "utf8")), true);
  is("1. …and never through router.replace / router.push (the call that dropped the param)", /router\.(replace|push)\(/.test(inbox), false);
  is("POSITIVE CONTROL: that router pattern does find the old page's call", /router\.(replace|push)\(/.test(strip(readFileSync("src/app/(internal)/match-ops/player-chats/CrmClient.tsx", "utf8"))), true);
  is("1. …and keeps the other params (built from window.location, so ?threadId survives)", /new URL\(window\.location\.href\)/.test(goFn), true);
  // 2. CHAT STATS: the five numbers as grid cells, the range toggle on its own row.
  const cells = statsCells({ metrics: { cohort: { conversations: 39, medianFirstResponseMin: 8.2, answeredWithin1h: 23, answeredWithin1hPct: 59, resolved: 22 } }, trend: { cohortMedianDeltaMin: -52 }, awaiting: { count: 4 } });
  is("2. five cells, in order", cells.map((c) => c.key), ["conversations", "median", "within1h", "resolved", "waiting"]);
  is("2. values and subs", cells.map((c) => [c.value, c.sub]), [["39", null], ["8m", "52m faster"], ["23", "59%"], ["22", "of 39"], ["4", null]]);
  is("2. nothing read yet is dashes, not zeros", statsCells(null).map((c) => c.value), ["—", "—", "—", "—", "—"]);
  is("2. minutes format", [fmtMinutes(0.4), fmtMinutes(125)], ["<1m", "2h 5m"]);
  const stats = strip(readFileSync(join(DIR, "ChatStats.tsx"), "utf8"));
  is("2. the range toggle renders before (above) the grid, on its own row", stats.indexOf('data-testid="chat-stats-range"') > 0 && stats.indexOf('data-testid="chat-stats-range"') < stats.indexOf('data-testid="chat-stats-grid"'), true);
  is("2. the grid is two rows of cells (2 or 3 columns), not one nowrap band", /grid grid-cols-2 [^"]*grid-cols-3/.test(stats) && !/whitespace-nowrap/.test(stats), true);
  is("2. the popover no longer renders the full-width strip", /<MetricsStrip/.test(inbox), false);
  // ITEMISED (2026-11-08, Ryan): the old page no longer renders the strip either (one number: the agent's
  // weekly line). The control moves to the line that replaced it, on both pages.
  const oldPage = strip(readFileSync("src/app/(internal)/match-ops/player-chats/CrmClient.tsx", "utf8"));
  is("POSITIVE CONTROL: both pages render the agent's weekly line", /<AgentScoreLine/.test(oldPage) && /<AgentScoreLine/.test(strip(readFileSync("src/app/(internal)/match-ops/player-chats/v2/Queue2.tsx", "utf8"))), true);
  is("the old page no longer renders the old strip", /<MetricsStrip/.test(oldPage), false);
  // 3. TEMPLATES LIVE IN THE COMPOSER ONLY.
  is("3. the ⋯ menu has no template item, and the page mounts no template modal of its own", /key: "template"|TemplateSendModal|approved WhatsApp template/.test(inbox), false);
  const comp = strip(readFileSync("src/app/(internal)/match-ops/player-chats/components/Composer.tsx", "utf8"));
  is("POSITIVE CONTROL: the composer keeps the Template quick action and the closed-window template send", /data-testid="crm-qa-template"/.test(comp) && /data-testid="crm-send-template"/.test(comp) && /<TemplateSendModal/.test(comp), true);
  // 4. THE FILTER POPOVER sits inside the queue column, inset, padded.
  const q = strip(readFileSync(join(DIR, "Queue2.tsx"), "utf8"));
  const pop = /data-testid="queue-filter-popover" className="([^"]+)"/.exec(q)?.[1] ?? "";
  is("POSITIVE CONTROL: the popover's classes were found", pop.length > 20, true);
  is("4. it spans the header with insets on BOTH sides and real padding", /\bleft-\[18px\]/.test(pop) && /\bright-\[18px\]/.test(pop) && /\bp-4\b/.test(pop), true);
  is("4. …and no fixed width that can push it past the column's left edge", /\bw-\[\d+px\]/.test(pop), false);
  is("4. …positioned against the header (relative), not the button", /className="relative flex flex-col gap-3 px-\[18px\]/.test(q), true);
  // 5. PLAYER DETAILS, OPEN OR CLOSED, PER BROWSER.
  is("5. the key is per staff id", detailsPrefKey("u-1"), "crm:inbox2:details:v1:u-1");
  is("5. stored \"1\" is open, \"0\" closed, nothing stored is closed (frame 1)", [readDetailsPref("1"), readDetailsPref("0"), readDetailsPref(null)], [true, false, false]);
  is("5. the page reads AND writes it", /getItem\(detailsPrefKey\(appUserId\)\)/.test(inbox) && /setItem\(detailsPrefKey\(appUserId\)/.test(inbox), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
