// THE CREDITS REPORT (Ryan, 2026-11-10) — pure: no Supabase, no React.
//
// The app never records a credit when it gives one (backend matches.service.ts: incrementCredits on
// user_credits, nothing else), so cancellation credits are REBUILT from the mirror's bookings, by the
// backend's own rules (heroku-prod 8965437):
//
//   MATCH WE CANCELLED  cancelPaidMatchV2 credits every real (non-fake) booking that is not cancelled and is
//                       FREE or PAID — matchesRepository.getById's players filter — with totalAmount +
//                       creditAmount (the card charge plus the credit spent). Dated by the match's start in
//                       Central. A free match (cancelFreeMatch) credits nothing, and its bookings carry 0.
//   PLAYER CANCELLED    leaveMatch → handleCreditRefund: PAID bookings only, same amount, and only when
//                       isRefundValid — more than 24 hours before kickoff for EVERYONE. Dated by canceled_at
//                       in Central. NOT the booking's cancelled_before_24h flag: for a member that flag is
//                       "more than 6 hours" (time-manager moreThan24HoursLeft(…, isMember)), so a member
//                       leaving 6–24h out carries the flag and got no credit. The backend marks a credited
//                       booking refunded, and on the mirror "more than 24h" and refunded agree on every row.
//   CREDITS USED        credit_amount on PAID bookings, dated by created_at in Central. A WAITING row is a
//                       checkout that never settled: the wallet is only decremented when it settles
//                       (user-matches.repository updatePaymentDataAndCreditAmount).
//
// EXCLUSIONS, EVERYWHERE: @matchday.com (test) and @playmatchday.com (staff) addresses, deleted accounts (the
// "Deleted" "Account" scrub), fake players, and Warsaw (PLN) — a Warsaw match for bookings, a Warsaw player for
// balances and staff credits.

export const CENTRAL = "America/Chicago";
export const centralDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: CENTRAL }).format(new Date(iso));
export const centralMonth = (iso: string) => centralDay(iso).slice(0, 7);
const DAY_MS = 86_400_000;

export type PlayerIn = {
  id: number; email: string | null; first_name: string | null; last_name: string | null;
  preferable_city_name: string | null; is_fake_player: boolean | null;
};

export type Excluded = "test" | "staff" | "deleted" | "fake" | "warsaw";

/** Why a player is left out of the US credit figures, or null when they count. */
export function excludedPlayer(u: PlayerIn | undefined, bookingEmail?: string | null): Excluded | null {
  const email = String(u?.email ?? bookingEmail ?? "").trim().toLowerCase();
  if (email.endsWith("@matchday.com")) return "test";
  if (u && u.first_name === "Deleted" && u.last_name === "Account") return "deleted";
  if (email.endsWith("@playmatchday.com")) return "staff";
  if (u?.is_fake_player) return "fake";
  if (u?.preferable_city_name === "Warsaw") return "warsaw";
  return null;
}

// ── THE DAILY BALANCE SNAPSHOT ─────────────────────────────────────────────────────────────────

export type BalanceRowIn = PlayerIn & { bal: unknown; synced_at: string | null };
export type BalanceTotals = {
  outstanding_cents: number; players_with_balance: number; negative_count: number; negative_cents: number;
  players_read: number; mirror_oldest_synced_at: string | null;
};

/** Every mdapi_users row → the day's totals. A balance that is not a finite number counts as 0. */
export function balanceTotals(rows: readonly BalanceRowIn[]): BalanceTotals {
  const t: BalanceTotals = { outstanding_cents: 0, players_with_balance: 0, negative_count: 0, negative_cents: 0, players_read: rows.length, mirror_oldest_synced_at: null };
  for (const r of rows) {
    if (excludedPlayer(r)) continue;
    const b = Number(r.bal ?? 0);
    if (!Number.isFinite(b) || b === 0) continue;
    if (b > 0) { t.outstanding_cents += b; t.players_with_balance++; } else { t.negative_cents += b; t.negative_count++; }
    if (r.synced_at && (t.mirror_oldest_synced_at == null || r.synced_at < t.mirror_oldest_synced_at)) t.mirror_oldest_synced_at = r.synced_at;
  }
  return t;
}

// ── THE MONTHLY REBUILD ────────────────────────────────────────────────────────────────────────

export type MatchIn = { api_id: number; city_name: string | null; start_date_utc: string | null; is_cancelled: boolean | null; name?: string | null };
export type BookingIn = {
  api_id: number; match_api_id: number; user_id: number | null; user_email: string | null; user_is_fake_player: boolean | null;
  paid_status: string | null; total_amount: number | null; credit_amount: number | null;
  is_cancelled: boolean | null; canceled_at: string | null; created_at: string | null;
};

export type MonthCredits = { month: string; matchCancelCents: number; playerCancelCents: number; usedCents: number };

const num = (x: number | null | undefined) => (Number.isFinite(Number(x)) ? Number(x) : 0);
/** What the backend credits for a booking: the card charge plus the credit spent. */
export const creditFor = (b: Pick<BookingIn, "total_amount" | "credit_amount">) => num(b.total_amount) + num(b.credit_amount);

