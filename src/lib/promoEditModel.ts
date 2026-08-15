// Promo Codes — the EDIT diff, and the three pairing rules (Phase 18d). Pure: no I/O, no React,
// no server-only, so the route, the screen and the node gate all import the SAME rules.
//
// THE BASELINE RULE, as everywhere else in this codebase: THE DIFF IS THE BODY. A field touched
// and returned to its original value is not a change. Clearing a box is not a change.
//
// THE THREE PAIRING RULES — and two of them CONTRADICT diff-only, which is exactly why they are
// here, named, and mutation-tested rather than left implicit in a component:
//
//   1. discountValue alone ⇒ ALSO send discountType.
//      The server reads the pair together (USD is cents, PERCENT is a bare number). Sending a
//      new value without the type invites it to be interpreted under the OLD type — $5 read as
//      5%, or 50% read as 50 cents.
//   2. either date changes ⇒ send BOTH dates.
//      Retool's DTO back-fills the untouched one. A window has two ends; moving one and omitting
//      the other is how you get an end before its start.
//   3. targetMatchType changes ⇒ DELETE the other scopes' keys.
//      The five scopes are mutually exclusive (TOTAL_USAGE lives in the same enum as SPECIFIC_*).
//      Leaving a stale matchIDs on a code that just became TIME_PERIOD sends two scopes at once.
//
// Rules 1 and 2 make the body BIGGER than the diff. Rule 3 makes it explicitly REMOVE keys. All
// three are copied from the Retool DTO (generateDtoToUpdatePromocode), which is the only
// description of this endpoint's expectations we have.
//
// WIRE FORMAT: USD discountValue is CENTS on the wire (×100 from dollars); PERCENT goes as-is.
// Dates are TRUE UTC instants — the OPPOSITE model to match startDate/endDate, which are local
// wall clock wearing a Z. NEVER share a helper with those; see promoTz.ts.

import type { DiscountType, TargetMatchType, TargetUserType } from "@/lib/promoModel";

// What the server holds now (the subset we can edit), in WIRE units: discountValue already cents
// for USD. This is what a detail GET returns.
export type PromoEditable = {
  code: string;
  startDateUtc: string;
  endDateUtc: string;
  discountType: DiscountType;
  discountValue: number;          // cents for USD, plain number for PERCENT
  numberOfUsesPerUser: number;
  targetUserType: TargetUserType;
  targetMatchType: TargetMatchType;
  matchTimePeriodStart: string | null;
  matchTimePeriodEnd: string | null;
  userIDs?: number[];
  matchIDs?: number[];
  fieldIDs?: number[];
};

// The keys the operator can move. Everything else on a promo is server-owned.
export const PROMO_EDITABLE_KEYS = [
  "code", "startDateUtc", "endDateUtc", "discountType", "discountValue",
  "numberOfUsesPerUser", "targetUserType", "targetMatchType",
  "matchTimePeriodStart", "matchTimePeriodEnd", "userIDs", "matchIDs", "fieldIDs",
] as const;
export type PromoEditableKey = (typeof PROMO_EDITABLE_KEYS)[number];

// Which extra keys each scope owns. Switching scope deletes every key owned by the others.
export const SCOPE_KEYS: Record<TargetMatchType, PromoEditableKey[]> = {
  ALL_MATCHES: [],
  TOTAL_USAGE: [],
  TIME_PERIOD: ["matchTimePeriodStart", "matchTimePeriodEnd"],
  SPECIFIC_FIELDS: ["fieldIDs"],
  SPECIFIC_MATCHES: ["matchIDs"],
};
const ALL_SCOPE_KEYS: PromoEditableKey[] = ["matchTimePeriodStart", "matchTimePeriodEnd", "fieldIDs", "matchIDs"];

