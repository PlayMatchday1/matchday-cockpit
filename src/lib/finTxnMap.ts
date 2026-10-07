/* STRIPE BALANCE TRANSACTION → fin_txn ROW. Pure, so it is testable without a network or a database.
 *
 * ── WHY THE BALANCE TRANSACTION AND NOT THE CHARGE ──────────────────────────────────────────────
 * fin_revenue is built from `charges.list`, which is why refunds, disputes, failed payments and
 * Stripe's fee rows have never existed in it: they are not charges. `balance_transactions.list`
 * returns every movement of money with a `reporting_category`, which is exactly the grain the
 * September export reconciles on — 5,451 charges, 4 refunds, 13 disputes, 1 failure, 638 fee rows.
 *
 * ── THE INSTANT IS STORED, THE MONTH IS NOT ─────────────────────────────────────────────────────
 * `created_at_utc` is Stripe's `created` as a true instant. No month label and no local date is
 * written. Every page derives the Central day at query time. The whole UTC/Central problem in
 * fin_revenue exists because a month string was stored at import and never questioned again.
 */

import type Stripe from "stripe";

/** fin_txn.kind. Stripe's reporting_category, narrowed, plus 'manual' for Venmo. */
export type TxnKind = "charge" | "refund" | "failed" | "dispute" | "fee" | "manual";

export type FinTxnRow = {
  created_at_utc: string;
  kind: TxnKind;
  gross_cents: number;
  fee_cents: number;
  net_cents: number;
  city: string | null;
  type: string | null;
  field_id: number | null;
  balance_txn_id: string;
  charge_id: string | null;
  payment_intent_id: string | null;
  subscription_id: string | null;
  invoice_id: string | null;
  source_id: string | null;
  is_test: boolean;
  is_internal: boolean;
  exclude_reason: string | null;
  source: string;
  description: string | null;
  dispute_reason: string | null;
};

/* STRIPE'S OWN CATEGORY NAMES, MAPPED. `charge_failure` is Stripe's name; ours is 'failed'. */
const CATEGORY: Record<string, TxnKind> = {
  charge: "charge",
  refund: "refund",
  charge_failure: "failed",
  dispute: "dispute",
  dispute_reversal: "dispute",
  refund_failure: "refund",
  fee: "fee",
};

/* ── TRANSFERS ARE NOT ACTIVITY, AND ARE SKIPPED ────────────────────────────────────────────────
 * A payout moves money that has ALREADY been counted as charges from the Stripe balance to the
 * bank. It is neither revenue nor cost, and storing it would understate every month by roughly its
 * own gross. Stripe's "Balance change from activity" export excludes these by design; the API's
 * balance_transactions.list includes them.
 *
 * MEASURED: September carried 21 payouts totalling -$86,274.96, and an earlier version of this file
 * swallowed every one of them into `fee` — 659 fee rows and -$86,851.17 against the export's 638
 * and -$576.21. That is what the fallback below used to do. */
const TRANSFER = new Set([
  "payout", "payout_cancel", "payout_failure",
  "transfer", "transfer_cancel", "transfer_failure",
  "topup",
]);

export const isTransferCategory = (category: string | null | undefined): boolean =>
  TRANSFER.has(String(category ?? ""));

/**
 * The kind for a category, or NULL when the row must not be stored.
 *
 * ── THERE IS NO FALLBACK BUCKET ANY MORE ────────────────────────────────────────────────────────
 * This returned `?? "fee"` on the reasoning that an unnamed movement is still money and dropping it
 * is how a reconciliation stops tying. The reasoning holds; the bucket was the mistake — it made
 * payouts look like fees and the September fee line wrong by $86,274.96, silently.
 *
 * An unrecognised category is now SKIPPED AND REPORTED: the sync collects it and raises an advisory
 * on the fin_sync_log row naming the category, the count and the total. Loud beats absorbed, and a
 * row nobody can classify is not a row to guess at.
 */
export function kindFromCategory(category: string | null | undefined): TxnKind | null {
  const c = String(category ?? "");
  if (TRANSFER.has(c)) return null;
  return CATEGORY[c] ?? null;
}

/* INTERNAL ACCOUNTS. The same regex membershipStats uses, so "internal" means one thing estate-wide.
 * EXCLUDED BY FLAG, NEVER BY DROPPING THE ROW — the row still has to be there for September to tie
 * to the Stripe export to the cent. Every page filters on the flag. */
export const INTERNAL_EMAIL_RX = /@matchday\.|@playmatchday\./i;

/* TEST MATCHES. Measured on September: zero charges match, and `TestPaidMatch` is one $0.54 row in
 * all of fin_revenue's history. The flag is here so the rule exists before it is needed, not
 * because it moves a number today. */
const TEST_NAME_RX = /\btest\b/i;

type Meta = Record<string, string | undefined>;

/**
 * One balance transaction plus the charge it hangs off (Stripe's `source`, expanded) → one row.
 *
 * `classify` and `cityOf` are injected rather than imported so this file stays free of the finance
 * importer's module graph, which pulls in a CSV parser the sync has no use for.
 */
