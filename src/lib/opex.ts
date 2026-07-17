// OpEx Calendar data model + recurrence expansion.
//
// One fin_opex_entries row per scheduled expense; recurring entries are
// expanded into per-day occurrences at render time (never stored). City
// Manager Pay is NOT stored here in Phase 1 — it is derived read-only
// from the checkIns.ts MANAGERS roster (see cityManagerRows). Every
// other category lives in fin_opex_entries and is user-editable.

import { MANAGERS, daysInMonth } from "./checkIns";

export type OpexCategory =
  | "city_manager"
  | "match_manager"
  | "field_cost"
  | "marketing"
  | "personnel"
  | "equipment"
  | "other";

export type Recurrence =
  | "one_time"
  | "weekly"
  | "monthly"
  | "quarterly"
  | "annually";

export type OpexEntry = {
  id: string;
  category: OpexCategory;
  subcategory: string | null;
  amount: number;
  scheduled_date: string; // YYYY-MM-DD
  recurrence: Recurrence;
  recurrence_end: string | null; // YYYY-MM-DD, null = indefinite
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

// Draft used by the add/edit modal (id + timestamps assigned by the DB).
export type OpexDraft = {
  category: OpexCategory;
  subcategory: string | null;
  amount: number;
  scheduled_date: string;
  recurrence: Recurrence;
  recurrence_end: string | null;
  notes: string | null;
};

// Display order + labels. "other" sits last so any Other-category entry
// still has a home in the grid.
export const OPEX_CATEGORIES: { key: OpexCategory; label: string }[] = [
  { key: "city_manager", label: "City Manager Pay" },
  { key: "match_manager", label: "Match Manager Pay" },
  { key: "field_cost", label: "Field Costs" },
  { key: "marketing", label: "Marketing" },
  { key: "personnel", label: "Personnel" },
  { key: "equipment", label: "Equipment" },
  { key: "other", label: "Other" },
];

export const RECURRENCES: { key: Recurrence; label: string }[] = [
  { key: "one_time", label: "One-time" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
  { key: "quarterly", label: "Quarterly" },
  { key: "annually", label: "Annually" },
];

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function monthLabel(year: number, month0: number): string {
  return `${MONTH_NAMES[month0]} ${year}`;
}

// "$500" / "$1,500" / "$12.50" — decimals only when present.
export function formatMoney(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

// ---------------- recurrence expansion ----------------

function ymd(dateStr: string): { y: number; m0: number; d: number } {
  const [y, m, d] = dateStr.split("-").map(Number);
  return { y, m0: m - 1, d };
}

// Whole months from anchor (a) to target (b); negative if target precedes.
function monthsBetween(ay: number, am0: number, by: number, bm0: number): number {
  return (by - ay) * 12 + (bm0 - am0);
}

// Day-of-month numbers on which `entry` occurs within the given month.
// All comparisons in UTC to avoid timezone drift. Honors scheduled_date
// as the first occurrence and recurrence_end as the hard stop. Monthly /
// quarterly / annually clamp to the month's last day when the anchor day
// does not exist (e.g. the 31st in a 30-day month, Feb 29 in a non-leap
// year).
export function occurrenceDaysInMonth(
  entry: Pick<OpexEntry, "scheduled_date" | "recurrence" | "recurrence_end">,
  year: number,
  month0: number,
): number[] {
  const a = ymd(entry.scheduled_date);
  const end = entry.recurrence_end ? ymd(entry.recurrence_end) : null;
  const monthLast = daysInMonth(year, month0);
  const anchorMs = Date.UTC(a.y, a.m0, a.d);
  const endMs = end ? Date.UTC(end.y, end.m0, end.d) : null;
  const dayMs = 86_400_000;

  const withinEnd = (day: number) =>
    endMs == null || Date.UTC(year, month0, day) <= endMs;
  const onOrAfterAnchor = (day: number) =>
    Date.UTC(year, month0, day) >= anchorMs;

  const out: number[] = [];
  switch (entry.recurrence) {
    case "one_time":
      if (a.y === year && a.m0 === month0) out.push(a.d);
      break;
    case "weekly": {
      const monthStartMs = Date.UTC(year, month0, 1);
      const monthEndMs = Date.UTC(year, month0, monthLast);
      // First occurrence on/after both the anchor and the month start,
      // aligned to the anchor's weekly cadence.
      let ms = Math.max(anchorMs, monthStartMs);
      const rem = (ms - anchorMs) % (7 * dayMs);
      if (rem !== 0) ms += 7 * dayMs - rem;
      for (; ms <= monthEndMs; ms += 7 * dayMs) {
        if (endMs != null && ms > endMs) break;
        out.push(new Date(ms).getUTCDate());
      }
      break;
    }
    case "monthly": {
      if (monthsBetween(a.y, a.m0, year, month0) >= 0) {
        const day = Math.min(a.d, monthLast);
        if (onOrAfterAnchor(day) && withinEnd(day)) out.push(day);
      }
      break;
    }
    case "quarterly": {
      const mb = monthsBetween(a.y, a.m0, year, month0);
      if (mb >= 0 && mb % 3 === 0) {
        const day = Math.min(a.d, monthLast);
        if (onOrAfterAnchor(day) && withinEnd(day)) out.push(day);
      }
      break;
    }
    case "annually": {
      if (year >= a.y && month0 === a.m0) {
        const day = Math.min(a.d, monthLast);
        if (onOrAfterAnchor(day) && withinEnd(day)) out.push(day);
      }
      break;
    }
  }
  return out.sort((x, y) => x - y);
}

// ---------------- grid rows ----------------

// One row in a category section: a labeled series of occurrence days at a
// fixed per-occurrence amount. Editable rows carry the source entry id so
// clicking a pill opens the edit modal; city-manager rows are read-only.
export type OpexRow = {
  key: string;
  label: string;
  amount: number; // per occurrence
  days: number[]; // day-of-month numbers this month
  editable: boolean;
  entryId?: string;
};

// City Manager Pay rows, derived read-only from the checkIns roster: each
// manager pays their monthly amount on payDay (clamped to the month's
// last day). Not stored in fin_opex_entries.
export function cityManagerRows(year: number, month0: number): OpexRow[] {
  const last = daysInMonth(year, month0);
  return MANAGERS.map((m) => ({
    key: `cm:${m.name}`,
    label: `${m.name} · ${m.city}`,
    amount: m.amount,
    days: [Math.min(m.payDay, last)],
    editable: false,
  }));
}

// Editable rows for a category, one per fin_opex_entries row, expanded to
// this month's occurrences. Entries with no occurrence this month drop.
export function entryRows(
  entries: OpexEntry[],
  category: OpexCategory,
  year: number,
  month0: number,
): OpexRow[] {
  return entries
    .filter((e) => e.category === category)
    .map((e) => ({
      key: `e:${e.id}`,
      label: e.subcategory?.trim() || "(no label)",
      amount: e.amount,
      days: occurrenceDaysInMonth(e, year, month0),
      editable: true,
      entryId: e.id,
    }))
    .filter((r) => r.days.length > 0)
    .sort((a, b) => a.label.localeCompare(b.label));
}
