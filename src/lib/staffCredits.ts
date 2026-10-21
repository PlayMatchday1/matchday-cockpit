// CREDITS GIVEN BY STAFF (Ryan, 2026-10-21) — pure (no Supabase, no React).
//
// Built from change_log only: every credit change Clubhouse makes goes through recordWrite with the
// balance before and after and the reason (Player Lookup · credits since 2026-08-14, and Match
// editor · credit everyone who paid). Credits changed in Retool are an absolute set that records
// nothing anywhere we can read (docs/matchday-api-facts.md "Player CREDITS"), so they are not here.
//
//   amount      after − before, in cents, from the logged balance pair (not the "delta" text)
//   counted     production rows whose outcome is "landed"; a failed or unknown write moved nothing
//               we can vouch for, so it is listed but never totalled
//   month       America/Chicago, the same clock as docs/finance/credits-by-month.csv
//
// FLAGS: a credit over $25, a second credit to the same player within 30 days, and a reason that is
// blank or one word.

export type LogRowIn = {
  id: string; created_at: string; actor_email: string | null; actor_name: string | null; source: string; env: string;
  endpoint: string; outcome: string; changes: { key: string; before: unknown; after: unknown }[] | null;
};

export type CreditEntry = {
  id: string; at: string; month: string; staff: string; playerId: number | null; source: string;
  beforeCents: number; afterCents: number; amountCents: number; reason: string; outcome: string; counted: boolean;
  flags: CreditFlag[];
};
export type CreditFlag = "over_25" | "repeat_30d" | "thin_reason";

export const FLAG_LABEL: Record<CreditFlag, string> = {
  over_25: "Over $25",
  repeat_30d: "Same player within 30 days",
  thin_reason: "Blank or one-word reason",
};

export const BIG_CREDIT_CENTS = 2500;
const REPEAT_MS = 30 * 86400e3;

export const chicagoMonth = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit" }).format(new Date(iso));
export const chicagoDay = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(iso));

const PROFILE_RX = /\/admin\/players\/(\d+)\/profile$/;

export function isThinReason(reason: string): boolean {
  return reason.trim().split(/\s+/).filter(Boolean).length <= 1;
}

/** change_log rows → credit entries, newest first, flags set. Rows that are not a credit change are dropped. */
export function creditEntries(rows: readonly LogRowIn[]): CreditEntry[] {
  const out: CreditEntry[] = [];
  for (const r of rows) {
    const m = r.endpoint?.match(PROFILE_RX);
    const bal = (r.changes ?? []).find((c) => c.key === "creditAmount");
    if (!m || !bal) continue;
    const before = Number(bal.before), after = Number(bal.after);
    if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
    const reasonRaw = (r.changes ?? []).find((c) => c.key === "reason")?.after;
    const reason = typeof reasonRaw === "string" && reasonRaw !== "—" ? reasonRaw.trim() : "";
    out.push({
      id: r.id, at: r.created_at, month: chicagoMonth(r.created_at),
      staff: (r.actor_email || r.actor_name || "unknown").toLowerCase(),
      playerId: Number(m[1]), source: r.source,
      beforeCents: before, afterCents: after, amountCents: after - before, reason,
      outcome: r.outcome, counted: r.env === "production" && r.outcome === "landed",
      flags: [],
    });
  }
  // Flags, oldest first so "a second credit" means the later one.
  out.sort((a, b) => a.at.localeCompare(b.at));
  const lastGiven = new Map<number, number>();
  for (const e of out) {
    if (!e.counted) continue;
    if (e.amountCents > BIG_CREDIT_CENTS) e.flags.push("over_25");
    if (e.amountCents > 0 && e.playerId != null) {
      const prev = lastGiven.get(e.playerId);
      const t = Date.parse(e.at);
      if (prev != null && t - prev <= REPEAT_MS) e.flags.push("repeat_30d");
      lastGiven.set(e.playerId, t);
    }
    if (isThinReason(e.reason)) e.flags.push("thin_reason");
  }
  return out.reverse();
}

export type StaffSummaryRow = {
  staff: string; given: number; addedCents: number; removedCents: number; avgGivenCents: number | null; netCents: number;
};

