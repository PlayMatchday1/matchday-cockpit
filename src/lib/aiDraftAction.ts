// A DRAFT'S ACTION, APPLIED — the decisions, with every outside dependency injected so
// scripts/ai-draft-test.ts can assert them without a network call.
//
// A person pressed the button. The action applied is the one stored on the draft when it was guarded;
// the browser sends only the draft id. The write itself goes through the credit or promo route, the
// same code the Player Lookup credit box and Promo Codes use, including recordWrite into change_log.
//
// ONE ATTEMPT. The row is claimed ('applying') before any write, so a second press writes nothing, and
// nothing here retries. If the write fails or may have landed, no reply text comes back, so the
// composer stays empty and the card shows why. Nothing here sends a message.

import { COURTESY_REASON_PREFIX, scrubPii } from "@/lib/aiDraftModel";
import type { StoredAction } from "@/lib/aiDraftRun";
import { fmtUsd } from "@/lib/creditsModel";

export const DRAFT_ACTION_SOURCE = "Player Chats · draft action";
export const AUTO_SEND_SOURCE = "Player Chats · auto-send";
export const AUTO_SEND_ACTOR = "auto-send@clubhouse.system";

export type ActionStatus = "landed" | "failed" | "not_applied" | "unknown";
export type ActionDraft = { id: string; thread_id: string; outcome: string; draft_text: string | null; action: StoredAction | null; action_status: string | null };
export type WriteResult = { status: ActionStatus; error?: string };

export type ActionIO = {
  threadId: string;
  /** "Auto:" when no person pressed anything. It leads the reason in change_log. */
  reasonPrefix?: string;
  loadDraft: () => Promise<ActionDraft | null>;
  threadPlayerId: () => Promise<number | null>;
  /** Null when this person may do it, or why not. Fresh from app_users on every press. */
  rightsRefusal: (kind: StoredAction["kind"]) => Promise<string | null>;
  /** The code to create, or why not. Only asked for a guest code. */
  guestPreflight: (playerId: number) => Promise<{ ok: true; code: string } | { ok: false; error: string }>;
  /** Claims the row only if nobody has. False means someone already pressed it. */
  claim: () => Promise<boolean>;
  writeCredit: (args: { playerId: number; deltaCents: number; expectedBeforeCents: number; reason: string }) => Promise<WriteResult>;
  writeGuestCode: (code: string) => Promise<WriteResult>;
  finish: (status: ActionStatus, draftText: string | null) => Promise<void>;
};

export type ActionResult =
  | { ok: true; status: "landed"; text: string; message: string }
  | { ok: false; httpStatus: number; status: ActionStatus | "refused"; error: string };

export function creditReason(a: Pick<StoredAction, "reason" | "is_courtesy">): string {
  const why = scrubPii(a.reason).trim() || "credit from a draft";
  return `${a.is_courtesy ? COURTESY_REASON_PREFIX : "Claude draft:"} ${why}`;
}

const refused = (httpStatus: number, error: string): ActionResult => ({ ok: false, httpStatus, status: "refused", error });

export async function applyDraftAction(io: ActionIO): Promise<ActionResult> {
  const d = await io.loadDraft();
  if (!d || d.thread_id !== io.threadId) return refused(404, "That draft isn't on this thread.");
  if (d.outcome !== "pending" || !d.action) return refused(409, "This draft has no action left to apply.");
  if (d.action_status) return refused(409, "This action was already pressed. Nothing was sent again.");
  const action = d.action;
  if ((await io.threadPlayerId()) !== action.player_id) return refused(409, "This thread is linked to a different account now. Regenerate the draft.");
  const no = await io.rightsRefusal(action.kind);
  if (no) return refused(403, no);

  let code: string | null = null;
  if (action.kind === "credit") {
    if (action.amount_cents == null || action.amount_cents <= 0 || action.balance_cents == null) return refused(409, "This credit has no amount or starting balance. Regenerate the draft.");
  } else {
    const pre = await io.guestPreflight(action.player_id);
    if (!pre.ok) return refused(409, pre.error);
    code = pre.code;
  }

  if (!(await io.claim())) return refused(409, "This action was already pressed. Nothing was sent again.");

  const w = action.kind === "credit"
    ? await io.writeCredit({ playerId: action.player_id, deltaCents: action.amount_cents!, expectedBeforeCents: action.balance_cents!, reason: `${io.reasonPrefix ? `${io.reasonPrefix} ` : ""}${creditReason(action)}` })
    : await io.writeGuestCode(code!);
  const text = code ? (d.draft_text ?? "").replace("{code}", code) : d.draft_text ?? "";
  await io.finish(w.status, w.status === "landed" && code ? text : null).catch((e: unknown) => {
    console.error("[ai-draft] action status not recorded", e instanceof Error ? e.message : e);
  });
  if (w.status === "landed") {
    const what = action.kind === "credit" ? `Credit of ${fmtUsd(action.amount_cents!)} applied.` : `Guest code ${code} created.`;
    return { ok: true, status: "landed", text, message: `${what} Nothing sent yet, press Send.` };
  }
  const prefix = w.status === "unknown" ? "This may have landed, so check Player Lookup before doing it again." : "This didn't apply.";
  return { ok: false, httpStatus: w.status === "unknown" ? 502 : 409, status: w.status, error: `${prefix} ${w.error ?? ""}`.trim() };
}