export function mapBalanceTxn(
  bt: Stripe.BalanceTransaction,
  opts: {
    classify: (a: { stripeType: string | null; description: string | null; hasMatchId: boolean }) => string;
    /** The city, decided the way fin_revenue's stripeSync decides it (finTxnSync.allocateCity). */
    cityOf: (a: { type: string; cityIdentifier: string | null; matchId: string | null; email: string | null }) => string;
    /** The member's email when the charge itself carries none (an invoice charge: Stripe puts the
     *  email on the customer). Looked up by the sync before mapping. */
    customerEmail?: (customerId: string) => string | null;
    /** mdapi field id → fin_venues.id, from fin_venue_fields. */
    venueOfField: (fieldId: number) => number | null;
  },
): (FinTxnRow & { fin_venue_id: number | null }) | null {
  // A TRANSFER OR AN UNKNOWN CATEGORY IS NOT A ROW. The caller counts and reports it.
  const kind = kindFromCategory(bt.reporting_category);
  if (kind == null) return null;
  const src = bt.source as Stripe.Charge | Stripe.Refund | Stripe.Dispute | null;
  // THE CHARGE IS WHERE THE METADATA LIVES. A refund or dispute carries the charge it reverses, so
  // attribution flows from there — a refund inherits its charge's city, type and field.
  const charge: Stripe.Charge | null =
    src && (src as Stripe.Charge).object === "charge" ? (src as Stripe.Charge) : null;
  /* THE CHARGE A REVERSAL REVERSES. A refund (re_, pyr_) and a dispute (du_) carry it as `.charge`;
   * a failure's source IS the charge. Stored as charge_id so the sync can copy the charge row's city,
   * type and field onto the reversal — the reversal's own source has no metadata at all. */
  const reversed = src && ((src as Stripe.Refund).object === "refund" || (src as Stripe.Dispute).object === "dispute")
    ? (src as Stripe.Refund | Stripe.Dispute).charge : null;
  const reversedChargeId = reversed == null ? null : typeof reversed === "string" ? reversed : reversed.id;
  const meta = ((charge?.metadata ?? {}) as Meta);

  const stripeType = typeof meta.type === "string" && meta.type.trim() ? meta.type.trim() : null;
  // metadata.matchId, else userMatchId — stripeSync's rule (the same value on some charges).
  const matchId = (meta.matchId?.trim() || meta.userMatchId?.trim()) || null;
  const description = bt.description ?? charge?.description ?? null;
  const type = opts.classify({ stripeType, description, hasMatchId: matchId != null });
  /* THE EMAIL, IN stripeSync.extractEmail's ORDER: billing_details → receipt_email →
   * metadata.email → the customer's. Membership charges are invoice charges and usually carry only
   * the customer. Used for the membership city. */
  const chargeEmail = charge?.billing_details?.email ?? charge?.receipt_email ?? null;
  const customerId = charge && typeof charge.customer === "string" ? charge.customer : null;
  const email = chargeEmail
    ?? (typeof meta.email === "string" && meta.email.trim() ? meta.email : null)
    ?? (customerId && opts.customerEmail ? opts.customerEmail(customerId) : null);
  const matchName = meta.matchName ?? null;

  const fieldRaw = meta.fieldId;
  const field_id = fieldRaw != null && String(fieldRaw).trim() !== "" && Number.isFinite(Number(fieldRaw))
    ? Number(fieldRaw) : null;

  /* THE INTERNAL FLAG STAYS ON billing_details / receipt_email, as it was when September tied. Widening it to
   * the customer's email is an EXCLUSION change, which flags months "Adjusted after final" — not
   * part of the attribution fix (Ryan, 2026-10-07). */
  const is_internal = !!chargeEmail && INTERNAL_EMAIL_RX.test(chargeEmail);
  const is_test = !!matchName && TEST_NAME_RX.test(matchName);

  return {
    created_at_utc: new Date(bt.created * 1000).toISOString(),
    kind,
    // CENTS, STRAIGHT FROM STRIPE, SIGNED AS STRIPE SIGNS THEM. No rounding, no division: the
    // dollar figure is formed once, on screen. Reversals arrive negative and stay negative.
    gross_cents: bt.amount,
    fee_cents: bt.fee ?? 0,
    net_cents: bt.net,
    city: opts.cityOf({ type, cityIdentifier: meta.cityIdentifier?.trim() || null, matchId, email: email ? email.trim().toLowerCase() : null }),
    type,
    field_id,
    fin_venue_id: field_id == null ? null : opts.venueOfField(field_id),
    balance_txn_id: bt.id,
    charge_id: charge?.id ?? reversedChargeId,
    payment_intent_id: (charge?.payment_intent as string | null) ?? null,
    subscription_id: null,
    /* INVOICE AND SUBSCRIPTION COME FROM THE INVOICE, NOT THE CHARGE. The Stripe types do not put
     * `invoice` on Charge in this API version, and `charge.invoice` has been unreliable here before
     * — the facts doc records it as NEVER populated on this account. The membership classifier keys
     * off metadata.matchId instead, which is the proven rule, so these two stay null until a reader
     * actually needs them rather than being filled with something that looks right and is not. */
    invoice_id: null,
    source_id: typeof bt.source === "string" ? bt.source : (src?.id ?? null),
    is_test,
    is_internal,
    exclude_reason: is_test ? "test match" : is_internal ? "internal account" : null,
    source: "Stripe",
    description,
    dispute_reason: src && (src as Stripe.Dispute).object === "dispute"
      ? ((src as Stripe.Dispute).reason ?? null) : null,
  };
}

/** The Central calendar day an instant falls on. The one place this conversion is written. */
export const centralDay = (iso: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(iso));

/** The Central month label, "Sep 2026", for grouping and for the page. */
export const centralMonth = (iso: string): string => {
  const d = centralDay(iso);
  const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${M[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
};
