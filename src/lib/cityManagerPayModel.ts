// Phase 25 Part B — the pure money model behind the city-manager sheet.
//
// Extracted so the sentence an operator reads BEFORE clicking ("$30 moves from Rooby to Lemmy,
// Rooby's total becomes $20, Lemmy's becomes $60") is a tested function and not string-building
// buried in a component. A reassignment is a payroll change; it should be assertable.
//
// The fee is NEVER a constant here — callers pass payAmount(maxPlayerCount, coManaged) from
// managerPayCompute, which is the same function that computes the payroll itself. 37% of matches
// are tournaments at $30, so a hardcoded $20 would be wrong most days.

export type ReassignInput = {
  fee: number;                 // what this match pays, from payAmount()
  fromName: string | null;     // who is on it now (null = unassigned)
  toName: string | null;       // who is being staged (null = removing)
  fromTotal: number;           // that person's current week total
  toTotal: number;             // ditto
  cityTotal: number;           // the city's current week total
};

export type ReassignImpact = {
  kind: "move" | "fill" | "remove" | "none";
  text: string;
  // the numbers the sentence quotes, exposed so a test asserts the MATH, not the prose
  fromTotalAfter: number | null;
  toTotalAfter: number | null;
  cityTotalAfter: number;
};

const money = (n: number) => `$${(Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export function reassignImpact(i: ReassignInput): ReassignImpact {
  const { fee, fromName, toName, fromTotal, toTotal, cityTotal } = i;

  // MOVE — the money changes hands. The city total does NOT change: the match still pays once.
  if (fromName && toName) {
    return {
      kind: "move",
      text: `${money(fee)} moves from ${fromName} to ${toName}. ${fromName}'s total becomes ${money(fromTotal - fee)}, ${toName}'s becomes ${money(toTotal + fee)}.`,
      fromTotalAfter: fromTotal - fee,
      toTotalAfter: toTotal + fee,
      cityTotalAfter: cityTotal, // unchanged, on purpose
    };
  }
  // FILL — a match that paid nobody now pays someone. The city total RISES by exactly one fee.
  if (!fromName && toName) {
    return {
      kind: "fill",
      text: `${toName} is paid ${money(fee)} for this match. Their total becomes ${money(toTotal + fee)} and the city total becomes ${money(cityTotal + fee)}.`,
      fromTotalAfter: null,
      toTotalAfter: toTotal + fee,
      cityTotalAfter: cityTotal + fee,
    };
  }
  // REMOVE — the match pays nobody. The city total FALLS by exactly one fee.
  if (fromName && !toName) {
    return {
      kind: "remove",
      text: `${fromName} loses ${money(fee)} and this match pays nobody. The city total becomes ${money(cityTotal - fee)}.`,
      fromTotalAfter: fromTotal - fee,
      toTotalAfter: null,
      cityTotalAfter: cityTotal - fee,
    };
  }
  return { kind: "none", text: "", fromTotalAfter: null, toTotalAfter: null, cityTotalAfter: cityTotal };
}

// The city total is the sum of its manager rows — the page must never print a total computed a
// different way from the rows above it.
export function cityTotalFromRows(rows: Array<{ total: number }>): number {
  return Math.round(rows.reduce((s, r) => s + (Number(r.total) || 0), 0) * 100) / 100;
}
