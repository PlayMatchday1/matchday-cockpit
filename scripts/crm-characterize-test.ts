import "server-only"; // no-op under --conditions=react-server
// Phase 19 STEP 0 — CHARACTERIZE Player Chats before Step 2 splits CrmClient (2,364 lines).
// The net under the refactor: pin what Player Chats DOES today so the split must keep it green.
//
// HONEST SCOPE / THE REPORTED DIFFICULTY (per the spec's "if it's hard to assert, that IS the
// finding"): the current Player Chats UI has NO test seams — zero data-testid hooks — and its
// live updates arrive over a Supabase realtime WEBSOCKET that cannot be driven hermetically
// without mutating production data. So the DOM-level behaviours (list renders/filters, a click
// visibly loads messages, the nav badge ticks, a realtime INSERT paints) are not assertable at
// runtime against the current seam-less code. Instead this suite pins the INVARIANTS the Step-2
// split most endangers, at the two levels that ARE assertable:
//   (A) the pure 24h-window rule — extracted to src/lib/crmWindow BEFORE the split (it moves
//       into the persistent provider, where a docked thread must keep re-evaluating it);
//   (B) source-level CONTRACTS the split must not change: the send target + confirm-then-append
//       + no-retry, Enter/Shift+Enter, the composer's expiry gate, and EXACTLY ONE realtime
//       subscription for the whole feature.
// After Step 2 gives a provider seam + testids, the dock's own hermetic suite asserts the
// runtime rendering. This file must stay green across the split.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/crm-characterize-test.ts

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { whatsappWindowExpired, WHATSAPP_WINDOW_MS } from "../src/lib/crmWindow";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const eq = (n: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
function mutation<T>(name: string, real: T, broken: T, assertion: (impl: T) => boolean) {
  let r = false, b = true;
  try { r = assertion(real); } catch { r = false; }
  try { b = assertion(broken); } catch { b = false; }
  (r && !b) ? ok(`${name}: real PASSES, broken FAILS (teeth)`) : bad(name, `real=${r} broken=${b}`);
}

const CRM_DIR = "src/app/(internal)/match-ops/player-chats";
const CRM = readFileSync(join(CRM_DIR, "CrmClient.tsx"), "utf8");
const COMPOSER = readFileSync(join(CRM_DIR, "components/Composer.tsx"), "utf8");
const SEND_ROUTE = readFileSync("src/app/api/crm/send/route.ts", "utf8");
const BADGE = readFileSync("src/lib/useCrmUnreadCount.ts", "utf8");

// ── (A) the 24h WhatsApp window — the rule the composer's disabled state depends on ────────
const NOW = Date.parse("2026-08-11T18:00:00.000Z");
const H = 3600000;
{
  // SMS never expires, whatever the timestamp.
  eq("SMS thread never expires (no window), even with an ancient inbound", whatsappWindowExpired("sms", new Date(NOW - 100 * H).toISOString(), NOW), false);
  eq("SMS thread with no inbound never expires", whatsappWindowExpired("sms", null, NOW), false);
  // WhatsApp inside the window sends; outside is blocked; exactly at the boundary is NOT expired.
  eq("WhatsApp inbound 23h ago is INSIDE the window (not expired)", whatsappWindowExpired("whatsapp", new Date(NOW - 23 * H).toISOString(), NOW), false);
  eq("WhatsApp inbound 25h ago is OUTSIDE the window (expired)", whatsappWindowExpired("whatsapp", new Date(NOW - 25 * H).toISOString(), NOW), true);
  eq("WhatsApp at EXACTLY 24h is not yet expired (strict >)", whatsappWindowExpired("whatsapp", new Date(NOW - WHATSAPP_WINDOW_MS).toISOString(), NOW), false);
  eq("WhatsApp one ms past 24h is expired", whatsappWindowExpired("whatsapp", new Date(NOW - WHATSAPP_WINDOW_MS - 1).toISOString(), NOW), true);
  // Fail closed: a WhatsApp thread with no inbound / a bad timestamp is treated as expired.
  eq("WhatsApp with NO inbound is expired (window never opened)", whatsappWindowExpired("whatsapp", null, NOW), true);
  eq("WhatsApp with an unparseable inbound is expired (fail closed)", whatsappWindowExpired("whatsapp", "not-a-date", NOW), true);
  // Re-evaluates over time: same thread, now advanced past the boundary, flips to expired.
  const inbound = new Date(NOW - 23 * H).toISOString();
  eq("the SAME thread flips to expired as `now` advances past 24h (re-evaluable on a timer)",
    [whatsappWindowExpired("whatsapp", inbound, NOW), whatsappWindowExpired("whatsapp", inbound, NOW + 2 * H)], [false, true]);
  // teeth: a rule that used kickoff of the window at SEND time (>= instead of >), or ignored
  // the channel, would misclassify the boundary / SMS.
  mutation("window rule keys on channel + strict 24h boundary", whatsappWindowExpired,
    ((ch: string, iso: string | null, now: number) => { if (!iso) return true; const t = Date.parse(iso); return now - t >= WHATSAPP_WINDOW_MS; }) as typeof whatsappWindowExpired,
    (fn) => fn("sms", new Date(NOW - 100 * H).toISOString(), NOW) === false && fn("whatsapp", new Date(NOW - WHATSAPP_WINDOW_MS).toISOString(), NOW) === false);
}

// ── (B) source-level CONTRACTS the split must preserve ─────────────────────────────────────
const noComments = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const COMPOSER_C = noComments(COMPOSER), CRM_C = noComments(CRM), SEND_C = noComments(SEND_ROUTE), BADGE_C = noComments(BADGE);
// The composer sends to /api/crm/send with { thread_id, body } and appends only on 2xx.
/fetch\(\s*["'`]\/api\/crm\/send["'`]/.test(COMPOSER_C) ? ok("composer posts to /api/crm/send") : bad("composer send target changed");
/thread_id:\s*threadId/.test(COMPOSER_C) && /\bbody\b/.test(COMPOSER_C) ? ok("composer send body is { thread_id, body }") : bad("composer send body shape changed");
// Confirm-then-append (NOT optimistic): the `if (!res.ok) throw` guard sits BEFORE onSent, so a
// non-2xx never appends a message. A duplicate/ghost message to a player is the risk this blocks.
{
  const iThrow = COMPOSER_C.indexOf("if (!res.ok)");
  const iSent = COMPOSER_C.indexOf("onSent(");
  iThrow > -1 && iSent > iThrow ? ok("composer is confirm-then-append: onSent only AFTER res.ok is checked") : bad("composer append/confirm order changed", `throw@${iThrow} sent@${iSent}`);
}
// No retry anywhere on the send path — a resend is a manual, operator action, never automatic.
{
  const sub = COMPOSER_C.slice(COMPOSER_C.indexOf("submitText"), COMPOSER_C.indexOf("submitText") + 900);
  !/retry|setTimeout\([^)]*submitText|while\s*\(/.test(sub) ? ok("composer send never auto-retries") : bad("composer added a retry");
}
!/retr(y|ies)|for\s*\(|while\s*\(/.test(SEND_C) ? ok("send route never retries the provider call (single-shot)") : bad("send route retries");
// A player-visible send must have a human behind it — the cron/CRON_SECRET path can't reach it.
/if \(!appUserId\)/.test(SEND_C) && /no_human_actor|human operator/.test(SEND_C) ? ok("send route requires a human operator (closes the cron send path)") : bad("send route missing human-actor guard");
/auth\.canSendMessages/.test(SEND_C) ? ok("send route gates on can_send_messages") : bad("send route missing can_send_messages gate");
// Enter sends, Shift+Enter newlines.
/e\.key === "Enter" && !e\.shiftKey/.test(COMPOSER_C) ? ok("Enter sends, Shift+Enter makes a newline") : bad("Enter/Shift+Enter handler changed");
// The composer disables on an expired WhatsApp window. SELECTOR-PATH UPDATE (Phase 19 Step 3b): the
// disabled expression now keys on `windowExpired` = whatsappWindowExpired || serverClosedWindow (a
// server 422 that closed the window mid-send also disables) — the gate is unchanged, only stronger.
/disabled\s*=\s*[^\n]*windowExpired/.test(COMPOSER_C) ? ok("composer is disabled when the WhatsApp window is expired (client OR server-422 close)") : bad("composer expiry gate removed");
// CrmClient delegates the window rule to the shared, tested helper (the Step-0 seam).
/from "@\/lib\/crmWindow"/.test(CRM_C) && /whatsappWindowExpired\(/.test(CRM_C) ? ok("CrmClient delegates the window rule to src/lib/crmWindow (tested seam)") : bad("CrmClient no longer uses the shared window rule");

// EXACTLY ONE realtime subscription across the CRM conversation code. B2 moved the single channel
// OUT of the feature dir INTO the provider (src/lib/crmConversation.tsx), so the scan now spans
// both — the invariant is unchanged (one channel + one .subscribe), only its home moved. There
// must never be two subscriptions on crm_messages (a prior duplicate-channel bug took every page
// down — see useCrmUnreadCount).
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}
const crmFiles = [...walk(CRM_DIR), "src/lib/crmConversation.tsx", "src/components/crm/CrmDock.tsx"];
const subscribeCount = crmFiles.reduce((n, f) => n + (readFileSync(f, "utf8").match(/\.subscribe\(/g)?.length ?? 0), 0);
const channelCount = crmFiles.reduce((n, f) => n + (readFileSync(f, "utf8").match(/\.channel\(/g)?.length ?? 0), 0);
eq("EXACTLY ONE realtime subscription across the CRM conversation code (feature + provider)", { channels: channelCount, subscribes: subscribeCount }, { channels: 1, subscribes: 1 });
// The nav unread badge is poll-only — NO realtime channel (documented crash-avoidance). Check
// against comment-stripped source so the "uses NO supabase.channel()" note doesn't false-match.
!/\.channel\(|\.subscribe\(/.test(BADGE_C) && /POLL_MS|setInterval/.test(BADGE_C) ? ok("nav unread badge stays poll-only (no realtime channel)") : bad("nav badge grew a realtime channel");

// ── Phase 19 Step 3b — every send AND every Resend go through /api/crm/send, which recordWrites
// METADATA ONLY. The message body is never copied into change_log (a second store of player PII
// under different access rules). logCrmSend takes a LENGTH, not the text, so the body structurally
// cannot reach the log.
const SEND_SRC = noComments(readFileSync("src/app/api/crm/send/route.ts", "utf8"));
/recordWrite\(/.test(SEND_SRC) ? ok("send route logs via recordWrite (Resend is the same route, so also logged)") : bad("send route not recordWrite-logged");
// change_log metadata is minimized: message_length (not the body) AND recipient LAST-4 only (not
// the full phone — a second copy of player PII in a table with an is_admin audience). thread_id is
// the authoritative recipient identifier. Pin BOTH so neither the body nor the full number drifts back.
(/message_length:\s*args\.bodyLength/.test(SEND_SRC) && /recipient_last4:\s*phoneLast4\(/.test(SEND_SRC) && !/recipient_phone/.test(SEND_SRC))
  ? ok("change_log records message_length + recipient LAST-4 (hint) — never the body OR the full phone")
  : bad("change_log metadata leaks the full recipient phone or the message body");
/bodyLength:\s*number/.test(SEND_SRC) ? ok("logCrmSend receives a LENGTH, never the message text — body can't reach change_log") : bad("logCrmSend now receives the message body (PII leak into change_log)");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