const sameArray = (a?: number[], b?: number[]) => {
  const x = [...(a ?? [])].sort((m, n) => m - n), y = [...(b ?? [])].sort((m, n) => m - n);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

function differs(k: PromoEditableKey, before: PromoEditable, after: PromoEditable): boolean {
  if (k === "userIDs" || k === "matchIDs" || k === "fieldIDs") {
    return !sameArray(before[k] as number[] | undefined, after[k] as number[] | undefined);
  }
  return before[k] !== after[k];
}

export type PromoDiff = {
  /** the request body: changed keys, plus whatever the pairing rules pull in */
  body: Record<string, unknown>;
  /** keys present because they CHANGED */
  changed: PromoEditableKey[];
  /** keys present ONLY because a pairing rule required them (not themselves changed) */
  pairedIn: PromoEditableKey[];
  /** scope keys explicitly REMOVED because the scope changed (rule 3) */
  removed: PromoEditableKey[];
};

// Build the PATCH body. `after` is the pending state in WIRE units.
export function promoDiff(before: PromoEditable, after: PromoEditable): PromoDiff {
  const changed: PromoEditableKey[] = [];
  for (const k of PROMO_EDITABLE_KEYS) {
    // scope-owned keys are handled by rule 3 below, not by plain diffing, so that a scope switch
    // cannot leave a stale one behind just because its value happens to be unchanged.
    if (ALL_SCOPE_KEYS.includes(k)) continue;
    if (differs(k, before, after)) changed.push(k);
  }
  // scope keys count as changed only while their OWNING scope is the active one
  for (const k of SCOPE_KEYS[after.targetMatchType]) {
    if (differs(k, before, after)) changed.push(k);
  }

  const body: Record<string, unknown> = {};
  for (const k of changed) body[k] = after[k];

  const pairedIn: PromoEditableKey[] = [];
  const removed: PromoEditableKey[] = [];

  // ── RULE 1 — discountValue implies discountType ──────────────────────────
  if (body.discountValue !== undefined && body.discountType === undefined) {
    body.discountType = after.discountType;
    pairedIn.push("discountType");
  }

  // ── RULE 2 — either date implies both ────────────────────────────────────
  const startMoved = body.startDateUtc !== undefined, endMoved = body.endDateUtc !== undefined;
  if (startMoved !== endMoved) {
    if (!startMoved) { body.startDateUtc = after.startDateUtc; pairedIn.push("startDateUtc"); }
    if (!endMoved) { body.endDateUtc = after.endDateUtc; pairedIn.push("endDateUtc"); }
  }

  // ── RULE 3 — switching scope deletes the other scopes' keys ──────────────
  if (before.targetMatchType !== after.targetMatchType) {
    const keep = new Set<PromoEditableKey>(SCOPE_KEYS[after.targetMatchType]);
    for (const k of ALL_SCOPE_KEYS) {
      if (keep.has(k)) continue;
      // Only announce a removal for a key the code ACTUALLY carried — deleting a key that was
      // never set is not a change and should not be reported to the operator as one.
      const had = k === "fieldIDs" || k === "matchIDs"
        ? ((before[k] as number[] | undefined)?.length ?? 0) > 0
        : before[k] != null;
      if (!had) continue;
      body[k] = null;   // explicit null = "unset this", not "leave it alone"
      removed.push(k);
    }
    // the new scope's own keys must be present when it needs them
    for (const k of SCOPE_KEYS[after.targetMatchType]) {
      if (body[k] === undefined && after[k] != null) { body[k] = after[k]; pairedIn.push(k); }
    }
  }

  return { body, changed, pairedIn, removed };
}

// ── READ-BACK: what actually landed, per field ───────────────────────────────
// A 2xx is not proof. IGNORED-AFTER-REDEMPTION is UNKNOWN for this endpoint — the DTO has no
// branch on usageCount — so rather than pre-emptively disabling fields, every sent key is
// compared against the re-read and reported individually. A silently-ignored field becomes
// visible the FIRST time it happens instead of being discovered months later.
export type FieldOutcome = { key: string; sent: unknown; got: unknown; landed: boolean };

export function verifyPromoWrite(sent: Record<string, unknown>, after: Record<string, unknown>): {
  fields: FieldOutcome[]; notApplied: string[]; outcome: "landed" | "notapplied";
} {
  const fields: FieldOutcome[] = [];
  for (const [key, want] of Object.entries(sent)) {
    const got = after[key];
    let landed: boolean;
    if (want === null) {
      // rule-3 removals: null, undefined, or an empty array all count as unset
      landed = got == null || (Array.isArray(got) && got.length === 0);
    } else if (Array.isArray(want)) {
      landed = sameArray(want as number[], Array.isArray(got) ? (got as number[]) : []);
    } else {
      landed = got === want;
    }
    fields.push({ key, sent: want, got: got ?? null, landed });
  }
  const notApplied = fields.filter((f) => !f.landed).map((f) => f.key);
  return { fields, notApplied, outcome: notApplied.length === 0 ? "landed" : "notapplied" };
}

// ── The consequence line shown BEFORE the click ──────────────────────────────
// It must describe the PENDING change, not the code in general — an operator who reads
// "this changes the cap" while the dates are what moved has been told nothing useful.
export function consequenceLine(d: PromoDiff, before: PromoEditable, after: PromoEditable): string {
  const bits: string[] = [];
  if (d.body.code !== undefined) bits.push(`the code players type becomes ${after.code}`);
  if (d.body.discountValue !== undefined || d.changed.includes("discountType")) {
    bits.push(`the discount becomes ${after.discountType === "USD" ? `$${(after.discountValue / 100).toFixed(2)}` : `${after.discountValue}%`}`);
  }
  if (d.body.startDateUtc !== undefined || d.body.endDateUtc !== undefined) bits.push("the window when it works moves");
  if (d.body.numberOfUsesPerUser !== undefined) {
    // The cap is ADVISORY — measured at 8.6% exceeded — so say so exactly when the cap is what
    // is changing, and not otherwise.
    const total = after.targetMatchType === "TOTAL_USAGE";
    bits.push(`the ${total ? "total" : "per-player"} cap becomes ${after.numberOfUsesPerUser} — the cap is advisory, the server does not hard-stop at it`);
  }
  if (d.body.targetUserType !== undefined) bits.push(`who can use it becomes ${after.targetUserType.replace(/_/g, " ").toLowerCase()}`);
  if (d.body.targetMatchType !== undefined) {
    bits.push(`what it applies to becomes ${after.targetMatchType.replace(/_/g, " ").toLowerCase()}`);
    if (d.removed.length) bits.push(`the previous scope's ${d.removed.join(" and ")} are cleared`);
  }
  if (!bits.length) return "";
  return `On save: ${bits.join("; ")}.`;
}

export const DELETE_CONSEQUENCE =
  "The code stops working for new redemptions. Redemptions already taken are unaffected. This is a soft delete — it can be restored.";
