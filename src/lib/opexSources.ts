// OpEx Calendar — builds the dated calendar groups from their REAL
// sources (Phase 2 of the blend redesign). One place that turns
// FinanceData + fin_opex_entries into the ordered list of category
// groups the calendar renders.
//
// Sources (all confirmed in Phase 0):
//   City Manager Pay  → fin_expenses category 'City Manager' (itemized,
//                       dated on the row's real pay date). Replaces the
//                       old checkIns roster so it agrees with Cash Flow.
//   Match Manager Pay → fin_expenses category 'Match Manager Pay'
//                       (written by the /managers sync), one row per
//                       (city, Thursday). Aggregated per city.
//   Field Costs       → buildFieldCostRows(data, month) — same total as
//                       the Field Costs tab. DATED: per-match venues on
//                       their real match days UNLESS they carry a
//                       billing_day (priced per match but invoiced on a
//                       fixed day → the month's per-match total collapses
//                       onto that day per cadence); flat/quarterly venues
//                       on fin_venues.billing_day per cadence; anything
//                       without captured timing folds into an "undated
//                       remainder" (never smeared onto day 1). Caveat: a
//                       per-match venue set to quarterly/annual dates only
//                       its billing-month total on the billing day; its
//                       off-cycle months land in the undated remainder
//                       (the per-month builder can't roll 3 months into
//                       one lump). WEEKLY splits the month total across
//                       fin_venues.billing_weekday's occurrences (per-match
//                       accrues each week's matches onto that weekday; flat
//                       splits evenly, remainder on the last). CUSTOM reads
//                       fin_venues.billing_custom_days[month] and places the
//                       month total on those day(s), split evenly — a month
//                       with a cost but no day set folds into the undated
//                       remainder. The group subtotal always equals the
//                       Field Costs tab total — dating only moves money
//                       across days, never changes the sum.
//   Every other operating category → mirrored from fin_expenses, one
//                       group per category (Marketing, Equipment,
//                       Corporate Salaries, Contractors, Subscriptions,
//                       …), itemized and dated on each row's expense date.
//                       Same source as Cash Flow, so the two agree by
//                       construction. Read-only here; edited on the
//                       Expenses tab. (fin_opex_entries is retired.)
//
// Every dated amount flows into Daily Total + Cumulative. The undated
// field-cost remainder is carried on the group (in the subtotal) but
// sits on no day, so it is the one honest exception to "all dated".

import { cashDays, cashMonthOffset, monthName, rateForYmd } from "./venuePay";
import type { FinanceData, FinVenue, FinExpense } from "./useFinanceData";
import { buildFieldCostRows } from "./financeCosts";
import { daysInMonth } from "./checkIns";
import { groupVenues, type VenueGroup } from "./venueGroups";

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// "Jul 2026" — the fin_expenses.month / Q2Month key format.
export function monthKeyFor(year: number, month0: number): string {
  return `${SHORT_MONTHS[month0]} ${year}`;
}

// day-of-month from a YYYY-MM-DD string, or null if unparseable / not in
// the target month (defensive — callers already filter by month).
function dayInMonth(dateStr: string | null, year: number, month0: number): number | null {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  if (y !== year || mo !== month0) return null;
  return d;
}

// Why a leaf row is not inline-editable, and where to change it instead.
//   manager-pay → recompute-owned; edit via manager_pay_adjustments on /managers
//   field-cost  → computed from the venue rate × cadence; edit the venue's rate
//                 in Field Costs config, or add a whole-month fin_venue_cost_overrides
export type CalRowLock =
  | { kind: "manager-pay" }
  | { kind: "field-cost"; venueId: number; venueName: string; monthKey: string };

// One line item: a labeled series of dated amounts (day → dollars).
export type CalRow = {
  key: string;
  label: string;
  sublabel?: string;     // city / context under the label
  cells: Record<number, number>;
  tag?: string;          // e.g. 'monthly' | 'quarterly' | 'per-match'
  quarterly?: boolean;   // amber accent
  // Set on a 1:1 generic fin_expenses leaf row → inline-editable (amount/date),
  // subject to the manual_entry lock inside the FinExpense.
  edit?: { expense: FinExpense };
  // Set on a non-editable leaf row → renders locked with a why + link(s).
  lock?: CalRowLock;
  // AS-OF CALENDAR ONLY (buildOpexCalendarAsOf). Money this row owes the month that sits on no
  // day: `paidUndated` is a bank payment whose day the bank does not record and whose venue has no
  // billing day; `undated` is a projection with no billing day set. Both are in the row's total.
  paidUndated?: number;
  undated?: number;
  info?: RowInfo;
  /** A PREPAID venue's cash drawn in this month for NEXT month's matches: "for November". */
  forMonth?: string;
};

// What the row's i says. Plain words; no table names.
export type RowInfo = {
  title: string;
  billed: string;
  rate: string;
  source: string;
  ytd: string | null;
  notes: string[];
};

export type CalGroup = {
  key: string;
  name: string;
  src: string;
  how?: string;              // the category i, in plain words (as-of calendar only)
  tag?: string;              // header pill (e.g. 'weekly', 'monthly · quarterly')
  defaultOpen: boolean;
  rows: CalRow[];
  agg: Record<number, number>;  // per-day sum across rows (collapsed chips)
  subtotal: number;             // includes undated
  undated: number;              // field-cost amount with no captured date
};

function aggregateAndSubtotal(rows: CalRow[]): { agg: Record<number, number>; dated: number } {
  const agg: Record<number, number> = {};
  let dated = 0;
  for (const r of rows) {
    for (const [d, v] of Object.entries(r.cells)) {
      const day = Number(d);
      agg[day] = (agg[day] ?? 0) + v;
      dated += v;
    }
  }
  return { agg, dated };
}

// ---------------- City Manager Pay ----------------

