// CLAUDE DRAFTS IN PLAYER CHATS — the guards on what a draft can say, what leaves for the API, and
// what it costs. Also the change-log record for every outbound send path.
//
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/ai-draft-test.ts
//
// WHY THIS IS A SUITE. Drafts are player-facing text written by a model, built from player data
// sent to a third party, on a budget. Every one of those can go wrong silently: an email in the
// request body, a courtesy credit promised to the wrong player, an em dash, a cap that never trips.
// None is visible by looking at one draft on a page. Runtime assertions over the pure model
// (src/lib/aiDraftModel) and the orchestration with fakes (src/lib/aiDraftRun) — no network, no DB.
//
// The few SOURCE assertions at the bottom are where a browser click or an HTTP route makes the
// behaviour unobservable here (Use draft never sends; each send route calls the logger). They pin
// the PAIRING and assert the negative too, per CLAUDE.md "Source-text assertions".

import { readFileSync } from "node:fs";
import {
  draftEligibility, buildDraftContext, buildDraftRequest, scrubPii, sanitizeDraft, hasDash, guardDraft,
  classifyDraftOutcome, capReached, draftCostUsd, assertAnthropicHost, monthStartUtcIso, DRAFT_INSTRUCTIONS,
  type DraftMsg, type DraftContextIn, type DraftRequest,
} from "../src/lib/aiDraftModel";
import { runDraft, type DraftDeps, type NewDraftRow, type StoredDraft } from "../src/lib/aiDraftRun";
import { draftOutcomePatch, discardPatch } from "../src/lib/aiDraftOutcome";
import { playbookForModel } from "../src/lib/aiDraftPlaybook";
import { crmSendLogBody, logCrmSend } from "../src/lib/crmSendLog";
import type { LogStore } from "../src/lib/changeLog";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`));
const eq = (n: string, got: unknown, want: unknown) => ok(n, JSON.stringify(got) === JSON.stringify(want), `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

const NOW = Date.parse("2026-10-20T18:00:00Z");
const H = 3600e3;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
let seq = 0;
const msg = (direction: "inbound" | "outbound", body: string, agoMs: number, extra: Partial<DraftMsg> = {}): DraftMsg =>
  ({ id: `m${++seq}`, direction, body, sent_at: iso(agoMs), ...extra });

// ── 1. a draft only when the latest message is from the player ───────────────────────────────
console.log("\nWHICH THREADS GET A DRAFT:");
{
  const q = [msg("outbound", "Hey, how can we help?", 3 * H), msg("inbound", "My match got cancelled, where's my credit?", 1 * H)];
  const e = draftEligibility(q, "whatsapp", NOW);
  ok("POSITIVE CONTROL: latest message from the player, window open → eligible", e.ok);
  ok("  and the draft is based on that latest player message", e.ok && e.basedOn.id === q[1].id);
  eq("latest message is ours → no draft", draftEligibility([q[1], msg("outbound", "Credit added!", 0.5 * H)], "whatsapp", NOW), { ok: false, reason: "latest_not_player" });
  ok("an out-of-hours AUTO-REPLY after the player does not count as our answer",
    draftEligibility([q[1], msg("outbound", "Thanks for reaching out!", 0.9 * H, { is_auto_reply: true })], "whatsapp", NOW).ok);
  eq("a player's emoji REACTION to our reply does not reopen the thread",
    draftEligibility([q[1], msg("outbound", "Done!", 0.5 * H), msg("inbound", "👍", 0.4 * H, { media_kind: "reaction" })], "whatsapp", NOW), { ok: false, reason: "latest_not_player" });
  eq("STOP → no draft", draftEligibility([msg("outbound", "Match tonight!", 5 * H), msg("inbound", "STOP", 1 * H)], "sms", NOW), { ok: false, reason: "stop" });
  eq("\"Stop.\" → no draft", draftEligibility([msg("inbound", "Stop.", 1 * H)], "sms", NOW), { ok: false, reason: "stop" });
  eq("a bare greeting → no draft", draftEligibility([msg("outbound", "Done!", 5 * H), msg("inbound", "Hey!", 1 * H)], "whatsapp", NOW), { ok: false, reason: "greeting" });
  eq("thanks only, in two messages → no draft", draftEligibility([msg("outbound", "Credit added", 5 * H), msg("inbound", "ok", 2 * H), msg("inbound", "thank you!! 🙏", 1 * H)], "whatsapp", NOW), { ok: false, reason: "greeting" });
  ok("\"Cancel membership\" is a REQUEST, not a stop word", draftEligibility([msg("inbound", "Cancel Membership", 1 * H)], "whatsapp", NOW).ok);
  ok("a greeting followed by a question → draft", draftEligibility([msg("inbound", "Hi", 1.1 * H), msg("inbound", "when is the video posted?", 1 * H)], "whatsapp", NOW).ok);
  ok("a greeting with a photo attached → draft (the photo is the request)", draftEligibility([msg("inbound", "hi", 1 * H, { media_kind: "image" })], "whatsapp", NOW).ok);
  eq("WhatsApp window closed (last player message 25h ago) → no draft", draftEligibility([msg("inbound", "where is my credit", 25 * H)], "whatsapp", NOW), { ok: false, reason: "window_closed" });
  ok("the same message on SMS (no window) → draft", draftEligibility([msg("inbound", "where is my credit", 25 * H)], "sms", NOW).ok);
  eq("no messages → no draft", draftEligibility([], "whatsapp", NOW), { ok: false, reason: "no_messages" });
}

