// FINANCE › EXPENSES — ONE MONTH, ONE LIST, GROUPED BY CATEGORY (Ryan, 2026-10-03).
//
// THE PAGE'S WHOLE MODEL, pure (no Supabase, no React) so scripts/expenses-page-test.ts can assert
// it. It changes no stored row: it groups fin_expenses for one month, exactly as stored.
//
// A LINE is what the old Recurring tab called a series: one city + category + vendor
// (recurringExpenses.seriesKeyOf — the same identity, so a raise mid-year is the same line). There
// is no recurrence column: a line booked in MORE THAN TWO months is "every month", otherwise
// "once" — the rule the Recurring tab already used for one-offs.
//
// THE TOTAL INCLUDES EVERY ROW OF THE MONTH, Match Manager Pay included (Ryan: "Including Match
// Manager Pay in the page total is what I want"). So the page total is what OpEx, the Cost report
// and the P&L read from the same table. Two kinds of row are read-only here and marked "auto":
//   · Match Manager Pay — rewritten daily from the Manager Pay page; ONE line for the month's total
//     (the city filter narrows it to that city).
//   · Meta ads — vendor "Meta", written by the daily Meta sync (manual_entry false).
// Any other imported row (manual_entry false) is locked, not auto.

import type { FinExpense } from "./useFinanceData";
import { seriesKeyOf } from "./recurringExpenses";

export const MATCH_PAY = "Match Manager Pay";
export const ALL_CITIES = "All";
export const COMPANY_WIDE = "Company-wide";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthKeyOf = (year: number, month0: number) => `${MON[month0]} ${year}`;
export function prevMonthKey(key: string): string {
  const [m, y] = key.split(" ");
  const i = MON.indexOf(m);
  return i === 0 ? `Dec ${Number(y) - 1}` : `${MON[i - 1]} ${y}`;
}
const r2 = (n: number) => Math.round(n * 100) / 100;

/** A category's colour: fixed for the ones in use, then a stable fallback. */
const PALETTE: Record<string, string> = {
  "Corporate Salaries": "#2f6b4f", "City Manager": "#4f9d74", "Match Manager Pay": "#7cc49a",
  "Contractors": "#9fd4b4", "Marketing": "#e0a33a", "Equipment": "#8a7fd1", "VEO Camera": "#b2a9e6",
  "Subscriptions": "#4f8fc9", "Misc": "#9aa5a0",
};
const FALLBACK = ["#c97a5b", "#5bb0c9", "#c9b45b", "#a35bc9", "#5bc98f"];
export function categoryColor(name: string): string {
  if (PALETTE[name]) return PALETTE[name];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK[h % FALLBACK.length];
}

/** THE PAGE'S CATEGORY ORDER (Ryan, 2026-10-04): these four first, then the rest by name. One
 *  order for the bubbles, the cards, the split bar and the add row's dropdown. */
export const CATEGORY_ORDER = ["Marketing", "Corporate Salaries", "City Manager", MATCH_PAY];
export function compareCategories(a: string, b: string): number {
  const ra = CATEGORY_ORDER.indexOf(a), rb = CATEGORY_ORDER.indexOf(b);
  return (ra < 0 ? CATEGORY_ORDER.length : ra) - (rb < 0 ? CATEGORY_ORDER.length : rb) || a.localeCompare(b);
}

export type ExpLine = {
  key: string;
  category: string;
  label: string;
  city: string | null;
  vendor: string | null;
  thisRows: FinExpense[];
  lastRows: FinExpense[];
  thisAmount: number;
  lastAmount: number;
  /** "every week" only for Match Manager Pay, paid each Tuesday from the Manager Pay page. */
  frequency: "every month" | "every week" | "once";
  /** Read-only and calculated elsewhere: Match Manager Pay, or the Meta ad rows. */
  auto: null | "match-pay" | "meta";
  /** Imported (manual_entry false) and not auto: shown with a lock, not editable. */
  locked: boolean;
};
export type ExpCategory = { name: string; color: string; total: number; lastTotal: number; lines: ExpLine[] };
export type ExpMonth = { monthKey: string; prevKey: string; total: number; matchPay: number; categories: ExpCategory[] };

export function cityMatches(r: Pick<FinExpense, "city">, city: string): boolean {
  if (city === ALL_CITIES) return true;
  if (city === COMPANY_WIDE) return !r.city || r.city === COMPANY_WIDE;
  return r.city === city;
}
const isMeta = (r: FinExpense) => r.vendor === "Meta" && r.manual_entry === false;

