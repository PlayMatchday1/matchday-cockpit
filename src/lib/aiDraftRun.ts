// CLAUDE DRAFTS — the orchestration, with every outside dependency injected.
//
// The route (src/app/api/crm/threads/[id]/ai-draft/route.ts) supplies Supabase reads/writes, the
// MatchDay profile read and the Anthropic call; scripts/ai-draft-test.ts supplies fakes. So the
// decisions that cost money or reach a third party — skip this thread, reuse a stored draft, stop at
// the cap, refuse a draft that broke a rule — are asserted inside `npm run verify` without a
// network call.
//
// ONE MODEL CALL PER REQUEST, NEVER A RETRY. A draft that fails a guard is stored as `failed` and
// shown as such; staff press Regenerate. Reopening a thread re-uses the draft already made for the
// same player message, unless it has gone STALE (made more than 2 hours ago, or a match it mentions
// has started since): then it is superseded and a fresh one is made. Stale is only ever asked here,
// when a person opens the thread: nothing regenerates on a timer, and the card holds its request while
// the tab is hidden. A failed or discarded draft stays put until someone presses Regenerate.
//
// A DRAFT WHOSE ACTION WAS PRESSED IS NEVER REPLACED. Its reply describes money that moved, and a new
// draft could propose moving it again.

import {
  buildDraftContext, buildDraftRequest, capReached, draftCostUsd, draftEligibility, guardDraft,
  monthStartUtcIso, parseDraftOutput, finalStaffNotes, MONTHLY_CAP_USD, SKIP_REASON_TEXT, AI_DRAFT_MODEL,
  accountConfirmed, unconfirmedReason, extractPhoneNumbers, decideLinkSuggestion, staffRepliesConfirmAccount, isStaffReply, selectExamples,
  type DraftContext, type DraftContextIn, type DraftMsg, type DraftOutput, type DraftRequest, type SkipReason, type LinkSuggestion,
} from "@/lib/aiDraftModel";
import {
  buildClock, matchKey, scheduleWindow, selectSchedule, staleDraftReason, tzForCity, FALLBACK_TZ, type ScheduleRow,
} from "@/lib/aiDraftClock";

export type StoredDraft = {
  id: string;
  outcome: string;
  draft_text: string | null;
  staff_notes: string | null;
  category: string | null;
  error: string | null;
  created_at: string;
  context_keys?: string[] | null;
  reply_without_action?: string | null;
  action?: StoredAction | null;
  action_status?: string | null;
};

// What the button will do, fixed when the draft is made. balance_cents is the balance the draft saw:
// the credit route aborts if it has moved, which also stops a second press.
export type StoredAction = { kind: "credit" | "issue_guest_code"; amount_cents: number | null; reason: string; is_courtesy: boolean; player_id: number; balance_cents: number | null };

export const ACTION_LOCKED = new Set(["applying", "landed", "unknown"]);
export const CONFIRMED_BY_STAFF_NOTE = "Account confirmed from earlier staff replies in this thread";

export type NewDraftRow = {
  thread_id: string;
  based_on_message_id: string;
  requested_by_user_id: string | null;
  model: string;
  playbook_version: string;
  category: string | null;
  draft_text: string | null;
  staff_notes: string | null;
  context_keys: string[];
  reply_without_action: string | null;
  action: StoredAction | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number;
  error: string | null;
  outcome: "pending" | "failed";
};

export type ModelReply = {
  text: string | null;
  stopReason: string | null;
  usage: { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null };
};

