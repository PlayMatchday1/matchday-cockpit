// CLAUDE DRAFTS — the orchestration, with every outside dependency injected.
//
// The route (src/app/api/crm/threads/[id]/ai-draft/route.ts) supplies Supabase reads/writes, the
// MatchDay profile read and the Anthropic call; scripts/ai-draft-test.ts supplies fakes. So the
// decisions that cost money or reach a third party — skip this thread, reuse a stored draft, stop at
// the cap, refuse a draft that broke a rule — are asserted inside `npm run verify` without a
// network call.
//
// ONE MODEL CALL PER REQUEST, NEVER A RETRY. A draft that fails a guard is stored as `failed` and
// shown as such; staff press Regenerate. Reopening a thread never re-drafts a draft that was
// already made, failed or discarded for the same player message.

import {
  buildDraftContext, buildDraftRequest, capReached, draftCostUsd, draftEligibility, guardDraft,
  monthStartUtcIso, parseDraftOutput, MONTHLY_CAP_USD, SKIP_REASON_TEXT, AI_DRAFT_MODEL,
  type DraftContextIn, type DraftMsg, type DraftRequest, type SkipReason,
} from "@/lib/aiDraftModel";

export type StoredDraft = {
  id: string;
  outcome: string;
  draft_text: string | null;
  staff_notes: string | null;
  category: string | null;
  error: string | null;
  created_at: string;
};

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
  loadThread: () => Promise<{ channel: string; player_id: number | null; match_ambiguous: boolean } | null>;
  loadMessages: () => Promise<DraftMsg[]>;
  latestDraftFor: (basedOnMessageId: string) => Promise<StoredDraft | null>;
  supersedePending: () => Promise<void>;
  /** Sum of cost_usd since the given instant. MUST throw on a read error — the cap fails closed. */
  monthSpendUsd: (sinceIso: string) => Promise<number>;
  loadContext: (thread: { player_id: number | null; match_ambiguous: boolean }) => Promise<{ ctx: DraftContextIn; keys: string[] } | { forbidden: true }>;
  playbook: () => { text: string; version: string };
  callModel: (req: DraftRequest) => Promise<ModelReply>;
  insertDraft: (row: NewDraftRow) => Promise<{ id: string; created_at: string }>;
};

export type DraftView = { id: string; text: string; staff_notes: string; category: string | null; flags: string[]; created_at: string };

export type DraftResult =
  | { status: "skipped"; reason: SkipReason; message: string }
  | { status: "not_configured"; message: string }
  | { status: "cap_reached"; spent_usd: number; message: string }
  | { status: "forbidden"; message: string }
  | { status: "not_found"; message: string }
  | { status: "discarded"; draft_id: string; message: string }
  | { status: "failed"; draft_id: string | null; message: string }
  | { status: "ok"; reused: boolean; draft: DraftView };

const flagsFromNotes = (notes: string | null) => {
  const m = notes?.match(/^\[flags: ([^\]]*)\]/);
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
};
const viewOf = (d: StoredDraft): DraftView => ({
  id: d.id, text: d.draft_text ?? "", staff_notes: (d.staff_notes ?? "").replace(/^\[flags: [^\]]*\]\s*/, ""),
  category: d.category, flags: flagsFromNotes(d.staff_notes), created_at: d.created_at,
});

export async function runDraft(deps: DraftDeps): Promise<DraftResult> {
  const thread = await deps.loadThread();
  if (!thread) return { status: "not_found", message: "Thread not found." };

  const msgs = await deps.loadMessages();
  const elig = draftEligibility(msgs, thread.channel, deps.now());
  if (!elig.ok) return { status: "skipped", reason: elig.reason, message: SKIP_REASON_TEXT[elig.reason] };

  // A draft already exists for this exact player message: show it, don't pay for another. A
  // discarded or failed one stays put until someone presses Regenerate.
  if (!deps.regenerate) {
    const prior = await deps.latestDraftFor(elig.basedOn.id);
    if (prior?.outcome === "pending") return { status: "ok", reused: true, draft: viewOf(prior) };
    if (prior?.outcome === "discarded") return { status: "discarded", draft_id: prior.id, message: "Draft discarded." };
    if (prior?.outcome === "failed") return { status: "failed", draft_id: prior.id, message: prior.error ?? "The last draft failed." };
  }

  if (!deps.hasKey) return { status: "not_configured", message: "Drafts are off: ANTHROPIC_API_KEY isn't set on the server." };

  // THE $20 CAP, checked before any model call. A failed spend read stops drafting too.
  let spent: number;
  try {
    spent = await deps.monthSpendUsd(monthStartUtcIso(deps.now()));
  } catch {
    return { status: "cap_reached", spent_usd: NaN, message: "Drafting is paused: this month's draft spend couldn't be checked." };
  }
  if (capReached(spent)) {
    return { status: "cap_reached", spent_usd: spent, message: `Drafting is paused for the rest of the month: the $${MONTHLY_CAP_USD} draft budget is used up ($${spent.toFixed(2)} spent).` };
  }

  const loaded = await deps.loadContext(thread);
  if ("forbidden" in loaded) return { status: "forbidden", message: "This player is outside your city." };
  const context = buildDraftContext(loaded.ctx);
  const playbook = deps.playbook();
  const req = buildDraftRequest({ playbook: playbook.text, context, msgs, now: deps.now() });

  if (deps.regenerate) await deps.supersedePending();

  const base = {
    thread_id: deps.threadId, based_on_message_id: elig.basedOn.id, requested_by_user_id: deps.requestedBy,
    model: AI_DRAFT_MODEL, playbook_version: playbook.version, context_keys: loaded.keys,
  };
  const fail = async (error: string, reply: ModelReply | null): Promise<DraftResult> => {
    const row = await deps.insertDraft({
      ...base, category: null, draft_text: null, staff_notes: null,
      input_tokens: reply?.usage.input_tokens ?? null, output_tokens: reply?.usage.output_tokens ?? null,
      cost_usd: reply ? draftCostUsd(reply.usage) : 0, error, outcome: "failed",
    });
    return { status: "failed", draft_id: row.id, message: error };
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
  const guarded = guardDraft(parsed, context);
  if (!guarded.ok) return fail(guarded.error, reply);

  const out = guarded.output;
  // Flags ride at the front of staff_notes so the table needs no extra column for them.
  const notes = `${out.flags.length ? `[flags: ${out.flags.join(", ")}] ` : ""}${out.staff_notes}`.trim();
  const row = await deps.insertDraft({
    ...base, category: out.category, draft_text: out.reply, staff_notes: notes || null,
    input_tokens: reply.usage.input_tokens ?? null, output_tokens: reply.usage.output_tokens ?? null,
    cost_usd: draftCostUsd(reply.usage), error: null, outcome: "pending",
  });
  return {
    status: "ok", reused: false,
    draft: { id: row.id, text: out.reply, staff_notes: out.staff_notes, category: out.category, flags: out.flags, created_at: row.created_at },
  };
}
