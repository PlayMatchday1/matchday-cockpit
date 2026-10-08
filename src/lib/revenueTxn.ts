/* REVENUE FROM fin_txn — the one derivation behind every figure on Finance › Revenue.
 *
 * Ryan's definitions, 2026-10-07 (settled; do not re-derive them here):
 *   - Days and months are Central time. The database does the bucketing (fin_txn_rollup, 0213).
 *   - Gross collected = successful Stripe charges + manual Venmo rows.
 *   - Net revenue = gross collected minus refunds, failed payments, disputes and sales tax.
 *   - Refunds, failed payments and disputes count in the month THEY happen, by their own date.
 *   - Stripe fees are not taken out of revenue; they show under net, then "Kept after fees".
 *     They include dispute fees and Stripe's other fee rows.
 *   - Sales tax from each city's rate in salesTax.ts.
 *   - Members with no city show as "Unassigned", so cities always add up to the total.
 *   - Test and internal rows are excluded.
 *
 * ── SALES TAX IS ROUNDED ONCE, PER ROLLUP ROW, IN CENTS ─────────────────────────────────────────
 * Every figure here is a sum of the same integer per-row amounts, so the calculation, the line
 * items, the city table and the field table all add to the net figure EXACTLY, whatever way they
 * are grouped. Rounding each total separately would leave them a cent apart.
 *
 *   tax on a row   = round(gross − gross ÷ (1 + rate))       signed like the row: a refund returns tax
 *   row, net       = gross − tax
 *
 * Venmo rows carry no tax: they are paid outside Stripe, and Stripe is what adds the tax.
 *
 * ── TWO RATES THIS FILE HAS TO CHOOSE ───────────────────────────────────────────────────────────
 * UNASSIGNED ("Deleted Account Revenue", or no city) has no rate of its own. It is taxed at the
 * Texas rate, 8.25%: five of the seven markets are Texas and it is the rate most members paid. The
 * Unassigned row's info says so.
 * A REAL CITY WITH NO RATE (a new market not yet in CITY_TAX_RATE) is taxed at 0 AND NAMED on the
 * page (`missingRate`), never silently. salesTax.ts throws for this case; a page that throws shows
 * no revenue at all, so the refusal is turned into a visible warning instead. */
import { CITY_TAX_RATE, hasTaxRate } from "./salesTax";

export type RollupRow = {
  period: string;            // YYYY-MM-DD, a Central day or the first of a Central month
  kind: "charge" | "refund" | "failed" | "dispute" | "fee" | "manual";
  source: string;            // Stripe | Venmo
  type: string;              // DPP | Membership | Private Rental | Strike | Unclassified
  city: string | null;
  fin_venue_id: number | null;
  excluded: boolean;
  n: number;
  gross_cents: number;
  fee_cents: number;
};

export const UNASSIGNED = "Unassigned";
export const UNASSIGNED_STORED = "Deleted Account Revenue";
export const UNASSIGNED_TAX_RATE = CITY_TAX_RATE.Austin; // 8.25%, see the header

/** The city a row is shown under. */
export const cityLabel = (c: string | null | undefined): string =>
  c == null || c.trim() === "" || c === UNASSIGNED_STORED ? UNASSIGNED : c;

export type Bucket = "dpp" | "membership" | "other";
/** DPP includes strike fees (the mock's DPP definition: "single match bookings and strike fees"). */
export const bucketOf = (type: string): Bucket =>
  type === "DPP" || type === "Strike" ? "dpp" : type === "Membership" ? "membership" : "other";

const REVERSAL = new Set(["refund", "failed", "dispute"]);
const MONEY = new Set(["charge", "refund", "failed", "dispute", "manual"]);

export function taxRateOf(city: string | null): { rate: number; missing: string | null } {
  const c = cityLabel(city);
  if (c === UNASSIGNED) return { rate: UNASSIGNED_TAX_RATE, missing: null };
  if (hasTaxRate(c)) return { rate: CITY_TAX_RATE[c], missing: null };
  return { rate: 0, missing: c };
}

/** Signed tax inside a row's gross, in cents. Zero for Venmo and for anything that is not money in. */
export function taxCentsOf(r: Pick<RollupRow, "kind" | "source" | "city" | "gross_cents">): number {
  if (r.source !== "Stripe" || !MONEY.has(r.kind)) return 0;
  const { rate } = taxRateOf(r.city);
  return rate === 0 ? 0 : Math.round(r.gross_cents - r.gross_cents / (1 + rate));
}

