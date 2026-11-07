// PLAYER CHATS 2.0 — the pure rules behind the new inbox (Figma 9TgSk4sYqq4nNoTH73wRRs, page
// "Clubhouse · Player Chats 2.0", frames 20851:45, 20855:44, 20852:319). Everything here is
// computed, not rendered, so scripts/chats-inbox2-test.ts asserts the values inside `npm run verify`.
//
// TIME MODELS. Two live in this file and they must not share helpers (CLAUDE.md):
//   • thread / message timestamps (last_message_at, waiting_since, latest_inbound_at) are TRUE
//     instants — compared as epoch ms.
//   • a match's startDate is LOCAL WALL CLOCK despite its Z. It is read off the string, never
//     through new Date() for display (wallClockWhen below). startDateUtc is a true instant and
//     is used ONLY to order matches, never formatted.

import { WHATSAPP_WINDOW_MS } from "@/lib/crmWindow";

// ── THE QUEUE ───────────────────────────────────────────────────────────────────────────────────
export type Inbox2Tab = "needs" | "waiting" | "done";
/** The section crmAttention gives an open thread: "human" (a person is owed a reply), "auto_sending"
 *  (a hold is running) or null (we answered; the ball is with the player). */
export type Section = "human" | "auto_sending" | null;

export type QueueRow = { id: string; last_message_at: string; waiting_since?: string | null };

/** When the wait started: the first unanswered player message, else the last message. */
export const waitStartIso = (r: QueueRow): string => r.waiting_since ?? r.last_message_at;

/** Needs reply holds ONLY threads waiting on us (Ryan 2026-11-06): the Auto-sending group on top,
 *  then the human rows, longest wait first. Waiting is every open thread with nothing owed, newest
 *  first. Done is the closed list, newest first. No Waiting section inside Needs reply. */
export function bucket<T extends QueueRow>(rows: readonly T[], tab: Inbox2Tab, sectionOf: (r: T) => Section) {
  const byLongestWait = (a: T, b: T) => Date.parse(waitStartIso(a)) - Date.parse(waitStartIso(b));
  const byNewest = (a: T, b: T) => Date.parse(b.last_message_at) - Date.parse(a.last_message_at);
  if (tab === "needs") {
    return {
      auto: rows.filter((r) => sectionOf(r) === "auto_sending").sort(byLongestWait),
      rows: rows.filter((r) => sectionOf(r) === "human").sort(byLongestWait),
    };
  }
  if (tab === "waiting") return { auto: [] as T[], rows: rows.filter((r) => sectionOf(r) === null).sort(byNewest) };
  return { auto: [] as T[], rows: [...rows].sort(byNewest) };
}

/** The wait's colour: over 30 minutes red, over 10 amber (the brief). Exactly 10 or 30 is not "over". */
export type WaitTone = "red" | "amber" | "plain";
export const WAIT_RED_MIN = 30;
export const WAIT_AMBER_MIN = 10;
export function waitTone(fromIso: string, nowMs: number): WaitTone {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return "plain";
  const min = (nowMs - t) / 60_000;
  return min > WAIT_RED_MIN ? "red" : min > WAIT_AMBER_MIN ? "amber" : "plain";
}
export const WAIT_COLOR: Record<WaitTone, string> = { red: "#d64531", amber: "#c27a00", plain: "#5e6b66" };

/** The Waiting tab's true count from the server's own totals (open minus awaiting), never negative. */
export const waitingCount = (c: { open: number; awaiting: number }) => Math.max(0, c.open - c.awaiting);

// ── THE WHATSAPP WINDOW ─────────────────────────────────────────────────────────────────────────
/** The pill beside Send. null on SMS (no window). Whole hours above an hour, minutes below. */
export function windowPill(channel: string | null | undefined, remainingMs: number | null): { text: string; open: boolean } | null {
  if ((channel ?? "sms") !== "whatsapp" || remainingMs == null) return null;
  if (remainingMs <= 0) return { text: "WhatsApp · window closed", open: false };
  const min = Math.floor(remainingMs / 60_000);
  const left = min >= 60 ? `${Math.floor(min / 60)}h` : `${Math.max(1, min)}m`;
  return { text: `WhatsApp · window open ${left}`, open: true };
}

