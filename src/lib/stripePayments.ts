import "server-only";
// Live per-player Stripe read for the Player Lookup Payments panel (Phase 18). READ
// ONLY, never cached — "pending" becoming "succeeded" is the point of the panel. Reuses
// STRIPE_SECRET_KEY exactly as stripeSync does (same var, same `new Stripe(key)`); the
// key is never returned, never logged, never put in an error message.
//
// Finding the player's charges (two routes, both reported so a mismatch is never silent):
//   1. email  -> customers.list({email}) -> charges.list({customer})
//   2. userId -> charges.search(metadata['userId']) — rescues the known email-mismatch
//      case (financeImport.ts:87: a Stripe customer email that differs from MatchDay's).
// Charges join to matches on metadata.matchId (never amount+timestamp); a charge with no
// matchId is a membership charge — that absence IS the discriminator.

import Stripe from "stripe";

export class StripeConfigError extends Error { constructor(m: string) { super(m); this.name = "StripeConfigError"; } }
export class StripeUnreachableError extends Error { constructor(m: string) { super(m); this.name = "StripeUnreachableError"; } }

export type PayStatus = "succeeded" | "pending" | "refunded" | "failed" | "disputed";
export type PaymentRow = {
  id: string; description: string; created: string; card: string | null;
  status: PayStatus; amount: number; matchId: string | null; isMembership: boolean;
};
export type PaymentsResult = {
  rows: PaymentRow[];
  foundVia: ("email" | "userId")[]; // which route(s) actually returned charges
  customerMatched: boolean;         // did email match a Stripe customer at all
};

function getStripe(): Stripe {
  const apiKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!apiKey) throw new StripeConfigError("STRIPE_SECRET_KEY is not set");
  return new Stripe(apiKey);
}

// disputed > refunded > raw status. A disputed charge is the most consequential state and
// must never be hidden behind "succeeded".
function statusOf(c: Stripe.Charge): PayStatus {
  if (c.disputed === true) return "disputed";
  if (c.refunded === true || (typeof c.amount_refunded === "number" && c.amount_refunded > 0)) return "refunded";
  if (c.status === "succeeded") return "succeeded";
  if (c.status === "pending") return "pending";
  return "failed";
}

function cardOf(c: Stripe.Charge): string | null {
  const card = c.payment_method_details?.card;
  if (card?.brand && card?.last4) return `${card.brand} ••${card.last4}`;
  return null;
}

function toRow(c: Stripe.Charge): PaymentRow {
  const meta = (c.metadata ?? {}) as Record<string, string>;
  const matchId = (typeof meta.matchId === "string" && meta.matchId.trim()) || (typeof meta.userMatchId === "string" && meta.userMatchId.trim()) || null;
  return {
    id: c.id,
    description: (c.description && c.description.trim()) || (matchId ? `Match ${matchId}` : "Membership"),
    created: new Date(c.created * 1000).toISOString(),
    card: cardOf(c),
    status: statusOf(c),
    amount: c.amount,
    matchId,
    isMembership: !matchId,
  };
}

export async function fetchPlayerPayments(email: string | null, userId: string | number | null): Promise<PaymentsResult> {
  const stripe = getStripe();
  const collected = new Map<string, { charge: Stripe.Charge; via: Set<"email" | "userId"> }>();
  let customerMatched = false;
  const add = (c: Stripe.Charge, via: "email" | "userId") => {
    const e = collected.get(c.id);
    if (e) e.via.add(via);
    else collected.set(c.id, { charge: c, via: new Set([via]) });
  };

  try {
    // Route 1 — email -> customer -> charges
    if (email && email.trim()) {
      const custs = await stripe.customers.list({ email: email.trim(), limit: 5 });
      customerMatched = custs.data.length > 0;
      for (const cust of custs.data) {
        const ch = await stripe.charges.list({ customer: cust.id, limit: 10 });
        for (const c of ch.data) add(c, "email");
      }
    }
    // Route 2 — metadata.userId (rescues the email-mismatch case). charges.search may be
    // unavailable on some keys; treat a search failure as "route found nothing", not fatal.
    if (userId != null && String(userId).trim()) {
      try {
        const found = await stripe.charges.search({ query: `metadata['userId']:'${String(userId).trim()}'`, limit: 10 });
        for (const c of found.data) add(c, "userId");
      } catch { /* search unsupported / no match — route 1 stands */ }
    }
  } catch (e) {
    // Any real Stripe/network failure — surface it, never degrade to an empty list. The
    // message is Stripe's (which never contains the key), sliced defensively.
    throw new StripeUnreachableError(e instanceof Error ? e.message.slice(0, 200) : "Stripe request failed");
  }

  const entries = [...collected.values()].sort((a, b) => b.charge.created - a.charge.created).slice(0, 10);
  const via = new Set<"email" | "userId">();
  for (const e of entries) for (const v of e.via) via.add(v);
  return { rows: entries.map((e) => toRow(e.charge)), foundVia: [...via], customerMatched };
}
