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
//   >= 10000                -> "—"          (no cap; there is no remaining to show)
//   TOTAL_USAGE, usage<=cap -> cap − redeemed (a real remaining)
//   TOTAL_USAGE, usage>cap  -> "over by N"   (18c item 4: the cap IS a total, so redemptions
//                             beyond it means the server over-redeemed — a finding, not a 0 to
//                             hide. "over by N" is not a negative number, so the rule holds.)
//   anything else           -> "per user"   (a per-user cap has no single global remaining)
export function leftLabel(p: Pick<PromoRow, "numberOfUsesPerUser" | "targetMatchType">, usageCount: number): string {
  if (p.numberOfUsesPerUser >= UNCAPPED) return "—";
  if (p.targetMatchType === "TOTAL_USAGE") {
    const left = p.numberOfUsesPerUser - usageCount;
    return left < 0 ? `over by ${(-left).toLocaleString()}` : left.toLocaleString();
  }
  return "per user";
}

// Colour hint for LEFT: "over" (warning — over-redeemed), "spent" (exactly 0 left), else "normal".
export function leftTone(p: Pick<PromoRow, "numberOfUsesPerUser" | "targetMatchType">, usageCount: number): "normal" | "spent" | "over" {
  if (p.numberOfUsesPerUser >= UNCAPPED) return "normal";
  if (p.targetMatchType === "TOTAL_USAGE") {
    const left = p.numberOfUsesPerUser - usageCount;
    return left < 0 ? "over" : left === 0 ? "spent" : "normal";
  }
  return "normal";
}

// One-line usage summary for the detail view / mobile card (Phase 18a §9a). Reads honestly in
// all cap shapes, surfacing over-redemption rather than rounding it away.
export function usageLine(p: Pick<PromoRow, "numberOfUsesPerUser" | "targetMatchType">, usageCount: number): string {
  const redeemed = usageCount.toLocaleString();
  if (p.numberOfUsesPerUser >= UNCAPPED) return `${redeemed} redeemed · no cap`;
  if (p.targetMatchType === "TOTAL_USAGE") {
    const left = p.numberOfUsesPerUser - usageCount;
    return left < 0
      ? `${redeemed} redeemed · ${(-left).toLocaleString()} OVER the total cap of ${p.numberOfUsesPerUser.toLocaleString()}`
      : `${redeemed} redeemed · ${left.toLocaleString()} left of ${p.numberOfUsesPerUser.toLocaleString()}`;
  }
  return `${redeemed} redeemed · cap ${p.numberOfUsesPerUser.toLocaleString()} per user`;
}

// The duplicate-check verdict (18c item 1). ?code= is a SUBSTRING filter that PAGES, so an exact
// code can sit beyond the fetched rows. Never say "free" unless the COMPLETE result set was seen.
//   taken        an exact (case-insensitive) match is among the fetched rows.
//   inconclusive no exact match fetched, but totalItems > rows — the real one MAY be unseen.
//   free         no exact match AND the whole set was fetched (totalItems <= rows).
// The classic failure this prevents: ?code=MA has 94 matches but the default page is 20 and the
// literal code "MA" is not in it — scanning that page alone would call a TAKEN name FREE.
export function dupeVerdict(rows: { code: string }[], totalItems: number, code: string): "taken" | "free" | "inconclusive" {
  const lc = code.trim().toLowerCase();
  if (rows.some((r) => r.code.toLowerCase() === lc)) return "taken";
  if (totalItems > rows.length) return "inconclusive";
  return "free";
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
// Name up to `n` items, then "+K more" — for the plain-English summary (Phase 20 D2).
export function nameList(items: string[], n = 3): string {
  if (items.length === 0) return "";
  if (items.length <= n) return items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  return `${items.slice(0, n).join(", ")} +${items.length - n} more`;
}

export function createSummary(args: {
  code: string; discountType: DiscountType; value: number; who: TargetUserType; which: TargetMatchType;
  uses: number; startLabel: string; endLabel: string; tzName: string;
  userNames?: string[]; matchPeriod?: { start: string; end: string }; matchCount?: number; fieldCount?: number;
}): string {
  const amt = args.discountType === "USD" ? `$${(args.value / 100).toFixed(2)} off` : `${args.value}% off`;
  const who = args.who === "SPECIFIC_USERS"
    ? (args.userNames && args.userNames.length ? nameList(args.userNames) : "selected players")
    : { ALL_USERS: "anyone", NEW_USERS: "new players", CHURN_USERS: "churned players", SPECIFIC_USERS: "selected players" }[args.who];
  // each scope phrase carries its own preposition — "off matches kicking off between…" reads
  // wrong with a leading "on", while "off on any match" needs it.
  const which = args.which === "TIME_PERIOD" && args.matchPeriod
      ? `matches kicking off between ${args.matchPeriod.start} and ${args.matchPeriod.end}`
    : args.which === "SPECIFIC_MATCHES" ? `on ${(args.matchCount ?? 0).toLocaleString()} selected match${args.matchCount === 1 ? "" : "es"}`
    : args.which === "SPECIFIC_FIELDS" ? `on matches at ${(args.fieldCount ?? 0).toLocaleString()} selected field${args.fieldCount === 1 ? "" : "s"}`
    : args.which === "TOTAL_USAGE" ? "on any match, capped in total"
    : "on any match";
  const capPhrase = args.which === "TOTAL_USAGE"
    ? `${args.uses.toLocaleString()} uses in total`
    : args.uses === 1 ? "once each" : `${args.uses.toLocaleString()} times each`;
  return `Code ${args.code} gives ${amt} ${which} to ${who}, ${capPhrase}, redeemable from ${args.startLabel} to ${args.endLabel} ${args.tzName}.`;
}