// ── context fixtures ─────────────────────────────────────────────────────────────────────────
const EMAIL = "jordan.realname@example.com";
const PHONE = "+15125550123";
const kickoff = "2026-10-20T20:00:00.000Z"; // instant
const lateCancel = (playedBefore: number, member = false): DraftContextIn => ({
  linked: true, ambiguous: false, firstName: "Jordan", city: "Austin", isMember: member, membership: null,
  creditsCents: 0, matchesPlayed: playedBefore, strikes: { active: 0, limit: 4, suspended: false },
  matches: [{ name: "Westlake 8v8", startDate: "2026-10-20T15:00:00.000Z", startDateUtc: kickoff, state: "player_cancelled", price: 1200, charged: 1299, playerCancelledAt: new Date(Date.parse(kickoff) - 3 * H).toISOString() }],
});

// ── 4. what leaves for the API ───────────────────────────────────────────────────────────────
console.log("\nTHE REQUEST BODY SENT TO THE API:");
{
  const msgs = [
    msg("inbound", `Hi it's Jordan Realname, my email is ${EMAIL} and my number is ${PHONE}, also try (512) 555-0199`, 2 * H),
    msg("outbound", "Hey Jordan! Let me check.", 1.5 * H, { sent_by_user_id: "staff-1" } as Partial<DraftMsg>),
    msg("inbound", "I cancelled 3 hours before, can I get a credit?", 1 * H),
  ];
  const ctx = buildDraftContext(lateCancel(0));
  const req = buildDraftRequest({ playbook: "## 1. House rules\nBe kind.", context: ctx, msgs, now: NOW });
  const body = JSON.stringify(req);
  console.log("\n  ----- logged request body (messages[0].content) -----");
  console.log(req.messages[0].content.split("\n").map((l) => `  | ${l}`).join("\n"));
  console.log("  -----------------------------------------------------\n");
  // Positive controls: the inputs DID carry the PII, and the patterns DO find it where it exists.
  ok("POSITIVE CONTROL: the raw player message contains the email and phone", msgs[0].body!.includes(EMAIL) && msgs[0].body!.includes(PHONE));
  ok("POSITIVE CONTROL: the email/phone patterns match the raw text", /@example\.com/.test(msgs[0].body!) && /5125550123|555-0123|5550123/.test(msgs[0].body!.replace(/\D/g, "")));
  ok("no email address anywhere in the request body", !/[A-Z0-9._%+-]+@[A-Z0-9-]+\.[A-Z]/i.test(body) && !body.includes("example.com"));
  ok("no full phone number anywhere in the request body", !/\d{7,}/.test(body.replace(/[\s().-]/g, "").replace(/2026\d*/g, "")) && !body.includes("555-0199") && !body.includes("5550123"));
  ok("the scrub left placeholders where they were", body.includes("[email]") && body.includes("[phone]"));
  ok("the first name IS present", body.includes("\\\"first_name\\\": \\\"Jordan\\\"") || body.includes('"first_name": "Jordan"') || req.messages[0].content.includes('"first_name": "Jordan"'));
  ok("the last name from the profile is NOT in the context (only first_name is built)", !JSON.stringify(ctx).includes("Realname"));
  ok("staff are labelled, never named", req.messages[0].content.includes("MatchDay staff:") && !body.includes("staff-1"));
  ok("no card, Stripe, member-number or password field names in the body", !/card|last4|stripe|payment_intent|subscription_id|member_number|password/i.test(body));
  eq("model is claude-sonnet-5-5 at low effort", [req.model, req.output_config.effort], ["claude-sonnet-5-5", "low"]);
  eq("scrubPii keeps short numbers (a $12 price, a 9pm time)", scrubPii("It was $12 at 9pm, team 4"), "It was $12 at 9pm, team 4");
}

