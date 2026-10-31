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
  classifyDraftOutcome, capReached, draftCostUsd, assertAnthropicHost, monthStartUtcIso, DRAFT_INSTRUCTIONS, DRAFT_OUTPUT_SCHEMA,
  decideAutoSend, decisionConfig, isAutoSendLive, autoSendAllowed, badAutoSendReplies, KILL_MAX_BAD, type AutoSendConfig, type DecisionContext, type DraftContext,
  parseDraftOutput, priorCourtesyFromLog, staffRepliesConfirmAccount, selectExamples, discardReasonText, DISCARD_CHIPS,
  type DraftMsg, type DraftContextIn, type DraftRequest,
} from "../src/lib/aiDraftModel";
import { runDraft, CONFIRMED_BY_STAFF_NOTE, type DraftDeps, type NewDraftRow, type StoredDraft } from "../src/lib/aiDraftRun";
import { applyDraftAction, creditReason, guestCodeBody, guestCodeFor, guestCodeRefusal, staffConfirmedMembership, writeStatusFrom, type ActionIO } from "../src/lib/aiDraftAction";
import { buildRecordedFields, type CameraRow } from "../src/lib/aiDraftCamera";
import { processHold, holdStopReason, type HoldIO, type HoldRow } from "../src/lib/aiDraftAuto";
import { draftOutcomePatch, discardPatch } from "../src/lib/aiDraftOutcome";
import { playbookForModel } from "../src/lib/aiDraftPlaybook";
import { crmSendLogBody, logCrmSend } from "../src/lib/crmSendLog";
import { linkThread, type LinkIO } from "../src/lib/crmThreadLink";
import { phoneDigits10, extractPhoneNumbers, decideLinkSuggestion, linkSuggestionText, phoneShapes, renderTranscript, toNoteBullets, finalStaffNotes } from "../src/lib/aiDraftModel";
import { sinceText, buildClock, scheduleWindow, fieldTokens, mentionedFields, selectSchedule, timesIn, unscheduledTimes, lateReplyProblem, staleDraftReason, matchKey, type ScheduleRow } from "../src/lib/aiDraftClock";
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
const lateCancel = (playedBefore: number, member = false, priorCourtesyCredit: boolean | null = false): DraftContextIn => ({
  priorCourtesyCredit,
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
  eq("model is claude-opus-5-5 at medium effort", [req.model, req.output_config.effort], ["claude-opus-5-5", "medium"]);
  eq("scrubPii keeps short numbers (a $12 price, a 9pm time)", scrubPii("It was $12 at 9pm, team 4"), "It was $12 at 9pm, team 4");
}

// ── 5. one courtesy credit per account, lifetime ─────────────────────────────────────────────
console.log("\nTHE LATE-CANCEL COURTESY (rule 5):");
{
  const first = buildDraftContext(lateCancel(0));
  const veteranNever = buildDraftContext(lateCancel(40));
  const returning = buildDraftContext(lateCancel(0, false, true));
  const memberFirst = buildDraftContext(lateCancel(0, true));
  const unknown = buildDraftContext(lateCancel(0, false, null));
  const unlinked = buildDraftContext({ ...lateCancel(0), linked: false, matchesPlayed: null });
  eq("never had one, never played → eligible", first.courtesy_credit_eligible, true);
  eq("never had one, 40 matches played → still eligible (playing no longer matters)", veteranNever.courtesy_credit_eligible, true);
  eq("already had one → NOT eligible, even with 0 played", returning.courtesy_credit_eligible, false);
  eq("a member is not eligible (members have no charge to credit)", memberFirst.courtesy_credit_eligible, false);
  eq("the history read failed → NOT eligible (no courtesy on a guess)", unknown.courtesy_credit_eligible, false);
  eq("an unlinked thread is never eligible", unlinked.courtesy_credit_eligible, false);
  ok("the old first-time flag is gone from what the model sees", !("first_time_player" in first));

  const row = (reason: string, before = 0, after = 1200, env = "production", outcome = "landed") =>
    ({ env, outcome, changes: [{ key: "creditAmount", before, after }, { key: "reason", before: "—", after: reason }] });
  for (const r of ["1st time", "1st cancel", "First match", "1st", "1st game", "1st offense", "1x courtesy credit. 16 hrs before the match.", "Courtesy credit: late cancel", "cancel grace", "Poor experience", "Experience", "one time", "one-time thing", "Player support - 1 time agreement"]) {
    eq(`prior courtesy: "${r}"`, priorCourtesyFromLog([row(r)]), true);
  }
  for (const r of ["no host", "lights", "Rain", "Double payed", "Wrong match", "Clicked the wrong match.", "credit", "Cancel", "Host", "Credit instead of refund"]) {
    eq(`not a courtesy: "${r}"`, priorCourtesyFromLog([row(r)]), false);
  }
  eq("a courtesy that didn't land doesn't count", priorCourtesyFromLog([row("1st time", 0, 1200, "production", "notapplied")]), false);
  eq("a staging test doesn't count", priorCourtesyFromLog([row("1st time", 0, 1200, "staging")]), false);
  eq("taking money away doesn't count", priorCourtesyFromLog([row("Experience adjust", 1200, 0)]), false);
  eq("no credit history at all → no prior courtesy", priorCourtesyFromLog([]), false);

  eq("the late cancel is visible to the model in hours", first.recent_matches[0].cancelled_hours_before_kickoff, 3);
  eq("the match price, not the amount with tax, is what the model sees as the price", first.recent_matches[0].match_price, "$12.00");
  const mem = buildDraftContext({ ...lateCancel(20, true), membership: { status: "ACTIVE", since: "2026-06-12T00:00:00Z", renews: "2026-11-01T00:00:00Z", canceledAt: "2026-10-06T03:30:00Z", price: 6650 } });
  eq("a billing date stored as midnight UTC on the 1st reads as the 1st, not Oct 31", mem.membership?.next_charge, "Nov 1, 2026");
  eq("a cancel at 03:30 UTC on the 6th is the 5th in Central (the day they pressed it)", mem.membership?.cancelled_on, "Oct 5, 2026");
  const offer = { reply: "Normally we need 24 hours, but I'll add a one-time credit.", staff_notes: ["Courtesy credit: issue $12.00"], category: "player_cancel", flags: ["needs_credit"], offers_courtesy_credit: true, match_ids: [] };
  ok("guard ACCEPTS a courtesy offer to a player who hasn't had one", guardDraft(offer, first).ok);
  ok("guard REJECTS the same offer to a player who has", !guardDraft(offer, returning).ok);
  ok("guard accepts a no-courtesy reply to that player", guardDraft({ ...offer, reply: "Our window is 24 hours, so this one isn't eligible.", offers_courtesy_credit: false }, returning).ok);
}

// ── 6. no em dash in any draft ───────────────────────────────────────────────────────────────
console.log("\nNO EM DASHES (rule 2):");
{
  const dirty = "Hey Jordan — sorry about that – the video is up 8–9pm, check it out — enjoy!";
  ok("POSITIVE CONTROL: the dash detector finds dashes in a dirty string", hasDash(dirty));
  const clean = sanitizeDraft(dirty);
  ok("sanitizeDraft leaves no em or en dash", !hasDash(clean), clean);
  eq("a time range keeps a hyphen", clean.includes("8-9pm"), true);
  const g = guardDraft({ reply: dirty, staff_notes: ["Check — the host"], category: "veo", flags: [], offers_courtesy_credit: false, match_ids: [] }, { courtesy_credit_eligible: false });
  ok("every draft that passes the guard is dash-free (reply and notes)", g.ok && !hasDash(g.output.reply) && !g.output.staff_notes.some(hasDash));
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
    loadThread: async () => ({ channel: "whatsapp", player_id: 42, match_ambiguous: false, account_confirmed: false }),
    countAccounts: async () => 1,
    findAccountsByPhone: async () => [],
    priorCategory: async () => null,
    loadExampleMessages: async () => [],
    appliedActions: async () => [],
    loadMessages: async () => over.msgs ?? [msg("inbound", "I cancelled 3 hours before, can I get a credit?", 1 * H)],
    latestDraftFor: async () => over.prior ?? null,
    supersedePending: async () => { calls.superseded++; },
    monthSpendUsd: async () => over.spend ?? 0,
    loadContext: async () => ({ ctx: over.ctx ?? lateCancel(0), keys: ["account", "first_name"] }),
    loadScheduleRows: async () => [],
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
// ── 7. the $150 monthly cap ───────────────────────────────────────────────────────────────────
console.log("\nTHE $150 MONTHLY CAP:");
{
  const under = fake({ spend: 149.99 });
  const r1 = await runDraft(under.deps);
  ok("POSITIVE CONTROL: at $149.99 spent, a draft is made (one model call)", r1.status === "ok" && under.calls.model.length === 1);
  const over = fake({ spend: 150.01 });
  const r2 = await runDraft(over.deps);
  ok("cost_usd forced over the cap ($150.01) → drafting stops", r2.status === "cap_reached");
  eq("  and the model is NOT called", over.calls.model.length, 0);
  ok("  and the card says so plainly", r2.status === "cap_reached" && /paused/.test(r2.message) && r2.message.includes("$150"));
  const exact = fake({ spend: 150 });
  ok("exactly $150.00 is already the cap", (await runDraft(exact.deps)).status === "cap_reached" && exact.calls.model.length === 0);
  const broken = fake({ monthSpendUsd: async () => { throw new Error("db down"); } });
  ok("a spend read that FAILS stops drafting too (fails closed)", (await runDraft(broken.deps)).status === "cap_reached" && broken.calls.model.length === 0);
  ok("capReached(NaN) is true", capReached(NaN));
  eq("cost of 9,000 in / 300 out at $4/$20 per million", draftCostUsd({ input_tokens: 9000, output_tokens: 300 }), 0.042);
  eq("a cache hit at 0.05x input, the Opus 5.5 rate", draftCostUsd({ cache_read_input_tokens: 1000000 }), 0.2);
  eq("every insert records its cost (failed ones too)", under.calls.inserts[0].cost_usd, 0.042);
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
    const f = fake({ msgs: [...msgs], loadThread: async () => ({ channel, player_id: 42, match_ambiguous: false, account_confirmed: false }) });
    const r = await runDraft(f.deps);
    ok(`${label} → skipped, no model call, nothing stored`, r.status === "skipped" && f.calls.model.length === 0 && f.calls.inserts.length === 0);
  }
  const prior: StoredDraft = { id: "d-old", outcome: "pending", draft_text: "Hi!", staff_notes: "[flags: escalate] check", category: "x", error: null, created_at: "" };
  const reuse = fake({ prior });
  const rr = await runDraft(reuse.deps);
  ok("reopening a thread returns the stored draft for free (no model call)", rr.status === "ok" && rr.reused && reuse.calls.model.length === 0);
  ok("  with its flags split back out of the notes", rr.status === "ok" && rr.draft.flags[0] === "escalate" && rr.draft.staff_notes[0] === "check");
  const disc = fake({ prior: { ...prior, outcome: "discarded" } });
  ok("a discarded draft is NOT redrafted on reopen", (await runDraft(disc.deps)).status === "discarded" && disc.calls.model.length === 0);
  const regen = fake({ prior, regenerate: true });
  ok("Regenerate makes a new draft and supersedes the pending one", (await runDraft(regen.deps)).status === "ok" && regen.calls.model.length === 1 && regen.calls.superseded === 1);

  const dashy = fake();
  const rd = await runDraft(dashy.deps);
  ok("a model reply WITH an em dash is stored and shown without one", rd.status === "ok" && !hasDash(rd.draft.text) && !hasDash(dashy.calls.inserts[0].draft_text ?? ""));

  const courtesyText = JSON.stringify({ reply: "I'll add a one-time credit for this one.", staff_notes: "Courtesy credit: issue $12.00", category: "player_cancel", flags: ["needs_credit"], offers_courtesy_credit: true });
  const firstTimer = fake({ ctx: lateCancel(0), modelText: courtesyText });
  const rf = await runDraft(firstTimer.deps);
  ok("no courtesy yet, late cancel: the courtesy offer is SHOWN", rf.status === "ok" && /one-time credit/.test(rf.draft.text));
  ok("  and the model was told they are eligible", firstTimer.calls.model[0].messages[0].content.includes('"courtesy_credit_eligible": true'));
  const returner = fake({ ctx: lateCancel(7, false, true), modelText: courtesyText });
  const rx = await runDraft(returner.deps);
  ok("already had one, late cancel: a courtesy offer is NOT shown", rx.status === "failed");
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

// ── unmatched phone numbers (2026-10-21) ─────────────────────────────────────────────────────
console.log("\nUNMATCHED PHONE NUMBERS:");
{
  // Digits only: every common format is the same number.
  for (const f of ["(512) 555-0100", "512-555-0100", "+15125550100", "512.555.0100", "1 512 555 0100", "5125550100", "+1 (512) 555 0100"]) {
    eq(`"${f}" → 5125550100`, phoneDigits10(f), "5125550100");
  }
  eq("a 7-digit local number is not matchable", phoneDigits10("555-0100"), null);
  eq("an 11-digit number not starting with 1 is not a US number", phoneDigits10("25125550100"), null);
  eq("a number inside a sentence is found", extractPhoneNumbers("hey it's (512) 555-0100, thanks!"), ["5125550100"]);
  eq("the two stored shapes searched for it", phoneShapes("5125550100"), ["+15125550100", "5125550100"]);
  eq("one account → suggest it", decideLinkSuggestion("5125550100", [{ id: 7, first_name: "Sam " }]), { kind: "one", player_id: 7, first_name: "Sam", last4: "0100" });
  eq("the same account found under both shapes is still ONE account", decideLinkSuggestion("5125550100", [{ id: 7, first_name: "Sam" }, { id: 7, first_name: "Sam" }]).kind, "one");
  const many = decideLinkSuggestion("5125550100", [{ id: 7, first_name: "Sam" }, { id: 9, first_name: "Ana" }]);
  eq("a number on two accounts → suggests nothing", many, { kind: "many", count: 2, last4: "0100" });
  ok("  and says so", /on 2 accounts, so there's no single match/.test(linkSuggestionText(many)));
  eq("no account → says so", linkSuggestionText(decideLinkSuggestion("5125550100", [])), "No account found for the number ending 0100.");
  eq("the suggestion reads \"Matches Sam, link?\"", linkSuggestionText({ kind: "one", player_id: 7, first_name: "Sam", last4: "0100" }), "Matches Sam (number ending 0100), link?");

  // An UNLINKED thread: the draft asks for the number and carries no account facts.
  let profileReads = 0;
  const factsCtx = { ...lateCancel(3), creditsCents: 1624, membership: { status: "ACTIVE", since: null, renews: null, canceledAt: null, price: 6650 } };
  const unlinkedThread = async () => ({ channel: "whatsapp", player_id: null, match_ambiguous: false, account_confirmed: false });
  const askText = JSON.stringify({ reply: "Happy to help! What's the phone number on your MatchDay account? You can find it in your profile in the app.", staff_notes: "", category: "account", flags: [], offers_courtesy_credit: false });
  const un = fake({ loadThread: unlinkedThread, modelText: askText, msgs: [msg("inbound", "where's my credit from last night?", 1 * H)], loadContext: async () => { profileReads++; return { ctx: factsCtx, keys: ["x"] }; } });
  const ru = await runDraft(un.deps);
  const sent = un.calls.model[0]?.messages[0].content ?? "";
  ok("unlinked thread → a draft is made", ru.status === "ok" && un.calls.model.length === 1);
  eq("  no account data is loaded at all", profileReads, 0);
  ok("  the model is told the account is unconfirmed and to ask", sent.includes('"account_confirmed": false') && sent.includes('"ask_for_account_phone": true'));
  ok("POSITIVE CONTROL: the facts fixture does carry a name, credits and a membership", factsCtx.firstName === "Jordan" && factsCtx.creditsCents === 1624);
  ok("  NO account facts in the request: no name, credits, membership or matches", !/Jordan|\$16\.24|\$66\.50|Westlake|"is_member": true/.test(sent) && sent.includes('"credit_balance": null') && sent.includes('"recent_matches": []'));
  ok("  the draft asks for the account's phone number", ru.status === "ok" && /phone number on your MatchDay account/.test(ru.draft.text));
  ok("  staff notes say why: \"No account found for this number.\" (first bullet)", ru.status === "ok" && ru.draft.staff_notes[0] === "No account found for this number.");
  ok("  and the stored notes say it too", (un.calls.inserts[0].staff_notes ?? "").includes("No account found for this number."));
  const dup = fake({ loadThread: unlinkedThread, modelText: JSON.stringify({ reply: "What's the phone number on your MatchDay account?", staff_notes: ["No account found for this number.", "Asked for it."], category: "account", flags: [], offers_courtesy_credit: false, match_ids: [] }) });
  const rd2 = await runDraft(dup.deps);
  eq("  the reason appears once even when the model also wrote it", rd2.status === "ok" && rd2.draft.staff_notes, ["No account found for this number.", "Asked for it."]);
  const dup2 = fake({ loadThread: unlinkedThread, modelText: JSON.stringify({ reply: "MatchDay is adult soccer, typically 16 and up.", staff_notes: ["Under 16: player says they're 14. No account found for this number."], category: "age", flags: ["under_16"], offers_courtesy_credit: false, match_ids: [] }) });
  const rd3 = await runDraft(dup2.deps);
  eq("  and once when the model buried it inside another bullet", rd3.status === "ok" && rd3.draft.staff_notes, ["No account found for this number.", "Under 16: player says they're 14."]);
  eq("  an unconfirmed thread is never courtesy-eligible", sent.includes('"courtesy_credit_eligible": false'), true);

  // AMBIGUOUS, not confirmed: same, with the account count.
  profileReads = 0;
  const amb = fake({ loadThread: async () => ({ channel: "whatsapp", player_id: 42, match_ambiguous: true, account_confirmed: false }), countAccounts: async () => 2, modelText: askText, loadContext: async () => { profileReads++; return { ctx: factsCtx, keys: [] }; } });
  const ra = await runDraft(amb.deps);
  ok("phone on 2 accounts, unconfirmed → notes say \"Number is on 2 accounts.\"", ra.status === "ok" && ra.draft.staff_notes[0] === "Number is on 2 accounts.");
  ok("  and the newest account's data is NOT loaded or sent", profileReads === 0 && !/Jordan/.test(amb.calls.model[0].messages[0].content));

  // LINKING makes the next draft include that player's info.
  let linkedNow = false; profileReads = 0;
  const flip = fake({
    loadThread: async () => (linkedNow ? { channel: "whatsapp", player_id: 42, match_ambiguous: true, account_confirmed: true } : { channel: "whatsapp", player_id: null, match_ambiguous: false, account_confirmed: false }),
    modelText: askText, loadContext: async () => { profileReads++; return { ctx: factsCtx, keys: ["first_name", "credits"] }; },
  });
  await runDraft(flip.deps);
  linkedNow = true;
  await runDraft({ ...flip.deps, regenerate: true });
  ok("before linking: no name in the request", !flip.calls.model[0].messages[0].content.includes("Jordan"));
  ok("after linking (confirmed by staff): the next draft's request carries the player's info", profileReads === 1 && flip.calls.model[1].messages[0].content.includes('"first_name": "Jordan"') && flip.calls.model[1].messages[0].content.includes('"credit_balance": "$16.24"'));
  ok("  even though the phone is still flagged on two accounts (confirmation wins)", flip.calls.model[1].messages[0].content.includes('"account_confirmed": true'));

  // A REPLY WITH A NUMBER suggests the single match, in any format, and never links.
  for (const typed of ["it's (512) 555-0100", "512-555-0100", "+15125550100"]) {
    const asked: string[] = [];
    const s1 = fake({ loadThread: unlinkedThread, modelText: askText, msgs: [msg("outbound", "What's the phone number on your account?", 2 * H), msg("inbound", typed, 1 * H)],
      findAccountsByPhone: async (d) => { asked.push(d); return [{ id: 7, first_name: "Sam" }]; } });
    const r = await runDraft(s1.deps);
    ok(`reply "${typed}" → suggests Sam (player 7), looked up by digits 5125550100`, "link_suggestion" in r && r.link_suggestion?.kind === "one" && (r.link_suggestion as { player_id: number }).player_id === 7 && asked[0] === "5125550100");
  }
  const s2 = fake({ loadThread: unlinkedThread, modelText: askText, msgs: [msg("inbound", "512 555 0100", 1 * H)], findAccountsByPhone: async () => [{ id: 7, first_name: "Sam" }, { id: 9, first_name: "Ana" }] });
  const r2 = await runDraft(s2.deps);
  ok("a number on two accounts suggests nothing and says so", "link_suggestion" in r2 && r2.link_suggestion?.kind === "many");
  const s3 = fake({ msgs: [msg("inbound", "my number is 512 555 0100", 1 * H)], findAccountsByPhone: async () => { throw new Error("should not be asked"); } });
  ok("a CONFIRMED thread never looks a number up", (await runDraft(s3.deps)).status === "ok");

  // THE LINK itself: who, when, before and after, read back.
  const logRows: Record<string, unknown>[] = [];
  const store: LogStore = { insert: async (r) => { logRows.push(r as unknown as Record<string, unknown>); }, list: async () => [], resolve: async () => {} };
  const mkIO = (start: number | null, sticks = true): LinkIO & { state: { player_id: number | null; account_confirmed_at: string | null; account_confirmed_by_user_id: string | null }; superseded: number } => {
    const io = {
      state: { player_id: start, account_confirmed_at: null as string | null, account_confirmed_by_user_id: null as string | null },
      superseded: 0,
      readThread: async () => ({ ...io.state }),
      readTarget: async (id: number) => (id === 404 ? null : { id, first_name: id === 7 ? "Sam" : "Ana", preferable_city_normalized: id === 8 ? "WAW" : "ATX" }),
      writeThread: async (p: { player_id: number; account_confirmed_at: string; account_confirmed_by_user_id: string | null }) => { if (sticks) io.state = { ...p }; },
      supersedePendingDrafts: async () => { io.superseded++; },
      now: () => "2026-10-21T15:00:00.000Z",
    };
    return io;
  };
  const actor = { appUserId: "user-ryan", email: "staff@example.com" };
  const io1 = mkIO(5);
  const lr = await linkThread({ threadId: "t1", playerId: 7, actor, confinedCity: null }, io1, store);
  ok("relink 5 → 7 lands (read-back shows player 7, confirmed)", lr.ok && lr.outcome === "landed" && io1.state.player_id === 7 && io1.state.account_confirmed_at != null);
  eq("  it is a CHANGE", lr.ok && lr.action, "change");
  eq("  the change log row says who, when, from and to", [logRows[0].actorName, logRows[0].actorEmail, logRows[0].at, (logRows[0].body as Record<string, unknown>).from_player_id, (logRows[0].body as Record<string, unknown>).to_player_id, logRows[0].source],
    ["staff@example.com", "staff@example.com", "2026-10-21T15:00:00.000Z", 5, 7, "crm-link"]);
  eq("  and records the confirming user on the thread", io1.state.account_confirmed_by_user_id, "user-ryan");
  eq("  the pending draft is superseded so the next one uses the new account", io1.superseded, 1);
  const io2 = mkIO(null);
  const l2 = await linkThread({ threadId: "t2", playerId: 7, actor, confinedCity: null }, io2, store);
  eq("an unlinked thread → action link", l2.ok && l2.action, "link");
  const io3 = mkIO(5, false);
  const l3 = await linkThread({ threadId: "t3", playerId: 7, actor, confinedCity: null }, io3, store);
  ok("a write that doesn't stick is NOT landed (read-back decides)", l3.ok && l3.outcome !== "landed");
  const io4 = mkIO(5);
  const before = logRows.length;
  const l4 = await linkThread({ threadId: "t4", playerId: 8, actor, confinedCity: "ATX" }, io4, store);
  ok("a city-confined account can't link to a player in another city (no write, no log)", !l4.ok && l4.status === 403 && io4.state.player_id === 5 && logRows.length === before);
  ok("POSITIVE CONTROL: the same confined account CAN link a player in its city", (await linkThread({ threadId: "t5", playerId: 7, actor, confinedCity: "ATX" }, mkIO(5), store)).ok);
}

// ── time awareness and the schedule (2026-10-21) ─────────────────────────────────────────────
console.log("\nTIME AND SCHEDULE:");
{
  // The PRUMC case: the player wrote Tue Oct 20 at 3:38 PM Central about "2 games today at PRUMC";
  // the draft is written Wed Oct 21 at 7:38 AM, 16 hours later.
  const WROTE = "2026-10-20T20:38:00.000Z"; // 3:38 PM CDT
  const NOW2 = Date.parse("2026-10-21T12:38:00.000Z"); // 7:38 AM CDT
  const CT = "America/Chicago";
  eq("how long ago, in the player's zone", sinceText(Date.parse(WROTE), NOW2, CT), "16h ago, yesterday 3:38 PM");
  eq("minutes when under an hour", sinceText(NOW2 - 25 * 60e3, NOW2, CT), "25 min ago, today 7:13 AM");
  const clock = buildClock({ now: NOW2, tz: CT, latestPlayerMsgIso: WROTE });
  eq("the clock names the last 7 days by date", clock.recent_days.slice(0, 3), ["today: Wednesday, Oct 21", "yesterday: Tuesday, Oct 20", "Monday, Oct 19"]);
  eq("the clock: now, zone, ago, very late (16h is not)", [clock.now_local, clock.time_zone, clock.latest_player_message, clock.reply_is_very_late],
    ["Wednesday, October 21, 2026 at 7:38 AM", "Central time (America/Chicago)", "16h ago, yesterday 3:38 PM", false]);
  eq("23h59m after → not very late", buildClock({ now: Date.parse(WROTE) + (24 * 60 - 1) * 60e3, tz: CT, latestPlayerMsgIso: WROTE }).reply_is_very_late, false);
  eq("24h01m after → very late", buildClock({ now: Date.parse(WROTE) + (24 * 60 + 1) * 60e3, tz: CT, latestPlayerMsgIso: WROTE }).reply_is_very_late, true);
  eq("the zone follows the player's city (Atlanta is Eastern)", buildClock({ now: NOW2, tz: "America/New_York", latestPlayerMsgIso: WROTE }).latest_player_message, "16h ago, yesterday 4:38 PM");
  ok("every transcript line carries its weekday and time in the player's zone",
    renderTranscript([{ id: "x", direction: "inbound", body: "2 games today at PRUMC?", sent_at: WROTE }], CT).startsWith("[Tue, Oct 20, 3:38 PM] Player:"));
  eq("the schedule window starts on the day the player WROTE (wall clock), 7 days on",
    scheduleWindow(WROTE, CT), { fromWall: "2026-10-20T00:00:00.000Z", toWall: "2026-10-28T00:00:00.000Z" });

  eq("PRUMC is a field token", fieldTokens("PRUMC"), ["prumc"]);
  eq("generic words are not", fieldTokens("Mueller Soccer Park Field 2"), ["mueller"]);
  const titles = ["PRUMC", "ATH Katy", "Mueller Soccer Park"];
  eq("\"2 games today at PRUMC\" names PRUMC", mentionedFields(["Are there 2 games today at PRUMC?"], titles), ["PRUMC"]);
  eq("\"at the park\" names no field", mentionedFields(["see you at the park tonight"], titles), []);
  ok("POSITIVE CONTROL: \"mueller\" does name Mueller", mentionedFields(["is mueller on tonight"], titles).length === 1);

  const row = (id: number, field: string, wall: string, utc: string, extra: Partial<ScheduleRow> = {}): ScheduleRow =>
    ({ api_id: id, field_title: field, start_date: wall, start_date_utc: utc, city_identifier: "HOU", is_cancelled: false, player_count: 12, max_player_count: 18, ...extra });
  const rows = [
    row(1, "PRUMC", "2026-10-20T18:00:00.000Z", "2026-10-20T23:00:00.000Z"),
    row(2, "PRUMC", "2026-10-20T20:00:00.000Z", "2026-10-21T01:00:00.000Z"),
    row(3, "PRUMC", "2026-10-22T19:00:00.000Z", "2026-10-23T00:00:00.000Z", { player_count: 15 }),
    row(4, "ATH Katy", "2026-10-21T20:00:00.000Z", "2026-10-22T01:00:00.000Z"),
    row(5, "Mueller Soccer Park", "2026-10-21T19:00:00.000Z", "2026-10-22T00:00:00.000Z", { city_identifier: "ATX" }),
  ];
  const sched = selectSchedule({ rows, texts: ["Are there 2 games today at PRUMC?"], cityCode: "HOU", now: NOW2 });
  eq("a named field picks that field's matches only", sched.entries.map((e) => e.match_id), [1, 2, 3]);
  eq("  last night's two are already over; Thursday's is upcoming with 3 spots",
    sched.entries.map((e) => [e.when_local, e.status, e.open_spots]),
    [["Tue, Oct 20, 6:00 PM", "already started or finished", 6], ["Tue, Oct 20, 8:00 PM", "already started or finished", 6], ["Thu, Oct 22, 7:00 PM", "upcoming", 3]]);
  eq("no field but \"tonight\" → the player's city", selectSchedule({ rows, texts: ["anything tonight?"], cityCode: "HOU", now: NOW2 }).entries.map((e) => e.match_id), [1, 2, 4, 3]);
  eq("no field and no day word → no schedule", selectSchedule({ rows, texts: ["where's my credit"], cityCode: "HOU", now: NOW2 }).basis, null);
  eq("a cancelled match says so", selectSchedule({ rows: [row(9, "PRUMC", "2026-10-22T19:00:00.000Z", "2026-10-23T00:00:00.000Z", { is_cancelled: true })], texts: ["PRUMC thursday?"], cityCode: null, now: NOW2 }).entries[0].status, "cancelled");

  // Times: "8pm", "8 PM", "8:00 p.m." are one time; a reply may quote only the schedule, the chat or the playbook.
  eq("time formats normalize", timesIn("8pm, 8 PM, 8:00 p.m. and 9:30am"), ["8:00 pm", "9:30 am"]);
  const allowed = [...sched.entries.map((e) => e.when_local), "Are there 2 games today at PRUMC?", "Support is 9am to 9pm Central."];
  eq("schedule times pass", unscheduledTimes("The next one is Thursday at 7:00 PM.", allowed), []);
  eq("support hours from the playbook pass", unscheduledTimes("We're around 9am to 9pm.", allowed), []);
  eq("an invented time is caught", unscheduledTimes("There's one tonight at 7:30pm!", allowed), ["7:30 pm"]);

  // Apologies (2026-10-22): a sorry for the wait only past 24 hours; under that, none.
  eq("over 24h, no apology → rejected", lateReplyProblem("Those were last night! The next one is Thursday at 7:00 PM.", true) != null, true);
  eq("over 24h, opens with sorry → fine", lateReplyProblem("Sorry for the slow reply! Those were last night.", true), null);
  eq("under 24h, apologizes for slowness → rejected", lateReplyProblem("Sorry for the slow reply! Thursday at 7:00 PM works.", false) != null, true);
  eq("under 24h, no apology, just the answer → fine", lateReplyProblem("Videos go up within 24 to 48 hours after the match.", false), null);
  eq("under 24h, sorry for a match we cancelled → fine", lateReplyProblem("Sorry about tonight's match!", false), null);
  eq("over 24h Veo answer: slow-reply apology, video timing stated plainly → fine", lateReplyProblem("Sorry for the slow reply! Videos go up within 24 to 48 hours after the match.", true), null);

  // Staff notes: the reason once, first, counted in the 3. Model shapes from stored drafts, 2026-10-22.
  const R = "No account found for this number.";
  eq("\"No account found for this number, so ...\" is cut to what follows", finalStaffNotes([
    "No account found for this number, so no account facts stated. Need the account phone before checking the two cancellations.",
    "Player asked for a refund of about $8 per cancelled booking.",
  ], R), [R, "Need the account phone before checking the two cancellations.", "Player asked for a refund of about $8 per cancelled booking."]);
  eq("\"Account still unconfirmed: no account matches this phone, so no facts verified.\" is cut", finalStaffNotes([
    "Account still unconfirmed: no account matches this phone, so no facts verified. Player gave a number but it did not link.",
  ], R), [R, "Player gave a number but it did not link."]);
  eq("\"Account still unconfirmed, check which ...\" keeps the instruction", finalStaffNotes(["Player just sent a phone number. Account still unconfirmed, check which account it matches."], R),
    [R, "Player just sent a phone number. Check which account it matches."]);
  eq("a bullet that is only the reason, in another shape, is dropped", finalStaffNotes(["No account matches this phone.", "Asked for it."], R), [R, "Asked for it."]);
  eq("\"No booking or account facts stated.\" is dropped", finalStaffNotes(["Under 16: player says they're 14.", "No booking or account facts stated."], R), [R, "Under 16: player says they're 14."]);
  eq("the reason counts as one of the 3", finalStaffNotes(["a", "b", "c"], R), [R, "a", "b"]);
  eq("two bullets that say the same thing → one", finalStaffNotes(["Check the cancel time.", "check the cancel time"], null), ["Check the cancel time."]);
  ok("POSITIVE CONTROL: a linked thread's notes are not cut", finalStaffNotes(["Account unconfirmed in Stripe, check it."], null)[0] === "Account unconfirmed in Stripe, check it.");

  // Notes: never more than 3 bullets.
  eq("5 bullets in → 3 out, in order", toNoteBullets(["a", "b", "c", "d", "e"]), ["a", "b", "c"]);
  eq("a dashed list in one string → bullets", toNoteBullets("- one\n- two\n- three\n- four"), ["one", "two", "three"]);

  // Through the orchestration.
  const pastText = JSON.stringify({ reply: "Both PRUMC games were last night, but there's another one Thursday at 7:00 PM with 3 spots left.", staff_notes: ["a", "b", "c", "d"], category: "booking", flags: [], offers_courtesy_credit: false, match_ids: [3] });
  const prumcMsgs = [msg("inbound", "Are there 2 games today at PRUMC?", NOW - Date.parse(WROTE) + (NOW2 - NOW))];
  prumcMsgs[0].sent_at = WROTE;
  const ctxHou = { ...lateCancel(5), cityCode: "HOU", matches: [] };
  const fy = fake({ now: () => NOW2, msgs: prumcMsgs, ctx: ctxHou, loadScheduleRows: async () => rows, modelText: pastText });
  const ry = await runDraft(fy.deps);
  const content = fy.calls.model[0]?.messages[0].content ?? "";
  ok("yesterday's \"today\" question: the request carries the clock (16h ago, yesterday 3:38 PM, not very late)", content.includes('"latest_player_message": "16h ago, yesterday 3:38 PM"') && content.includes('"reply_is_very_late": false'));
  ok("  and PRUMC's schedule with last night's games marked over and Thursday's upcoming", content.includes('"already started or finished"') && content.includes('"when_local": "Thu, Oct 22, 7:00 PM"') && content.includes("at the field the player named"));
  ok("  the draft that treats it as past and offers the real next time is SHOWN", ry.status === "ok" && /last night/.test(ry.draft.text) && /7:00 PM/.test(ry.draft.text));
  eq("  staff notes capped at 3 bullets", ry.status === "ok" && ry.draft.staff_notes.length, 3);
  ok("  the stored notes are 3 bullet lines", (fy.calls.inserts[0].staff_notes ?? "").split("\n").filter((l) => l.startsWith("- ")).length === 3);
  ok("  the mentioned match is stored with its kickoff (so the draft goes stale then)", fy.calls.inserts[0].context_keys.includes(matchKey(3, "2026-10-23T00:00:00.000Z")));

  const invent = fake({ now: () => NOW2, msgs: prumcMsgs, ctx: ctxHou, loadScheduleRows: async () => rows,
    modelText: JSON.stringify({ reply: "There's one tonight at 8:30pm at PRUMC.", staff_notes: [], category: "booking", flags: [], offers_courtesy_credit: false, match_ids: [] }) });
  const ri = await runDraft(invent.deps);
  ok("a draft with a match time NOT in the schedule is not shown", ri.status === "failed" && /isn't in our schedule \(8:30 pm\)/.test(ri.message));
  // Over 24 hours is only reachable on SMS: a WhatsApp thread that old is window_closed and gets no draft.
  const noSorry = fake({ now: () => NOW2 + 14 * H, msgs: prumcMsgs, ctx: ctxHou, loadScheduleRows: async () => rows,
    loadThread: async () => ({ channel: "sms", player_id: 42, match_ambiguous: false, account_confirmed: false }),
    modelText: JSON.stringify({ reply: "Both PRUMC games were Tuesday night. Next one is Thursday at 7:00 PM.", staff_notes: [], category: "booking", flags: [], offers_courtesy_credit: false, match_ids: [3] }) });
  const rn = await runDraft(noSorry.deps);
  ok("a 30h-late SMS draft that doesn't open with sorry is not shown, for that reason", rn.status === "failed" && /over 24 hours late/.test(rn.message));
  const quick = fake({ msgs: [msg("inbound", "any games tonight?", 0.5 * H)], ctx: { ...lateCancel(5), cityCode: "HOU" },
    modelText: JSON.stringify({ reply: "Sorry for the slow reply! Let me check tonight's games.", staff_notes: [], category: "booking", flags: [], offers_courtesy_credit: false, match_ids: [] }) });
  const rq = await runDraft(quick.deps);
  ok("a 30-minute reply that apologizes for slowness is not shown, for that reason", rq.status === "failed" && /wait under 24 hours/.test(rq.message));

  // Stale drafts.
  eq("a draft made 3h ago is stale", staleDraftReason({ created_at: new Date(NOW2 - 3 * H).toISOString() }, NOW2), "it was made more than 2 hours ago");
  eq("a draft made 30 min ago is fresh", staleDraftReason({ created_at: new Date(NOW2 - 0.5 * H).toISOString() }, NOW2), null);
  eq("a 30-min-old draft whose mentioned match kicked off 10 min ago is stale",
    staleDraftReason({ created_at: new Date(NOW2 - 0.5 * H).toISOString(), context_keys: [matchKey(3, new Date(NOW2 - 10 * 60e3).toISOString())] }, NOW2), "a match it mentions has started");
  const oldPrior: StoredDraft = { id: "d-3h", outcome: "pending", draft_text: "Let me check tonight's schedule", staff_notes: "- x", category: "booking", error: null, created_at: new Date(NOW - 3 * H).toISOString(), context_keys: [] };
  const fs1 = fake({ prior: oldPrior, msgs: [msg("inbound", "any news?", 4 * H)],
    modelText: JSON.stringify({ reply: "Still checking for you.", staff_notes: [], category: "other", flags: [], offers_courtesy_credit: false, match_ids: [] }) });
  const rs = await runDraft(fs1.deps);
  ok("opening a thread whose saved draft is stale supersedes it and makes a fresh one", rs.status === "ok" && !rs.reused && fs1.calls.superseded === 1 && fs1.calls.model.length === 1);
  const fresh = fake({ prior: { ...oldPrior, created_at: new Date(NOW - 0.5 * H).toISOString() } });
  ok("a fresh saved draft is reused (no model call)", (await runDraft(fresh.deps)).status === "ok" && fresh.calls.model.length === 0);
}

// ── phase 2: actions ─────────────────────────────────────────────────────────────────────────
console.log("\nPROPOSED ACTIONS:");
{
  const base = { staff_notes: [], flags: [], match_ids: [], offers_courtesy_credit: true };
  const credit = (amount: number | null, over: Record<string, unknown> = {}) => ({
    ...base, category: "player_cancel", reply: "We've credited $12.00 to your account, it'll apply to your next booking.",
    reply_without_action: "Normally we need 24 hours notice for a credit, but let me see what I can do.",
    action: { kind: "credit" as const, amount_cents: amount, reason: "late cancel, first courtesy" }, ...over,
  });
  const ctx = buildDraftContext(lateCancel(0));
  const g = (o: Parameters<typeof guardDraft>[0], c = ctx, applied: { kind: string }[] = []) => guardDraft(o, { courtesy_credit_eligible: c.courtesy_credit_eligible, context: c, appliedActions: applied });
  ok("POSITIVE CONTROL: a credit of the match price on a late cancel passes", g(credit(1200)).ok);
  const paid = g(credit(1299));
  ok("RULE 6: the paid amount ($12.99, with tax and fee) fails, for that reason", !paid.ok && /\$12\.99/.test(paid.error));
  ok("an amount that's nowhere in context fails", !g(credit(5000)).ok);
  ok("no amount fails", !g(credit(null)).ok);
  ok("a credit with no context to check fails", !guardDraft(credit(1200), { courtesy_credit_eligible: true }).ok);
  ok("a player_cancel credit not flagged as a courtesy fails", !g(credit(1200, { offers_courtesy_credit: false })).ok);
  ok("the second courtesy fails", !g(credit(1200), buildDraftContext(lateCancel(0, false, true))).ok);
  const far = buildDraftContext({ ...lateCancel(0), matches: [{ ...lateCancel(0).matches[0], playerCancelledAt: new Date(Date.parse(kickoff) - 30 * H).toISOString() }] });
  ok("a cancel 30 hours out is credited automatically, so no button", !g(credit(1200), far).ok);
  const club = buildDraftContext({ ...lateCancel(0), matches: [{ ...lateCancel(0).matches[0], state: "club_cancelled" }] });
  ok("a match already marked club-cancelled gets no button", !g(credit(1200, { category: "match_cancelled", offers_courtesy_credit: false }), club).ok);
  const unmarked = buildDraftContext({ ...lateCancel(0), matches: [{ ...lateCancel(0).matches[0], state: "played" }] });
  ok("POSITIVE CONTROL: a match not marked cancelled can (the host never showed)", g(credit(1200, { category: "match_cancelled", offers_courtesy_credit: false }), unmarked).ok);
  ok("a member's match gets no credit", !g(credit(1200, { category: "match_cancelled", offers_courtesy_credit: false }), buildDraftContext({ ...lateCancel(0, true), matches: [{ ...lateCancel(0).matches[0], state: "played" }] })).ok);
  ok("a category outside the list can't carry a credit", !g(credit(1200, { category: "veo", offers_courtesy_credit: false }), unmarked).ok);
  ok("the same action already applied on this thread fails", !g(credit(1200), ctx, [{ kind: "credit" }]).ok);
  ok("the version without the action can't say it's done", !g(credit(1200, { reply_without_action: "We've credited $12.00." })).ok);
  ok("a proposed action needs both versions", !g(credit(1200, { reply_without_action: "" })).ok);
  ok("an unconfirmed account can't carry an action", !g(credit(1200), buildDraftContext({ ...lateCancel(0), ambiguous: true, confirmed: false })).ok);
  ok("no action, but the reply says a credit is done: fails", !g({ ...base, offers_courtesy_credit: false, category: "player_cancel", reply: "We've credited your account." }).ok);
  const mem = buildDraftContext({ ...lateCancel(0, true), membership: { status: "ACTIVE", since: "2026-01-01T00:00:00Z", renews: null, canceledAt: null, price: 6650 } });
  ok("RULE 6, EVERYWHERE: a membership price is not a credit amount, even on a membership_billing draft", !g(credit(6650, { category: "membership_billing", offers_courtesy_credit: false }), mem).ok);
  ok("  nor from any other category", !g(credit(6650, { category: "needs_credit", offers_courtesy_credit: false }), mem).ok);
  const guest = { ...base, offers_courtesy_credit: false, category: "guest_pass", reply: "Your guest code is {code}, it works 3 times and goes live in a few minutes.", reply_without_action: "We're processing your guest passes.", action: { kind: "issue_guest_code" as const, amount_cents: null, reason: "member asked" } };
  ok("POSITIVE CONTROL: a guest code draft with the placeholder passes", g(guest, mem).ok);
  ok("a guest code without the placeholder fails (the model can't write a code)", !g({ ...guest, reply: "Your guest code is ATX597FP." }, mem).ok);
  ok("a guest code for a non-member fails", !g(guest, ctx).ok);
  const p1 = parseDraftOutput(JSON.stringify({ ...base, category: "x", reply: "hi", reply_without_action: "ignored", action: { kind: "none", amount_cents: null, reason: "" } }));
  eq("kind none parses to no action", [p1?.action, p1?.reply_without_action], [null, ""]);
  const schemaAction = DRAFT_OUTPUT_SCHEMA.properties.action.properties.kind.enum;
  eq("the model can propose a credit or a guest code, and cannot cancel a membership", schemaAction, ["none", "credit", "issue_guest_code"]);

  // Through runDraft: stored on the row, for the button.
  const text = JSON.stringify(credit(1200));
  const f = fake({ ctx: { ...lateCancel(0), creditsCents: 300 }, modelText: text });
  const r = await runDraft(f.deps);
  ok("the action comes back on the draft", r.status === "ok" && r.draft.action?.amount_cents === 1200 && r.draft.text_without_action !== null);
  eq("  stored with the player and the balance the draft saw", [f.calls.inserts[0].action?.player_id, f.calls.inserts[0].action?.balance_cents, f.calls.inserts[0].action?.is_courtesy], [42, 300, true]);
  const fp = fake({ modelText: JSON.stringify(credit(1299)) });
  const rp = await runDraft(fp.deps);
  ok("a credit that fails the guard is stored failed with no action", rp.status === "failed" && fp.calls.inserts[0].outcome === "failed" && fp.calls.inserts[0].action === null);
  const pressed: StoredDraft = { id: "d-p", outcome: "pending", draft_text: "We've credited $12.00.", staff_notes: null, category: "player_cancel", error: null, created_at: new Date(NOW - 5 * H).toISOString(), action_status: "landed" };
  const stale = fake({ prior: pressed });
  ok("a draft whose action landed is reused even though it's stale, no model call", (await runDraft(stale.deps)).status === "ok" && stale.calls.model.length === 0 && stale.calls.superseded === 0);
  const regen = fake({ prior: pressed, regenerate: true });
  await runDraft(regen.deps);
  ok("  and Regenerate can't replace it", regen.calls.model.length === 0 && regen.calls.superseded === 0);

  // Pressing the button.
  const mk = (over: Partial<ActionIO> = {}) => {
    const log = { writes: [] as unknown[], finished: [] as unknown[], claimed: false };
    const io: ActionIO = {
      threadId: "t1",
      loadDraft: async () => ({ id: "d1", thread_id: "t1", outcome: "pending", draft_text: "We've credited $8.00.", action_status: null, action: { kind: "credit", amount_cents: 800, reason: "late cancel", is_courtesy: true, player_id: 42, balance_cents: 300 } }),
      threadPlayerId: async () => 42, rightsRefusal: async () => null,
      guestPreflight: async () => ({ ok: true, code: "ATX597FP" }),
      claim: async () => { if (log.claimed) return false; log.claimed = true; return true; },
      writeCredit: async (a) => { log.writes.push(a); return { status: "landed" }; },
      writeGuestCode: async (c) => { log.writes.push(c); return { status: "landed" }; },
      finish: async (s, t) => { log.finished.push([s, t]); },
      ...over,
    };
    return { io, log };
  };
  const a1 = mk();
  const ra = await applyDraftAction(a1.io);
  ok("LANDED: the reply text comes back for the composer", ra.ok && ra.text === "We've credited $8.00.");
  eq("  the write carries the delta, the balance the draft saw, and the courtesy marker", a1.log.writes[0], { playerId: 42, deltaCents: 800, expectedBeforeCents: 300, reason: "Courtesy credit: late cancel" });
  ok("  and that reason counts as a prior courtesy next time", priorCourtesyFromLog([{ env: "production", outcome: "landed", changes: [{ key: "creditAmount", before: 0, after: 800 }, { key: "reason", before: "", after: creditReason({ reason: "late cancel", is_courtesy: true }) }] }]));
  ok("  and a non-courtesy credit doesn't carry the marker", creditReason({ reason: "no host", is_courtesy: false }) === "Claude draft: no host");
  ok("a phone in the model's reason is scrubbed before the log", !creditReason({ reason: "called 512-555-0100", is_courtesy: false }).includes("555"));
  const second = await applyDraftAction(a1.io);
  ok("a second press writes nothing", !second.ok && a1.log.writes.length === 1);
  for (const [status, label] of [["failed", "FAILED"], ["not_applied", "NOT APPLIED"], ["unknown", "UNKNOWN"]] as const) {
    const a = mk({ writeCredit: async () => ({ status, error: "nope" }) });
    const rf = await applyDraftAction(a.io);
    ok(`${label}: no reply text comes back, so the composer stays empty, and the error shows`, !rf.ok && rf.status === status && /nope/.test(rf.error) && !("text" in rf));
    eq(`  and the row records ${status}`, a.log.finished[0], [status, null]);
  }
  const noRights = mk({ rightsRefusal: async () => "EDIT CREDITS is required" });
  ok("no EDIT CREDITS: refused before any claim or write", !(await applyDraftAction(noRights.io)).ok && !noRights.log.claimed && noRights.log.writes.length === 0);
  const relinked = mk({ threadPlayerId: async () => 99 });
  ok("the thread was relinked: refused before any write", !(await applyDraftAction(relinked.io)).ok && relinked.log.writes.length === 0);
  const claimedElsewhere = mk({ claim: async () => false });
  ok("someone else claimed it first: no write", !(await applyDraftAction(claimedElsewhere.io)).ok && claimedElsewhere.log.writes.length === 0);
  const gc = mk({ loadDraft: async () => ({ id: "d2", thread_id: "t1", outcome: "pending", draft_text: "Your guest code is {code}, live in a few minutes.", action_status: null, action: { kind: "issue_guest_code", amount_cents: null, reason: "member asked", is_courtesy: false, player_id: 42, balance_cents: 0 } }) });
  const rg = await applyDraftAction(gc.io);
  ok("guest code: the code is filled into the reply after it's created", rg.ok && rg.text === "Your guest code is ATX597FP, live in a few minutes.");
  eq("  and stored, so a send compares against what was actually in the box", gc.log.finished[0], ["landed", "Your guest code is ATX597FP, live in a few minutes."]);
  const gr = mk({ loadDraft: gc.io.loadDraft, guestPreflight: async () => ({ ok: false, error: "already has one" }) });
  ok("guest code refused: no claim, no write", !(await applyDraftAction(gr.io)).ok && !gr.log.claimed && gr.log.writes.length === 0);
  eq("writeStatusFrom: credit LANDED / NOT APPLIED / ambiguous 502 / bare 403 / bare 500", [writeStatusFrom(200, { outcome: "LANDED" }), writeStatusFrom(200, { outcome: "NOT APPLIED" }), writeStatusFrom(502, { ambiguous: true }), writeStatusFrom(403, { error: "x" }), writeStatusFrom(500, { error: "x" })], ["landed", "not_applied", "unknown", "not_applied", "unknown"]);
  eq("writeStatusFrom: promo recordWrite states", [writeStatusFrom(200, { outcome: "landed" }), writeStatusFrom(200, { outcome: "notapplied" }), writeStatusFrom(409, { duplicate: true, error: "x" })], ["landed", "not_applied", "not_applied"]);

  // Guest code rules.
  const T = Date.parse("2026-10-31T12:00:00Z");
  const facts = { statusRaw: "ACTIVE", canceledAt: null, since: "2026-01-01T00:00:00Z", slug: "ATX597", existingCodes: [], staffConfirmed: false, now: T };
  eq("POSITIVE CONTROL: an active member past 24 hours with no code", guestCodeRefusal(facts), null);
  eq("the code is the slug plus FP", guestCodeFor("ATX597"), "ATX597FP");
  ok("no membership", /active membership/.test(guestCodeRefusal({ ...facts, statusRaw: "CANCELED" }) ?? ""));
  ok("a member who cancelled", /cancelled/.test(guestCodeRefusal({ ...facts, canceledAt: "2026-10-01T00:00:00Z" }) ?? ""));
  ok("an active FP code under an OLD slug refuses (member number changed)", /already has/.test(guestCodeRefusal({ ...facts, existingCodes: [{ code: "HOU12FP", end_date_utc: "2027-01-01T00:00:00Z", deleted_at: null }] }) ?? ""));
  eq("an expired one doesn't", guestCodeRefusal({ ...facts, existingCodes: [{ code: "ATX597FP", end_date_utc: "2026-01-01T00:00:00Z", deleted_at: null }] }), null);
  eq("a deleted one doesn't", guestCodeRefusal({ ...facts, existingCodes: [{ code: "ATX597FP", end_date_utc: "2027-01-01T00:00:00Z", deleted_at: "2026-02-01T00:00:00Z" }] }), null);
  ok("a membership 23 hours old refuses", /under 24 hours/.test(guestCodeRefusal({ ...facts, since: new Date(T - 23 * H).toISOString() }) ?? ""));
  eq("  unless a staff message confirmed it", guestCodeRefusal({ ...facts, since: new Date(T - 23 * H).toISOString(), staffConfirmed: true }), null);
  eq("25 hours old is fine", guestCodeRefusal({ ...facts, since: new Date(T - 25 * H).toISOString() }), null);
  ok("an unknown start date counts as new", /under 24 hours/.test(guestCodeRefusal({ ...facts, since: null }) ?? ""));
  ok("a slug that isn't letters then digits builds nothing", /couldn't be read/.test(guestCodeRefusal({ ...facts, slug: "ATX 597;" }) ?? ""));
  ok("a staff message confirming the membership counts", staffConfirmedMembership(["Your membership is active, you're all set"]));
  ok("the canned guest pass ask doesn't", !staffConfirmedMembership(["Send us a screenshot of the first MatchDay tab, the Home tab, showing your member number."]));
  const gb = guestCodeBody("ATX597FP", T);
  eq("the promo request is built here, 100% off, 3 uses in total, one year", [gb.code, gb.discountType, gb.value, gb.uses, gb.who, gb.which, gb.startDateUtc, gb.endDateUtc], ["ATX597FP", "PERCENT", 100, 3, "ALL_USERS", "TOTAL_USAGE", "2026-10-31T12:00:00.000Z", "2027-10-31T12:00:00.000Z"]);

  // Outcomes with two versions.
  const two = { id: "d1", thread_id: "t1", outcome: "pending", draft_text: "We've credited $8.00.", reply_without_action: "Let me check on that credit." };
  const oBase = { threadId: "t1", messageId: "m9", userId: "u1", nowIso: "2026-10-20T18:00:00.000Z" };
  eq("Use draft alone, sent as is → sent_unchanged", draftOutcomePatch(two, { ...oBase, sentBody: two.reply_without_action })?.outcome, "sent_unchanged");
  eq("the action version, sent as is → sent_unchanged", draftOutcomePatch(two, { ...oBase, sentBody: two.draft_text })?.outcome, "sent_unchanged");
}

// ── phase 2: length, examples, playbook, cameras ─────────────────────────────────────────────
console.log("\nLENGTH, EXAMPLES AND CAMERAS:");
{
  ok("the instructions default to one short sentence", /Default to one short sentence/.test(DRAFT_INSTRUCTIONS));
  ok("  and ban the closing offer", /Never end with a closing offer/.test(DRAFT_INSTRUCTIONS));
  ok("  the old 1 to 3 sentences is gone", !/1 to 3 short sentences/.test(DRAFT_INSTRUCTIONS));
  const pb = playbookForModel(readFileSync("docs/support/PLAYBOOK.md", "utf8"));
  ok("the playbook has the new rule, and no first-time wording", /One courtesy credit per account, lifetime/.test(pb) && !/first_time_player|first-time player/.test(pb));
  ok("  the minimum players and camera facts", /typically 12/.test(pb) && /75 minutes/.test(pb) && /recorded_fields/.test(pb));
  ok("  the Retool blind spot for staff", /check Retool/.test(pb));

  const m = (body: string, extra: Partial<DraftMsg> = {}) => msg("outbound", body, 1 * H, extra);
  const canned = "To cancel your membership: Profile tab, Membership Details, scroll to the bottom, Cancel Membership, confirm.";
  const picked = selectExamples([
    m("Awesome!"), m("Hey which field did you mean to book?"), m("Hey Jordan, you're all set"),
    m(canned), m(canned), m(canned),
    m("auto", { is_auto_reply: true }), m("tmpl", { template_name: "support_followup" }),
    m("I refunded your card"), m("Sure — done"), m("x".repeat(281)), m("Hi"), m("Awesome!"),
    m(`Mail ${EMAIL} or ${PHONE}`), m("Here you go https://app.veo.co/matches/123 and your code is ATX597FP"),
  ]);
  ok("POSITIVE CONTROL: real short replies are kept", picked.includes("Awesome!") && picked.includes("Hey which field did you mean to book?"));
  eq("a repeated short reply appears once", picked.filter((p) => p === "Awesome!").length, 1);
  ok("canned text with no template_name is dropped", !picked.some((p) => p.includes("Membership Details")));
  ok("auto-replies and templates are dropped", !picked.includes("auto") && !picked.includes("tmpl"));
  ok("a refund reply, a dashed reply, a very long reply and a bare hi are dropped", !picked.some((p) => /refund|—|^x+$|^Hi$/.test(p)));
  ok("another player's name, email, phone, link and code are scrubbed", !/Jordan|example\.com|555|veo\.co|ATX597/.test(picked.join(" ")) && picked.includes("Hey {name}, you're all set"));
  ok("\"Hey which field\" keeps its words (lower case isn't a name)", picked.some((p) => p.startsWith("Hey which")));
  eq("never more than 30", selectExamples(Array.from({ length: 50 }, (_, i) => m(`reply number ${i}`))).length, 30);

  const seen: (string | null)[] = [];
  const fx = fake({ ctx: lateCancel(0), priorCategory: async () => "veo", loadExampleMessages: async (c) => { seen.push(c); return [m("Awesome!"), m("Yes it's on")]; } });
  await runDraft(fx.deps);
  eq("examples come from the thread's last category", seen, ["veo"]);
  ok("  they reach the request under the agreed heading", fx.calls.model[0].messages[0].content.includes("EXAMPLES OF HOW THE TEAM WRITES") && fx.calls.model[0].messages[0].content.includes("- Yes it's on"));
  ok("  and are counted in context_keys", fx.calls.inserts[0].context_keys.includes("examples:2"));
  const fy = fake({ loadExampleMessages: async () => { throw new Error("db down"); } });
  ok("an examples read that fails still drafts, with no block", (await runDraft(fy.deps)).status === "ok" && !fy.calls.model[0].messages[0].content.includes("EXAMPLES OF") && fy.calls.inserts[0].context_keys.includes("examples:0"));

  const at = (id: number, name: string, field: number, title: string, startUtc: string, cancelled = false): CameraRow => ({ field_id: field, field_title: title, name, start_date: startUtc, start_date_utc: startUtc, is_cancelled: cancelled });
  const CN = Date.parse("2026-10-31T12:00:00Z");
  const fields = buildRecordedFields([
    at(1, "Zipp 🎥", 1, "Zipp", "2026-10-20T20:00:00Z"), at(2, "Zipp 🎥", 1, "Zipp", "2026-11-03T20:00:00Z"),
    at(3, "Keswick 🎥", 2, "Keswick", "2026-10-21T20:00:00Z"), at(4, "Keswick", 2, "Keswick", "2026-10-22T20:00:00Z"), at(5, "Keswick", 2, "Keswick", "2026-10-23T20:00:00Z"),
    at(6, "Westlake", 3, "Westlake", "2026-10-24T20:00:00Z"),
    at(7, "Gone 🎥", 4, "Gone", "2026-10-24T20:00:00Z", true),
  ], CN);
  eq("only fields with a live marked match, most recorded first", fields.map((f) => [f.field, f.recorded_matches, f.matches]), [["Zipp", 2, 2], ["Keswick", 1, 3]]);
  eq("  with the last and next recorded match, wall clock as written", [fields[0].last_recorded, fields[0].next_recorded], ["Tue, Oct 20, 8:00 PM", "Tue, Nov 3, 8:00 PM"]);
  ok("a coded field with no marker isn't listed", !fields.some((f) => f.field === "Westlake"));
  const withCam = buildDraftContext({ ...lateCancel(0), recordedFields: fields });
  eq("the list reaches the context", withCam.recorded_fields.length, 2);
  eq("an unconfirmed account's context has none", buildDraftContext({ ...lateCancel(0), recordedFields: fields, ambiguous: true, confirmed: false }).recorded_fields, []);
  ok("the model is told to answer camera questions only from it", /Answer camera questions only from recorded_fields/.test(DRAFT_INSTRUCTIONS));
}

// ── phase 2: confirmed by conversation ───────────────────────────────────────────────────────
console.log("\nCONFIRMED BY CONVERSATION:");
{
  const acct = { firstName: "Jordan", creditsCents: 1624, matches: lateCancel(0).matches.map((x) => ({ ...x, name: "Westlake 8v8 🎥" })), membership: { status: "ACTIVE", since: "2026-06-12T00:00:00Z", renews: "2026-11-01T00:00:00Z", canceledAt: "2026-10-06T03:30:00Z", price: 6650 } };
  const staff = (body: string, extra: Partial<DraftMsg> = {}) => [msg("outbound", body, 2 * H, extra)];
  for (const b of ["Hey Jordan, let me check", "hey jordan!", "Thanks Jordan", "Jordan, can you resend that?", "All set, Jordan!", "I see $16.24 on your account", "That one was $12.00", "You paid $12.99", "Your Westlake 8v8 spot is set", "You cancelled on Oct 5", "You won't be charged on November 1", "Renews 11/1"]) {
    ok(`CONFIRMS: "${b}"`, staffRepliesConfirmAccount(staff(b), acct));
  }
  for (const b of ["Hey Sam, let me check", "Which account is this?", "Credits apply automatically", "That one was $8.00", "Cancel by the 5th", "Jordanna said hi", "We will check with Jordan's team at the field", "You cancelled on Oct 25", "Oct 15"]) {
    ok(`does not confirm: "${b}"`, !staffRepliesConfirmAccount(staff(b), acct));
  }
  ok("an auto-reply never confirms", !staffRepliesConfirmAccount(staff("Hey Jordan!", { is_auto_reply: true }), acct));
  ok("a template never confirms", !staffRepliesConfirmAccount(staff("Hey Jordan!", { template_name: "x" }), acct));
  ok("the player naming themselves doesn't confirm", !staffRepliesConfirmAccount([msg("inbound", "Hey it's Jordan", 2 * H)], acct));
  ok("a credit balance of $0 doesn't match a $0 mention", !staffRepliesConfirmAccount(staff("That's $0.00"), { ...acct, creditsCents: 0 }));

  let reads = 0;
  const amb = { channel: "whatsapp", player_id: 42, match_ambiguous: true, account_confirmed: false };
  const said = (body: string) => fake({ loadThread: async () => amb, countAccounts: async () => 2, msgs: [msg("outbound", body, 3 * H), msg("inbound", "where's my credit?", 1 * H)], loadContext: async () => { reads++; return { ctx: { ...lateCancel(0), ambiguous: true }, keys: ["first_name"] }; } });
  const yes = said("Hey Jordan, let me look");
  const ry = await runDraft(yes.deps);
  ok("staff addressed the linked name: context loads normally", yes.calls.model[0].messages[0].content.includes('"first_name": "Jordan"') && yes.calls.model[0].messages[0].content.includes('"account_confirmed": true'));
  eq("  and the first staff note says why", ry.status === "ok" && ry.draft.staff_notes[0], CONFIRMED_BY_STAFF_NOTE);
  reads = 0;
  const no = said("Hi, how can we help?");
  const rn = await runDraft(no.deps);
  ok("staff said nothing specific: read for the check, but NOTHING reaches the request", reads === 1 && !/Jordan|Westlake/.test(no.calls.model[0].messages[0].content) && no.calls.model[0].messages[0].content.includes('"account_confirmed": false'));
  ok("  and the notes give the usual reason", rn.status === "ok" && rn.draft.staff_notes[0] === "Number is on 2 accounts.");
  reads = 0;
  const none = fake({ loadThread: async () => amb, countAccounts: async () => 2, msgs: [msg("inbound", "where's my credit?", 1 * H)], loadContext: async () => { reads++; return { ctx: lateCancel(0), keys: [] }; } });
  await runDraft(none.deps);
  eq("no staff message at all: the account isn't even read", reads, 0);
  const outside = fake({ loadThread: async () => amb, countAccounts: async () => 2, msgs: [msg("outbound", "Hey Jordan", 3 * H), msg("inbound", "hi there, a question", 1 * H)], loadContext: async () => ({ forbidden: true }) });
  ok("a player outside a confined account's city stays unconfirmed, not an error", (await runDraft(outside.deps)).status === "ok" && outside.calls.model[0].messages[0].content.includes('"account_confirmed": false'));
}

// ── phase 2: discard reasons and staleness ───────────────────────────────────────────────────
console.log("\nDISCARD REASONS AND STALENESS:");
{
  eq("the four chips", DISCARD_CHIPS, ["Too long", "Wrong answer", "Missing info", "Wrong tone"]);
  eq("a chip alone", discardReasonText("Too long", ""), "Too long");
  eq("a chip with a note", discardReasonText("Wrong tone", " too stiff "), "Wrong tone: too stiff");
  eq("a phone number in the note is scrubbed", discardReasonText("Missing info", "call 512-555-0100"), "Missing info: call [phone]");
  eq("a made-up chip stores nothing", discardReasonText("Bad", "x"), null);
  eq("no chip stores nothing (a tab open from before this shipped)", discardReasonText(undefined, undefined), null);
  const d = { id: "d1", thread_id: "t1", outcome: "pending", draft_text: "x" };
  eq("the patch carries the reason", discardPatch(d, { threadId: "t1", userId: "u", nowIso: "n", reason: "Too long" })?.discard_reason, "Too long");
  const strip = (s: string) => s.replace(/\/\/[^\n]*/g, "");
  ok("POSITIVE CONTROL: the stale check still exists, in runDraft", /staleDraftReason\(prior/.test(strip(readFileSync("src/lib/aiDraftRun.ts", "utf8"))));
  const tick = strip(readFileSync("src/lib/aiDraftAutoRun.ts", "utf8"));
  ok("POSITIVE CONTROL: the tick drafts", /runDraft\(\{/.test(tick));
  ok("the tick never regenerates: only a thread with no draft for this message, regenerate false", /regenerate: false/.test(tick) && !/regenerate: true/.test(tick) && /if \(\(any\.data \?\? \[\]\)\.length\) return "has_draft"/.test(tick));
  const card = strip(readFileSync("src/app/(internal)/match-ops/player-chats/components/AiDraftCard.tsx", "utf8"));
  ok("the card holds its request while the tab is hidden", /visibilityState === "visible"\) \{ void request\(false\)/.test(card));
  ok("the tick's cron is every minute", /"\/api\/crm\/auto-send\/tick",\s*"schedule": "\* \* \* \* \*"/.test(readFileSync("vercel.json", "utf8")));
  ok("the action button says it doesn't send", /\+ use draft/.test(card) && !/Send \+/.test(card));
}

// ── auto-send: the decision ──────────────────────────────────────────────────────────────────
console.log("\nAUTO-SEND DECISION:");
{
  const on: AutoSendConfig = { auto_categories: ["veo", "player_cancel", "guest_pass", "booking"], action_categories: ["player_cancel", "guest_pass"], credit_cap_cents: 1500, hold_minutes: 3, enabled: true, shadow: false };
  const ctx = (over: Partial<DecisionContext> = {}, c: DraftContext = buildDraftContext(lateCancel(0))): DecisionContext => ({ context: c, windowClosed: false, humanRepliedRecently: false, guest: null, ...over });
  const plain = { reply: "Videos go up within 24 to 48 hours.", category: "veo", flags: [] as string[], action: null };
  const credit = (amount: number) => ({ reply: "We've credited it.", category: "player_cancel", flags: [] as string[], action: { kind: "credit" as const, amount_cents: amount, reason: "late cancel" } });
  const d = decideAutoSend;
  eq("POSITIVE: a plain reply in a category that's on → auto_send", d(plain, ctx(), on).decision, "auto_send");
  eq("POSITIVE: a credit of the match price under the cap, no prior courtesy → auto_send_with_action", d(credit(1200), ctx(), on).decision, "auto_send_with_action");
  for (const f of ["escalate", "refund_pushback", "strike_dispute", "under_16", "hold_requested", "urgent"]) {
    const r = d({ ...plain, flags: [f] }, ctx(), on);
    ok(`HUMAN: flag ${f}`, r.decision === "human" && r.reason.includes(f));
  }
  ok("POSITIVE CONTROL: the guest_pass and needs_credit flags don't stop it (action drafts carry them)", d({ ...plain, flags: ["guest_pass", "needs_credit"] }, ctx(), on).decision === "auto_send");
  const everything = { ...on, auto_categories: ["complaint", "membership_billing", "strike", "payment", "account", "other"] };
  for (const c of ["complaint", "membership_billing", "strike", "payment", "account", "other"]) {
    ok(`HUMAN: category ${c}, even if someone put it on the list`, d({ ...plain, category: c }, ctx(), everything).decision === "human");
  }
  const unconfirmed = buildDraftContext({ ...lateCancel(0), ambiguous: true, confirmed: false });
  ok("HUMAN: unconfirmed account and the reply states a fact", /unconfirmed/.test(d({ ...plain, reply: "You have $16.24 in credit." }, ctx({}, unconfirmed), on).reason));
  ok("  also: \"your membership\"", d({ ...plain, reply: "Your membership renews soon." }, ctx({}, unconfirmed), on).decision === "human");
  ok("  also: a date", d({ ...plain, reply: "That was on Oct 21." }, ctx({}, unconfirmed), on).decision === "human");
  eq("POSITIVE CONTROL: unconfirmed, asking for the number, states no fact → auto_send", d({ ...plain, reply: "What's the phone number on your MatchDay account? It's in your profile in the app." }, ctx({}, unconfirmed), on).decision, "auto_send");
  ok("HUMAN: the guard failed", /failed a check/.test(d({ ...plain, guardError: "a dash" }, ctx(), on).reason) && d({ ...plain, guardError: "a dash" }, ctx(), on).decision === "human");
  ok("HUMAN: the WhatsApp window is closed", /window/.test(d(plain, ctx({ windowClosed: true }), on).reason));
  ok("HUMAN: a person replied in the last 2 hours", /2 hours/.test(d(plain, ctx({ humanRepliedRecently: true }), on).reason));
  ok("HUMAN: empty reply", /no reply/.test(d({ ...plain, reply: "  " }, ctx(), on).reason));
  ok("HUMAN: category not on", /isn't turned on/.test(d({ ...plain, category: "logistics" }, ctx(), on).reason));
  ok("HUMAN: a category the model invented", d({ ...plain, category: "brand_new" }, ctx(), on).decision === "human");
  ok("HUMAN: can send in this category but can't act in it", /Actions aren't/.test(d({ ...credit(1200), category: "veo" }, ctx(), on).reason));

  // The cap, exactly.
  const m = (price: number) => buildDraftContext({ ...lateCancel(0), matches: [{ ...lateCancel(0).matches[0], price }] });
  eq("cap: $15.00 exactly at a $15.00 cap → with action", d(credit(1500), ctx({}, m(1500)), on).decision, "auto_send_with_action");
  const over = d(credit(1501), ctx({}, m(1501)), on);
  ok("cap: $15.01 at a $15.00 cap → human, for that reason", over.decision === "human" && /over the \$15\.00 cap/.test(over.reason));
  ok("the amount must be a match price in context", /isn't a match price/.test(d(credit(800), ctx(), on).reason));
  ok("prior courtesy → human", d(credit(1200), ctx({}, buildDraftContext(lateCancel(0, false, true))), on).decision === "human");
  ok("courtesy history unreadable → human", d(credit(1200), ctx({}, buildDraftContext(lateCancel(0, false, null))), on).decision === "human");
  const club = buildDraftContext({ ...lateCancel(0), matches: [{ ...lateCancel(0).matches[0], state: "club_cancelled" }] });
  ok("a club-cancelled match, already credited → human", /already cancelled/.test(d(credit(1200), ctx({}, club), on).reason));
  // Guest code.
  const member = buildDraftContext({ ...lateCancel(0, true), membership: { status: "ACTIVE", since: "2026-01-01T00:00:00Z", renews: null, canceledAt: null, price: 6650 } });
  const code = { reply: "Your code is {code}.", category: "guest_pass", flags: ["guest_pass"], action: { kind: "issue_guest_code" as const, amount_cents: null, reason: "asked" } };
  const good = { active: true, over24Hours: true, hasActiveCode: false };
  eq("POSITIVE: guest code, active over 24 hours, no code → with action", d(code, ctx({ guest: good }, member), on).decision, "auto_send_with_action");
  ok("guest code: not active → human", d(code, ctx({ guest: { ...good, active: false } }, member), on).decision === "human");
  ok("guest code: under 24 hours → human, with no staff-message exception", /under 24 hours/.test(d(code, ctx({ guest: { ...good, over24Hours: false } }, member), on).reason));
  ok("guest code: already has one → human", /already has/.test(d(code, ctx({ guest: { ...good, hasActiveCode: true } }, member), on).reason));
  ok("guest code: facts couldn't be read → human", d(code, ctx({ guest: null }, member), on).decision === "human");

  // Shipped state: shadow, lists empty.
  const shipped: AutoSendConfig = { auto_categories: [], action_categories: [], credit_cap_cents: 1500, hold_minutes: 3, enabled: false, shadow: true };
  eq("shipped: not live", isAutoSendLive(shipped), false);
  eq("shadow with empty lists still shows what would happen", d(plain, ctx(), decisionConfig(shipped)).decision, "auto_send");
  eq("  including an action", d(credit(1200), ctx(), decisionConfig(shipped)).decision, "auto_send_with_action");
  ok("  and still sends a complaint to a person", d({ ...plain, category: "complaint" }, ctx(), decisionConfig(shipped)).decision === "human");
  const liveEmpty = { ...shipped, enabled: true, shadow: false };
  eq("LIVE with empty lists does nothing: the widening is shadow only", d(plain, ctx(), decisionConfig(liveEmpty)).decision, "human");
  eq("not live with a list set respects the list", d(plain, ctx(), decisionConfig({ ...shipped, auto_categories: ["booking"] })).decision, "human");
  eq("enabled with shadow on isn't live", isAutoSendLive({ enabled: true, shadow: true }), false);
  eq("shadow off but not enabled isn't live", isAutoSendLive({ enabled: false, shadow: false }), false);

  // The single allowed shape through the send route.
  const T = Date.parse("2026-10-31T12:00:00Z");
  const row = { thread_id: "t1", draft_text: "Hello", decision: "auto_send", hold_status: "sending", hold_until: new Date(T - 1000).toISOString(), outcome: "pending" };
  const arg = { threadId: "t1", body: "Hello", now: T };
  ok("THE ONE ALLOWED SHAPE: sending, hold over, live, decision stored, same text", autoSendAllowed(row, liveEmpty, arg));
  ok("  with an action decision too", autoSendAllowed({ ...row, decision: "auto_send_with_action" }, liveEmpty, arg));
  for (const [n, r, c, a] of [
    ["no draft", null, liveEmpty, arg],
    ["no config", row, null, arg],
    ["shadow on", row, { ...liveEmpty, shadow: true }, arg],
    ["disabled", row, { ...liveEmpty, enabled: false }, arg],
    ["still holding", { ...row, hold_status: "holding" }, liveEmpty, arg],
    ["cancelled", { ...row, hold_status: "cancelled" }, liveEmpty, arg],
    ["hold not over", { ...row, hold_until: new Date(T + 1000).toISOString() }, liveEmpty, arg],
    ["no hold time", { ...row, hold_until: null }, liveEmpty, arg],
    ["decision human", { ...row, decision: "human" }, liveEmpty, arg],
    ["no decision", { ...row, decision: null }, liveEmpty, arg],
    ["another thread", row, liveEmpty, { ...arg, threadId: "t2" }],
    ["different text", row, liveEmpty, { ...arg, body: "Something else" }],
    ["already sent", { ...row, outcome: "sent_unchanged" }, liveEmpty, arg],
  ] as const) {
    ok(`  refused: ${n}`, !autoSendAllowed(r as Parameters<typeof autoSendAllowed>[0], c as AutoSendConfig | null, a));
  }

  // The hold.
  const hold = (over: Partial<HoldRow> = {}): HoldRow => ({ id: "d1", thread_id: "t1", based_on_message_id: "b1", created_at: new Date(T - 3 * 60e3).toISOString(), hold_until: new Date(T - 1000).toISOString(), draft_text: "We've credited $8.00.", decision: "auto_send_with_action", action: { kind: "credit", amount_cents: 800, reason: "x", is_courtesy: true, player_id: 42, balance_cents: 0 }, ...over });
  const pmsg: DraftMsg = { id: "b1", direction: "inbound", body: "can I get a credit", sent_at: new Date(T - 5 * 60e3).toISOString() };
  const mkH = (over: Partial<HoldIO> = {}, msgs: DraftMsg[] = [pmsg]) => {
    const log = { moves: [] as string[], human: [] as string[], applied: 0, sent: [] as string[] };
    const io: HoldIO = {
      now: () => T, config: async () => liveEmpty, thread: async () => ({ channel: "sms", msgs }),
      moveHold: async (_id, from, to) => { log.moves.push(`${from}>${to}`); return true; },
      routeToHuman: async (_id, r) => { log.human.push(r); },
      applyAction: async () => { log.applied++; return { ok: true, status: "landed", text: "We've credited $8.00.", message: "" }; },
      send: async (_d, t) => { log.sent.push(t); return { ok: true }; },
      ...over,
    };
    return { io, log };
  };
  const h1 = mkH();
  eq("a hold that ends: applies, then sends", [await processHold(hold(), h1.io), h1.log.applied, h1.log.sent], ["sent", 1, ["We've credited $8.00."]]);
  eq("  and walks the states", h1.log.moves, ["holding>sending", "sending>sent"]);
  const h2 = mkH({ applyAction: async () => ({ ok: false, httpStatus: 409, status: "failed", error: "nope" }) });
  eq("the action write fails: NOTHING sends", [await processHold(hold(), h2.io), h2.log.sent.length], ["failed", 0]);
  ok("  and it goes to a person with the error", /nope/.test(h2.log.human[0]));
  const h3 = mkH({ send: async () => ({ ok: false, error: "Meta 400" }) });
  eq("the send fails after the credit landed: not retried", [await processHold(hold(), h3.io), h3.log.sent.length], ["failed", 0]);
  ok("  and the note says the action landed", /action landed/.test(h3.log.human[0]));
  const staffMsg: DraftMsg = { id: "s1", direction: "outbound", body: "On it", sent_at: new Date(T - 60e3).toISOString() };
  const h4 = mkH({}, [pmsg, staffMsg]);
  eq("a staff message cancels it: no money, no send", [await processHold(hold(), h4.io), h4.log.applied, h4.log.sent.length], ["cancelled", 0, 0]);
  const h5 = mkH({ config: async () => shipped });
  eq("the kill switch cancels it: no money, no send", [await processHold(hold(), h5.io), h5.log.applied, h5.log.sent.length], ["cancelled", 0, 0]);
  const h6 = mkH({}, [pmsg, { id: "b2", direction: "inbound", body: "actually never mind", sent_at: new Date(T - 60e3).toISOString() }]);
  eq("the player wrote again: cancelled", [await processHold(hold(), h6.io), h6.log.applied], ["cancelled", 0]);
  const h7 = mkH({ moveHold: async () => false });
  eq("another run took it: nothing happens", [await processHold(hold(), h7.io), h7.log.applied, h7.log.sent.length], ["skipped", 0, 0]);
  const autoMsg: DraftMsg = { ...staffMsg, auto_sent_draft_id: "d0" };
  eq("an earlier auto-send isn't a staff message", holdStopReason(hold(), [pmsg, autoMsg], "sms", liveEmpty, T), null);
  ok("an auto-send doesn't confirm an account", !staffRepliesConfirmAccount([{ ...autoMsg, body: "Hey Jordan!" }], { firstName: "Jordan", creditsCents: 0, membership: null, matches: [] }));
  ok("an auto-send isn't an example of how the team writes", selectExamples([{ ...autoMsg, body: "Awesome!" }]).length === 0);
  ok("the transcript labels it", renderTranscript([{ ...autoMsg, body: "Hi" }]).includes("MatchDay (sent automatically)"));
  ok("eligibility counts it as our answer (no draft on top of it)", !draftEligibility([pmsg, autoMsg], "sms", T).ok);

  // The kill switch.
  const sentAt = (i: number) => ({ thread_id: `t${i}`, sent_at: new Date(T - 40 * 60e3).toISOString() });
  const reply = (i: number, body: string, minsAfter = 5) => ({ thread_id: `t${i}`, body, sent_at: new Date(T - 40 * 60e3 + minsAfter * 60e3).toISOString() });
  for (const w of ["that's wrong", "No", "that's not what I asked", "that’s not right", "I want a refund", "can I talk to a human"]) {
    eq(`kill: "${w}" counts`, badAutoSendReplies([sentAt(1)], [reply(1, w)], T), 1);
  }
  for (const w of ["I know, thanks", "thanks!", "note taken", "humane", "wrongful"]) {
    eq(`kill: "${w}" doesn't`, badAutoSendReplies([sentAt(1)], [reply(1, w)], T), 0);
  }
  eq("kill: \"no worries\" counts too, whole words only go so far", badAutoSendReplies([sentAt(1)], [reply(1, "no worries")], T), 1);
  eq("kill: a reply after 30 minutes doesn't count", badAutoSendReplies([sentAt(1)], [reply(1, "wrong", 31)], T), 0);
  eq("kill: a message before the auto-send doesn't count", badAutoSendReplies([sentAt(1)], [reply(1, "wrong", -1)], T), 0);
  eq("kill: another thread's reply doesn't count", badAutoSendReplies([sentAt(1)], [reply(2, "wrong")], T), 0);
  eq("kill: an auto-send over an hour old doesn't count", badAutoSendReplies([{ thread_id: "t1", sent_at: new Date(T - 61 * 60e3).toISOString() }], [{ thread_id: "t1", body: "wrong", sent_at: new Date(T - 60 * 60e3).toISOString() }], T), 0);
  eq("kill: two complaints on one auto-send count once", badAutoSendReplies([sentAt(1)], [reply(1, "wrong"), reply(1, "no")], T), 1);
  eq("kill: the threshold is MORE than 3", KILL_MAX_BAD, 3);

  // Real-thread regression: a late cancel filed under another category with no courtesy flag.
  const noCourtesy = buildDraftContext(lateCancel(0, false, true));
  const g = guardDraft({ reply: "We've credited $12.00.", reply_without_action: "I'll get that added.", category: "needs_credit", flags: [], staff_notes: [], match_ids: [], offers_courtesy_credit: false, action: { kind: "credit", amount_cents: 1200, reason: "staff agreed" } }, { courtesy_credit_eligible: noCourtesy.courtesy_credit_eligible, context: noCourtesy });
  ok("a late cancel under another category, unflagged, fails the guard (seen on a real thread)", !g.ok && /own cancel/.test(g.error));
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
  const draftRoute = strip(readFileSync("src/app/api/crm/threads/[id]/ai-draft/route.ts", "utf8")) + strip(readFileSync("src/lib/aiDraftDeps.ts", "utf8")) + strip(readFileSync("src/lib/aiDraftAutoRun.ts", "utf8")).replace(/import \{ POST as sendPOST \}[^\n]*\n/, "").replace(/\/\/ The one path to a player[\s\S]*?\n\}\n/, "");
  const runSrc = strip(readFileSync("src/lib/aiDraftRun.ts", "utf8"));
  ok("POSITIVE CONTROL: the link route writes player_id", /from\("crm_threads"\)\.update\(patch\)/.test(strip(readFileSync("src/app/api/crm/threads/[id]/link/route.ts", "utf8"))));
  ok("drafting NEVER links on its own: no crm_threads update and no link call in the draft path", !/from\("crm_threads"\)\.update|\/link\b|linkThread/.test(draftRoute + runSrc));
  const card2 = strip(readFileSync("src/app/(internal)/match-ops/player-chats/components/AiDraftCard.tsx", "utf8"));
  ok("the card links only from the Link button's click (one call site, inside onClick)", (card2.match(/confirmLink\(/g) ?? []).length === 1 && /onClick=\{\(\) => void confirmLink\(/.test(card2) && (card2.match(/linkThreadToPlayer\(/g) ?? []).length === 1);
  const actionRoute = strip(readFileSync("src/app/api/crm/threads/[id]/ai-draft/action/route.ts", "utf8"));
  ok("POSITIVE CONTROL: the action route posts to the credit and promo routes' own handlers", /creditPOST\(/.test(actionRoute) && /promoPOST/.test(actionRoute));
  ok("the action route never sends a message, and writes through no apiWrite of its own", !/sendWhatsApp|telnyx|\/api\/crm\/send|apiWrite\(|recordWrite\(/i.test(actionRoute));
  const sendRoute = strip(readFileSync("src/app/api/crm/send/route.ts", "utf8"));
  ok("THE SEND ROUTE: autoSentDraftId is set in exactly one place, behind autoSendAllowed", (sendRoute.match(/autoSentDraftId = /g) ?? []).length === 1 && /if \(autoSendAllowed\([^\n]*\) autoSentDraftId = draftId;/.test(sendRoute));
  ok("  and the check only runs with no human actor", /if \(!appUserId && parsed\.auto_send === true && draftId\)/.test(sendRoute));
  ok("  and everything else with no human still gets no_human_actor", /if \(!appUserId\) \{\s*if \(!autoSentDraftId\) \{[\s\S]{0,200}no_human_actor/.test(sendRoute));
  ok("  the refusal is the only bare !appUserId check (crm-characterize's pin can't match anything else)", (sendRoute.match(/if \(!appUserId\)/g) ?? []).length === 1);
  const creditRoute = strip(readFileSync("src/app/api/matchday/[env]/players/[playerId]/credits/route.ts", "utf8"));
  const promoRoute = strip(readFileSync("src/app/api/promos/create/route.ts", "utf8"));
  ok("POSITIVE CONTROL: the credit and promo routes gate on a person's session", /authenticateCredits\(req\)/.test(creditRoute) && /authenticateCapability\(req, "managePromos"\)/.test(promoRoute));
  ok("THE CREDIT AND PROMO ROUTES STAY CLOSED TO THE CRON SECRET", !/CRON_SECRET|authenticateCrm/.test(creditRoute + promoRoute));
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
