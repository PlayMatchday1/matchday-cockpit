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
  /** Sales tax in this row, summed from each charge's own rounded tax by the database (fin_txn_sums,
   *  0214). Absent on a hand-built row, which then has its tax computed here the same way. */
  tax_cents?: number;
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

/** Round half away from zero — Postgres round(numeric), so a hand-built row and a database row agree. */
const roundAway = (x: number) => Math.sign(x) * Math.round(Math.abs(x));

/** Signed tax inside a row's gross, in cents. Zero for Venmo and for anything that is not money in.
 *  TAX IS PER CHARGE: Stripe charged price + round(price × rate) on every charge (all 5,451 in
 *  September 2026), so the tax in a charge is gross − round(gross ÷ (1 + rate)). A database row
 *  carries that sum already (tax_cents); a single hand-built row is computed the same way. */
export function taxCentsOf(r: Pick<RollupRow, "kind" | "source" | "city" | "gross_cents"> & { tax_cents?: number }): number {
  if (r.source !== "Stripe" || !MONEY.has(r.kind)) return 0;
  if (r.tax_cents != null) return r.tax_cents;
  const { rate } = taxRateOf(r.city);
  return rate === 0 ? 0 : r.gross_cents - roundAway(r.gross_cents / (1 + rate));
}

/** The rates the database needs to tax per charge (fin_txn_sums): salesTax.ts, passed as-is. */
export const RATES_FOR_SQL = { p_rates: CITY_TAX_RATE, p_default_rate: UNASSIGNED_TAX_RATE };

/** True for a row that is part of revenue at all (not a fee row, not test or internal). */
export const isRevenueRow = (r: RollupRow) => !r.excluded && MONEY.has(r.kind);

/* ── ONE BASIS FOR REFUNDS AND DISPUTES: NET OF THE TAX THAT CAME BACK WITH THEM (2026-10-07) ──
 * The calculation used to show a refund at its gross (tax included) and take the returned tax off
 * inside "Sales tax", while the city table showed the same refund net of tax: October read −$318 at
 * the top and −$293 in the table. Now every refund, failed payment and dispute on the page is net
 * of tax, and "Sales tax" is the tax on the month's charges. Net revenue is the same number either
 * way:  gross + Σ reversal gross − Σ all tax  =  gross + Σ reversal net − Σ tax on charges.
 *
 * DPP, MEMBERSHIP AND OTHER ARE AFTER THEIR OWN REFUNDS AND DISPUTES, so the three add up to net
 * revenue (Ryan, 2026-10-07). A reversal is taken off the line its charge was on, by the type it
 * inherited from that charge. The city and field tables keep the mock's separate "Refunds &
 * disputes" column, so their DPP and Membership cells are BEFORE reversals; GroupRow says which. */
export type Totals = {
  charges: number; chargesN: number;
  venmo: number; venmoN: number;
  refunds: number; refundsN: number;     // net of tax
  failed: number; failedN: number;       // net of tax
  disputes: number; disputesN: number;   // net of tax
  /** The same three at Stripe's amounts, tax included — what ties to the Stripe export. */
  refundsGross: number; failedGross: number; disputesGross: number;
  tax: number;            // NEGATIVE: the sales tax on this period's charges
  gross: number;          // charges + venmo
  net: number;
  fees: number;           // NEGATIVE
  kept: number;
  /** After their own refunds and disputes, net of tax. dpp + membership + other = net. */
  dpp: number; membership: number; other: number;
  /** All refunds, failed payments and disputes, net of tax (= refunds + failed + disputes). */
  reversals: number;
  missingRate: string[];
};