// ── 5. courtesy credit for first-time players only ───────────────────────────────────────────
console.log("\nTHE LATE-CANCEL COURTESY (rule 5):");
{
  const first = buildDraftContext(lateCancel(0));
  const returning = buildDraftContext(lateCancel(7));
  const memberFirst = buildDraftContext(lateCancel(0, true));
  const unlinked = buildDraftContext({ ...lateCancel(0), linked: false, matchesPlayed: null });
  eq("first-time player (0 played) → first_time_player, courtesy eligible", [first.first_time_player, first.courtesy_credit_eligible], [true, true]);
  eq("returning player (7 played) → not first time, NOT eligible", [returning.first_time_player, returning.courtesy_credit_eligible], [false, false]);
  eq("a first-time MEMBER is not eligible (members have no charge to credit)", memberFirst.courtesy_credit_eligible, false);
  eq("an unlinked thread is never eligible (no courtesy on a guess)", unlinked.courtesy_credit_eligible, false);
  eq("the late cancel is visible to the model in hours", first.recent_matches[0].cancelled_hours_before_kickoff, 3);
  eq("the match price, not the amount with tax, is what the model sees as the price", first.recent_matches[0].match_price, "$12.00");
  const mem = buildDraftContext({ ...lateCancel(20, true), membership: { status: "ACTIVE", since: "2026-06-12T00:00:00Z", renews: "2026-11-01T00:00:00Z", canceledAt: "2026-10-06T03:30:00Z", price: 6650 } });
  eq("a billing date stored as midnight UTC on the 1st reads as the 1st, not Oct 31", mem.membership?.next_charge, "Nov 1, 2026");
  eq("a cancel at 03:30 UTC on the 6th is the 5th in Central (the day they pressed it)", mem.membership?.cancelled_on, "Oct 5, 2026");
  const offer = { reply: "Normally we need 24 hours, but since it's your first match I'll add a one-time credit.", staff_notes: "Courtesy credit: issue $12.00", category: "player_cancel", flags: ["needs_credit"], offers_courtesy_credit: true };
  ok("guard ACCEPTS a courtesy offer to a first-time player", guardDraft(offer, first).ok);
  ok("guard REJECTS the same offer to a returning player", !guardDraft(offer, returning).ok);
  ok("guard accepts a no-courtesy reply to a returning player", guardDraft({ ...offer, reply: "Our window is 24 hours, so this one isn't eligible.", offers_courtesy_credit: false }, returning).ok);
}