function cityManagerGroup(
  data: FinanceData,
  monthKey: string,
  year: number,
  month0: number,
): CalGroup {
  const rows: CalRow[] = data.expenses
    .filter((r) => r.category === "City Manager" && r.month === monthKey)
    .map((r, i) => {
      const day = dayInMonth(r.date, year, month0);
      // VENDOR FIRST — the person's name. This read notes first, which was wrong the moment the
      // Apr–Jun batch put a sentence there: those rows labelled themselves "April CM payment"
      // instead of "Yara". notes survives only as the fallback for a row that has no vendor yet,
      // and this now matches the generic expense path below, which has always been vendor-first.
      const name = (r.vendor?.trim() || r.notes?.trim() || r.city?.trim() || "Manager");
      return {
        key: `cm:${r.id ?? i}`,
        label: name,
        sublabel: r.city ?? undefined,
        cells: day ? { [day]: r.amount } : {},
        edit: { expense: r },
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  const { agg, dated } = aggregateAndSubtotal(rows);
  return {
    key: "city",
    name: "City Manager Pay",
    src: "from Expenses · fin_expenses",
    defaultOpen: true,
    rows,
    agg,
    subtotal: dated,
    undated: 0,
  };
}

// ---------------- Match Manager Pay ----------------

function matchManagerGroup(
  data: FinanceData,
  monthKey: string,
  year: number,
  month0: number,
): CalGroup {
  // One fin_expenses row per (city, Thursday). Aggregate per city into a
  // row whose cells carry each Thursday's amount.
  const byCity = new Map<string, CalRow>();
  for (const r of data.expenses) {
    if (r.category !== "Match Manager Pay" || r.month !== monthKey) continue;
    const day = dayInMonth(r.date, year, month0);
    if (day == null) continue;
    const city = r.city?.trim() || "Unknown";
    let row = byCity.get(city);
    if (!row) {
      row = { key: `mm:${city}`, label: city, cells: {}, lock: { kind: "manager-pay" } };
      byCity.set(city, row);
    }
    row.cells[day] = (row.cells[day] ?? 0) + r.amount;
  }
  const rows = [...byCity.values()].sort((a, b) => a.label.localeCompare(b.label));
  const { agg, dated } = aggregateAndSubtotal(rows);
  return {
    key: "match",
    name: "Match Manager Pay",
    src: "from Manager Pay page · per city",
    tag: "weekly",
    defaultOpen: false,
    rows,
    agg,
    subtotal: dated,
    undated: 0,
  };
}

// ---------------- Field Costs (dated) ----------------

// Which day this month a flat/quarterly venue's bill lands on, honoring
// cadence + anchor month. null = no captured timing (or an off-cadence
// month) → the amount folds into the undated remainder.
function billingDayForMonth(
  venue: FinVenue | undefined,
  year: number,
  month0: number,
): number | null {
  if (!venue || venue.billing_day == null) return null;
  const monthLast = daysInMonth(year, month0);
  const day = Math.min(venue.billing_day, monthLast);
  const cadence = venue.billing_cadence;
  if (cadence === "monthly") return day;
  const anchor = venue.billing_anchor_month; // 1..12
  if (anchor == null) return null;
  const target = month0 + 1; // 1..12
  if (cadence === "annual") return target === anchor ? day : null;
  // quarterly
  return (((target - anchor) % 3) + 3) % 3 === 0 ? day : null;
}

// ── THE ONE PLACE A BILLING DATE IS DERIVED ───────────────────────────────────────────────────
//
// Which day(s) of THIS month a venue's lump lands on. An empty array means UNDATED — counted in
// the month's subtotal, landing on no day, which OpEx files under "Undated — timing not set".
//
// WHY IT IS EXPORTED. The Field Costs "Bills on" column used to re-derive this from billing_day
// alone, which is wrong for CUSTOM cadence: custom reads billing_custom_days and ignores
// billing_day entirely, so five venues displayed a date the money does not land on (NEMP showed
// Aug 20 while its August cost was undated). Two code paths answering one question is what
// produced that bug and the cost_per_match one before it. There is now one, and both callers use
// it — grep billing_day / billing_custom_days to confirm nothing else derives a date.
//
// BEHAVIOUR IS UNCHANGED: custom → customDaysFor; everything else → billingDayForMonth, which
// already folds in cadence, anchor month and the Math.min day clamp.
export function resolveBillingDates(
  venue: FinVenue | undefined | null,
  year: number,
  month0: number,
): { days: number[]; cadence: FinVenue["billing_cadence"] } {
  const cadence = venue?.billing_cadence ?? "monthly";
  if (!venue) return { days: [], cadence };
  if (cadence === "custom") return { days: customDaysFor(venue, year, month0), cadence };
  const day = billingDayForMonth(venue, year, month0);
  return { days: day == null ? [] : [day], cadence };
}

// True when a venue's cost is driven by a partner-dashboard payout rather
// than matchCount × rate (Crossbar's per_match_minus_manager). It's stored
// as billing_type='per_match' but its amount can't be spread over match
// days, so it must be dated as a monthly lump.
function isDashboardDriven(data: FinanceData, venueId: number): boolean {
  const dash = data.partnerDashboards.find((d) => d.venueId === venueId);
  return dash?.revenueModel === "per_match_minus_manager";
}

// Split `amount` across `days` as evenly as possible, to the cent, with any
// remainder cents landing on the LAST day. The cells always sum to exactly
// `amount` (rounded to cents) — the invariant every cadence must keep.
function splitEven(amount: number, days: number[]): Record<number, number> {
  const cells: Record<number, number> = {};
  const uniq = [...new Set(days)].sort((a, b) => a - b);
  const n = uniq.length;
  if (n === 0) return cells;
  const cents = Math.round(amount * 100);
  const base = Math.trunc(cents / n);
  uniq.forEach((d, i) => {
    const c = i === n - 1 ? cents - base * (n - 1) : base;
    cells[d] = (cells[d] ?? 0) + c / 100;
  });
  return cells;
}

// Every day-of-month in the month whose weekday matches `weekday` (0=Sun).
function weeklyDaysFor(year: number, month0: number, weekday: number): number[] {
  const days: number[] = [];
  const last = daysInMonth(year, month0);
  for (let d = 1; d <= last; d++) {
    if (new Date(year, month0, d).getDay() === weekday) days.push(d);
  }
  return days;
}

// The captured custom billing days for this venue in this month (CUSTOM
// cadence). Keyed by ISO year-month in billing_custom_days. [] = none set.
function customDaysFor(
  venue: FinVenue | undefined,
  year: number,
  month0: number,
): number[] {
  const map = venue?.billing_custom_days;
  if (!map) return [];
  const key = `${year}-${String(month0 + 1).padStart(2, "0")}`;
  const arr = map[key];
  if (!Array.isArray(arr)) return [];
  const last = daysInMonth(year, month0);
  return [
    ...new Set(
      arr
        .map((n) => Math.round(Number(n)))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= last),
    ),
  ].sort((a, b) => a - b);
}

// Per-match cost hits (day-of-month → rate) for a field-cost row: one entry
// per alive match, plus charged cancellations when the leg's venue bills on
// cancel. Shared by the per-match auto-spread and the weekly accrual.
function perMatchHits(
  data: FinanceData,
  fc: ReturnType<typeof buildFieldCostRows>[number],
  venueById: Map<number, FinVenue>,
  monthKey: string,
  year: number,
  month0: number,
): Array<{ day: number; rate: number }> {
  const hits: Array<{ day: number; rate: number }> = [];
  for (const leg of fc.legs) {
    const legVenue = venueById.get(leg.venueId);
    // THE RATE FOR EACH MATCH'S WEEKDAY when the venue has day-of-week rates (0201).
    const rateOf = (ymd: string) => (legVenue?.rate_days ? rateForYmd(legVenue.rate_days, leg.rate, ymd) : leg.rate);
    for (const s of data.masterSchedule) {
      if (s.venue_id !== leg.venueId || s.month !== monthKey) continue;
      const day = dayInMonth(s.match_date, year, month0);
      if (day != null) hits.push({ day, rate: rateOf(s.match_date) });
    }
    if (legVenue?.charge_on_cancel) {
      for (const s of data.cancelledSchedule) {
        if (s.venue_id !== leg.venueId || s.month !== monthKey) continue;
        const day = dayInMonth(s.match_date, year, month0);
        if (day != null) hits.push({ day, rate: rateOf(s.match_date) });
      }
    }
  }
  return hits;
}

// Weekly accrual for per-match venues: each match's cost lands on the next
// weekly billing day on/after its match day (matches after the last weekly
// day fold onto it, keeping the total in-month). Same rhythm as Match
// Manager Pay Thursdays. Returns the dated sum for reconciliation.
function accrueWeekly(
  hits: Array<{ day: number; rate: number }>,
  weeklyDays: number[],
): { cells: Record<number, number>; sum: number } {
  const cells: Record<number, number> = {};
  if (weeklyDays.length === 0) return { cells, sum: 0 };
  const B = [...weeklyDays].sort((a, b) => a - b);
  const lastB = B[B.length - 1];
  let sum = 0;
  for (const h of hits) {
    let target = lastB;
    for (const b of B) {
      if (b >= h.day) {
        target = b;
        break;
      }
    }
    cells[target] = (cells[target] ?? 0) + h.rate;
    sum += h.rate;
  }
  return { cells, sum };
}

function fieldCostGroup(
  data: FinanceData,
  monthKey: string,
  year: number,
  month0: number,
  // true → a venue whose amount has no day becomes its own row carrying `undated`, instead of
  // folding anonymously into the group remainder. The as-of calendar needs to say WHO is undated.
  attachUndated = false,
): CalGroup {
  const venueById = new Map<number, FinVenue>();
  for (const v of data.venues) venueById.set(v.id, v);

  const rows: CalRow[] = [];
  let undated = 0;
  let subtotal = 0;

  const push = (
    fc: { key: string; displayName: string; city: string; primaryVenueId: number },
    cells: Record<number, number>,
    tag: string,
    quarterly?: boolean,
  ) => {
    rows.push({
      key: fc.key,
      label: fc.displayName,
      sublabel: fc.city,
      cells,
      tag,
      quarterly,
      lock: {
        kind: "field-cost",
        venueId: fc.primaryVenueId,
        venueName: fc.displayName,
        monthKey,
      },
    });
  };

  const pushUndated = (
    fc: { key: string; displayName: string; city: string; primaryVenueId: number; amount: number },
    tag: string,
  ) => {
    undated += fc.amount;
    if (!attachUndated) return;
    push(fc, {}, tag);
    rows[rows.length - 1].undated = fc.amount;
  };

  /* ── THE PAY SCHEDULE DECIDES WHERE THE CASH LANDS (migration 0201) ─────────────────────────
   * A venue with pay_schedule is dated by it and nothing else; the legacy cadence code below only
   * runs for a venue that has none. The AMOUNT is the month's cost (hand-set or auto) — the schedule
   * never changes it, only where it sits.
   *
   * PREPAID: the cash for a month's matches leaves the month BEFORE. So this month skips its own
   * prepaid venues (that cash went last month) and draws NEXT month's on this month's dates, marked
   * "for <next month>". Cost (and Cities) still put that cost in the month the matches happen. */
  const scheduledCells = (
    fc: ReturnType<typeof buildFieldCostRows>[number],
    sched: NonNullable<FinVenue["pay_schedule"]>,
    costKey: string, costYear: number, costMonth0: number,
  ): { cells: Record<number, number>; left: number } => {
    if (sched.mode === "match") {
      const scheduleDriven = fc.billingType === "per_match" && fc.override == null && !isDashboardDriven(data, fc.primaryVenueId);
      const hits = perMatchHits(data, fc, venueById, costKey, costYear, costMonth0);
      const cells: Record<number, number> = {};
      if (!hits.length) return { cells, left: fc.amount };
      // Priced per match when the amount IS the matches; a hand-set or partner amount is spread
      // evenly over the match dates instead, so the cells still add to the month's amount.
      const even = splitEven(fc.amount, hits.map((h) => h.day));
      if (scheduleDriven) {
        let sum = 0;
        for (const h of hits) { cells[h.day] = (cells[h.day] ?? 0) + h.rate; sum += h.rate; }
        if (Math.abs(sum - fc.amount) <= 1) return { cells, left: 0 };
      }
      return { cells: even, left: 0 };
    }
    const r = cashDays(sched, year, month0, fc.amount);
    const cells: Record<number, number> = {};
    for (const x of r.days) cells[x.d] = Math.round(((cells[x.d] ?? 0) + x.amount) * 100) / 100;
    return { cells, left: Math.max(0, r.unscheduled) };
  };
  const nextM0 = (month0 + 1) % 12, nextY = month0 === 11 ? year + 1 : year;
  const nextKey = monthKeyFor(nextY, nextM0);
  for (const fc of buildFieldCostRows(data, nextKey)) {
    const primary = venueById.get(fc.primaryVenueId);
    const sched = primary?.pay_schedule ?? null;
    if (!sched || cashMonthOffset(sched) !== 1 || Math.abs(fc.amount) < 0.005) continue;
    subtotal += fc.amount;
    const { cells, left } = scheduledCells(fc, sched, nextKey, nextY, nextM0);
    push({ ...fc, key: `${fc.key}:prepaid` }, cells, "prepaid");
    rows[rows.length - 1].forMonth = `for ${monthName(nextM0)}`;
    if (left > 0.005) { rows[rows.length - 1].undated = left; undated += left; }
  }

  for (const fc of buildFieldCostRows(data, monthKey)) {
    if (Math.abs(fc.amount) < 0.005) continue;
    const primary = venueById.get(fc.primaryVenueId);
    const sched = primary?.pay_schedule ?? null;
    if (sched && cashMonthOffset(sched) === 1) continue;   // paid last month, for this month
    subtotal += fc.amount;
    if (sched) {
      const { cells, left } = scheduledCells(fc, sched, monthKey, year, month0);
      push(fc, cells, sched.mode);
      if (left > 0.005) { rows[rows.length - 1].undated = left; undated += left; }
      continue;
    }
    const cadence = primary?.billing_cadence ?? "monthly";

    // A per-match venue whose amount can be dated off its own schedule
    // (not an override, not a Crossbar dashboard payout). Drives both the
    // auto-spread default and the weekly accrual.
    const scheduleDriven =
      fc.billingType === "per_match" &&
      fc.override == null &&
      !isDashboardDriven(data, fc.primaryVenueId);

    // --- per-match auto-spread: cadence monthly, no fixed billing day.
    // Each match's cost sits on its real match day. billing_day set on a
    // per-match venue means "priced per match, invoiced on a fixed day"
    // and instead flows through the monthly/quarterly/annual lump below.
    if (scheduleDriven && cadence === "monthly" && primary?.billing_day == null) {
      const hits = perMatchHits(data, fc, venueById, monthKey, year, month0);
      const cells: Record<number, number> = {};
      let datedSum = 0;
      for (const h of hits) {
        cells[h.day] = (cells[h.day] ?? 0) + h.rate;
        datedSum += h.rate;
      }
      // Cells always reconcile for pure per-match; the tolerance + undated
      // fallback is defensive so a drift never distorts the subtotal.
      if (Math.abs(datedSum - fc.amount) <= 1) push(fc, cells, "per-match");
      else pushUndated(fc, "per-match");
      continue;
    }

    // --- weekly: per-match accrues each week's matches onto the weekday;
    // flat splits the month total evenly across that weekday's hits.
    if (cadence === "weekly") {
      const wd = primary?.billing_weekday;
      const weeklyDays = wd == null ? [] : weeklyDaysFor(year, month0, wd);
      if (weeklyDays.length === 0) {
        pushUndated(fc, "weekly"); // no weekday captured → honest remainder
        continue;
      }
      let cells: Record<number, number>;
      if (scheduleDriven) {
        const hits = perMatchHits(data, fc, venueById, monthKey, year, month0);
        const { cells: acc, sum } = accrueWeekly(hits, weeklyDays);
        cells = Math.abs(sum - fc.amount) <= 1 ? acc : splitEven(fc.amount, weeklyDays);
      } else {
        cells = splitEven(fc.amount, weeklyDays);
      }
      push(fc, cells, "weekly");
      continue;
    }

    // --- the dated lump. CUSTOM spreads across its captured days; monthly /
    // quarterly / annual land on one. No captured timing → undated remainder,
    // never defaulted to day 1. Both resolve through resolveBillingDates so the
    // Field Costs column cannot answer this question differently.
    const { days } = resolveBillingDates(primary, year, month0);
    if (days.length === 0) pushUndated(fc, cadence);
    else if (cadence === "custom") push(fc, splitEven(fc.amount, days), "custom");
    else push(fc, { [days[0]]: fc.amount }, cadence, cadence !== "monthly");
  }

  rows.sort((a, b) => a.label.localeCompare(b.label));
  const { agg } = aggregateAndSubtotal(rows);
  return {
    key: "field",
    name: "Field Costs",
    src: "from Field Costs config · per venue",
    tag: "per-venue cadence",
    defaultOpen: false,
    rows,
    agg,
    subtotal,
    undated,
  };
}

// ---------------- Expense-category groups (mirror fin_expenses) ----------------

// City Manager Pay + Match Manager Pay are rendered as their own dedicated
// groups above, so they're excluded from the generic mirror (matches Cash
// Flow's DEDICATED_LINE_CATEGORIES). Field Costs is venue-derived, not a
// fin_expenses category, so it never collides here.
const DEDICATED_EXPENSE_CATEGORIES = new Set<string>([
  "City Manager",
  "Match Manager Pay",
]);

// One group per remaining fin_expenses category with rows this month, each
// itemized (one row per expense) and dated on the expense date. The group
// subtotal is the full category-month total so it equals the Expenses tab's
// filtered total by construction; a row whose date falls outside the month
// (shouldn't happen — month is derived from date) lands in the undated
// remainder rather than being dropped. Company-wide rows (no city) are
// labeled explicitly, never silently bucketed under a city.
function expenseCategoryGroups(
  data: FinanceData,
  monthKey: string,
  year: number,
  month0: number,
): CalGroup[] {
  const byCat = new Map<string, FinExpense[]>();
  for (const r of data.expenses) {
    if (r.month !== monthKey) continue;
    if (DEDICATED_EXPENSE_CATEGORIES.has(r.category)) continue;
    const arr = byCat.get(r.category);
    if (arr) arr.push(r);
    else byCat.set(r.category, [r]);
  }

  const groups: CalGroup[] = [];
  for (const [cat, catRows] of byCat) {
    let subtotal = 0;
    const rows: CalRow[] = catRows
      .map((r, i) => {
        subtotal += r.amount;
        const day = dayInMonth(r.date, year, month0);
        const city = r.city?.trim();
        return {
          key: `exp:${r.id ?? `${cat}-${i}`}`,
          label: r.vendor?.trim() || r.notes?.trim() || cat,
          sublabel: city || "Company-wide",
          cells: day ? { [day]: r.amount } : {},
          edit: { expense: r },
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    const { agg, dated } = aggregateAndSubtotal(rows);
    groups.push({
      key: `expcat:${cat}`,
      name: cat,
      src: "from Expenses · fin_expenses",
      defaultOpen: false,
      rows,
      agg,
      subtotal,
      undated: subtotal - dated,
    });
  }
  // Biggest categories first (stable tiebreak on name).
  groups.sort((a, b) => b.subtotal - a.subtotal || a.name.localeCompare(b.name));
  return groups;
}

// ---------------- assembly ----------------

export type OpexCalendar = {
  groups: CalGroup[];        // 3 dedicated groups + one per fin_expenses category present
  dayTotal: number[];        // 1-indexed, length days+1
  cumulative: number[];      // 1-indexed
  monthTotal: number;        // sum of every subtotal (incl. undated)
  datedTotal: number;        // sum placed on days (monthTotal − undated)
  undatedFieldCosts: number;
  biggestHit: { day: number; amount: number } | null;
  categoriesWithSpend: number;
};

export function buildOpexCalendar(
  data: FinanceData | null,
  year: number,
  month0: number,
): OpexCalendar {
  const monthKey = monthKeyFor(year, month0);
  const days = daysInMonth(year, month0);

  const groups: CalGroup[] = data
    ? [
        cityManagerGroup(data, monthKey, year, month0),
        matchManagerGroup(data, monthKey, year, month0),
        fieldCostGroup(data, monthKey, year, month0),
        ...expenseCategoryGroups(data, monthKey, year, month0),
      ]
    : [];

  // Daily totals + cumulative across every dated cell.
  const dayTotal = new Array<number>(days + 1).fill(0);
  for (const g of groups) {
    for (const [d, v] of Object.entries(g.agg)) {
      dayTotal[Number(d)] += v;
    }
  }
  const cumulative = new Array<number>(days + 1).fill(0);
  let run = 0;
  for (let d = 1; d <= days; d++) {
    run += dayTotal[d];
    cumulative[d] = run;
  }

  const undatedFieldCosts = groups.reduce((s, g) => s + g.undated, 0);
  const monthTotal = groups.reduce((s, g) => s + g.subtotal, 0);
  const datedTotal = monthTotal - undatedFieldCosts;

  // Biggest single-day hit (drives a KPI + the sparkline jump).
  let biggestHit: { day: number; amount: number } | null = null;
  for (let d = 1; d <= days; d++) {
    if (dayTotal[d] > 0 && (!biggestHit || dayTotal[d] > biggestHit.amount)) {
      biggestHit = { day: d, amount: dayTotal[d] };
    }
  }

  const categoriesWithSpend = groups.filter((g) => g.subtotal > 0).length;

  return {
    groups,
    dayTotal,
    cumulative,
    monthTotal,
    datedTotal,
    undatedFieldCosts,
    biggestHit,
    categoriesWithSpend,
  };
}

// =================================================================================================
// THE AS-OF CALENDAR — what the OpEx page renders. (buildOpexCalendar above is the pure projection
// and is kept as-is for its suite.)
//
// ONE RULE, SPLIT AT TODAY:
//   days up to and including today → what was actually PAID
//   days after today               → the PROJECTION from venue settings
//
// FIELD COSTS, PAID = the bank. The 2026 QuickBooks "Sports Field Fees" reconciliation is loaded
// into fin_venue_cost_overrides by scripts/load-field-cost-2026.mjs, one row per venue per month,
// every row stamped created_by = BANK_SOURCE. That stamp is what separates a bank figure from an
// operator's "Custom billing month" override, which is a plan, not a payment.
//
// THE BANK RECORDS THE MONTH, NOT THE DAY (the source CSV has `month`, no date). So a paid amount
// is placed on the venue's own billing day for that month where one is set, and otherwise counts in
// the row's Month total with no day. It is NEVER smeared, and never put on day 1.
//
// A PAST MONTH WITH NO BANK ROW SHOWS NOTHING for that venue — not the model. That is also true of
// a past month the bank load does not reach yet (September 2026 is excluded by the loader), so the
// category i states how far the bank data runs.
//
// EVERYTHING ELSE (City Manager, Match Manager, every expense category) is already an actual
// ledger row on its own date; past-or-future is just which side of today its date falls.
// =================================================================================================

export const BANK_SOURCE = "field-cost-2026-reconciliation";

export type MonthState = "past" | "current" | "future";

export type OpexCalendarAsOf = OpexCalendar & {
  state: MonthState;
  // Last day of THIS month that counts as paid: days in a past month, today in the current one,
  // 0 in a future one. A cell is paid iff its day <= paidThrough.
  paidThrough: number;
  paidTotal: number;
  bankThrough: string | null; // "Aug 2026" — the last month the bank load covers
};

const fmtUsd = (n: number) =>
  `$${n.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(Math.round(n * 100) / 100) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;

function monthStateOf(year: number, month0: number, now: Date): MonthState {
  const a = year * 12 + month0;
  const b = now.getFullYear() * 12 + now.getMonth();
  return a < b ? "past" : a > b ? "future" : "current";
}

function monthIndex(key: string): number {
  // "Aug 2026" → 2026*12+7, or -1
  const m = /^([A-Z][a-z]{2}) (\d{4})$/.exec(key);
  if (!m) return -1;
  const i = SHORT_MONTHS.indexOf(m[1]);
  return i < 0 ? -1 : Number(m[2]) * 12 + i;
}

function addCells(into: Record<number, number>, from: Record<number, number>) {
  for (const [d, v] of Object.entries(from)) {
    const day = Number(d);
    into[day] = Math.round(((into[day] ?? 0) + v) * 100) / 100;
  }
}

export function rowTotal(r: CalRow): number {
  let t = (r.paidUndated ?? 0) + (r.undated ?? 0);
  for (const v of Object.values(r.cells)) t += v;
  return Math.round(t * 100) / 100;
}

function billedAndRate(v: FinVenue | undefined, data: FinanceData): { billed: string; rate: string } {
  if (!v) return { billed: "Not set", rate: "Not set" };
  const dash = data.partnerDashboards.find((d) => d.venueId === v.id);
  const when =
    v.billing_cadence === "weekly" ? ", invoiced weekly"
    : v.billing_cadence === "custom" ? ", invoiced on set dates"
    : v.billing_cadence === "quarterly" ? ", invoiced quarterly"
    : v.billing_cadence === "annual" ? ", invoiced yearly"
    : v.billing_day != null ? ", invoiced monthly" : "";
  if (v.billing_type === "profit_share" || dash?.revenueModel === "per_match_minus_manager") {
    return { billed: "Share of match revenue", rate: "The partner's share, from their dashboard" };
  }
  if (v.billing_type === "monthly_flat") {
    return { billed: "Monthly", rate: v.monthly_flat != null ? `${fmtUsd(v.monthly_flat)} / month` : "Not set" };
  }
  if (v.per_match_rate == null && v.hourly_rate != null) {
    return { billed: `Per hour${when}`, rate: `${fmtUsd(v.hourly_rate)} / hour` };
  }
  return {
    billed: `Per match${when}`,
    rate: v.per_match_rate != null ? `${fmtUsd(v.per_match_rate)} / match` : "Not set",
  };
}

function fieldCostGroupAsOf(
  data: FinanceData,
  monthKey: string,
  year: number,
  month0: number,
  state: MonthState,
  paidThrough: number,
  bankThrough: string | null,
): CalGroup {
  const venueById = new Map<number, FinVenue>();
  for (const v of data.venues) venueById.set(v.id, v);
  const groupOf = new Map<number, VenueGroup>();
  for (const g of groupVenues(data.venues)) for (const l of g.legs) groupOf.set(l.id, g);

  const bank = data.overrides.filter((o) => o.created_by === BANK_SOURCE);
  const byPrimary = new Map<number, CalRow>();
  const placedOnBillingDay = new Set<number>();
  // NAMED FOR THE VENUE THE BANK PAID. A group's primary is its cheapest leg (venueGroups sorts by
  // rate), so Soccer Central's money would otherwise sit under "Soccer Central Tournament" at $0.
  const paidVenueOf = new Map<number, number>();
  const getRow = (venueId: number): { row: CalRow; primary: FinVenue | undefined } => {
    const g = groupOf.get(venueId);
    const primary = g?.legs[0] ?? venueById.get(venueId);
    const pid = primary?.id ?? venueId;
    let row = byPrimary.get(pid);
    if (!row) {
      const name = g?.displayName ?? primary?.venue_name ?? `Venue ${pid}`;
      row = {
        key: `field:${pid}`,
        label: name,
        sublabel: primary?.city,
        cells: {},
        lock: { kind: "field-cost", venueId: pid, venueName: name, monthKey },
      };
      byPrimary.set(pid, row);
    }
    return { row, primary };
  };

  // ── PAID: the bank, for any month that has started.
  if (state !== "future") {
    for (const o of bank) {
      if (o.month !== monthKey || Math.abs(o.override_amount) < 0.005) continue;
      const { row } = getRow(o.venue_id);
      const paidVenue = venueById.get(o.venue_id);
      if (paidVenue && row.lock?.kind === "field-cost") {
        paidVenueOf.set(row.lock.venueId, paidVenue.id);
        row.label = paidVenue.venue_name;
        row.lock.venueName = paidVenue.venue_name;
      }
      /* THE BANK MONTH IS THE CASH MONTH, so a bank payment sits on the venue's PAY SCHEDULE dates in
       * that month (0201) — never shifted for prepaid, which only moves projected cash. "Each match"
       * has no single date for a lump, so it stays in the Month total, as an undated bank row did. */
      const sched = paidVenue?.pay_schedule ?? null;
      let days: number[]; let cadence: string;
      if (sched) {
        cadence = sched.mode === "dates" && sched.dates.length > 1 ? "custom" : sched.mode;
        days = sched.mode === "match" ? [] : cashDays(sched, year, month0, o.override_amount).days.map((x) => x.d);
      } else {
        ({ days, cadence } = resolveBillingDates(paidVenue, year, month0));
      }
      const usable = days.filter((d) => d <= paidThrough);
      if (usable.length === 0) {
        row.paidUndated = Math.round(((row.paidUndated ?? 0) + o.override_amount) * 100) / 100;
      } else {
        addCells(row.cells, cadence === "custom" || cadence === "weekly" || cadence === "biweekly" ? splitEven(o.override_amount, usable) : { [usable[0]]: o.override_amount });
        placedOnBillingDay.add(row.lock!.kind === "field-cost" ? row.lock!.venueId : 0);
      }
    }
  }

  // ── PROJECTED: venue settings, for days after today. Bank rows are taken out first so the
  // projection is the model (or an operator's planned override), never a bank figure re-dated.
  if (state !== "past") {
    const planned: FinanceData = { ...data, overrides: data.overrides.filter((o) => o.created_by !== BANK_SOURCE) };
    const proj = fieldCostGroup(planned, monthKey, year, month0, true);
    for (const pr of proj.rows) {
      const venueId = pr.lock?.kind === "field-cost" ? pr.lock.venueId : null;
      if (venueId == null) continue;
      const { row } = getRow(venueId);
      if (pr.forMonth) row.forMonth = pr.forMonth;   // a prepaid venue's next-month cash
      const future: Record<number, number> = {};
      for (const [d, v] of Object.entries(pr.cells)) if (Number(d) > paidThrough) future[Number(d)] = v;
      addCells(row.cells, future);
      if (pr.undated) row.undated = Math.round(((row.undated ?? 0) + pr.undated) * 100) / 100;
      row.tag = pr.tag;
    }
  }

  // ── The i, per row.
  const yearNum = year;
  const rows = [...byPrimary.values()].filter((r) => Math.abs(rowTotal(r)) >= 0.005);
  for (const r of rows) {
    const pid = r.lock?.kind === "field-cost" ? r.lock.venueId : -1;
    const primary = venueById.get(paidVenueOf.get(pid) ?? pid);
    const legs = new Set((groupOf.get(pid)?.legs ?? []).map((l) => l.id).concat(pid));
    const ytd = bank
      .filter((o) => legs.has(o.venue_id) && o.month.endsWith(String(yearNum)))
      .reduce((s, o) => s + o.override_amount, 0);
    const { billed, rate } = billedAndRate(primary, data);
    const notes: string[] = [];
    if (placedOnBillingDay.has(pid)) {
      notes.push("The bank records the month a payment cleared, not the day. It is shown on this venue's billing day.");
    }
    if (r.paidUndated) {
      notes.push(`${fmtUsd(r.paidUndated)} paid this month with no billing day set. It is in the Month total, not on a day.`);
    }
    if (r.undated) {
      notes.push(`${fmtUsd(r.undated)} projected with no billing day set. It is in the Month total, not on a day.`);
    }
    r.info = {
      title: `${r.label}${r.sublabel ? `, ${r.sublabel}` : ""}`,
      billed,
      rate,
      source:
        state === "past" ? "Paid: bank payments."
        : state === "future" ? "Projected from venue settings."
        : "Up to today: bank payments. After today: projected from venue settings.",
      ytd: `${fmtUsd(Math.round(ytd * 100) / 100)} paid${bankThrough ? ` (bank, through ${bankThrough})` : ""}`,
      notes,
    };
  }
  rows.sort((a, b) => (a.sublabel ?? "").localeCompare(b.sublabel ?? "") || a.label.localeCompare(b.label));

  const { agg } = aggregateAndSubtotal(rows);
  const subtotal = Math.round(rows.reduce((s, r) => s + rowTotal(r), 0) * 100) / 100;
  const undated = rows.reduce((s, r) => s + (r.paidUndated ?? 0) + (r.undated ?? 0), 0);
  return {
    key: "field",
    name: "Field Costs",
    src: "",
    how:
      "What we pay each venue. Days up to today show what the bank paid" +
      (bankThrough ? ` (loaded through ${bankThrough}; a later past month shows nothing until it is loaded)` : "") +
      ". Days after today are projected from each venue's billing settings. The bank records the month, not the day: a paid amount sits on the venue's billing day, or only in the Month total if none is set. Solid amounts are paid (bank payments). Dashed amounts are projected from each venue's billing settings. Today is highlighted.",
    defaultOpen: true,
    rows,
    agg,
    subtotal,
    undated,
  };
}

function ledgerInfo(
  data: FinanceData,
  r: CalRow,
  kind: "city" | "match" | "expense",
  category: string,
  year: number,
  now: Date,
): RowInfo {
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const exp = r.edit?.expense;
  const same = (e: FinExpense) =>
    kind === "match"
      ? e.category === "Match Manager Pay" && (e.city?.trim() || "Unknown") === r.label
      : e.category === category && (e.vendor?.trim() || e.notes?.trim() || "") === (exp?.vendor?.trim() || exp?.notes?.trim() || "");
  const ytd = data.expenses
    .filter((e) => same(e) && (e.date ?? "").startsWith(String(year)) && (e.date ?? "") <= todayIso)
    .reduce((s, e) => s + e.amount, 0);
  const month = rowTotal(r);
  const notes: string[] = [];
  if (exp && exp.manual_entry) notes.push("Click an amount to change it.");
  if (exp && !exp.manual_entry) notes.push("Imported. Re-upload it on Q2 Import to change it.");
  if (kind === "match") notes.push("Recomputed on the Manager Pay page. Change it there.");
  return {
    title: `${r.label}${r.sublabel && kind !== "match" ? `, ${r.sublabel}` : ""}`,
    billed: kind === "city" ? "Monthly" : kind === "match" ? "Weekly" : "As entered",
    rate: kind === "match" ? "Per match managed" : `${fmtUsd(month)} this month`,
    source: kind === "match" ? "Manager Pay page." : "Expenses ledger, on the date entered.",
    ytd: `${fmtUsd(Math.round(ytd * 100) / 100)} paid`,
    notes,
  };
}

export function buildOpexCalendarAsOf(
  data: FinanceData | null,
  year: number,
  month0: number,
  now: Date,
): OpexCalendarAsOf {
  const state = monthStateOf(year, month0, now);
  const days = daysInMonth(year, month0);
  const paidThrough = state === "past" ? days : state === "current" ? now.getDate() : 0;
  const monthKey = monthKeyFor(year, month0);

  let bankThrough: string | null = null;
  let groups: CalGroup[] = [];
  if (data) {
    let best = -1;
    for (const o of data.overrides) {
      if (o.created_by !== BANK_SOURCE) continue;
      const i = monthIndex(o.month);
      if (i > best) { best = i; bankThrough = o.month; }
    }
    const city = cityManagerGroup(data, monthKey, year, month0);
    city.how = "Monthly pay to each city manager, from the Expenses ledger, on the day it is paid.";
    for (const r of city.rows) r.info = ledgerInfo(data, r, "city", "City Manager", year, now);
    const match = matchManagerGroup(data, monthKey, year, month0);
    match.how = "Weekly pay to match managers, by city, from the Manager Pay page. It is recomputed there, so it is changed there.";
    for (const r of match.rows) r.info = ledgerInfo(data, r, "match", "Match Manager Pay", year, now);
    const field = fieldCostGroupAsOf(data, monthKey, year, month0, state, paidThrough, bankThrough);
    const rest = expenseCategoryGroups(data, monthKey, year, month0);
    for (const g of rest) {
      g.how = `${g.name} spending from the Expenses ledger, on the date of each expense.`;
      for (const r of g.rows) r.info = ledgerInfo(data, r, "expense", g.name, year, now);
      // Ledger rows with no date carry their amount as undated, so the row total still holds it.
      for (const r of g.rows) {
        const dated = Object.values(r.cells).reduce((s, v) => s + v, 0);
        const amt = r.edit?.expense.amount ?? dated;
        if (Math.abs(amt - dated) >= 0.005) r.undated = amt - dated;
      }
    }
    groups = [city, match, field, ...rest];
  }

  const dayTotal = new Array<number>(days + 1).fill(0);
  for (const g of groups) for (const [d, v] of Object.entries(g.agg)) dayTotal[Number(d)] += v;
  const cumulative = new Array<number>(days + 1).fill(0);
  let run = 0;
  for (let d = 1; d <= days; d++) { run += dayTotal[d]; cumulative[d] = run; }

  const monthTotal = Math.round(groups.reduce((s, g) => s + g.subtotal, 0) * 100) / 100;
  const undatedFieldCosts = groups.reduce((s, g) => s + g.undated, 0);
  let paidTotal = 0;
  for (const g of groups) {
    for (const r of g.rows) {
      for (const [d, v] of Object.entries(r.cells)) if (Number(d) <= paidThrough) paidTotal += v;
      paidTotal += r.paidUndated ?? 0;
      if (state === "past") paidTotal += r.undated ?? 0;
    }
  }
  let biggestHit: { day: number; amount: number } | null = null;
  for (let d = 1; d <= days; d++) {
    if (dayTotal[d] > 0 && (!biggestHit || dayTotal[d] > biggestHit.amount)) biggestHit = { day: d, amount: dayTotal[d] };
  }
  return {
    groups,
    dayTotal,
    cumulative,
    monthTotal,
    datedTotal: monthTotal - undatedFieldCosts,
    undatedFieldCosts,
    biggestHit,
    categoriesWithSpend: groups.filter((g) => g.subtotal > 0).length,
    state,
    paidThrough,
    paidTotal: Math.round(paidTotal * 100) / 100,
    bankThrough,
  };
}

/**
 * EVERY VENUE THAT HAS MONEY LEAVING IN THE MONTH, by Field Costs row (group primary id).
 * Field Costs hides a venue as "inactive" only when it is NOT in this set, so the set errs wide:
 *
 *   1. The OpEx calendar itself (buildOpexCalendarAsOf) — bank payments for days up to today, and
 *      the projection for days after it. Exactly what the OpEx page draws.
 *   2. PLUS the pay-schedule projection over the WHOLE month, past days included. The calendar
 *      shows only the bank for a day that has passed, so a scheduled payment the bank feed has not
 *      recorded yet (a prepaid Oct 1 payment for November, say) would otherwise vanish, and a
 *      missing bank record must never hide a venue.
 *
 * A row counts when its total — dated cells, undated, paid-undated — is non-zero, so a refund
 * (negative) counts as money moving too. Prepaid rows ("for November") carry the venue's id.
 */
export function fieldCostPayeesIn(data: FinanceData, year: number, month0: number, now: Date): Set<number> {
  const out = new Set<number>();
  const take = (rows: CalRow[]) => {
    for (const r of rows) {
      if (r.lock?.kind !== "field-cost" || Math.abs(rowTotal(r)) < 0.005) continue;
      out.add(r.lock.venueId);
    }
  };
  const cal = buildOpexCalendarAsOf(data, year, month0, now);
  for (const g of cal.groups) if (g.key === "field") take(g.rows);
  const planned: FinanceData = { ...data, overrides: data.overrides.filter((o) => o.created_by !== BANK_SOURCE) };
  take(fieldCostGroup(planned, monthKeyFor(year, month0), year, month0, true).rows);
  return out;
}
