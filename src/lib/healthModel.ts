// STAFF APP HEALTH TAB: cancel rate and fill rate (Ryan, 2026-11-01). Pure; the server reads live in
// healthLoad.ts. Every match comes through the SAME live range read and shaping the Gameday Ops board
// uses (trimMatch, withVenueMaxPlayers, withSpots), so a period's figures are the sum of the board's
// day headers by construction.
//
// FILL = the board's "Real spots filled": spotTiles over the matches that were not cancelled, real
//        players (fakes excluded by account) over field spots (fieldSpots: the Field Ops max, else the
//        shape max, never below the cap). A match with no cap drops out of fill only, as on the board.
// CANCEL = cancelled ÷ scheduled, scheduled = played + cancelled. SLATE CHANGE cancels (stored, or
//        inferred: cancelled more than 24 h before kickoff) are left out of both (cancelReasons.ts).
// BOTH count only matches whose kickoff has passed (the current period reads "so far").
// MATCHDAY MATCHES = real players ÷ 18 (Ryan, 2026-11-01). The desktop's "MD standard" tile is field
//        spots ÷ 18 and is not changed.

import { fieldSpots, type ApiMatch } from "./gamedayModel";
import { spotTiles, type MatchSpots } from "./gamedaySpots";
import { cancelReasonFor, reasonLine, REASON_TAG, type CancelReason, type StaffReason } from "./cancelReasons";

export const MD_PLAYERS = 18;

export type HealthMatch = ApiMatch & {
  id: number; startDateUtc: string; isCancelled?: boolean; minPlayerCount?: number | null;
  fieldId?: number | null; field?: { title?: string | null; city?: { name?: string | null } } | null;
  autoCanceled?: boolean; autoCanceledMinutes?: number | null;
  spots?: MatchSpots | null; venueMaxPlayers?: number | null;
  /** The field row this match is counted under (the venue) and its name. */
  rowKey?: string; rowName?: string;
};
export type CancelInputs = { updatedAtOf: Map<number, string | null>; stored: Map<number, { reason: StaffReason }>; logged: Set<number> };

export type Rates = {
  scheduled: number; played: number; canceled: number;
  /** Cancels before Slate change was taken out, and how many it took out. */
  canceledAll: number; slateChange: number;
  cancelRate: number | null;
  real: number; capacity: number; fake: number; fillRate: number | null; md: number;
  /** Played matches with a cap (the fill denominator's matches). */
  fillMatches: number;
  /** Played matches under their own minimum (real < minPlayerCount). */
  underMin: number;
  reasons: Partial<Record<CancelReason, number>>;
};
export type FieldRow = Rates & { key: string; name: string; maxSpots: number | null; avgReal: number | null; minPlayerCount: number | null; reasonTag: string | null };
export type CityRow = Rates & { city: string; fields: FieldRow[]; reasonLine: string };
export type PeriodSummary = { from: string; to: string; cities: CityRow[]; total: Rates & { reasonLine: string } };

const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : null);
const realOf = (m: HealthMatch) => m.spots?.real ?? 0;

export function reasonOf(m: HealthMatch, c: CancelInputs): CancelReason {
  return cancelReasonFor({
    stored: c.stored.get(m.id)?.reason ?? null, loggedByClubhouse: c.logged.has(m.id),
    autoCanceled: m.autoCanceled === true, autoCanceledMinutes: m.autoCanceledMinutes ?? null,
    startDateUtc: m.startDateUtc, updatedAt: c.updatedAtOf.get(m.id) ?? null,
    realPlayers: realOf(m), minPlayerCount: m.minPlayerCount ?? null,
  });
}

/** One group's rates: played and cancelled among matches whose kickoff has passed. */
export function ratesOf(ms: HealthMatch[], c: CancelInputs, nowMs: number): Rates {
  const past = ms.filter((m) => Date.parse(m.startDateUtc) <= nowMs);
  const played = past.filter((m) => !m.isCancelled);
  const cancelled = past.filter((m) => m.isCancelled);
  const reasons: Partial<Record<CancelReason, number>> = {};
  for (const m of cancelled) { const r = reasonOf(m, c); reasons[r] = (reasons[r] ?? 0) + 1; }
  const slate = reasons.slate_change ?? 0;
  const canceled = cancelled.length - slate;
  const scheduled = played.length + canceled;
  const t = spotTiles(played, fieldSpots);   // the board's own sum; it skips cancelled and uncapped matches
  const fillMatches = played.filter((m) => { const s = fieldSpots(m); return s != null && s > 0; }).length;
  return {
    scheduled, played: played.length, canceled, canceledAll: cancelled.length, slateChange: slate,
    cancelRate: pct(canceled, scheduled),
    real: t.fill.real, capacity: t.fill.cap, fake: t.fill.fake, fillRate: pct(t.fill.real, t.fill.cap),
    md: Math.round((t.fill.real / MD_PLAYERS) * 10) / 10,
    fillMatches, underMin: played.filter((m) => realOf(m) < (m.minPlayerCount ?? 0)).length,
    reasons,
  };
}