// ── 6. no em dash in any draft ───────────────────────────────────────────────────────────────
console.log("\nNO EM DASHES (rule 2):");
{
  const dirty = "Hey Jordan — sorry about that – the video is up 8–9pm, check it out — enjoy!";
  ok("POSITIVE CONTROL: the dash detector finds dashes in a dirty string", hasDash(dirty));
  const clean = sanitizeDraft(dirty);
  ok("sanitizeDraft leaves no em or en dash", !hasDash(clean), clean);
  eq("a time range keeps a hyphen", clean.includes("8-9pm"), true);
  const g = guardDraft({ reply: dirty, staff_notes: "Check — the host", category: "veo", flags: [], offers_courtesy_credit: false }, { courtesy_credit_eligible: false });
  ok("every draft that passes the guard is dash-free (reply and notes)", g.ok && !hasDash(g.output.reply) && !hasDash(g.output.staff_notes));
  ok("the drafting instructions contain no dash", !hasDash(DRAFT_INSTRUCTIONS));
  const pb = playbookForModel(readFileSync("docs/support/PLAYBOOK.md", "utf8"));
  ok("POSITIVE CONTROL: the playbook sent to the model has the house rules", /^## 1\./m.test(pb) && pb.includes("No em dashes"));
  ok("the playbook sent to the model stops before section 4 (history, never sent)", !/^## 4\./m.test(pb) && !pb.includes("Zelle"));
  ok("the playbook sent to the model contains no dash (its example answers are what the model copies)", !hasDash(pb));
}

// ── orchestration fakes ──────────────────────────────────────────────────────────────────────
type Fake = { deps: DraftDeps; calls: { model: DraftRequest[]; inserts: NewDraftRow[]; superseded: number } };
function fake(over: Partial<DraftDeps> & { msgs?: DraftMsg[]; ctx?: DraftContextIn; spend?: number; prior?: StoredDraft | null; modelText?: string } = {}): Fake {
  const calls = { model: [] as DraftRequest[], inserts: [] as NewDraftRow[], superseded: 0 };
  const deps: DraftDeps = {
    threadId: "t1", requestedBy: "u1", regenerate: false, now: () => NOW, hasKey: true,
    loadThread: async () => ({ channel: "whatsapp", player_id: 42, match_ambiguous: false }),
    loadMessages: async () => over.msgs ?? [msg("inbound", "I cancelled 3 hours before, can I get a credit?", 1 * H)],
    latestDraftFor: async () => over.prior ?? null,
    supersedePending: async () => { calls.superseded++; },
    monthSpendUsd: async () => over.spend ?? 0,
    loadContext: async () => ({ ctx: over.ctx ?? lateCancel(0), keys: ["account", "first_name"] }),
    playbook: () => ({ text: "## 1. House rules", version: "test" }),
    callModel: async (req) => {
      calls.model.push(req);
      return { text: over.modelText ?? JSON.stringify({ reply: "Hey Jordan — happy to help!", staff_notes: "", category: "player_cancel", flags: [], offers_courtesy_credit: false }), stopReason: "end_turn", usage: { input_tokens: 9000, output_tokens: 300 } };
    },
    insertDraft: async (row) => { calls.inserts.push(row); return { id: `d${calls.inserts.length}`, created_at: new Date(NOW).toISOString() }; },
    ...over,
  };
  return { deps, calls };
}

// tsx runs this file as CJS, which has no top-level await: the async sections run inside main().
async function main() {
// ── 7. the $20 monthly cap ───────────────────────────────────────────────────────────────────
console.log("\nTHE $20 MONTHLY CAP:");
{
  const under = fake({ spend: 19.99 });
  const r1 = await runDraft(under.deps);
  ok("POSITIVE CONTROL: at $19.99 spent, a draft is made (one model call)", r1.status === "ok" && under.calls.model.length === 1);
  const over = fake({ spend: 20.01 });
  const r2 = await runDraft(over.deps);
  ok("cost_usd forced over the cap ($20.01) → drafting stops", r2.status === "cap_reached");
  eq("  and the model is NOT called", over.calls.model.length, 0);
  ok("  and the card says so plainly", r2.status === "cap_reached" && /paused/.test(r2.message) && r2.message.includes("$20"));
  const exact = fake({ spend: 20 });
  ok("exactly $20.00 is already the cap", (await runDraft(exact.deps)).status === "cap_reached" && exact.calls.model.length === 0);
  const broken = fake({ monthSpendUsd: async () => { throw new Error("db down"); } });
  ok("a spend read that FAILS stops drafting too (fails closed)", (await runDraft(broken.deps)).status === "cap_reached" && broken.calls.model.length === 0);
  ok("capReached(NaN) is true", capReached(NaN));
  eq("cost of 9,000 in / 300 out at $2/$10 per million", draftCostUsd({ input_tokens: 9000, output_tokens: 300 }), 0.021);
  eq("every insert records its cost (failed ones too)", under.calls.inserts[0].cost_usd, 0.021);
  eq("the cap month starts on the 1st (UTC)", monthStartUtcIso(NOW), "2026-10-01T00:00:00.000Z");
}

// ── 9 + 5 + 6 through the orchestration ──────────────────────────────────────────────────────
console.log("\nORCHESTRATION (no draft, reuse, guards):");
{
  for (const [label, msgs, channel] of [
    ["STOP", [msg("inbound", "STOP", 1 * H)], "whatsapp"],
    ["a greeting", [msg("outbound", "Done", 3 * H), msg("inbound", "hello", 1 * H)], "whatsapp"],
    ["a closed WhatsApp window", [msg("inbound", "where's my credit", 30 * H)], "whatsapp"],
  ] as const) {
    const f = fake({ msgs: [...msgs], loadThread: async () => ({ channel, player_id: 42, match_ambiguous: false }) });
    const r = await runDraft(f.deps);
    ok(`${label} → skipped, no model call, nothing stored`, r.status === "skipped" && f.calls.model.length === 0 && f.calls.inserts.length === 0);
  }
  const prior: StoredDraft = { id: "d-old", outcome: "pending", draft_text: "Hi!", staff_notes: "[flags: escalate] check", category: "x", error: null, created_at: "" };
  const reuse = fake({ prior });
  const rr = await runDraft(reuse.deps);
  ok("reopening a thread returns the stored draft for free (no model call)", rr.status === "ok" && rr.reused && reuse.calls.model.length === 0);
  ok("  with its flags split back out of the notes", rr.status === "ok" && rr.draft.flags[0] === "escalate" && rr.draft.staff_notes === "check");
  const disc = fake({ prior: { ...prior, outcome: "discarded" } });
  ok("a discarded draft is NOT redrafted on reopen", (await runDraft(disc.deps)).status === "discarded" && disc.calls.model.length === 0);
  const regen = fake({ prior, regenerate: true });
  ok("Regenerate makes a new draft and supersedes the pending one", (await runDraft(regen.deps)).status === "ok" && regen.calls.model.length === 1 && regen.calls.superseded === 1);

  const dashy = fake();
  const rd = await runDraft(dashy.deps);
  ok("a model reply WITH an em dash is stored and shown without one", rd.status === "ok" && !hasDash(rd.draft.text) && !hasDash(dashy.calls.inserts[0].draft_text ?? ""));

  const courtesyText = JSON.stringify({ reply: "Since it's your first match, I'll add a one-time credit.", staff_notes: "Courtesy credit: issue $12.00", category: "player_cancel", flags: ["needs_credit"], offers_courtesy_credit: true });
  const firstTimer = fake({ ctx: lateCancel(0), modelText: courtesyText });
  const rf = await runDraft(firstTimer.deps);
  ok("first-time player late cancel: the courtesy offer is SHOWN", rf.status === "ok" && /one-time credit/.test(rf.draft.text));
  ok("  and the model was told they are eligible", firstTimer.calls.model[0].messages[0].content.includes('"courtesy_credit_eligible": true'));
  const returner = fake({ ctx: lateCancel(7), modelText: courtesyText });
  const rx = await runDraft(returner.deps);
  ok("returning player late cancel: a courtesy offer is NOT shown", rx.status === "failed");
  ok("  it is stored as failed with the reason", returner.calls.inserts[0].outcome === "failed" && /courtesy/.test(returner.calls.inserts[0].error ?? ""));
  ok("  and the model was told they are NOT eligible", returner.calls.model[0].messages[0].content.includes('"courtesy_credit_eligible": false'));

  const refused = fake({ callModel: async () => ({ text: null, stopReason: "refusal", usage: { input_tokens: 100, output_tokens: 0 } }) });
  ok("a refusal is stored as failed, with no retry", (await runDraft(refused.deps)).status === "failed" && refused.calls.inserts[0].outcome === "failed");
  const nokey = fake({ hasKey: false });
  ok("no ANTHROPIC_API_KEY → not_configured, no call", (await runDraft(nokey.deps)).status === "not_configured" && nokey.calls.model.length === 0);
  let threw = false; try { assertAnthropicHost("https://api.anthropic.com.evil.com/v1"); } catch { threw = true; }
  ok("the API host is checked on the PARSED host: api.anthropic.com.evil.com is rejected", threw);
  let fine = true; try { assertAnthropicHost("https://api.anthropic.com"); } catch { fine = false; }
  ok("POSITIVE CONTROL: api.anthropic.com itself passes", fine);
}

// ── 3. outcomes ──────────────────────────────────────────────────────────────────────────────
console.log("\nOUTCOMES (sent unchanged / sent edited / discarded):");
{
  const draft = { id: "d1", thread_id: "t1", outcome: "pending", draft_text: "Hey Jordan! Your video goes up within 24 to 48 hours." };
  const base = { threadId: "t1", messageId: "m9", userId: "u1", nowIso: "2026-10-20T18:00:00.000Z" };
  eq("sent exactly as drafted → sent_unchanged, distance 0",
    draftOutcomePatch(draft, { ...base, sentBody: draft.draft_text })?.outcome, "sent_unchanged");
  eq("whitespace-only differences still count as unchanged",
    draftOutcomePatch(draft, { ...base, sentBody: `  ${draft.draft_text}\n` })?.edit_distance, 0);
  const edited = draftOutcomePatch(draft, { ...base, sentBody: "Hey Jordan! Your video goes up within 48 hours." });
  eq("an edited send → sent_edited", edited?.outcome, "sent_edited");
  ok("  with a positive edit distance and the message it became", (edited?.edit_distance ?? 0) > 0 && edited?.sent_message_id === "m9");
  eq("a draft_id from ANOTHER thread records nothing", draftOutcomePatch({ ...draft, thread_id: "t2" }, { ...base, sentBody: "x" }), null);
  eq("an outcome already recorded is never overwritten", draftOutcomePatch({ ...draft, outcome: "sent_unchanged" }, { ...base, sentBody: "x" }), null);
  eq("discard of a pending draft → discarded", discardPatch(draft, base)?.outcome, "discarded");
  eq("discard of a draft already sent records nothing", discardPatch({ ...draft, outcome: "sent_edited" }, base), null);
  eq("classifyDraftOutcome('abc','abd') distance 1", classifyDraftOutcome("abc", "abd"), { outcome: "sent_edited", edit_distance: 1 });
}

// ── 8. every send path writes the change log ─────────────────────────────────────────────────
console.log("\nCHANGE LOG FOR EVERY SEND PATH:");
{
  const rows: Record<string, unknown>[] = [];
  const store: LogStore = { insert: async (r) => { rows.push(r as unknown as Record<string, unknown>); }, list: async () => [], resolve: async () => {} };
  const common = { threadId: "t1", toPhone: PHONE, channel: "whatsapp" as const, appUserId: "u1", actorEmail: "staff@example.com", nowIso: "2026-10-20T18:00:00.000Z" };
  const caption = "Here is your match video Jordan";
  await logCrmSend({ ...common, kind: "media", path: "/api/crm/send-media", bodyLength: caption.length, sendError: null, mediaKind: "image" }, store);
  await logCrmSend({ ...common, kind: "template", path: "/api/crm/send-template", bodyLength: 120, sendError: "Meta 400: opted out", templateName: "support_followup" }, store);
  await logCrmSend({ ...common, kind: "text", path: "/api/crm/send", bodyLength: 40, sendError: null }, store);
  eq("three sends → three change_log rows", rows.length, 3);
  eq("the rows name their routes", rows.map((r) => r.endpoint), ["/api/crm/send-media", "/api/crm/send-template", "/api/crm/send"]);
  // A provider error is a plain Error, which recordWrite classifies as "unknown" (NO ANSWER): the
  // same classification /api/crm/send has always given a failed Telnyx or Meta send.
  eq("a media send that landed is landed; a template Meta refused is not", [rows[0].outcome, rows[1].outcome], ["landed", "unknown"]);
  const logged = JSON.stringify(rows);
  ok("POSITIVE CONTROL: the logged rows carry the recipient's last four digits", logged.includes('"recipient_last4":"0123"'));
  ok("no caption text in the log", !logged.includes(caption));
  ok("no full phone in the log", !logged.includes("5125550123") && !logged.includes(PHONE));
  eq("the media row records kind + caption length only", crmSendLogBody({ ...common, kind: "media", path: "/api/crm/send-media", bodyLength: 31, sendError: null, nowIso: "", mediaKind: "image" }),
    { thread_id: "t1", recipient_last4: "0123", channel: "whatsapp", kind: "media", message_length: 31, media_kind: "image" });
}

// ── source pairings (a click and an HTTP route are not observable here) ──────────────────────
console.log("\nSOURCE PAIRINGS:");
{
  const strip = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const composer = strip(readFileSync("src/app/(internal)/match-ops/player-chats/components/Composer.tsx", "utf8"));
  const onUse = composer.slice(composer.indexOf("onUse={"), composer.indexOf("onDiscarded={"));
  ok("POSITIVE CONTROL: the Composer wires the draft card's onUse", onUse.length > 20 && onUse.includes("setBody(text)"));
  ok("Use draft fills the box and NEVER sends (no submitText, no fetch in onUse)", !/submitText|fetch\(|send/i.test(onUse.replace("setBody", "")));
  ok("the Composer sends the draft_id with the text it sends", /draft_id:\s*usedDraftId/.test(composer));
  const card = strip(readFileSync("src/app/(internal)/match-ops/player-chats/components/AiDraftCard.tsx", "utf8"));
  ok("the draft card never calls a send route", !/\/api\/crm\/send/.test(card));
  for (const [route, path] of [["send", "/api/crm/send"], ["send-media", "/api/crm/send-media"], ["send-template", "/api/crm/send-template"]] as const) {
    const src = strip(readFileSync(`src/app/api/crm/${route}/route.ts`, "utf8"));
    const calls = [...src.matchAll(/logCrmSend\(\{([^}]*)\}\)/g)].map((m) => m[1]);
    ok(`${route}: calls logCrmSend with its own path`, calls.length > 0 && calls.every((c) => c.includes(`path: "${path}"`)));
    ok(`${route}: passes a LENGTH, never the text, into the log`, calls.every((c) => /bodyLength:\s*\w+\.length/.test(c) && !/\b(body|caption|renderedBody|vars):/.test(c)));
    ok(`${route}: does not call recordWrite directly (one logging shape)`, !/recordWrite\(/.test(src));
  }
  const draftRoute = strip(readFileSync("src/app/api/crm/threads/[id]/ai-draft/route.ts", "utf8"));
  ok("the draft route never sends a message (no send helpers imported)", !/sendWhatsApp|telnyx|\/api\/crm\/send/i.test(draftRoute));
  ok("the draft route reads no Stripe and spreads no profile into the context", !/fetchPlayerPayments|\.\.\.p\b|\.\.\.raw|\.\.\.listRow/.test(draftRoute));
}

}

main().then(
  () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail || pass === 0 ? 1 : 0);
  },
  (e) => { console.error(e); process.exit(1); },
);
