// The pure rules of the staff app's Needs a human push (appPushHuman.ts), apart so they run in tests.

import { NO_DRAFT_YET, type Attention } from "./crmAttention";

/** The tick drafts a thread 90 s after its last player message (aiDraftAutoRun DRAFT_AFTER_MS); two more
 *  ticks of grace before "No draft yet" is taken as final. */
export const DRAFT_SETTLE_MS = 90e3 + 120e3;

export type WaitMsg = { direction: "inbound" | "outbound"; sent_at: string; sent_by_user_id: string | null; media_kind: string | null };

/** When this wait began: the first player message after the last message a person on staff sent. Bot
 *  replies, auto-sent drafts and a strike holding reply carry no sender, so they do not end a wait.
 *  A reaction is not a message (loadAttention skips it too). Null: nothing from the player since. */
export function waitStartOf(msgs: WaitMsg[]): string | null {
  let lastStaff = -1;
  msgs.forEach((m, i) => { if (m.direction === "outbound" && m.sent_by_user_id) lastStaff = i; });
  const first = msgs.slice(lastStaff + 1).find((m) => m.direction === "inbound" && m.media_kind !== "reaction");
  return first?.sent_at ?? null;
}

/** Needs a human, and settled: any reason but "No draft yet", or "No draft yet" once no draft is coming. */
export function settledHuman(a: Attention & { entered_at: string }, now: number, hasModelKey: boolean): boolean {
  if (a.section !== "human") return false;
  if (a.reason !== NO_DRAFT_YET) return true;
  return !hasModelKey || now - Date.parse(a.entered_at) >= DRAFT_SETTLE_MS;
}

type Staff = { id: string; is_admin?: boolean | null; can_access_chats?: boolean | null; is_service_account?: boolean | null; city_identifier?: string | null };

/** The assignee; with nobody assigned, every chat staff member the inbox shows an unassigned thread to:
 *  admin or Player Chats, not a service account, and not city-confined (crmScope never lists an
 *  unassigned thread to a confined account). */
export function humanRecipients(staff: Staff[], assigneeId: string | null): string[] {
  if (assigneeId) return staff.some((u) => u.id === assigneeId && u.is_service_account !== true) ? [assigneeId] : [];
  return staff.filter((u) => u.is_service_account !== true && (u.is_admin === true || u.can_access_chats === true)
    && !(typeof u.city_identifier === "string" && u.city_identifier.trim())).map((u) => u.id);
}

/** "Bryan O. · ATX · Category other always goes to a person." An unlinked thread is named by the last
 *  four digits of its number; a missing city is left out. */
export function humanPushText(player: { first_name: string | null; last_name: string | null; preferable_city_normalized: string | null } | null, phone: string, reason: string): { title: string; body: string } {
  const first = player?.first_name?.trim() ?? "", last = player?.last_name?.trim() ?? "";
  const name = first || last ? (last ? `${first} ${last[0].toUpperCase()}.`.trim() : first) : `Number ending ${phone.replace(/\D/g, "").slice(-4)}`;
  const city = player?.preferable_city_normalized?.trim() || null;
  // A reason can be a raw model error (measured: a 400 body of several hundred characters); the
  // notification keeps its first 120 characters and the thread note shows it whole.
  const r = reason.replace(/\s+/g, " ").trim();
  const shown = r.length > 120 ? `${r.slice(0, 119).trimEnd()}…` : r;
  return { title: "Needs a human", body: [name, city, shown].filter(Boolean).join(" · ") };
}