/** Frame 3's plain explanation. No pronoun guessed from a name: "when they reply". */
export function closedWindowText(firstName: string, latestInboundIso: string | null, nowMs: number): string {
  const who = firstName.trim() || "This player";
  const t = latestInboundIso ? Date.parse(latestInboundIso) : NaN;
  if (!Number.isFinite(t)) {
    return `${who} hasn't written to us on WhatsApp, so WhatsApp only allows a template. Free text opens when they write.`;
  }
  const ago = nowMs - t;
  const days = Math.floor(ago / 86_400_000);
  const when = days >= 2 ? `${days} days ago` : days === 1 ? "yesterday" : `${Math.max(1, Math.floor(ago / 3_600_000))} hours ago`;
  return `${who} last wrote ${when}, so WhatsApp only allows a template. Free text opens again when they reply.`;
}
// Re-exported so the window length the copy talks about is the one the rule uses.
export { WHATSAPP_WINDOW_MS };

// ── GIVE CREDIT ─────────────────────────────────────────────────────────────────────────────────
export const CREDIT_PRESETS_CENTS = [500, 900, 1500] as const;
/** Whole dollars without ".00" ("$9"), cents when there are any ("$9.50"). */
export const dollars = (cents: number) => `$${cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2)}`;
/** What validateAdjustment parses: a positive amount typed as dollars. */
export const presetRaw = (cents: number) => (cents / 100).toFixed(2);
export const creditReplyLine = (cents: number) => `${dollars(cents)} credit is on your account.`;
/** Appends the credit line to what is already in the box, on its own line; never replaces it. */
export function appendLine(body: string, line: string): string {
  const b = body.replace(/\s+$/, "");
  return b ? `${b}\n${line}` : line;
}

// ── THE PLAYER STRIP ────────────────────────────────────────────────────────────────────────────
/** "Casual · Level 3" (Ryan 2026-11-06, Q6): membership and level together; level from selfRatingValue. */
export function membershipLevel(isMember: boolean, level: number | null | undefined): string {
  return [isMember ? "Member" : "Casual", level != null && Number.isFinite(level) ? `Level ${level}` : null].filter(Boolean).join(" · ");
}

