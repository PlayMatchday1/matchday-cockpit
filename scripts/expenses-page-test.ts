// FINANCE › EXPENSES — the redesigned page's model, against the real builder.
//   npx tsx scripts/expenses-page-test.ts
//
// WHAT THIS GUARDS (Ryan, 2026-10-03). The page is one month, one list grouped by category, with
// Match Manager Pay and the Meta ads as read-only "auto" rows. It changes no stored row, so:
//   · category totals sum to the month total, and the month total is every Expenses row of the
//     month (Match Manager Pay included) — the number OpEx, the Cost report and the P&L read
//   · selecting a bubble shows only that category; unselecting restores all
//   · an expense added through the row appears once and raises its category and the month total
//     by its amount; "every month" writes twelve and skips months that already have the line
//   · the Cost report's monthly figures are unchanged (the page reads, never writes)
//   · the header rule: Expenses, like OpEx, draws its own one-month header

import {
  expensesMonth, visibleCategories, changeText, planAdd, addProblem, prevMonthKey, MATCH_PAY, ALL_CITIES, COMPANY_WIDE,
} from "../src/lib/expensesMonth";
import { monthlyExpenseCategoryFor } from "../src/lib/financeStats";
import { drawsOwnHeader } from "../src/lib/financeChrome";
import type { FinanceData, FinExpense } from "../src/lib/useFinanceData";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

let id = 0;
const row = (month: string, date: string, category: string, city: string | null, vendor: string | null, amount: number, manual = true): FinExpense =>
  ({ id: ++id, date, month, city, category, vendor, amount, notes: null, manual_entry: manual } as unknown as FinExpense);

// A small real-shaped ledger: salaries every month, a city manager that got a raise, Meta (auto,
// imported), a one-off purchase, Match Manager Pay (auto), and history so "every month" can be judged.
const EXP: FinExpense[] = [
  ...["Jul", "Aug", "Sep", "Oct"].map((m, i) => row(`${m} 2026`, `2026-${String(7 + i).padStart(2, "0")}-15`, "Corporate Salaries", null, "Nick", 1000)),
  row("Aug 2026", "2026-08-01", "City Manager", "Austin", "Garrett", 500),
  row("Sep 2026", "2026-09-01", "City Manager", "Austin", "Garrett", 500),
  row("Oct 2026", "2026-10-01", "City Manager", "Austin", "Garrett", 850),     // +$350 vs Sep
  row("Sep 2026", "2026-09-30", "Marketing", "Austin", "Meta", 1136.83, false),
  row("Oct 2026", "2026-10-31", "Marketing", "Austin", "Meta", 67.56, false),
  row("Oct 2026", "2026-10-31", "Marketing", "Dallas", "Meta", 79.36, false),
  row("Oct 2026", "2026-10-12", "Equipment", "Dallas", "Goal Co", 640),        // once
  row("Sep 2026", "2026-09-29", MATCH_PAY, "Austin", "Weekly payroll", 720, false),
  row("Oct 2026", "2026-10-06", MATCH_PAY, "Austin", "Weekly payroll", 720, false),
  row("Oct 2026", "2026-10-06", MATCH_PAY, "Dallas", "Weekly payroll", 100, false),
  row("Sep 2026", "2026-09-10", "Misc", null, "Lawyer", 300),                  // Sep only: a gap in Oct
];
const sumMonth = (month: string, rows = EXP) => Math.round(rows.filter((r) => r.month === month).reduce((s, r) => s + r.amount, 0) * 100) / 100;

console.log("\nTOTALS — categories sum to the month, and the month is every row (Match Manager Pay included)");
{
  const m = expensesMonth(EXP, "Oct 2026");
  is("category totals sum to the month total", Math.round(m.categories.reduce((s, c) => s + c.total, 0) * 100), Math.round(m.total * 100));
  is(`the month total is every October Expenses row: $${sumMonth("Oct 2026")}`, m.total, sumMonth("Oct 2026"));
  is("...which includes Match Manager Pay ($820) — the page total OpEx and the Cost report read", m.matchPay, 820);
  const mp = m.categories.find((c) => c.name === MATCH_PAY)!;
  is("Match Manager Pay is ONE auto line for the month's total", [mp.lines.length, mp.lines[0].auto, mp.lines[0].thisAmount], [1, "match-pay", 820]);
  const meta = m.categories.find((c) => c.name === "Marketing")!.lines;
  is("Meta rows are auto, one line per city", meta.map((l) => [l.city, l.auto]), [["Dallas", "meta"], ["Austin", "meta"]]);
  is("the city filter narrows Match Manager Pay to that city ($100 Dallas)", expensesMonth(EXP, "Oct 2026", "Dallas").matchPay, 100);
  const dallas = expensesMonth(EXP, "Oct 2026", "Dallas");
  is("...and the Dallas month is every Dallas row", dallas.total, Math.round(EXP.filter((r) => r.month === "Oct 2026" && r.city === "Dallas").reduce((s, r) => s + r.amount, 0) * 100) / 100);
  is("Company-wide is the rows with no city", expensesMonth(EXP, "Oct 2026", COMPANY_WIDE).total, 1000);
}