/** The booking's credit kind under the backend's rules, or null when it earned no credit. */
export function cancellationCredit(b: BookingIn, m: MatchIn | undefined): { kind: "match" | "player"; day: string; cents: number } | null {
  if (!m) return null;
  const cents = creditFor(b);
  if (cents <= 0) return null;
  if (!m.start_date_utc) return null;
  if (!b.is_cancelled) {
    // Still on the match: only the match's own cancel credits it.
    if (!m.is_cancelled || (b.paid_status !== "PAID" && b.paid_status !== "FREE")) return null;
    return { kind: "match", day: centralDay(m.start_date_utc), cents };
  }
  // The player left first. Credited at the time they left, whatever happened to the match afterwards (the
  // match's cancel skips a cancelled booking).
  if (b.paid_status !== "PAID" || !b.canceled_at) return null;
  if (Date.parse(m.start_date_utc) - Date.parse(b.canceled_at) <= DAY_MS) return null;
  return { kind: "player", day: centralDay(b.canceled_at), cents };
}

/** Whether a booking is left out: its player, or a Warsaw match. */
export function excludedBooking(b: BookingIn, m: MatchIn | undefined, players: ReadonlyMap<number, PlayerIn>): boolean {
  if (b.user_is_fake_player) return true;
  if (m?.city_name === "Warsaw") return true;
  return excludedPlayer(b.user_id == null ? undefined : players.get(b.user_id), b.user_email) != null;
}

/** Month by month (Central), oldest first: cancellation credits by kind, and credits used. `from` / `to` are
 *  inclusive Central days, so a partial month can be cut at a date. */
export function monthlyCredits(
  bookings: readonly BookingIn[], matches: ReadonlyMap<number, MatchIn>, players: ReadonlyMap<number, PlayerIn>,
  from: string, to: string,
): MonthCredits[] {
  const by = new Map<string, MonthCredits>();
  const row = (day: string) => {
    const month = day.slice(0, 7);
    let r = by.get(month);
    if (!r) { r = { month, matchCancelCents: 0, playerCancelCents: 0, usedCents: 0 }; by.set(month, r); }
    return r;
  };
  for (const b of bookings) {
    const m = matches.get(b.match_api_id);
    if (excludedBooking(b, m, players)) continue;
    const c = cancellationCredit(b, m);
    if (c && c.day >= from && c.day <= to) row(c.day)[c.kind === "match" ? "matchCancelCents" : "playerCancelCents"] += c.cents;
    const used = num(b.credit_amount);
    if (used > 0 && b.paid_status === "PAID" && b.created_at) {
      const d = centralDay(b.created_at);
      if (d >= from && d <= to) row(d).usedCents += used;
    }
  }
  return [...by.values()].sort((a, b) => a.month.localeCompare(b.month));
}

// ── FLAGS ──────────────────────────────────────────────────────────────────────────────────────

export type CreditAllIn = { match_id: number | null; endpoint: string; changes: { key: string; before: unknown; after: unknown }[] | null; created_at: string };
export type DoubleCredit = { matchId: number; matchName: string | null; matchDay: string | null; players: number; cents: number; creditedAt: string };

/** Matches where staff ran "credit everyone who paid" (landed production rows) and the match is now cancelled,
 *  so the cancel credited the same players again. The amount is what the staff run added to players whose
 *  booking was still active when the match was cancelled — the ones the cancel credited a second time. */
export function doubleCredits(
  rows: readonly CreditAllIn[], matches: ReadonlyMap<number, MatchIn>, bookings: readonly BookingIn[],
): DoubleCredit[] {
  const out = new Map<number, DoubleCredit>();
  for (const r of rows) {
    const m = r.match_id == null ? undefined : matches.get(r.match_id);
    if (!m?.is_cancelled) continue;
    const pid = Number(r.endpoint.match(/\/admin\/players\/(\d+)\/profile$/)?.[1]);
    const bal = (r.changes ?? []).find((c) => c.key === "creditAmount");
    const cents = Number(bal?.after) - Number(bal?.before);
    if (!Number.isFinite(pid) || !Number.isFinite(cents) || cents <= 0) continue;
    const credited = bookings.some((b) => b.match_api_id === m.api_id && b.user_id === pid && cancellationCredit(b, m)?.kind === "match");
    if (!credited) continue;
    const d = out.get(m.api_id) ?? { matchId: m.api_id, matchName: m.name ?? null, matchDay: m.start_date_utc ? centralDay(m.start_date_utc) : null, players: 0, cents: 0, creditedAt: r.created_at };
    d.players++; d.cents += cents;
    if (r.created_at < d.creditedAt) d.creditedAt = r.created_at;
    out.set(m.api_id, d);
  }
  return [...out.values()].sort((a, b) => (b.matchDay ?? "").localeCompare(a.matchDay ?? ""));
}

// ── THE DOWNLOAD ───────────────────────────────────────────────────────────────────────────────

export type MonthlyRow = {
  month: string; partialThrough: string | null;
  cancellationCents: number; staffCents: number; totalIssuedCents: number; usedCents: number; monthEndCents: number | null;
};

const dollars = (c: number) => (c / 100).toFixed(2);
const MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthLabel = (ym: string) => `${MON[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

/** The Monthly table as the screen shows it. UTF-8 with a BOM so Excel reads it. */
export function monthlyCsv(rows: readonly MonthlyRow[]): string {
  const head = ["Month", "Cancellation credits issued", "Staff credits issued", "Total issued", "Credits used", "Month-end balance"];
  const lines = [head.join(",")];
  for (const r of rows) {
    const label = r.partialThrough ? `${monthLabel(r.month)} (through ${r.partialThrough})` : monthLabel(r.month);
    lines.push([label, dollars(r.cancellationCents), dollars(r.staffCents), dollars(r.totalIssuedCents), dollars(r.usedCents), r.monthEndCents == null ? "" : dollars(r.monthEndCents)].join(","));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}