export type UpcomingCandidate = { matchId: number | null; name: string; startDate: string | null; startDateUtc: string | null; state: string };
/** The next match: the soonest UPCOMING one, ordered by the true instant (startDateUtc). */
export function nextMatch<T extends UpcomingCandidate>(matches: readonly T[]): T | null {
  const up = matches.filter((m) => m.state === "upcoming" && m.matchId != null);
  up.sort((a, b) => (Date.parse(a.startDateUtc ?? "") || Infinity) - (Date.parse(b.startDateUtc ?? "") || Infinity));
  return up[0] ?? null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** WALL CLOCK: "Today 7:00 PM", "Tomorrow 7:00 PM", "Fri 7:00 PM" (within 6 days), else "Nov 12 7:00 PM".
 *  `todayYmd` is today's date in the match's own zone ("2026-11-06"). Read off the string only. */
export function wallClockWhen(startDate: string | null, todayYmd: string): string {
  const x = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(startDate ?? "");
  if (!x) return "";
  const [, y, mo, d, hh, mi] = x;
  const h = +hh, time = `${h % 12 === 0 ? 12 : h % 12}:${mi} ${h >= 12 ? "PM" : "AM"}`;
  const day = Date.UTC(+y, +mo - 1, +d);
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(todayYmd);
  const today = t ? Date.UTC(+t[1], +t[2] - 1, +t[3]) : NaN;
  const diff = Math.round((day - today) / 86_400_000);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Tomorrow ${time}`;
  if (diff > 1 && diff < 7) return `${WEEKDAYS[new Date(day).getUTCDay()]} ${time}`;
  return `${MONTHS[+mo - 1]} ${+d} ${time}`;
}

/** Initials for the strip and the faces column: first letters of the first two words. */
export function initials(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] ?? "?") + (w[1]?.[0] ?? "")).toUpperCase();
}

// ── THE APP ACTIVITY LINE ───────────────────────────────────────────────────────────────────────
/** The one line under the chips: a failure in the last 7 days wins (red), else the latest action.
 *  `items` are newest first, as annotate() returns them. */
export function activityLine<I extends { failed: boolean; ts: string; background: string | null }>(items: readonly I[], nowMs: number, recentMs = 7 * 86_400_000):
  { item: I; failed: boolean } | null {
  const f = items.find((i) => i.failed);
  if (f && nowMs - Date.parse(f.ts) <= recentMs) return { item: f, failed: true };
  const a = items.find((i) => i.background == null);
  return a ? { item: a, failed: false } : null;
}

// ── MESSAGES ────────────────────────────────────────────────────────────────────────────────────
/** Day divider label, uppercase in the frame: "TODAY", "YESTERDAY", "WED, OCT 29". Local calendar. */
export function dayDivider(iso: string, now: Date): string {
  const d = new Date(iso);
  const key = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (key(d) === key(now)) return "TODAY";
  if (key(d) === key(new Date(now.getTime() - 86_400_000))) return "YESTERDAY";
  const wd = d.toLocaleDateString("en-US", { weekday: "short" });
  const md = d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
  return `${wd}, ${md}`.toUpperCase();
}

// ── CHAT STATS (the ⋯ menu popover) ─────────────────────────────────────────────────────────────
// The same five numbers the old page's strip shows, from GET /api/crm/metrics, as grid cells.
export type StatsResponse = {
  metrics: { cohort: { conversations: number; medianFirstResponseMin: number | null; answeredWithin1h: number; answeredWithin1hPct: number | null; resolved: number } };
  trend: { cohortMedianDeltaMin: number | null } | null;
  awaiting: { count: number };
};
export type StatCell = { key: string; label: string; value: string; sub: string | null; tone: "plain" | "good" | "bad" | "amber" };
export function fmtMinutes(min: number | null): string {
  if (min == null) return "—";
  if (min < 1) return "<1m";
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60), r = Math.round(min % 60);
  return r === 0 ? `${h}h` : `${h}h ${r}m`;
}
export function statsCells(d: StatsResponse | null): StatCell[] {
  const c = d?.metrics.cohort ?? null;
  const n = c?.conversations ?? null;
  const delta = d?.trend?.cohortMedianDeltaMin ?? null;
  const waiting = d?.awaiting.count ?? null;
  return [
    { key: "conversations", label: "Conversations", value: n == null ? "—" : String(n), sub: null, tone: "plain" },
    { key: "median", label: "Median first reply", value: fmtMinutes(c?.medianFirstResponseMin ?? null),
      sub: delta != null && delta !== 0 ? `${fmtMinutes(Math.abs(delta))} ${delta < 0 ? "faster" : "slower"}` : null,
      tone: delta == null || delta === 0 ? "plain" : delta < 0 ? "good" : "bad" },
    { key: "within1h", label: "Answered within 1h", value: c ? String(c.answeredWithin1h) : "—",
      sub: c?.answeredWithin1hPct != null ? `${Math.round(c.answeredWithin1hPct)}%` : null, tone: "plain" },
    { key: "resolved", label: "Resolved", value: c ? String(c.resolved) : "—", sub: n != null ? `of ${n}` : null, tone: "plain" },
    { key: "waiting", label: "Waiting on a reply", value: waiting == null ? "—" : String(waiting), sub: waiting === 0 ? "all caught up" : null, tone: waiting ? "amber" : "good" },
  ];
}

// ── PLAYER DETAILS, OPEN OR CLOSED, PER BROWSER (as the old page's crm:contextOpen:v1:<id>) ────
export const detailsPrefKey = (appUserId: string) => `crm:inbox2:details:v1:${appUserId}`;
/** "1" open, "0" closed; anything else (nothing stored) is the default, closed (Figma frame 1). */
export const readDetailsPref = (raw: string | null): boolean => raw === "1";