console.log("\nLINES — last month, this month, the change, every month / once");
{
  const m = expensesMonth(EXP, "Oct 2026");
  const cm = m.categories.find((c) => c.name === "City Manager")!.lines[0];
  is("Garrett: last month $500, this month $850", [cm.lastAmount, cm.thisAmount], [500, 850]);
  is("...the change in words", changeText(cm, m.prevKey), "+$350 vs Sep");
  const nick = m.categories.find((c) => c.name === "Corporate Salaries")!.lines[0];
  is("Nick: unchanged, so no change text", changeText(nick, m.prevKey), null);
  is("booked in 4 months → every month", nick.frequency, "every month");
  is("Garrett booked in 3 months → every month", cm.frequency, "every month");
  is("the goals, booked once → once", m.categories.find((c) => c.name === "Equipment")!.lines[0].frequency, "once");
  const misc = m.categories.find((c) => c.name === "Misc");
  is("a line booked last month and not this one is shown as a gap (to fill), adding $0", [misc?.lines[0].thisRows.length, misc?.total], [0, 0]);
  is("prevMonthKey crosses the year", prevMonthKey("Jan 2027"), "Dec 2026");
}

console.log("\nBUBBLES — one selected shows only it; unselected shows all with money");
{
  const m = expensesMonth(EXP, "Oct 2026");
  const all = visibleCategories(m, null).map((c) => c.name);
  is("nothing selected: every category with money this month (Misc, at $0, is hidden)", all.includes("Misc"), false);
  is("CONTROL — and the others are all there", all.sort(), ["City Manager", "Corporate Salaries", "Equipment", "Marketing", MATCH_PAY]);
  is("selecting Marketing shows only Marketing", visibleCategories(m, "Marketing").map((c) => c.name), ["Marketing"]);
  is("selecting Misc opens it even at $0", visibleCategories(m, "Misc").map((c) => c.name), ["Misc"]);
  is("unselecting restores all", visibleCategories(m, null).map((c) => c.name).sort(), all.sort());
}

console.log("\nTHE ADD ROW — once, every month, and the skip");
{
  const once = { what: "Sideline banners", category: "Equipment", amount: 275, how: "once" as const, city: "Austin", day: 1, date: "2026-10-20" };
  is("a valid draft has no problem", addProblem(once), null);
  is("Match Manager Pay cannot be added here", addProblem({ ...once, category: MATCH_PAY }) !== null, true);
  const p1 = planAdd(once, EXP);
  is("once writes one row on its date", p1.rows.map((r) => [r.date, r.month, r.amount]), [["2026-10-20", "Oct 2026", 275]]);
  const after = [...EXP, ...p1.rows.map((r, i) => ({ id: 9000 + i, ...r, notes: null, manual_entry: true } as unknown as FinExpense))];
  const before = expensesMonth(EXP, "Oct 2026"), now = expensesMonth(after, "Oct 2026");
  const lineHits = now.categories.flatMap((c) => c.lines).filter((l) => l.label === "Sideline banners");
  is("the added expense appears once", [lineHits.length, lineHits[0]?.thisRows.length], [1, 1]);
  is("...it raises Equipment by its amount", Math.round((now.categories.find((c) => c.name === "Equipment")!.total - before.categories.find((c) => c.name === "Equipment")!.total) * 100), 27500);
  is("...and the month total by its amount", Math.round((now.total - before.total) * 100), 27500);

  const monthly = { what: "Garrett", category: "City Manager", amount: 850, how: "monthly" as const, city: "Austin", day: 31, date: "2026-10-01" };
  const p2 = planAdd(monthly, EXP);
  is("every month: twelve months from the chosen one, minus those already booked (Oct)", [p2.rows.length, p2.skipped], [11, ["Oct 2026"]]);
  is("...Nov through Sep, on the 31st clamped to short months", p2.rows.slice(0, 4).map((r) => r.date), ["2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28"]);
  is("...the last is Sep 2027", p2.rows[p2.rows.length - 1].month, "Sep 2027");
  const fresh = planAdd({ ...monthly, what: "New hire", city: "Dallas" }, EXP);
  is("a new line writes all twelve", [fresh.rows.length, fresh.skipped.length], [12, 0]);
}

console.log("\nTHE COST REPORT'S MONTHLY FIGURES ARE UNCHANGED");
{
  const data = { expenses: EXP } as unknown as FinanceData;
  const snap = JSON.stringify(EXP);
  const before = ["city_manager", "marketing", "equipment"].map((k) => monthlyExpenseCategoryFor(data, "Oct 2026" as never, k as never));
  for (const c of [ALL_CITIES, "Austin", "Dallas", COMPANY_WIDE]) { expensesMonth(EXP, "Oct 2026", c); expensesMonth(EXP, "Sep 2026", c); }
  visibleCategories(expensesMonth(EXP, "Oct 2026"), "Marketing");
  planAdd({ what: "x", category: "Misc", amount: 1, how: "monthly", city: null, day: 1, date: "2026-10-01" }, EXP);
  const after = ["city_manager", "marketing", "equipment"].map((k) => monthlyExpenseCategoryFor(data, "Oct 2026" as never, k as never));
  is("City Manager, Marketing, Equipment for October are identical after the page builds", after, before);
  is("CONTROL — and they are real figures ($850, $146.92, $640)", before.map((v) => Math.round(v * 100) / 100), [850, 146.92, 640]);
  is("the Expenses rows themselves are untouched", JSON.stringify(EXP), snap);
}

console.log("\nTHE HEADER — Expenses draws its own month header, like OpEx");
{
  is("Expenses: no FINANCE title, no period bar", drawsOwnHeader("/admin/finance/ledger/expenses"), true);
  is("CONTROL — the Cost report keeps them", drawsOwnHeader("/admin/finance/cost"), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (pass === 0 || fail > 0) process.exit(1);
