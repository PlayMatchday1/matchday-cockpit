// FIELD COSTS v2 — a venue's RATES by day of week and its PAY SCHEDULE (migration 0201).
// Spec: scripts/mocks/field-costs-v2.html (Ryan, 2026-10-02).
//
// TWO QUESTIONS, KEPT APART:
//   What a month COSTS  — matches × the rate for each match's weekday, or the hand-set amount.
//                         Lands in the month the matches happen (Cost, Cities). rateForYmd.
//   When the CASH goes  — the pay schedule. Decides only where OpEx (and Cash Flow) put the money.
//                         cashDays.
// A prepaid venue's cost for November is still November's cost; only its cash lands in October.
//
// Pure: no React, no Supabase. The page, financeCosts and opexSources all read this file.

export type DayRate = { v: number; days: number[] };   // days: 0 = Monday … 6 = Sunday
export type PayDate = { d: number; v?: number | null };
export type DatesSchedule = { mode: "dates"; dates: PayDate[]; prepaid?: boolean };
export type PaySchedule =
  | DatesSchedule
  | { mode: "weekly" | "biweekly"; anchor: string }      // anchor: YYYY-MM-DD
  | { mode: "match" };

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
export const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const DAY_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const DAY_CHIP = ["M", "T", "W", "T", "F", "S", "S"];
const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/* ── PARSING, DEFENSIVELY ─────────────────────────────────────────────────────────────────────
 * Code can deploy before a migration lands, and a hand-edited JSON value can be anything. A value
 * that is not a valid schedule or rate list reads as NOT SET (null), never as a guess. */
export function parseRateDays(raw: unknown): DayRate[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 3) return null;
  const out: DayRate[] = [];
  for (const r of raw) {
    const v = Number((r as { v?: unknown })?.v);
    const days = (r as { days?: unknown })?.days;
    if (!Number.isFinite(v) || !Array.isArray(days)) return null;
    const ds = days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    out.push({ v, days: [...new Set(ds)].sort((a, b) => a - b) });
  }
  return out;
}

export function parsePaySchedule(raw: unknown): PaySchedule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.mode === "match") return { mode: "match" };
  if (r.mode === "weekly" || r.mode === "biweekly") {
    const a = String(r.anchor ?? "");
    return /^\d{4}-\d{2}-\d{2}$/.test(a) ? { mode: r.mode, anchor: a } : null;
  }
  if (r.mode === "dates" && Array.isArray(r.dates)) {
    const dates: PayDate[] = [];
    for (const x of r.dates) {
      const d = Number((x as { d?: unknown })?.d);
      if (!Number.isInteger(d) || d < 1 || d > 31) continue;
      const vRaw = (x as { v?: unknown })?.v;
      const v = vRaw == null || vRaw === "" ? null : Number(vRaw);
      dates.push({ d, v: v != null && Number.isFinite(v) ? v : null });
    }
    if (!dates.length) return null;
    return { mode: "dates", dates: dates.sort((a, b) => a.d - b.d), prepaid: r.prepaid === true };
  }
  return null;
}

/** Monday = 0 for a calendar date. The date is a plain YYYY-MM-DD (no zone), read in UTC. */
export function weekdayOfYmd(ymd: string): number {
  const d = new Date(`${ymd.slice(0, 10)}T00:00:00Z`);
  return (d.getUTCDay() + 6) % 7;
}

/* ── THE RATE FOR A MATCH ─────────────────────────────────────────────────────────────────────
 * With rate_days set, the rate whose days include the match's weekday. Without it, `single` —
 * the venue's one rate (per_match_rate for what is billed, cost_per_match for Cities). A weekday
 * no rate covers is $0; the page keeps every day in exactly one rate, so that is only reachable by
 * a hand-edited value. */
export function rateForYmd(rates: DayRate[] | null, single: number | null, ymd: string): number {
  if (!rates) return single ?? 0;
  const wd = weekdayOfYmd(ymd);
  return rates.find((r) => r.days.includes(wd))?.v ?? 0;
}

/** "Mon–Thu", "Fri, Sat", "Sun" — a run of three or more days is a range. Empty for every day. */
export function dayRange(days: number[]): string {
  const ds = [...days].sort((a, b) => a - b);
  if (ds.length === 7 || ds.length === 0) return "";
  const runs: number[][] = [];
  let run = [ds[0]];
  for (let i = 1; i < ds.length; i++) {
    if (ds[i] === ds[i - 1] + 1) run.push(ds[i]); else { runs.push(run); run = [ds[i]]; }
  }
  runs.push(run);
  return runs.map((r) => (r.length > 2 ? `${DAY_SHORT[r[0]]}–${DAY_SHORT[r[r.length - 1]]}` : r.map((d) => DAY_SHORT[d]).join(", "))).join(", ");
}