export function summarize(from: string, to: string, ms: HealthMatch[], c: CancelInputs, nowMs: number): PeriodSummary {
  const byCity = new Map<string, HealthMatch[]>();
  for (const m of ms) { const k = m.field?.city?.name ?? "No city"; (byCity.get(k) ?? byCity.set(k, []).get(k)!).push(m); }
  const cities: CityRow[] = [...byCity].map(([city, cms]) => {
    const byField = new Map<string, HealthMatch[]>();
    for (const m of cms) { const k = m.rowKey ?? (m.fieldId != null ? `f${m.fieldId}` : `t${m.field?.title ?? "?"}`); (byField.get(k) ?? byField.set(k, []).get(k)!).push(m); }
    const fields: FieldRow[] = [...byField].map(([key, fms]) => {
      const r = ratesOf(fms, c, nowMs);
      const caps = fms.filter((m) => !m.isCancelled).map((m) => fieldSpots(m)).filter((x): x is number => x != null && x > 0);
      const counted = Object.entries(r.reasons).filter(([k, n]) => k !== "slate_change" && (n ?? 0) > 0);
      return {
        ...r, key, name: fms[0].rowName ?? fms[0].field?.title ?? `Field ${fms[0].fieldId ?? "?"}`,
        maxSpots: caps.length ? Math.max(...caps) : null,
        avgReal: r.fillMatches > 0 ? Math.round((r.real / r.fillMatches) * 10) / 10 : null,
        minPlayerCount: fms.find((m) => m.minPlayerCount != null)?.minPlayerCount ?? null,
        // ONE REASON SHARED BY EVERY CANCEL AT THE FIELD (Slate change is not a cancel here).
        reasonTag: r.canceled > 0 && counted.length === 1 ? REASON_TAG[counted[0][0] as CancelReason] : null,
      };
    });
    const r = ratesOf(cms, c, nowMs);
    return { ...r, city, fields, reasonLine: reasonLine(withoutSlate(r.reasons)) };
  });
  const total = ratesOf(ms, c, nowMs);
  return { from, to, cities, total: { ...total, reasonLine: reasonLine(withoutSlate(total.reasons)) } };
}

const withoutSlate = (r: Partial<Record<CancelReason, number>>) => { const o = { ...r }; delete o.slate_change; return o; };

/* ── PERIODS: weeks run Monday to Sunday; wall-clock dates, as the board's day ─────────────────── */
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const at = (s: string) => new Date(`${s}T00:00:00Z`);
export const addDays = (s: string, n: number) => { const d = at(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
export const mondayOf = (s: string) => { const d = at(s); return addDays(s, -((d.getUTCDay() + 6) % 7)); };
export const monthStart = (s: string) => `${s.slice(0, 7)}-01`;
export const addMonths = (s: string, n: number) => { const d = at(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + n); return ymd(d); };

export type Period = { kind: "week" | "month"; from: string; to: string; current: boolean };
export function periodOf(kind: "week" | "month", start: string, today: string): Period {
  const from = kind === "week" ? mondayOf(start) : monthStart(start);
  const to = kind === "week" ? addDays(from, 6) : addDays(addMonths(from, 1), -1);
  return { kind, from, to, current: today >= from && today <= to };
}
/** Week: the last full week. Month: the current month so far. */
export function defaultStart(kind: "week" | "month", today: string): string {
  return kind === "week" ? addDays(mondayOf(today), -7) : monthStart(today);
}
export function stepPeriod(p: Period, by: number, today: string): Period {
  const start = p.kind === "week" ? addDays(p.from, 7 * by) : addMonths(p.from, by);
  const next = periodOf(p.kind, start, today);
  return next.from > today ? p : next;   // forward stops at the current period
}
