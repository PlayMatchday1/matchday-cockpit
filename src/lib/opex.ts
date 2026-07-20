// OpEx Calendar formatting helpers.
//
// The calendar now derives every line from fin_expenses (see
// src/lib/opexSources.ts) — City Manager / Match Manager Pay, Field Costs,
// and one group per remaining fin_expenses category. The old
// fin_opex_entries model + recurrence expansion that used to live here were
// retired when "+ Add expense" moved to the Expenses tab; only these
// display helpers remain.

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