/** The month, grouped. Lines with a row this month OR last month (a line booked last month and
 *  not this one is a gap, shown so it can be filled); totals count this month only. */
export function expensesMonth(expenses: readonly FinExpense[], monthKey: string, city: string = ALL_CITIES): ExpMonth {
  const prevKey = prevMonthKey(monthKey);
  // Booked months per line, over ALL history — the "every month / once" rule.
  const bookedMonths = new Map<string, Set<string>>();
  for (const r of expenses) {
    if (r.category === MATCH_PAY) continue;
    const k = seriesKeyOf(r);
    (bookedMonths.get(k) ?? bookedMonths.set(k, new Set()).get(k)!).add(r.month);
  }

  const lines = new Map<string, ExpLine>();
  let mpThis = 0, mpLast = 0;
  const mpThisRows: FinExpense[] = [], mpLastRows: FinExpense[] = [];
  for (const r of expenses) {
    if (r.month !== monthKey && r.month !== prevKey) continue;
    if (!cityMatches(r, city)) continue;
    if (r.category === MATCH_PAY) {
      if (r.month === monthKey) { mpThis += Number(r.amount); mpThisRows.push(r); }
      else { mpLast += Number(r.amount); mpLastRows.push(r); }
      continue;
    }
    const k = seriesKeyOf(r);
    let l = lines.get(k);
    if (!l) {
      l = {
        key: k, category: r.category, label: r.vendor?.trim() || r.category, city: r.city?.trim() || null, vendor: r.vendor ?? null,
        thisRows: [], lastRows: [], thisAmount: 0, lastAmount: 0,
        frequency: (bookedMonths.get(k)?.size ?? 0) > 2 ? "every month" : "once",
        auto: isMeta(r) ? "meta" : null, locked: false,
      };
      lines.set(k, l);
    }
    if (r.month === monthKey) { l.thisRows.push(r); l.thisAmount += Number(r.amount); }
    else { l.lastRows.push(r); l.lastAmount += Number(r.amount); }
    if (r.manual_entry === false && !isMeta(r)) l.locked = true;
  }
  if (mpThisRows.length || mpLastRows.length) {
    lines.set(`auto:${MATCH_PAY}`, {
      key: `auto:${MATCH_PAY}`, category: MATCH_PAY, label: "Match manager pay", city: city === ALL_CITIES ? null : city, vendor: null,
      thisRows: mpThisRows, lastRows: mpLastRows, thisAmount: mpThis, lastAmount: mpLast,
      frequency: "every week", auto: "match-pay", locked: true,
    });
  }

  const byCat = new Map<string, ExpCategory>();
  for (const l of lines.values()) {
    l.thisAmount = r2(l.thisAmount);
    l.lastAmount = r2(l.lastAmount);
    const c = byCat.get(l.category) ?? { name: l.category, color: categoryColor(l.category), total: 0, lastTotal: 0, lines: [] };
    c.lines.push(l);
    c.total = r2(c.total + l.thisAmount);
    c.lastTotal = r2(c.lastTotal + l.lastAmount);
    byCat.set(l.category, c);
  }
  const categories = [...byCat.values()]
    .map((c) => ({ ...c, lines: c.lines.sort((a, b) => b.thisAmount - a.thisAmount || a.label.localeCompare(b.label)) }))
    .sort((a, b) => compareCategories(a.name, b.name));
  return { monthKey, prevKey, total: r2(categories.reduce((s, c) => s + c.total, 0)), matchPay: r2(mpThis), categories };
}

/** What the list shows: every category with money this month — or, with one selected, only it
 *  (even at $0, so a selected bubble always opens its card). */
export function visibleCategories(m: ExpMonth, selected: string | null): ExpCategory[] {
  if (selected) return m.categories.filter((c) => c.name === selected);
  return m.categories.filter((c) => Math.abs(c.total) >= 0.005);
}

/** "+$350 vs Sep" — or null when this month equals last month. */
export function changeText(l: Pick<ExpLine, "thisAmount" | "lastAmount">, prevKey: string): string | null {
  const d = r2(l.thisAmount - l.lastAmount);
  if (Math.abs(d) < 0.005) return null;
  const abs = Math.abs(d);
  const money = `$${abs.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(abs) ? 0 : 2, maximumFractionDigits: 2 })}`;
  return `${d > 0 ? "+" : "−"}${money} vs ${prevKey.split(" ")[0]}`;
}