// ── guest codes ────────────────────────────────────────────────────────────────────────────────

export const GUEST_CODE_DISCOUNT_PERCENT = 100;
export const GUEST_CODE_USES = 3;
const DAY_MS = 86400e3;

// A staff reply saying the membership checks out. Rule 11 is "confirm the membership, then issue".
const CONFIRMS_MEMBERSHIP_RX = /\bmembership\b[^.!?\n]*\b(?:active|confirmed|verified|all set|good to go|checks out)\b|\b(?:confirmed|verified)\b[^.!?\n]*\bmembership\b/i;
export const staffConfirmedMembership = (bodies: readonly string[]) => bodies.some((b) => CONFIRMS_MEMBERSHIP_RX.test(b));

export const guestCodeFor = (slug: string) => `${slug}FP`;

export type GuestFacts = {
  statusRaw: string | null; canceledAt: string | null; since: string | null;
  /** The live membership's slug, ATX597. */
  slug: string | null;
  /** Mirror rows for {slug}FP across every slug this player has ever held. */
  existingCodes: readonly { code: string; end_date_utc: string | null; deleted_at: string | null }[];
  staffConfirmed: boolean;
  now: number;
};

// Why this player can't get a code now, or null. A member number can change (117 of 843 players in a
// sample hold more than one slug), so any live code under ANY of their slugs counts, not just an exact
// match on today's. A code named some other way can't be seen here.
export function guestCodeRefusal(f: GuestFacts): string | null {
  const status = (f.statusRaw ?? "").toUpperCase();
  if (status !== "ACTIVE" && status !== "ADDED_FROM_ADMIN") return "No active membership on this account.";
  if (f.canceledAt) return "This member has cancelled, so no guest code.";
  if (!f.slug || !/^[A-Za-z]+\d+$/.test(f.slug)) return "This member's number couldn't be read, so no code was built.";
  const live = f.existingCodes.find((c) => !c.deleted_at && (!c.end_date_utc || Date.parse(c.end_date_utc) > f.now));
  if (live) return `This player already has an active code: ${live.code}.`;
  const since = f.since ? Date.parse(f.since) : NaN;
  const young = !Number.isFinite(since) || f.now - since < DAY_MS;
  if (young && !f.staffConfirmed) return "This membership is under 24 hours old. Confirm it in a message on this thread first.";
  return null;
}

// The whole request to /api/promos/create. Built here from the slug; the model supplies none of it.
export function guestCodeBody(code: string, now: number) {
  const end = new Date(now);
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  return {
    code, discountType: "PERCENT", value: GUEST_CODE_DISCOUNT_PERCENT, uses: GUEST_CODE_USES, who: "ALL_USERS", which: "TOTAL_USAGE",
    startDateUtc: new Date(now).toISOString(), endDateUtc: end.toISOString(), source: DRAFT_ACTION_SOURCE,
  };
}

// The same code as the POST /admin/promocodes body, for a caller that isn't the Promo Codes form.
export function guestCodeApiBody(code: string, now: number) {
  const b = guestCodeBody(code, now);
  return {
    code, startDateUtc: b.startDateUtc, endDateUtc: b.endDateUtc, discountType: b.discountType, discountValue: b.value,
    numberOfUsesPerUser: b.uses, targetUserType: b.who, targetMatchType: b.which,
  };
}

// What the credit and promo routes answered, as one of the four states. No outcome at all on a 5xx is
// UNKNOWN; a 4xx with no outcome was refused before any write.
export function writeStatusFrom(httpStatus: number, j: Record<string, unknown>): ActionStatus {
  const o = String(j.outcome ?? "").toLowerCase().replace(/[\s_]/g, "");
  if (j.ambiguous === true || o === "unknown") return "unknown";
  if (o === "landed") return "landed";
  if (o === "notapplied") return "not_applied";
  if (o === "failed") return "failed";
  return httpStatus >= 500 ? "unknown" : "not_applied";
}