export const emptyTotals = (): Totals => ({
  charges: 0, chargesN: 0, venmo: 0, venmoN: 0, refunds: 0, refundsN: 0, failed: 0, failedN: 0,
  disputes: 0, disputesN: 0, refundsGross: 0, failedGross: 0, disputesGross: 0,
  tax: 0, gross: 0, net: 0, fees: 0, kept: 0,
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
    const net = r.gross_cents - tax;
    if (r.kind === "charge") { t.charges += r.gross_cents; t.chargesN += r.n; t.tax -= tax; }
    else if (r.kind === "manual") { t.venmo += r.gross_cents; t.venmoN += r.n; t.tax -= tax; }
    else if (r.kind === "refund") { t.refunds += net; t.refundsGross += r.gross_cents; t.refundsN += r.n; }
    else if (r.kind === "failed") { t.failed += net; t.failedGross += r.gross_cents; t.failedN += r.n; }
    else if (r.kind === "dispute") { t.disputes += net; t.disputesGross += r.gross_cents; t.disputesN += r.n; }
    if (REVERSAL.has(r.kind)) t.reversals += net;
    t[bucketOf(r.type)] += net;
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

/** A city-month's member-spot shares: venue id → that venue's member spots ÷ the city's. */
export type MemberShares = (city: string, period: string) => { venueId: number; share: number }[] | null;

/** Split `cents` by `shares` (summing to ≤ 1) to the cent, largest remainder first. What the shares
 *  do not cover is returned as `rest`, so nothing is created or lost. */
export function splitCents(cents: number, shares: { venueId: number; share: number }[]): { parts: Map<number, number>; rest: number } {
  const parts = new Map<number, number>();
  const raw = shares.map((s) => ({ id: s.venueId, v: cents * s.share }));
  const covered = Math.round(raw.reduce((a, r) => a + r.v, 0));
  const fl = raw.map((r) => ({ id: r.id, n: Math.trunc(r.v), f: r.v - Math.trunc(r.v) }));
  let left = covered - fl.reduce((a, r) => a + r.n, 0);
  fl.sort((x, y) => Math.abs(y.f) - Math.abs(x.f));
  for (const r of fl) { if (left === 0) break; const step = Math.sign(left); r.n += step; left -= step; }
  for (const r of fl) if (r.n !== 0) parts.set(r.id, (parts.get(r.id) ?? 0) + r.n);
  return { parts, rest: cents - covered };
}

/** The key of the field a venue belongs to: name AND city. A field can span several venue rows
 *  (split-rate legs), and names repeat across cities ("Hattrick"). */
export const fieldKeyOf = (vid: number, venues: Map<number, { name: string; city: string | null }>, rowCity: string | null = null) => {
  const v = venues.get(vid);
  return `${v?.name ?? `Venue ${vid}`}|${v?.city ?? cityLabel(rowCity)}`;
};

/** MEMBERSHIP CREDITED TO FIELDS — the Cities page's rule (cityPnl.ts, "ALLOCATE membership onto
 *  the pitches"): a field gets the city's membership for the month × (the field's member spots that
 *  month ÷ the city's member spots that month). `memberShares` supplies those shares from the same
 *  helpers (venueMemberSpotsFor, cityTotalMemberSpotsFor), keyed by the row's Central month.
 *
 *  Each venue-less membership row (charge or reversal) is replaced by one row per field, with its
 *  gross AND its tax each split to the cent, plus a remainder row with no venue for whatever the
 *  shares do not cover (Unassigned members; a city-month with no member spots). Nothing is created
 *  or lost, and every later figure — the Field tab, and the page filtered to one field — is a sum
 *  of these same rows, so they agree to the cent. Split rows carry n = 0: a charge is not divisible,
 *  so the counts stay on the remainder row. */
export function allocateMembership(rows: RollupRow[], memberShares?: MemberShares): RollupRow[] {
  if (!memberShares) return rows;
  const out: RollupRow[] = [];
  for (const r of rows) {
    if (r.fin_venue_id != null || bucketOf(r.type) !== "membership" || !isRevenueRow(r) || cityLabel(r.city) === UNASSIGNED) { out.push(r); continue; }
    const shares = memberShares(cityLabel(r.city), `${r.period.slice(0, 7)}-01`);
    if (!shares || shares.length === 0) { out.push(r); continue; }
    const tax = taxCentsOf(r);
    const g = splitCents(r.gross_cents, shares), t = splitCents(tax, shares);
    for (const s of shares) {
      const gc = g.parts.get(s.venueId) ?? 0, tc = t.parts.get(s.venueId) ?? 0;
      if (gc === 0 && tc === 0) continue;
      out.push({ ...r, fin_venue_id: s.venueId, n: 0, gross_cents: gc, tax_cents: tc, fee_cents: 0 });
    }
    if (g.rest !== 0 || t.rest !== 0 || r.fee_cents !== 0) out.push({ ...r, gross_cents: g.rest, tax_cents: t.rest });
  }
  return out;
}

/** allocateMembership FOR DAY ROWS, rounded at the MONTH. Splitting each day's membership on its own
 *  rounds differently from splitting the month's total, so a field's chart drifted a few cents from
 *  its Field-tab row. Here each month group (the grouping a month row has) is split exactly as
 *  allocateMembership splits that month row, and each field's month amount is then spread over the
 *  group's days by the days' gross, to the cent. Summing any field's days gives its month figure. */
export function allocateMembershipDays(rows: RollupRow[], memberShares?: MemberShares): RollupRow[] {
  if (!memberShares) return rows;
  const out: RollupRow[] = [];
  const groups = new Map<string, RollupRow[]>();
  for (const r of rows) {
    if (r.fin_venue_id != null || bucketOf(r.type) !== "membership" || !isRevenueRow(r) || cityLabel(r.city) === UNASSIGNED) { out.push(r); continue; }
    const k = [r.period.slice(0, 7), r.kind, r.source, r.type, r.city, r.excluded].join("|");
    const g = groups.get(k) ?? []; g.push(r); groups.set(k, g);
  }
  for (const days of groups.values()) {
    const first = days[0];
    const shares = memberShares(cityLabel(first.city), `${first.period.slice(0, 7)}-01`);
    if (!shares || shares.length === 0) { out.push(...days); continue; }
    const G = days.reduce((a, r) => a + r.gross_cents, 0), T = days.reduce((a, r) => a + taxCentsOf(r), 0);
    const g = splitCents(G, shares), t = splitCents(T, shares);
    // Day weights: each day's share of the month's gross (all on the first day if it nets to 0).
    const w = G !== 0 ? days.map((r, i) => ({ venueId: i, share: r.gross_cents / G })) : days.map((_, i) => ({ venueId: i, share: i === 0 ? 1 : 0 }));
    const spread = (amount: number) => { const sp = splitCents(amount, w); const by = days.map((_, i) => sp.parts.get(i) ?? 0); by[0] += sp.rest; return by; };
    const targets: [number | null, number, number][] = [...shares.map((s) => [s.venueId, g.parts.get(s.venueId) ?? 0, t.parts.get(s.venueId) ?? 0] as [number, number, number]), [null, g.rest, t.rest]];
    for (const [vid, gc, tc] of targets) {
      if (gc === 0 && tc === 0 && vid != null) continue;
      const gd = spread(gc), td = spread(tc);
      days.forEach((r, i) => {
        if (gd[i] === 0 && td[i] === 0 && !(vid == null && r.n)) return;
        out.push({ ...r, fin_venue_id: vid, n: vid == null ? r.n : 0, gross_cents: gd[i], tax_cents: td[i], fee_cents: vid == null ? r.fee_cents : 0 });
      });
    }
  }
  return out;
}

/** BY FIELD (fin_venue), in cents. A field is the venue its Stripe field ID maps to, never a match
 *  name; membership is credited by allocateMembership. Only what cannot be placed stays in
 *  "Membership (no field)"; any other money with no field is "No field". */
export function byFieldRows(
  rows: RollupRow[],
  venues: Map<number, { name: string; city: string | null }>,
  memberShares?: MemberShares,
): GroupRow[] {
  const m = new Map<string, GroupRow>();
  for (const r of allocateMembership(rows, memberShares)) {
    if (!isRevenueRow(r)) continue;
    let key: string, label: string, city: string | null = null, vid: number | null = null;
    if (r.fin_venue_id != null) {
      const v = venues.get(r.fin_venue_id);
      key = `f${fieldKeyOf(r.fin_venue_id, venues, r.city)}`; label = v?.name ?? `Venue ${r.fin_venue_id}`;
      city = v?.city ?? cityLabel(r.city); vid = r.fin_venue_id;
    } else if (bucketOf(r.type) === "membership") { key = "membership"; label = NO_FIELD_MEMBERSHIP; }
    else { key = "nofield"; label = NO_FIELD_OTHER; }
    const g = m.get(key) ?? blankGroup(key, label, city, vid);
    addTo(g, r);
    m.set(key, g);
  }
  return [...m.values()].sort((a, b) =>
    (a.venueId == null ? 1 : 0) - (b.venueId == null ? 1 : 0) || b.net - a.net);
}

/* ── THE PAGE FILTER: ONE CITY, OR ONE FIELD ──────────────────────────────────────────────────
 * The rows the top card, the four-month table and the chart sum when a city or a field is chosen.
 * A city keeps that city's rows; a field keeps that field's rows after allocateMembership — the
 * very rows the Field tab groups — so "Austin" equals Austin's City row and "Austin · NEMP" equals
 * NEMP's Field row, to the cent. */
export type PageFilter = { city: string | null; field: string | null };   // field = fieldKeyOf(…)

export function filterRows(
  rows: RollupRow[],
  f: PageFilter,
  venues: Map<number, { name: string; city: string | null }>,
  memberShares?: MemberShares,
  /** Day rows: allocate at the month, so the days sum to the month figure (allocateMembershipDays). */
  days = false,
): RollupRow[] {
  if (f.field) {
    return (days ? allocateMembershipDays : allocateMembership)(rows, memberShares)
      .filter((r) => r.fin_venue_id != null && fieldKeyOf(r.fin_venue_id, venues, r.city) === f.field);
  }
  if (f.city) {
    // Stripe's fee rows carry no city and stay out: fees are a whole-business figure.
    return rows.filter((r) => r.kind !== "fee" && cityLabel(r.city) === f.city);
  }
  return rows;
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