export type DraftDeps = {
  threadId: string;
  requestedBy: string | null;
  regenerate: boolean;
  now: () => number;
  hasKey: boolean;
  loadThread: () => Promise<{ channel: string; player_id: number | null; match_ambiguous: boolean; account_confirmed: boolean } | null>;
  loadMessages: () => Promise<DraftMsg[]>;
  latestDraftFor: (basedOnMessageId: string) => Promise<StoredDraft | null>;
  supersedePending: () => Promise<void>;
  /** Sum of cost_usd since the given instant. MUST throw on a read error — the cap fails closed. */
  monthSpendUsd: (sinceIso: string) => Promise<number>;
  /** How many accounts carry this thread's phone. Only asked for an unconfirmed linked thread. */
  countAccounts: () => Promise<number | null>;
  /** Accounts whose phone is exactly this 10-digit number, in either stored shape. */
  findAccountsByPhone: (digits10: string) => Promise<{ id: number; first_name: string | null }[]>;
  /** Called ONLY for a confirmed thread: an unconfirmed one sends no account data at all. */
  loadContext: (thread: { player_id: number | null; match_ambiguous: boolean }) => Promise<{ ctx: DraftContextIn; keys: string[] } | { forbidden: true }>;
  /** Every non-deleted match whose WALL CLOCK start_date is in [fromWall, toWall), all cities. */
  loadScheduleRows: (window: { fromWall: string; toWall: string }) => Promise<ScheduleRow[]>;
  /** The category of this thread's latest categorized draft, if it has one. */
  priorCategory: () => Promise<string | null>;
  /** Recent outbound staff messages, newest first: in that category, or across all when null. */
  loadExampleMessages: (category: string | null) => Promise<DraftMsg[]>;
  /** Actions pressed on this thread lately whose write landed or may have. */
  appliedActions: () => Promise<{ kind: string }[]>;
  playbook: () => { text: string; version: string };
  callModel: (req: DraftRequest) => Promise<ModelReply>;
  insertDraft: (row: NewDraftRow) => Promise<{ id: string; created_at: string }>;
  /** Called with what the decision needs, after a guarded draft is stored. The auto-send tick uses it. */
  afterDraft?: (d: { draftId: string; output: DraftOutput; context: DraftContext; msgs: DraftMsg[] }) => Promise<void>;
};

export type DraftView = {
  id: string; text: string; staff_notes: string[]; category: string | null; flags: string[]; created_at: string;
  text_without_action: string | null; action: StoredAction | null; action_status: string | null;
};

// A suggestion rides on every result after eligibility, so the card can offer "Link" even when the
// draft itself is reused, failed or paused by the cap.
type WithLink = { link_suggestion?: LinkSuggestion | null };
export type DraftResult =
  | { status: "skipped"; reason: SkipReason; message: string }
  | ({ status: "not_configured"; message: string } & WithLink)
  | ({ status: "cap_reached"; spent_usd: number; message: string } & WithLink)
  | { status: "forbidden"; message: string }
  | { status: "not_found"; message: string }
  | ({ status: "discarded"; draft_id: string; message: string } & WithLink)
  | ({ status: "failed"; draft_id: string | null; message: string } & WithLink)
  | ({ status: "ok"; reused: boolean; draft: DraftView } & WithLink);

const flagsFromNotes = (notes: string | null) => {
  const m = notes?.match(/^\[flags: ([^\]]*)\]/);
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
};
// Stored as "[flags: a, b]\n- note\n- note". A row written before notes became bullets is one line.
const viewOf = (d: StoredDraft): DraftView => ({
  id: d.id, text: d.draft_text ?? "",
  staff_notes: (d.staff_notes ?? "").replace(/^\[flags: [^\]]*\]\s*/, "").split(/\n+/).map((l) => l.replace(/^- /, "").trim()).filter(Boolean),
  category: d.category, flags: flagsFromNotes(d.staff_notes), created_at: d.created_at,
  text_without_action: d.reply_without_action ?? null, action: d.action ?? null, action_status: d.action_status ?? null,
});