/* ── THE ADD ROW ──────────────────────────────────────────────────────────────────────────────
 * "Once" writes one row on its date. "Every month" writes the chosen month and each of the next 11
 * — twelve — on the chosen day (clamped to a short month's last day), and SKIPS a month that
 * already has a row for the same city + category + vendor, as the drawer always has. Pure: it
 * returns the rows to write and the months skipped; the page writes them one by one through the
 * audited insertFinExpense, never retrying. */
export type AddDraft = {
  what: string;
  category: string;
  amount: number;
  how: "monthly" | "once";
  city: string | null;
  /** monthly: day of month 1–31; ignored for once. */
  day: number;
  /** once: YYYY-MM-DD; monthly: any date in the first month. */
  date: string;
};
export type PlannedRow = { date: string; month: string; city: string | null; category: string; vendor: string; amount: number };

export function addProblem(d: AddDraft): string | null {
  if (!d.what.trim()) return "Say what or who it is.";
  if (!d.category) return "Pick a category.";
  if (d.category === MATCH_PAY) return "Match Manager Pay comes from the Manager Pay page.";
  if (!Number.isFinite(d.amount) || d.amount <= 0) return "The amount must be more than $0.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return "Pick a date.";
  if (d.how === "monthly" && !(d.day >= 1 && d.day <= 31)) return "The day of the month is 1 to 31.";
  return null;
}

export function planAdd(d: AddDraft, existing: readonly FinExpense[]): { rows: PlannedRow[]; skipped: string[] } {
  const base = { city: d.city?.trim() || null, category: d.category, vendor: d.what.trim(), amount: r2(d.amount) };
  if (d.how === "once") {
    const y = Number(d.date.slice(0, 4)), m0 = Number(d.date.slice(5, 7)) - 1;
    return { rows: [{ ...base, date: d.date, month: monthKeyOf(y, m0) }], skipped: [] };
  }
  const key = seriesKeyOf({ ...base } as unknown as FinExpense);
  const have = new Set(existing.filter((r) => seriesKeyOf(r) === key).map((r) => r.month));
  const rows: PlannedRow[] = [], skipped: string[] = [];
  let y = Number(d.date.slice(0, 4)), m0 = Number(d.date.slice(5, 7)) - 1;
  for (let i = 0; i < 12; i++) {
    const month = monthKeyOf(y, m0);
    const dim = new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
    const day = Math.min(d.day, dim);
    if (have.has(month)) skipped.push(month);
    else rows.push({ ...base, month, date: `${y}-${String(m0 + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}` });
    m0++;
    if (m0 === 12) { m0 = 0; y++; }
  }
  return { rows, skipped };
}

/** "Paid on the 5th of each month, through Sep 2027." / "One payment on that date." — the line
 *  under the add row, following its choices. Null until the date is a date. */
export function addHint(how: AddDraft["how"], date: string): string | null {
  if (how === "once") return "One payment on that date.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const y = Number(date.slice(0, 4)), m0 = Number(date.slice(5, 7)) - 1 + 11, day = Number(date.slice(8, 10));
  const sfx = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `Paid on the ${day}${sfx} of each month, through ${monthKeyOf(y + Math.floor(m0 / 12), m0 % 12)}.`;
}

/* ── SIMILAR NAMES ────────────────────────────────────────────────────────────────────────────
 * "Deeona" and "Deonna" are two lines because the names differ. Before adding, the page asks
 * whether the new name is a line that already exists in the same category and city. It never
 * blocks: both answers save. An exact match (ignoring case and spaces) is the same line already,
 * so it is not "similar". Close = an edit distance of 1, or 2 for names of five letters or more. */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
export function similarLine(what: string, category: string, city: string | null, existing: readonly FinExpense[]): string | null {
  const name = what.trim().toLowerCase();
  if (name.length < 3 || !category) return null;
  const cityK = (c: string | null | undefined) => { const t = (c ?? "").trim(); return t === "" || t === COMPANY_WIDE ? "" : t; };
  const want = cityK(city);
  let best: { vendor: string; dist: number } | null = null;
  for (const r of existing) {
    if (r.category !== category || cityK(r.city) !== want) continue;
    const v = (r.vendor ?? "").trim();
    const lv = v.toLowerCase();
    if (!lv || lv === name) { if (lv === name) return null; continue; }
    const dist = editDistance(name, lv);
    if (dist <= (Math.min(name.length, lv.length) >= 5 ? 2 : 1) && (!best || dist < best.dist)) best = { vendor: v, dist };
  }
  return best?.vendor ?? null;
}
