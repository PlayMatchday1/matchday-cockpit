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
//   Marketing/Personnel/Equipment/Other → fin_opex_entries.
//
// Every dated amount flows into Daily Total + Cumulative. The undated
// field-cost remainder is carried on the group (in the subtotal) but
// sits on no day, so it is the one honest exception to "all dated".

import type { FinanceData, FinVenue } from "./useFinanceData";
import { buildFieldCostRows } from "./financeCosts";
import { daysInMonth } from "./checkIns";
import { entryRows, type OpexEntry, type OpexCategory } from "./opex";

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

// One line item: a labeled series of dated amounts (day → dollars).
export type CalRow = {
  key: string;
  label: string;
  sublabel?: string;     // city / context under the label
  cells: Record<number, number>;
  tag?: string;          // e.g. 'monthly' | 'quarterly' | 'per-match'
  quarterly?: boolean;   // amber accent
  editable?: boolean;    // opens the entry modal
  entryId?: string;
};

export type CalGroup = {
  key: string;
  name: string;
  src: string;
  tag?: string;              // header pill (e.g. 'weekly', 'monthly · quarterly')
  defaultOpen: boolean;
  rows: CalRow[];
  agg: Record<number, number>;  // per-day sum across rows (collapsed chips)
  subtotal: number;             // includes undated
  undated: number;              // field-cost amount with no captured date
  editableCat?: OpexCategory;   // set for the 4 user-editable categories
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
      const name = (r.notes?.trim() || r.vendor?.trim() || r.city?.trim() || "Manager");
      return {
        key: `cm:${r.id ?? i}`,
        label: name,
        sublabel: r.city ?? undefined,
        cells: day ? { [day]: r.amount } : {},
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
      row = { key: `mm:${city}`, label: city, cells: {} };
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
    for (const s of data.masterSchedule) {
      if (s.venue_id !== leg.venueId || s.month !== monthKey) continue;
      const day = dayInMonth(s.match_date, year, month0);
      if (day != null) hits.push({ day, rate: leg.rate });
    }
    if (legVenue?.charge_on_cancel) {
      for (const s of data.cancelledSchedule) {
        if (s.venue_id !== leg.venueId || s.month !== monthKey) continue;
        const day = dayInMonth(s.match_date, year, month0);
        if (day != null) hits.push({ day, rate: leg.rate });
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
): CalGroup {
  const venueById = new Map<number, FinVenue>();
  for (const v of data.venues) venueById.set(v.id, v);

  const rows: CalRow[] = [];
  let undated = 0;
  let subtotal = 0;

  const push = (fc: { key: string; displayName: string; city: string }, cells: Record<number, number>, tag: string, quarterly?: boolean) => {
    rows.push({ key: fc.key, label: fc.displayName, sublabel: fc.city, cells, tag, quarterly });
  };

  for (const fc of buildFieldCostRows(data, monthKey)) {
    if (Math.abs(fc.amount) < 0.005) continue;
    subtotal += fc.amount;
    const primary = venueById.get(fc.primaryVenueId);
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
      else undated += fc.amount;
      continue;
    }

    // --- weekly: per-match accrues each week's matches onto the weekday;
    // flat splits the month total evenly across that weekday's hits.
    if (cadence === "weekly") {
      const wd = primary?.billing_weekday;
      const weeklyDays = wd == null ? [] : weeklyDaysFor(year, month0, wd);
      if (weeklyDays.length === 0) {
        undated += fc.amount; // no weekday captured → honest remainder
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

    // --- custom: this month's cost lands on the captured day(s), split
    // evenly. A month with a cost but no day set → undated remainder.
    if (cadence === "custom") {
      const days = customDaysFor(primary, year, month0);
      if (days.length > 0) push(fc, splitEven(fc.amount, days), "custom");
      else undated += fc.amount;
      continue;
    }

    // --- monthly / quarterly / annual: single dated lump on the billing
    // day (cadence + anchor aware). No captured timing → undated remainder,
    // never defaulted to day 1.
    const day = billingDayForMonth(primary, year, month0);
    if (day != null) push(fc, { [day]: fc.amount }, cadence, cadence !== "monthly");
    else undated += fc.amount;
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

// ---------------- Editable categories ----------------

const EDITABLE: { key: OpexCategory; label: string }[] = [
  { key: "marketing", label: "Marketing" },
  { key: "personnel", label: "Personnel" },
  { key: "equipment", label: "Equipment" },
  { key: "other", label: "Other" },
];

function editableGroup(
  entries: OpexEntry[],
  cat: OpexCategory,
  label: string,
  year: number,
  month0: number,
): CalGroup {
  const rows: CalRow[] = entryRows(entries, cat, year, month0).map((r) => {
    const cells: Record<number, number> = {};
    for (const d of r.days) cells[d] = (cells[d] ?? 0) + r.amount;
    return {
      key: r.key,
      label: r.label,
      cells,
      editable: true,
      entryId: r.entryId,
    };
  });
  const { agg, dated } = aggregateAndSubtotal(rows);
  return {
    key: cat,
    name: label,
    src: "from + Add Expense",
    defaultOpen: true,
    rows,
    agg,
    subtotal: dated,
    undated: 0,
    editableCat: cat,
  };
}

// ---------------- assembly ----------------

export type OpexCalendar = {
  groups: CalGroup[];        // the 3 auto groups + any non-empty editable groups
  emptyEditable: string[];   // labels of editable cats with no rows (collapse to one line)
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
  entries: OpexEntry[],
  year: number,
  month0: number,
): OpexCalendar {
  const monthKey = monthKeyFor(year, month0);
  const days = daysInMonth(year, month0);

  const autoGroups: CalGroup[] = data
    ? [
        cityManagerGroup(data, monthKey, year, month0),
        matchManagerGroup(data, monthKey, year, month0),
        fieldCostGroup(data, monthKey, year, month0),
      ]
    : [];

  const editableGroups = EDITABLE.map((e) =>
    editableGroup(entries, e.key, e.label, year, month0),
  );
  const nonEmptyEditable = editableGroups.filter((g) => g.rows.length > 0);
  const emptyEditable = editableGroups
    .filter((g) => g.rows.length === 0)
    .map((g) => g.name);

  const groups = [...autoGroups, ...nonEmptyEditable];

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
    emptyEditable,
    dayTotal,
    cumulative,
    monthTotal,
    datedTotal,
    undatedFieldCosts,
    biggestHit,
    categoriesWithSpend,
  };
}