const money0 = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const moneyRate = (v: number) => `$${(Math.round(v * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`;

/** The list tag's rate part: "$180" or "$140 Mon–Sat · $160 Sun". */
export function rateLabel(rates: DayRate[] | null, single: number | null): string {
  if (!rates || rates.length <= 1) return moneyRate(rates?.[0]?.v ?? single ?? 0);
  return rates.map((r) => `${moneyRate(r.v)} ${dayRange(r.days)}`).join(" · ");
}

/* ── WHEN THE CASH GOES ───────────────────────────────────────────────────────────────────────
 * The days of the CASH month a venue pays on, and how much on each. `total` is the cost being paid
 * (the hand-set amount, or the auto amount). `matchDays` are the matches' days of THAT month — used
 * by "each match" mode, with `perMatch` the amount for each (rate by weekday).
 *
 * Pick dates: a typed amount is paid on its date; every blank date splits what is left EVENLY
 * (Ryan, 2026-10-02 — the last one included). Anything left over, with no blank to take it, is
 * UNSCHEDULED, and the page says so. Weekly / every 2 weeks: the month split evenly over the days.
 *
 * The days returned are days of the month the schedule is DRAWN in. A prepaid schedule is drawn in
 * the month BEFORE the cost month; the caller decides which month that is (cashMonthOffset). */
export type CashDay = { d: number; amount: number };
export function cashDays(
  sched: PaySchedule,
  drawYear: number, drawMonth0: number,
  total: number,
  matchDays: { d: number; amount: number }[] = [],
): { days: CashDay[]; unscheduled: number } {
  const dim = new Date(Date.UTC(drawYear, drawMonth0 + 1, 0)).getUTCDate();
  const clamp = (d: number) => Math.min(Math.max(1, d), dim);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  if (sched.mode === "match") {
    return { days: matchDays.map((m) => ({ d: m.d, amount: r2(m.amount) })), unscheduled: 0 };
  }
  if (sched.mode === "weekly" || sched.mode === "biweekly") {
    const anchorWd = weekdayOfYmd(sched.anchor);
    const anchorT = Date.UTC(+sched.anchor.slice(0, 4), +sched.anchor.slice(5, 7) - 1, +sched.anchor.slice(8, 10));
    const ds: number[] = [];
    for (let d = 1; d <= dim; d++) {
      const t = Date.UTC(drawYear, drawMonth0, d);
      if ((new Date(t).getUTCDay() + 6) % 7 !== anchorWd) continue;
      if (sched.mode === "biweekly" && Math.round((t - anchorT) / 86400000 / 7) % 2 !== 0) continue;
      ds.push(d);
    }
    if (!ds.length) return { days: [], unscheduled: r2(total) };
    const parts = splitCents(total, ds.length);
    return { days: ds.map((d, i) => ({ d, amount: parts[i] })), unscheduled: 0 };
  }
  const dates = [...(sched as DatesSchedule).dates].sort((a, b) => a.d - b.d);
  const fixed = dates.reduce((a, x) => a + (x.v != null ? x.v : 0), 0);
  const blanks = dates.filter((x) => x.v == null).length;
  const shares = splitCents(blanks ? Math.max(total - fixed, 0) : 0, Math.max(blanks, 1));
  let k = 0;
  const days = dates.map((x) => ({ d: clamp(x.d), amount: r2(x.v != null ? x.v : shares[k++]) }));
  const unscheduled = r2(total - days.reduce((a, x) => a + x.amount, 0));
  return { days, unscheduled };
}

/** `total` in `n` parts that ADD UP to it to the cent: the leftover cents go one each to the first
 *  parts ($200 in 3 → $66.67, $66.67, $66.66). Dividing and rounding each part ($66.67 × 3) is
 *  $200.01, and OpEx's days must sum to the Field Costs figure (scripts/opex-field-sum-test.ts). */
export function splitCents(total: number, n: number): number[] {
  if (n <= 0) return [];
  const cents = Math.round(total * 100);
  const base = Math.trunc(cents / n);
  const rest = cents - base * n;
  return Array.from({ length: n }, (_, i) => (base + (i < Math.abs(rest) ? Math.sign(rest) : 0)) / 100);
}

/** Months the cash sits before the cost month: 1 for a prepaid Pick-dates schedule, else 0. */
export const cashMonthOffset = (sched: PaySchedule | null): number =>
  sched?.mode === "dates" && sched.prepaid ? 1 : 0;

