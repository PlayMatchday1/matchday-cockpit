// Promo Codes — the pure model (Phase 18b). No I/O, no React, no server-only: importable by
// the route, the page, and the node test alike. Every rule the screen depends on lives here so
// a test can pin it without a browser. Dates are TRUE UTC (see promoTz.ts); state comparisons
// use lexicographic ISO-Z compare, which is chronological for this fixed format.

export type DiscountType = "PERCENT" | "USD";
export type TargetUserType = "ALL_USERS" | "NEW_USERS" | "CHURN_USERS" | "SPECIFIC_USERS";
// FIVE values — TOTAL_USAGE lives in the SAME enum as SPECIFIC_*, so a code is total-capped OR
// scoped to specific matches/fields, never both (proven against the create DTO).
export type TargetMatchType = "ALL_MATCHES" | "TOTAL_USAGE" | "TIME_PERIOD" | "SPECIFIC_FIELDS" | "SPECIFIC_MATCHES";
export type PromoState = "active" | "scheduled" | "expired" | "deleted";

// The list-row shape (proven raw payload — usageCount is NOT here, it is detail-only).
export type PromoRow = {
  id: number;
  code: string;
  startDateUtc: string;
  endDateUtc: string;
  discountType: DiscountType;
  discountValue: number;
  targetUserType: TargetUserType;
  numberOfUsesPerUser: number;
  targetMatchType: TargetMatchType;
  matchTimePeriodStart: string | null;
  matchTimePeriodEnd: string | null;
  createdAt: string;
  updatedAt?: string;
  deletedAt: string | null;
};

export const UNCAPPED = 10000; // the "no limit" sentinel operators have typed for years

// STATE is DERIVED, never stored: deleted wins; else start in the future = scheduled; else end
// in the past = expired; else active. `nowIso` is a true-UTC instant string.
export function promoState(p: Pick<PromoRow, "startDateUtc" | "endDateUtc" | "deletedAt">, nowIso: string): PromoState {
  if (p.deletedAt) return "deleted";
  if (p.startDateUtc > nowIso) return "scheduled";
  if (p.endDateUtc < nowIso) return "expired";
  return "active";
}

// Which server table a row belongs to. The server splits by end date (endDateMin/endDateMax),
// so LIVE = end in the future/now, PAST = end already gone. A deleted code with a future end
// date therefore lands in LIVE — intended; it is shown there, badged and struck.
export function promoBucket(p: Pick<PromoRow, "endDateUtc">, nowIso: string): "live" | "past" {
  return p.endDateUtc >= nowIso ? "live" : "past";
}

// DISCOUNT label. PERCENT is a whole number; USD is stored in CENTS.
export function discountLabel(p: Pick<PromoRow, "discountType" | "discountValue">): string {
  return p.discountType === "USD" ? "$" + (p.discountValue / 100).toFixed(2) : `${p.discountValue}%`;
}

// CAP (on the list — numberOfUsesPerUser is on the row). The 10000 sentinel prints "no cap",
// never the number, so nobody treats it as a meaningful limit.
export function capLabel(p: Pick<PromoRow, "numberOfUsesPerUser">): string {
  return p.numberOfUsesPerUser >= UNCAPPED ? "no cap" : p.numberOfUsesPerUser.toLocaleString();
}

// LEFT (detail only — needs usageCount). Driven by targetMatchType, not inferred:
//   >= 10000                -> "—"        (no cap; there is no remaining to show)
//   targetMatchType TOTAL   -> a TOTAL cap: cap − redeemed, clamped at 0 so it is NEVER negative
//   anything else           -> "per user" (a per-user cap has no single global remaining)
// A negative number anywhere is a failure — this function never produces one.
export function leftLabel(p: Pick<PromoRow, "numberOfUsesPerUser" | "targetMatchType">, usageCount: number): string {
  if (p.numberOfUsesPerUser >= UNCAPPED) return "—";
  if (p.targetMatchType === "TOTAL_USAGE") return Math.max(0, p.numberOfUsesPerUser - usageCount).toLocaleString();
  return "per user";
}

// One-line usage summary for the detail view / mobile card (Phase 18a §9a). Reads honestly in
// all three cap shapes without ever printing a negative or a bare 10000.
export function usageLine(p: Pick<PromoRow, "numberOfUsesPerUser" | "targetMatchType">, usageCount: number): string {
  const redeemed = usageCount.toLocaleString();
  if (p.numberOfUsesPerUser >= UNCAPPED) return `${redeemed} redeemed · no cap`;
  if (p.targetMatchType === "TOTAL_USAGE") return `${redeemed} redeemed · ${Math.max(0, p.numberOfUsesPerUser - usageCount).toLocaleString()} left of ${p.numberOfUsesPerUser.toLocaleString()}`;
  return `${redeemed} redeemed · cap ${p.numberOfUsesPerUser.toLocaleString()} per user`;
}

// ── display maps for audience / which-matches ──
export const USER_TYPE_LABEL: Record<TargetUserType, string> = {
  ALL_USERS: "All Users", NEW_USERS: "New Users", CHURN_USERS: "Churn Users", SPECIFIC_USERS: "Specific Users",
};
export const MATCH_TYPE_LABEL: Record<TargetMatchType, string> = {
  ALL_MATCHES: "All Matches", TOTAL_USAGE: "All Matches (total cap)", TIME_PERIOD: "Promo Time Period",
  SPECIFIC_FIELDS: "Specific Fields", SPECIFIC_MATCHES: "Specific Matches",
};
export const USER_TYPES: TargetUserType[] = ["ALL_USERS", "NEW_USERS", "CHURN_USERS", "SPECIFIC_USERS"];
export const MATCH_TYPES: TargetMatchType[] = ["ALL_MATCHES", "TOTAL_USAGE", "TIME_PERIOD", "SPECIFIC_FIELDS", "SPECIFIC_MATCHES"];

// Plain-English one-liner for the create form summary. `startIso`/`endIso` are UTC; the caller
// renders the Chicago times via promoTz and passes them in already-formatted.
export function createSummary(args: {
  code: string; discountType: DiscountType; value: number; who: TargetUserType; which: TargetMatchType;
  uses: number; startLabel: string; endLabel: string; tzName: string;
}): string {
  const amt = args.discountType === "USD" ? `$${(args.value / 100).toFixed(2)} off` : `${args.value}% off`;
  const who = { ALL_USERS: "anyone", NEW_USERS: "new players", CHURN_USERS: "churned players", SPECIFIC_USERS: "specific players" }[args.who];
  const which = {
    ALL_MATCHES: "any match", TOTAL_USAGE: "any match, capped in total",
    TIME_PERIOD: "matches inside the promo window", SPECIFIC_FIELDS: "matches on selected fields", SPECIFIC_MATCHES: "selected matches",
  }[args.which];
  const capPhrase = args.which === "TOTAL_USAGE"
    ? `${args.uses.toLocaleString()} uses in total`
    : args.uses === 1 ? "once each" : `${args.uses.toLocaleString()} times each`;
  return `Code ${args.code} gives ${amt} on ${which} to ${who}, ${capPhrase}, from ${args.startLabel} to ${args.endLabel} ${args.tzName} time.`;
}
