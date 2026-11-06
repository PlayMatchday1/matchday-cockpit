// WHY A MATCH WAS CANCELLED (Ryan, 2026-11-01). Pure; the server reads live in cancelReasonsLoad.ts.
//
// STORED: the reason staff pick when they cancel in the Clubhouse (match_cancel_reasons, 0246, 0255), one
// of Not enough players, Weather, Manager, Facility, Slate change, Other (Other needs a note). A stored
// reason always wins.
//
// NOT ENOUGH PLAYERS (Ryan, 2026-11-06) is the same "players" reason the automatic cancels below are
// read as, so Health counts a staff cancel for low turnout and a MatchDay auto-cancel together under
// one heading, and both count in the cancel rate (only Slate change is left out). Which is which stays
// knowable: a stored row is staff's (set_by 'staff', 0255), an inferred one is MatchDay's.
//
// INFERRED, at read time, for a cancel with no stored reason, in this order:
//   Slate change  the cancel (match.updatedAt, which equals the cancel time: measured against every
//                 Clubhouse cancel in October, to the minute) is more than 24 hours before kickoff.
//                 Real cancels happen on match day; earlier ones are slots we meant to delete.
//   Players       a MatchDay auto-cancel: not cancelled by the Clubhouse, auto-cancel on, the cancel
//                 within -2..+15 minutes of kickoff minus autoCanceledMinutes, and fewer real players
//                 than the minimum. Measured on October: 130 of the 131 cancels the Clubhouse did not
//                 make, and none of the 34 it did.
//   Unknown       anything else (Retool or MatchDay's admin outside that window).
// Accepted limits (Ryan, 2026-11-01): an edit after a cancel moves updatedAt; a Retool cancel inside
// the window reads as Players.

export const STAFF_REASONS = ["players", "weather", "manager", "facility", "slate_change", "other"] as const;
export type StaffReason = (typeof STAFF_REASONS)[number];
export type CancelReason = StaffReason | "unknown";

/** One name per reason, the same on every chip, line, tag and log entry. */
export const REASON_LABEL: Record<CancelReason, string> = {
  players: "Not enough players", weather: "Weather", manager: "Manager", facility: "Facility",
  slate_change: "Slate change", other: "Other", unknown: "Unknown",
};
/** What each staff reason means, under its chip. */
export const REASON_HINT: Record<StaffReason, string> = {
  players: "Too few players to play; MatchDay's own auto-cancels count here too",
  weather: "Weather", manager: "No manager available", facility: "Field unavailable, lights, access",
  slate_change: "Removed from the slate, not really cancelled", other: "Needs a short note",
};
/** The field tag when every cancel at a field shares one reason: the short name (Ryan, 2026-11-01). */
export const REASON_TAG: Record<CancelReason, string> = REASON_LABEL;

export const NOTE_MAX = 280;
export const SLATE_CHANGE_BEFORE_MS = 24 * 3600e3;
export const AUTO_WINDOW_BEFORE_MS = 2 * 60e3;
export const AUTO_WINDOW_AFTER_MS = 15 * 60e3;

/** The reason a cancel request carries, checked: null when it is fine, else the sentence to show. */
export function reasonProblem(reason: unknown, note: unknown): string | null {
  if (typeof reason !== "string" || !(STAFF_REASONS as readonly string[]).includes(reason)) return "Pick a reason for the cancellation.";
  const n = typeof note === "string" ? note.trim() : "";
  if (reason === "other" && !n) return "Other needs a short note.";
  if (n.length > NOTE_MAX) return `Keep the note under ${NOTE_MAX} characters.`;
  return null;
}

export type CancelFacts = {
  /** The stored reason, if staff picked one. */
  stored: StaffReason | null;
  /** The Clubhouse logged a cancel for this match (change_log). */
  loggedByClubhouse: boolean;
  autoCanceled: boolean; autoCanceledMinutes: number | null;
  startDateUtc: string; updatedAt: string | null;
  /** Real players on the roster (the board's real count). */
  realPlayers: number; minPlayerCount: number | null;
};

export function cancelReasonFor(f: CancelFacts): CancelReason {
  if (f.stored) return f.stored;
  const kick = Date.parse(f.startDateUtc), at = f.updatedAt ? Date.parse(f.updatedAt) : NaN;
  if (Number.isFinite(kick) && Number.isFinite(at) && kick - at > SLATE_CHANGE_BEFORE_MS) return "slate_change";
  if (!f.loggedByClubhouse && f.autoCanceled && Number.isFinite(kick) && Number.isFinite(at)) {
    const autoAt = kick - (f.autoCanceledMinutes ?? 0) * 60e3;
    const inWindow = at >= autoAt - AUTO_WINDOW_BEFORE_MS && at <= autoAt + AUTO_WINDOW_AFTER_MS;
    if (inWindow && f.realPlayers < (f.minPlayerCount ?? 0)) return "players";
  }
  return "unknown";
}

/** "Players 3 · Weather 1 · Facility 1", largest first, then by the fixed order. */
export function reasonLine(counts: Partial<Record<CancelReason, number>>): string {
  const order: CancelReason[] = ["players", "weather", "manager", "facility", "other", "unknown", "slate_change"];
  return order.filter((r) => (counts[r] ?? 0) > 0).sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || order.indexOf(a) - order.indexOf(b))
    .map((r) => `${REASON_LABEL[r]} ${counts[r]}`).join(" · ");
}

/** The surface a cancel's change_log source names. */
export function surfaceOf(source: string): string {
  if (source.startsWith("Staff app")) return "Staff app";
  if (source.startsWith("Master Schedule panel")) return "Match editor";
  return "Match panel";
}
