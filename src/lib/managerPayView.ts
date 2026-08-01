// Pure view model for the Manager Pay page. Takes the /api/manager-pay/week
// payload (whose pay math is NOT touched here) and derives the presentation
// facts the page renders and the tests assert on: card rates, tiles, the
// needs-a-look flags, and the card-rate-sum check. No React, no fetching.

import {
  TOURNAMENT_THRESHOLD,
  addDays,
  weekdayUtc,
  type ManagerPayWeekPayload,
  type CitySection,
  type MatchSummary,
  type ManagerRow,
} from "./managerPayCompute";

export const money = (n: number) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });

// The Monday of the week that contains `iso` (UTC, Mon-first). Shared so the
// page, the rail-badge hook, and the tests all default to the same week.
export function snapToMonday(iso: string): string {
  const wd = weekdayUtc(iso);
  return addDays(iso, wd === 0 ? -6 : -(wd - 1));
}
// Default view: the last COMPLETED week (the prior Monday), which is the one
// that's about to be paid — the same default the old /managers page used.
export function defaultManagerPayWeek(todayIso: string): string {
  return addDays(snapToMonday(todayIso), -7);
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function payDayLabel(payDate: string): string {
  // payDate is a Tuesday (weekStart + 8). Label as "Tue Aug 4".
  const d = new Date(`${payDate}T00:00:00.000Z`);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${WD[d.getUTCDay()]} ${mon} ${d.getUTCDate()}`;
}

// managers named on a match card (0, 1 or 2)
export function managerNamesOf(m: MatchSummary): string[] {
  return [m.primaryManagerName, m.secondManagerName].filter((s): s is string => !!s);
}
export function isUnassigned(m: MatchSummary): boolean {
  return !m.isCancelled && managerNamesOf(m).length === 0;
}

export type CardRate = {
  kind: "cancelled" | "unassigned" | "paid";
  amount: number; // per-manager
  each: boolean; // co-managed → "$20 each"
  tournament: boolean; // capacity-based premium trigger (maxPlayerCount ≥ 25)
  reason: string | null; // why a tournament paid the ordinary rate (co-managed)
  clickable: boolean; // cancelled cards are not clickable — no row underneath
};

// The rate a match card shows. Uses payPerManager from the payload (the real
// pay math); reason explains a tournament that paid the ordinary rate. In the
// real (capacity-based) model the only such case is co-managed — a solo
// maxPlayerCount≥25 match always earns the premium — so "under N" never fires.
export function cardRate(m: MatchSummary): CardRate {
  const tournament = (m.maxPlayerCount ?? 0) >= TOURNAMENT_THRESHOLD;
  if (m.isCancelled) return { kind: "cancelled", amount: 0, each: false, tournament, reason: null, clickable: false };
  const names = managerNamesOf(m);
  if (names.length === 0) return { kind: "unassigned", amount: 0, each: false, tournament, reason: null, clickable: true };
  const each = names.length > 1;
  const reason = tournament && m.payPerManager < 30 ? (each ? "co-managed" : `under ${TOURNAMENT_THRESHOLD}`) : null;
  return { kind: "paid", amount: m.payPerManager, each, tournament, reason, clickable: true };
}

// The card rates, counting an "each" rate once per manager on the card, must sum
// to the city's match-pay total. If the calendar and the payout run can drift,
// they will — this is the guard.
export function cardRateSum(city: CitySection): number {
  return city.matches.reduce((s, m) => {
    const r = cardRate(m);
    return s + r.amount * managerNamesOf(m).length;
  }, 0);
}

// ── needs-a-look flags on a manager row (rank: noEmail > bareReason) ──
export type RowFlag = "noEmail" | "bareReason";
export function managerRowFlags(r: ManagerRow, isAdmin: boolean): RowFlag[] {
  const out: RowFlag[] = [];
  // Email presence is only knowable on the admin payload; on the public payload
  // it's stripped, and a no-email manager structurally has no row anyway.
  if (isAdmin && !r.managerEmail) out.push("noEmail");
  if (r.adjustment !== 0 && !r.adjustmentNotes) out.push("bareReason");
  return out;
}
export function rowNeedsLook(r: ManagerRow, isAdmin: boolean): boolean {
  return managerRowFlags(r, isAdmin).length > 0;
}

// ── scoped tiles (city chip rescopes; the attention filter does NOT) ──
export type Tiles = {
  totalPayout: number;
  matchPay: number;
  adjTotal: number;
  adjCount: number;
  managersPaid: number;
  citiesPaid: number;
  matchesPaid: number; // not cancelled, has a manager
  matchesOnCalendar: number;
  cancelled: number;
  unassigned: number;
  needsLook: number;
  breakdown: { kind: "unassigned" | "noEmail" | "bareReason"; n: number }[];
};

function citiesInScope(payload: ManagerPayWeekPayload, city: string | null): CitySection[] {
  return city ? payload.cities.filter((c) => c.cityIdentifier === city) : payload.cities;
}

export function computeTiles(payload: ManagerPayWeekPayload, city: string | null, isAdmin: boolean): Tiles {
  const scope = citiesInScope(payload, city);
  const rows = scope.flatMap((c) => c.managers);
  const matches = scope.flatMap((c) => c.matches);
  const matchPay = scope.reduce((s, c) => s + c.baseTotal, 0);
  const adjRows = rows.filter((r) => r.adjustment !== 0);
  const adjTotal = adjRows.reduce((s, r) => s + r.adjustment, 0);
  const managersPaid = rows.filter((r) => r.total > 0).length;
  const citySet = new Set(rows.filter((r) => r.total > 0).map((r) => r.cityIdentifier ?? "Unknown"));
  const cancelled = matches.filter((m) => m.isCancelled).length;
  const unassigned = matches.filter(isUnassigned).length;
  const matchesPaid = matches.filter((m) => !m.isCancelled && managerNamesOf(m).length > 0).length;

  // needs-a-look, scoped, each thing counted once under most urgent
  let noEmail = 0;
  let bareReason = 0;
  for (const r of rows) {
    const f = managerRowFlags(r, isAdmin);
    if (f.includes("noEmail")) noEmail++;
    else if (f.includes("bareReason")) bareReason++;
  }
  const breakdown = ([
    { kind: "unassigned" as const, n: unassigned },
    { kind: "noEmail" as const, n: noEmail },
    { kind: "bareReason" as const, n: bareReason },
  ]).filter((b) => b.n > 0);
  const needsLook = unassigned + noEmail + bareReason;

  return {
    totalPayout: matchPay + adjTotal,
    matchPay,
    adjTotal,
    adjCount: adjRows.length,
    managersPaid,
    citiesPaid: citySet.size,
    matchesPaid,
    matchesOnCalendar: matches.length,
    cancelled,
    unassigned,
    needsLook,
    breakdown,
  };
}

// ── layout rules (one source, used by the page AND the tests) ──

// The week strip only shows in the "Week + pay" view and never while the
// attention filter is on (§5: filtering removes every strip). "Pay only" and
// the attention filter both suppress it.
export function canShowWeekStrip(view: "both" | "pay", onlyAttn: boolean): boolean {
  return view === "both" && !onlyAttn;
}
// A city band prints the MANAGER/…/TOTAL column header once, and only when it
// has manager rows. A band that's only an unassigned match prints none (§2).
export function bandRendersColumnHeader(rows: ManagerRow[]): boolean {
  return rows.length > 0;
}
// The manager rows that worked a given match — a co-managed match returns BOTH
// (§4: clicking opens both rows). Cancelled/unassigned matches return none.
// matchId is compared as-is (never coerced), matching the payload's type.
export function managerRowsForMatch(payload: ManagerPayWeekPayload, matchId: number): ManagerRow[] {
  const out: ManagerRow[] = [];
  for (const c of payload.cities) for (const r of c.managers) {
    if (r.matches.some((m) => m.matchId === matchId)) out.push(r);
  }
  return out;
}

export const FLAG_NOUN: Record<"unassigned" | "noEmail" | "bareReason", (n: number) => string> = {
  unassigned: (n) => `match${n === 1 ? "" : "es"} with no manager`,
  noEmail: () => "with no payroll email",
  bareReason: (n) => `adjustment${n === 1 ? "" : "s"} with no reason`,
};
