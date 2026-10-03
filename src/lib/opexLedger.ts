// OPEX v3 — every payment of the month as ONE ROW, in six categories.
//
// THE NUMBERS ARE buildOpexCalendarAsOf's (src/lib/opexSources.ts), unchanged: bank payments for
// days up to today, venue / pay / expense settings after it. This file only flattens that calendar
// into payments and files each one under one of the six categories Ryan set on 2026-10-02:
//
//   Personnel      City Manager pay, Match Manager pay, Corporate Salaries, Contractors
//   Field Costs    what we pay each venue
//   Equipment      Equipment, and VEO Camera
//   Marketing · Subscriptions · Misc
//
// An Expenses category that is in none of those is filed under Misc WITH ITS OWN NAME as the
// sub-type ("Misc · Fuel"), never dropped and never silently merged.
//
// ONE PAYMENT = one dated amount on one row of the calendar. Money a row owes the month with no
// day (a bank payment for a venue with no billing day, a projection with no billing day, a ledger
// expense with no date) is a payment with day null: it is in every total and in the ledger's
// "No day set" group, and on no calendar day. The sum of all payments is the calendar's monthTotal.

import type { CalGroup, CalRow, OpexCalendarAsOf } from "./opexSources";

export type CatKey = "pers" | "field" | "equip" | "mkt" | "subs" | "misc";

export const CATS: { key: CatKey; name: string; short: string; col: string; how: string }[] = [
  { key: "pers", name: "Personnel", short: "Personnel", col: "#2f6b4f", how: "City manager pay, match manager pay, corporate salaries and contractors." },
  { key: "field", name: "Field Costs", short: "Fields", col: "#5aa77a", how: "What we pay each venue. Paid days are bank payments; later days are projected from each venue's billing settings." },
  { key: "equip", name: "Equipment", short: "Equipment", col: "#8a7fd1", how: "Cameras, goals and gear. Includes VEO camera plans." },
  { key: "mkt", name: "Marketing", short: "Marketing", col: "#e0a33a", how: "Ads and agency spend, from the Expenses page." },
  { key: "subs", name: "Subscriptions", short: "Subscriptions", col: "#4f8fc9", how: "Software and services billed monthly, from the Expenses page." },
  { key: "misc", name: "Misc", short: "Misc", col: "#9aa5a0", how: "Anything else on the Expenses page, under its own name." },
];
export const CAT_BY_KEY = Object.fromEntries(CATS.map((c) => [c.key, c])) as Record<CatKey, (typeof CATS)[number]>;

/** Where an Expenses category goes, and the sub-type it reads as on a ledger row. */
export function categorize(expenseCategory: string): { cat: CatKey; sub: string } {
  switch (expenseCategory) {
    case "City Manager": return { cat: "pers", sub: "City manager pay" };
    case "Match Manager Pay": return { cat: "pers", sub: "Match manager pay" };
    case "Corporate Salaries": return { cat: "pers", sub: "Corporate salaries" };
    case "Contractors": return { cat: "pers", sub: "Contractors" };
    case "Equipment": return { cat: "equip", sub: "Equipment" };
    case "VEO Camera": return { cat: "equip", sub: "VEO camera" };
    case "Marketing": return { cat: "mkt", sub: "Marketing" };
    case "Subscriptions": return { cat: "subs", sub: "Subscriptions" };
    case "Misc": return { cat: "misc", sub: "Misc" };
    default: return { cat: "misc", sub: expenseCategory };   // "Misc · Fuel"
  }
}

export type Payment = {
  key: string;
  day: number | null;      // null = in the month, on no day
  payee: string;
  cat: CatKey;
  sub: string;             // what it is; equal to the category name when there is nothing to add
  city: string | null;
  amount: number;
  paid: boolean;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The sub-type worth printing: nothing when it only repeats the category ("Marketing · Marketing"). */
export const subLabel = (p: Payment): string | null =>
  p.sub === CAT_BY_KEY[p.cat].name || p.sub === "Field cost" ? null : p.sub;

/** The city worth printing beside a payee: nothing when it IS the payee ("Austin · Austin"). */
export const cityLabel = (p: Payment): string | null =>
  p.city && p.city.trim() && p.city.trim() !== p.payee.trim() ? p.city.trim() : null;

function groupCat(g: CalGroup): { cat: CatKey; sub: string } {
  if (g.key === "city") return categorize("City Manager");
  if (g.key === "match") return categorize("Match Manager Pay");
  if (g.key === "field") return { cat: "field", sub: "Field cost" };
  if (g.key.startsWith("expcat:")) return categorize(g.key.slice(7));
  return { cat: "misc", sub: g.name };
}

function rowCity(g: CalGroup, r: CalRow): string | null {
  if (g.key === "match") return r.label;                       // one row per city
  const s = r.sublabel?.trim();
  return s && s !== "Company-wide" ? s : null;
}

/** Every payment in the month, as one list. Sums to cal.monthTotal (to the cent). */
export function paymentsOf(cal: OpexCalendarAsOf): Payment[] {
  const out: Payment[] = [];
  for (const g of cal.groups) {
    const { cat, sub: groupSub } = groupCat(g);
    for (const r of g.rows) {
      const city = rowCity(g, r);
      // A PREPAID venue's cash for next month's matches reads "for November" (Field Costs v2).
      const sub = r.forMonth ?? groupSub;
      for (const [d, v] of Object.entries(r.cells)) {
        if (Math.abs(v) < 0.005) continue;
        const day = Number(d);
        out.push({ key: `${r.key}:${day}`, day, payee: r.label, cat, sub, city, amount: r2(v), paid: day <= cal.paidThrough });
      }
      if (r.paidUndated && Math.abs(r.paidUndated) >= 0.005) {
        out.push({ key: `${r.key}:paid-undated`, day: null, payee: r.label, cat, sub, city, amount: r2(r.paidUndated), paid: true });
      }
      if (r.undated && Math.abs(r.undated) >= 0.005) {
        // A projection with no day is still a projection; in a month that is over, it is counted as
        // paid, exactly as buildOpexCalendarAsOf's paidTotal counts it.
        out.push({ key: `${r.key}:undated`, day: null, payee: r.label, cat, sub, city, amount: r2(r.undated), paid: cal.state === "past" });
      }
    }
  }
  return out.sort((a, b) => (a.day ?? 99) - (b.day ?? 99) || b.amount - a.amount || a.payee.localeCompare(b.payee));
}

export const sumOf = (ps: Payment[]): number => r2(ps.reduce((s, p) => s + p.amount, 0));