/** True for a row that is part of revenue at all (not a fee row, not test or internal). */
export const isRevenueRow = (r: RollupRow) => !r.excluded && MONEY.has(r.kind);

export type Totals = {
  charges: number; chargesN: number;
  venmo: number; venmoN: number;
  refunds: number; refundsN: number;
  failed: number; failedN: number;
  disputes: number; disputesN: number;
  tax: number;            // NEGATIVE: what comes off gross
  gross: number;          // charges + venmo
  net: number;
  fees: number;           // NEGATIVE
  kept: number;
  dpp: number; membership: number; other: number; reversals: number;  // net of tax; sum to net
  missingRate: string[];
};

export const emptyTotals = (): Totals => ({
  charges: 0, chargesN: 0, venmo: 0, venmoN: 0, refunds: 0, refundsN: 0, failed: 0, failedN: 0,
  disputes: 0, disputesN: 0, tax: 0, gross: 0, net: 0, fees: 0, kept: 0,
  dpp: 0, membership: 0, other: 0, reversals: 0, missingRate: [],
});

/** Every figure in the headline and the line items, in CENTS. */
export function totalsOf(rows: RollupRow[]): Totals {
  const t = emptyTotals();
  const missing = new Set<string>();
  for (const r of rows) {
    // STRIPE FEES: every fee Stripe took, on any row, plus its own fee rows (dispute fees, billing).
    // Test and internal rows still cost a fee, so they are not filtered out of this one figure.
    if (r.source === "Stripe") t.fees += r.kind === "fee" ? r.gross_cents : -r.fee_cents;
    if (!isRevenueRow(r)) continue;
    const tax = taxCentsOf(r);
    const m = taxRateOf(r.city).missing;
    if (m && r.source === "Stripe") missing.add(m);
    t.tax -= tax;
    const net = r.gross_cents - tax;
    if (r.kind === "charge") { t.charges += r.gross_cents; t.chargesN += r.n; }
    else if (r.kind === "manual") { t.venmo += r.gross_cents; t.venmoN += r.n; }
    else if (r.kind === "refund") { t.refunds += r.gross_cents; t.refundsN += r.n; }
    else if (r.kind === "failed") { t.failed += r.gross_cents; t.failedN += r.n; }
    else if (r.kind === "dispute") { t.disputes += r.gross_cents; t.disputesN += r.n; }
    if (REVERSAL.has(r.kind)) t.reversals += net;
    else t[bucketOf(r.type)] += net;
  }
  t.gross = t.charges + t.venmo;
  t.net = t.gross + t.refunds + t.failed + t.disputes + t.tax;
  t.kept = t.net + t.fees;
  t.missingRate = [...missing].sort();
  return t;
}

export type GroupRow = {
  key: string;
  label: string;
  city: string | null;
  venueId: number | null;
  dpp: number; membership: number; other: number; reversals: number; net: number;
  /** What `other` is made of, by type, for the row's info. */
  otherByType: Record<string, number>;
};

function blankGroup(key: string, label: string, city: string | null, venueId: number | null): GroupRow {
  return { key, label, city, venueId, dpp: 0, membership: 0, other: 0, reversals: 0, net: 0, otherByType: {} };
}

function addTo(g: GroupRow, r: RollupRow) {
  const net = r.gross_cents - taxCentsOf(r);
  if (REVERSAL.has(r.kind)) g.reversals += net;
  else {
    const b = bucketOf(r.type);
    g[b] += net;
    if (b === "other") {
      const k = r.source === "Venmo" ? `${r.type} (Venmo)` : r.type;
      g.otherByType[k] = (g.otherByType[k] ?? 0) + net;
    }
  }
  g.net += net;
}

/** BY CITY, in cents. Unassigned last; every revenue row lands in exactly one row. */
export function byCityRows(rows: RollupRow[]): GroupRow[] {
  const m = new Map<string, GroupRow>();
  for (const r of rows) {
    if (!isRevenueRow(r)) continue;
    const c = cityLabel(r.city);
    const g = m.get(c) ?? blankGroup(c, c, c === UNASSIGNED ? null : c, null);
    addTo(g, r);
    m.set(c, g);
  }
  return [...m.values()].sort((a, b) =>
    (a.label === UNASSIGNED ? 1 : 0) - (b.label === UNASSIGNED ? 1 : 0) || b.net - a.net);
}

export const NO_FIELD_MEMBERSHIP = "Membership (no field)";
export const NO_FIELD_OTHER = "No field";