export async function runDraft(deps: DraftDeps): Promise<DraftResult> {
  const thread = await deps.loadThread();
  if (!thread) return { status: "not_found", message: "Thread not found." };

  const msgs = await deps.loadMessages();
  const elig = draftEligibility(msgs, thread.channel, deps.now());
  if (!elig.ok) return { status: "skipped", reason: elig.reason, message: SKIP_REASON_TEXT[elig.reason] };

  // UNCONFIRMED ACCOUNT. No account data is loaded, and if the player has just typed a phone
  // number, look it up (digits only) and SUGGEST the match. Nothing here links anything.
  const flags = { linked: thread.player_id != null, ambiguous: thread.match_ambiguous, confirmed: thread.account_confirmed };
  const confirmed = accountConfirmed(flags);
  let link_suggestion: LinkSuggestion | null = null;
  if (!confirmed) {
    const typed = elig.pending.flatMap((m) => extractPhoneNumbers(m.body ?? ""));
    if (typed.length > 0) link_suggestion = decideLinkSuggestion(typed[typed.length - 1], await deps.findAccountsByPhone(typed[typed.length - 1]));
  }
  const withLink = <T extends DraftResult>(x: T): T => (link_suggestion ? { ...x, link_suggestion } : x);

  // A draft already exists for this exact player message: show it, don't pay for another. A
  // discarded or failed one stays put until someone presses Regenerate.
  let supersede = deps.regenerate;
  const prior = await deps.latestDraftFor(elig.basedOn.id);
  if (prior?.outcome === "pending" && ACTION_LOCKED.has(prior.action_status ?? "")) {
    return withLink({ status: "ok", reused: true, draft: viewOf(prior) });
  }
  if (!deps.regenerate) {
    if (prior?.outcome === "pending") {
      if (!staleDraftReason(prior, deps.now())) return withLink({ status: "ok", reused: true, draft: viewOf(prior) });
      supersede = true; // stale: replaced below, once the cap allows a new one
    }
    if (prior?.outcome === "discarded") return withLink({ status: "discarded", draft_id: prior.id, message: "Draft discarded." });
    if (prior?.outcome === "failed") return withLink({ status: "failed", draft_id: prior.id, message: prior.error ?? "The last draft failed." });
  }

  if (!deps.hasKey) return withLink({ status: "not_configured", message: "Drafts are off: ANTHROPIC_API_KEY isn't set on the server." });

  // THE $20 CAP, checked before any model call. A failed spend read stops drafting too.
  let spent: number;
  try {
    spent = await deps.monthSpendUsd(monthStartUtcIso(deps.now()));
  } catch {
    return withLink({ status: "cap_reached", spent_usd: NaN, message: "Drafting is paused: this month's draft spend couldn't be checked." });
  }
  if (capReached(spent)) {
    return withLink({ status: "cap_reached", spent_usd: spent, message: `Drafting is paused for the rest of the month: the $${MONTHLY_CAP_USD} draft budget is used up ($${spent.toFixed(2)} spent).` });
  }

  let ctxIn: DraftContextIn;
  let keys: string[];
  let reason: string | null = null;
  // LINKED BUT UNCONFIRMED, AND A PERSON ALREADY KNEW WHO THIS IS. The account's data is read only to
  // make this check, and only when there is a staff message to check. If nothing in those messages
  // matches the account, what was read goes no further than this block.
  let confirmedByStaff: { ctx: DraftContextIn; keys: string[] } | null = null;
  if (!confirmed && flags.linked && msgs.some(isStaffReply)) {
    const loaded = await deps.loadContext(thread);
    if (!("forbidden" in loaded) && staffRepliesConfirmAccount(msgs, loaded.ctx)) confirmedByStaff = loaded;
  }
  if (confirmedByStaff) {
    ctxIn = { ...confirmedByStaff.ctx, confirmed: true };
    keys = confirmedByStaff.keys;
    reason = CONFIRMED_BY_STAFF_NOTE;
  } else if (confirmed) {
    const loaded = await deps.loadContext(thread);
    if ("forbidden" in loaded) return { status: "forbidden", message: "This player is outside your city." };
    ctxIn = { ...loaded.ctx, confirmed: thread.account_confirmed };
    keys = loaded.keys;
  } else {
    const accountCount = flags.linked ? await deps.countAccounts() : 0;
    ctxIn = { ...flags, accountCount, firstName: null, city: null, isMember: null, membership: null, creditsCents: null, matchesPlayed: null, strikes: null, matches: [] };
    keys = ["account"];
    reason = unconfirmedReason(ctxIn);
  }
  const context = buildDraftContext(ctxIn);
  const playbook = deps.playbook();

  // THE CLOCK AND THE SCHEDULE. The player's city sets the zone (Central when unknown). The
  // schedule window starts on the day the player wrote; a field named in what they wrote picks the
  // field, otherwise a day word ("tonight", "Saturday") picks their city.
  const now = deps.now();
  const playerTz = tzForCity(ctxIn.cityCode ?? null);
  const texts = msgs.filter((m) => m.direction === "inbound").slice(-6).map((m) => m.body ?? "");
  const rows = await deps.loadScheduleRows(scheduleWindow(elig.basedOn.sent_at, playerTz ?? FALLBACK_TZ)).catch(() => [] as ScheduleRow[]);
  const schedule = selectSchedule({ rows, texts, cityCode: ctxIn.cityCode ?? null, now });
  const tz = playerTz ?? tzForCity(schedule.fieldCity) ?? FALLBACK_TZ;
  const clock = buildClock({ now, tz, latestPlayerMsgIso: elig.basedOn.sent_at });
  // One model call per request, so the examples can't wait for this draft's own category: they use
  // the thread's last drafted category, or the latest across all categories on a first draft.
  const exampleCategory = await deps.priorCategory().catch(() => null);
  const examples = selectExamples(await deps.loadExampleMessages(exampleCategory).catch(() => [] as DraftMsg[]));
  const req = buildDraftRequest({ playbook: playbook.text, context, msgs, now, tz, clock, schedule, examples });
  if (schedule.basis) keys = [...keys, `schedule:${schedule.basis}`];
  keys = [...keys, `examples:${examples.length}`];

  if (supersede) await deps.supersedePending();

  const base = {
    thread_id: deps.threadId, based_on_message_id: elig.basedOn.id, requested_by_user_id: deps.requestedBy,
    model: AI_DRAFT_MODEL, playbook_version: playbook.version, context_keys: keys,
  };
  const fail = async (error: string, reply: ModelReply | null): Promise<DraftResult> => {
    const row = await deps.insertDraft({
      ...base, category: null, draft_text: null, staff_notes: null, reply_without_action: null, action: null,
      input_tokens: reply?.usage.input_tokens ?? null, output_tokens: reply?.usage.output_tokens ?? null,
      cost_usd: reply ? draftCostUsd(reply.usage) : 0, error, outcome: "failed",
    });
    return withLink({ status: "failed", draft_id: row.id, message: error });
  };

  let reply: ModelReply;
  try {
    reply = await deps.callModel(req);
  } catch (e) {
    return fail(`Claude couldn't be reached: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`, null);
  }
  if (reply.stopReason === "refusal") return fail("Claude declined to draft this one.", reply);
  if (reply.stopReason === "max_tokens") return fail("The draft was cut off. Try Regenerate.", reply);
  const parsed = reply.text ? parseDraftOutput(reply.text) : null;
  if (!parsed) return fail("The draft came back in an unexpected shape. Try Regenerate.", reply);
  // Times may come from the schedule, the conversation, or the playbook (support hours) and nowhere
  // else. Late is decided here, from the clock, not by the model.
  const guarded = guardDraft(parsed, {
    courtesy_credit_eligible: context.courtesy_credit_eligible,
    context,
    appliedActions: await deps.appliedActions().catch(() => [{ kind: "credit" }, { kind: "issue_guest_code" }]),
    veryLate: clock.reply_is_very_late,
    allowedTimeSources: [...schedule.entries.map((e) => e.when_local), ...msgs.map((m) => m.body ?? ""), playbook.text],
  });
  if (!guarded.ok) return fail(guarded.error, reply);

  const out = guarded.output;
  // AT MOST 3 BULLETS. The reason an account is unconfirmed is stated in code, first, not left to
  // the model; a model clause that restates it is cut (finalStaffNotes).
  const staffNotes = finalStaffNotes(out.staff_notes, reason);
  // Flags ride at the front of staff_notes so the table needs no extra column for them.
  const notes = [out.flags.length ? `[flags: ${out.flags.join(", ")}]` : "", ...staffNotes.map((n) => `- ${n}`)].filter(Boolean).join("\n");
  // Which schedule matches the reply mentions, with their start: the draft goes stale at kickoff.
  const action: StoredAction | null = out.action && thread.player_id != null ? {
    kind: out.action.kind, amount_cents: out.action.amount_cents, reason: out.action.reason,
    is_courtesy: out.offers_courtesy_credit, player_id: thread.player_id, balance_cents: ctxIn.creditsCents,
  } : null;
  const mentioned = out.match_ids.filter((id) => schedule.startsById.get(id)).map((id) => matchKey(id, schedule.startsById.get(id)!));
  const row = await deps.insertDraft({
    ...base, context_keys: [...base.context_keys, ...mentioned], category: out.category, draft_text: out.reply, staff_notes: notes || null,
    reply_without_action: action ? out.reply_without_action ?? null : null, action,
    input_tokens: reply.usage.input_tokens ?? null, output_tokens: reply.usage.output_tokens ?? null,
    cost_usd: draftCostUsd(reply.usage), error: null, outcome: "pending",
  });
  await deps.afterDraft?.({ draftId: row.id, output: out, context, msgs });
  return withLink({
    status: "ok", reused: false,
    draft: {
      id: row.id, text: out.reply, staff_notes: staffNotes, category: out.category, flags: out.flags, created_at: row.created_at,
      text_without_action: action ? out.reply_without_action ?? null : null, action, action_status: null,
    },
  });
}