/** One row per staff member over the entries passed in (already filtered to a range). Counted rows only. */
export function staffSummary(entries: readonly CreditEntry[]): StaffSummaryRow[] {
  const by = new Map<string, StaffSummaryRow>();
  for (const e of entries) {
    if (!e.counted || e.amountCents === 0) continue;
    const r = by.get(e.staff) ?? { staff: e.staff, given: 0, addedCents: 0, removedCents: 0, avgGivenCents: null, netCents: 0 };
    if (e.amountCents > 0) { r.given++; r.addedCents += e.amountCents; } else r.removedCents += -e.amountCents;
    r.netCents = r.addedCents - r.removedCents;
    by.set(e.staff, r);
  }
  for (const r of by.values()) r.avgGivenCents = r.given > 0 ? Math.round(r.addedCents / r.given) : null;
  return [...by.values()].sort((a, b) => b.addedCents - a.addedCents || a.staff.localeCompare(b.staff));
}

export type MonthRow = { month: string; given: number; addedCents: number; removedCents: number; netCents: number; byStaff: Record<string, number> };

/** Month by month (Central), newest first, with each staff member's net in that month. */
export function monthlyBreakdown(entries: readonly CreditEntry[]): MonthRow[] {
  const by = new Map<string, MonthRow>();
  for (const e of entries) {
    if (!e.counted || e.amountCents === 0) continue;
    const r = by.get(e.month) ?? { month: e.month, given: 0, addedCents: 0, removedCents: 0, netCents: 0, byStaff: {} };
    if (e.amountCents > 0) { r.given++; r.addedCents += e.amountCents; } else r.removedCents += -e.amountCents;
    r.netCents += e.amountCents;
    r.byStaff[e.staff] = (r.byStaff[e.staff] ?? 0) + e.amountCents;
    by.set(e.month, r);
  }
  return [...by.values()].sort((a, b) => b.month.localeCompare(a.month));
}

export type CreditFilter = {
  since: string; until: string; staff: string; player: string; minCents: number | null; maxCents: number | null; reason: string; flaggedOnly: boolean;
};

/** Range is by Central day, inclusive. Amount range tests the signed amount. Player matches id or name. */
export function filterEntries(entries: readonly CreditEntry[], f: CreditFilter, names: ReadonlyMap<number, string> = new Map()): CreditEntry[] {
  const player = f.player.trim().toLowerCase(), reason = f.reason.trim().toLowerCase();
  return entries.filter((e) => {
    const d = chicagoDay(e.at);
    if (d < f.since || d > f.until) return false;
    if (f.staff && e.staff !== f.staff) return false;
    if (player && !(String(e.playerId ?? "") === player || (names.get(e.playerId ?? -1) ?? "").toLowerCase().includes(player))) return false;
    if (f.minCents != null && e.amountCents < f.minCents) return false;
    if (f.maxCents != null && e.amountCents > f.maxCents) return false;
    if (reason && !e.reason.toLowerCase().includes(reason)) return false;
    if (f.flaggedOnly && e.flags.length === 0) return false;
    return true;
  });
}

const dollars = (c: number) => (c / 100).toFixed(2);
function cell(v: string): string {
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The detail list as the screen shows it. UTF-8 with a BOM so Excel reads names correctly. */
export function staffCreditsCsv(entries: readonly CreditEntry[], names: ReadonlyMap<number, string>): string {
  const head = ["Date and time (Central)", "Staff", "Player ID", "Player", "Amount", "Balance before", "Balance after", "Reason", "Where", "Recorded", "Flags"];
  const fmt = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit" });
  const lines = [head.join(",")];
  for (const e of entries) {
    lines.push([
      cell(fmt(e.at)), cell(e.staff), String(e.playerId ?? ""), cell(names.get(e.playerId ?? -1) ?? ""),
      // Signed amounts are numbers, not text a player typed, so they are written as-is.
      dollars(e.amountCents), dollars(e.beforeCents), dollars(e.afterCents),
      cell(e.reason), cell(e.source), e.counted ? "yes" : `no (${e.outcome})`, cell(e.flags.map((f) => FLAG_LABEL[f]).join("; ")),
    ].join(","));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}