/** BY FIELD (fin_venue), in cents. A field is the venue its Stripe field ID maps to, never a match
 *  name. Money with no field — membership, and anything else without one — gets its own rows, so
 *  the table still adds up to net revenue. */
export function byFieldRows(
  rows: RollupRow[],
  venues: Map<number, { name: string; city: string | null }>,
): GroupRow[] {
  const m = new Map<string, GroupRow>();
  for (const r of rows) {
    if (!isRevenueRow(r)) continue;
    let key: string, label: string, city: string | null, vid: number | null = null;
    if (r.fin_venue_id != null) {
      // ONE ROW PER FIELD, NOT PER fin_venues ROW. A field can span several venue rows (split-rate
      // legs), so the key is the name AND the city — names repeat across cities ("Hattrick").
      const v = venues.get(r.fin_venue_id);
      label = v?.name ?? `Venue ${r.fin_venue_id}`; city = v?.city ?? cityLabel(r.city);
      key = `f${label}|${city}`;
      vid = r.fin_venue_id;
    } else if (bucketOf(r.type) === "membership") {
      key = "membership"; label = NO_FIELD_MEMBERSHIP; city = null;
    } else {
      key = "nofield"; label = NO_FIELD_OTHER; city = null;
    }
    const g = m.get(key) ?? blankGroup(key, label, city, vid);
    addTo(g, r);
    m.set(key, g);
  }
  return [...m.values()].sort((a, b) =>
    (a.venueId == null ? 1 : 0) - (b.venueId == null ? 1 : 0) || b.net - a.net);
}

/** Net cents per period key for a filtered row set — the pace chart's series. */
export function netByPeriod(
  rows: RollupRow[],
  keep: (r: RollupRow) => boolean,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!isRevenueRow(r) || !keep(r)) continue;
    out.set(r.period, (out.get(r.period) ?? 0) + r.gross_cents - taxCentsOf(r));
  }
  return out;
}

// ── MONTH STATUS ─────────────────────────────────────────────────────────────────────────────────
/* "Updating" until Stripe's data for the month's last day has synced, then "Final". Stripe makes a
 * day's payments available by about noon the next day, so the month is final once a successful
 * stripe-txn sync has COMPLETED after midnight Central on the 2nd of the next month — the mock's
 * "final by Oct 2". A row added or changed after that instant (fin_txn.updated_at, which is stamped
 * only for an amount or an exclusion change, or a late insert) makes it "Adjusted after final". */
export type MonthStatus =
  | { k: "updating"; finalBy: string }
  | { k: "final"; finalAt: string }
  | { k: "adjusted"; finalAt: string; cents: number; n: number };

/** The instant a month can become final: 00:00 Central on the 2nd of the following month. */
export function finalThreshold(year: number, month1: number, toUtcMs: (y: number, m: number, d: number) => number): number {
  const ny = month1 === 12 ? year + 1 : year, nm = month1 === 12 ? 1 : month1 + 1;
  return toUtcMs(ny, nm, 2);
}

/** True once the Central month holding `iso` has passed its final threshold — a row INSERTED then is
 *  "added after final" and is stamped (finTxnSync, finTxnVenmo), the same as an amount change. */
export function isAfterFinal(iso: string, nowMs: number, toUtcMs: (y: number, m: number, d: number) => number): boolean {
  const [y, m] = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" })
    .format(new Date(iso)).split("-").map(Number);
  return nowMs > finalThreshold(y, m, toUtcMs);
}

export function monthStatus(
  threshold: number,
  lastSyncMs: number | null,
  adjustments: { updatedMs: number; cents: number }[],
  finalByLabel: string,
): MonthStatus {
  if (lastSyncMs == null || lastSyncMs < threshold) return { k: "updating", finalBy: finalByLabel };
  const late = adjustments.filter((a) => a.updatedMs > threshold);
  const at = new Date(threshold).toISOString();
  if (late.length === 0) return { k: "final", finalAt: at };
  return { k: "adjusted", finalAt: at, cents: late.reduce((a, x) => a + x.cents, 0), n: late.length };
}

// ── FORMATTING ───────────────────────────────────────────────────────────────────────────────────
/** "−$1,234" / "$1,234.56". A true minus sign, as the mock prints it. */
export function money(cents: number, withCents = false): string {
  const v = cents / 100;
  const s = Math.abs(v).toLocaleString("en-US", withCents
    ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : { maximumFractionDigits: 0 });
  return `${v < 0 && (withCents ? Math.abs(cents) >= 1 : Math.abs(v) >= 0.5) ? "−" : ""}$${s}`;
}