/* ── THE WORDS ─────────────────────────────────────────────────────────────────────────────── */

/** The list's "Pays on" cell, for a cost month: bold line and the grey line under it. */
export function paysOnText(
  sched: PaySchedule | null, costYear: number, costMonth0: number, total: number,
  matchCount: number, matchDays: { d: number; amount: number }[] = [],
): { b: string; s: string } {
  if (!sched || sched.mode === "match") return { b: "Each match date", s: `${matchCount} date${matchCount === 1 ? "" : "s"} in ${MON3[costMonth0]}` };
  const off = cashMonthOffset(sched);
  const dy = costMonth0 - off < 0 ? costYear - 1 : costYear, dm = (costMonth0 - off + 12) % 12;
  const r = cashDays(sched, dy, dm, total, matchDays);
  if (sched.mode === "weekly" || sched.mode === "biweekly") {
    return { b: `Every ${sched.mode === "biweekly" ? "other " : ""}${DAY_LONG[weekdayOfYmd(sched.anchor)]}`, s: `${r.days.length} payments in ${MON3[dm]}` };
  }
  const prepaid = (sched as DatesSchedule).prepaid === true;
  if (r.days.length === 1) {
    return prepaid ? { b: `Paid ${MON3[dm]} ${r.days[0].d}`, s: "prepaid, month before" } : { b: `${MON3[dm]} ${r.days[0].d}`, s: "monthly" };
  }
  return { b: r.days.map((x) => `${money0(x.amount)} ${MON3[dm]} ${x.d}`).join(" · "), s: `${r.days.length} payments${prepaid ? ", prepaid" : ""}` };
}

/** The panel's grey result line under the calendar. warn = the dates do not cover the month. */
export function payResultText(
  sched: PaySchedule, costYear: number, costMonth0: number, total: number,
  matchDays: { d: number; amount: number }[] = [],
): { html: string; warn: boolean } {
  const off = cashMonthOffset(sched);
  const dy = costMonth0 - off < 0 ? costYear - 1 : costYear, dm = (costMonth0 - off + 12) % 12;
  const r = cashDays(sched, dy, dm, total, matchDays);
  let t = sched.mode === "match" ? `${money0(total)} over ${r.days.length} match dates`
    : r.days.length === 1 ? `${money0(r.days[0].amount)} ${MON3[dm]} ${r.days[0].d}${sched.mode === "dates" && sched.prepaid ? ` · prepaid, for ${MONTH_FULL[costMonth0]}` : ""}`
    : sched.mode === "dates" ? r.days.map((x) => `${money0(x.amount)} ${MON3[dm]} ${x.d}`).join(" · ")
    : `${money0(r.days[0]?.amount ?? 0)} × ${r.days.length} · ${r.days.map((x) => `${MON3[dm]} ${x.d}`).join(", ")}`;
  if (r.unscheduled > 0.5) return { html: `${t} · ${money0(r.unscheduled)} unscheduled`, warn: true };
  if (r.unscheduled < -0.5) return { html: `${t} · over the month total`, warn: true };
  return { html: t, warn: false };
}

export const monthName = (m0: number) => MONTH_FULL[m0];
export const monthShort = (m0: number) => MON3[m0];

/**
 * COST PER MATCH ON A GIVEN DAY — Match P&L's per-match cost, made weekday-aware (Ryan, 2026-10-03).
 *
 * cost_per_match (what a pitch costs to run) and per_match_rate / rate_days (what the venue invoices)
 * are DIFFERENT columns and both stay. rate_days holds invoice rates, so it is not copied over
 * cost_per_match; its weekday SURCHARGE is: cost_per_match + (that day's rate − per_match_rate).
 * ATH Katy: $140 + ($160 − $140) = $160 on a Sunday, $140 otherwise. A venue with no rate_days, no
 * cost_per_match or no per_match_rate to measure the surcharge from keeps cost_per_match unchanged.
 * `ymd` is the match's WALL-CLOCK date (YYYY-MM-DD), the same date rate_days is keyed on.
 */
export function costPerMatchOn(
  v: { cost_per_match: number | null; per_match_rate: number | null; rate_days?: DayRate[] | null },
  ymd: string,
): number | null {
  const base = v.cost_per_match ?? null;
  if (base == null || !v.rate_days || v.rate_days.length === 0 || v.per_match_rate == null) return base;
  return Math.round((base + rateForYmd(v.rate_days, v.per_match_rate, ymd) - v.per_match_rate) * 100) / 100;
}
