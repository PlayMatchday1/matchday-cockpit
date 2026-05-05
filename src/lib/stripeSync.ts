// Stripe API → StripeAllocatedRow[]. Server-side counterpart to the
// CSV importer in financeImport.ts. Same classification helpers
// (isStrikeCharge, looksLikeMembership, cityFromIdentifier,
// normalizeMatchName), same aggregation (aggregateStripeRows), so the
// rows this produces are byte-equivalent to the CSV path for the same
// underlying charges.
//
// Used by /api/sync/stripe. Never imported into the browser bundle —
// reads STRIPE_SECRET_KEY from the server env.

import type { SupabaseClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import {
  DELETED_ACCOUNT_CITY,
  aggregateStripeRows,
  cityFromIdentifier,
  isStrikeCharge,
  looksLikeMembership,
  monthLabelFromIsoDate,
  type StripeAllocatedRow,
} from "./financeImport";
import { selectAll } from "./supabasePagination";
import { normalizeMatchName } from "./venueNormalization";
import { cityFromAbbr } from "./cityMap";

export type StripeSyncOptions = {
  // Inclusive lower bound for charge.created. Required.
  since: Date;
  // Inclusive upper bound for charge.created. Defaults to now.
  until?: Date;
};

export type StripeSyncResult = {
  rows: StripeAllocatedRow[]; // already aggregated, ready for commitStripe
  earliestDate: string | null;
  latestDate: string | null;
  totalCharges: number; // every charge the API returned in the window
  paidRows: number; // status === 'succeeded' AND currency === 'usd'
  skippedNonPaid: number; // status !== 'succeeded'
  skippedNonUsd: number; // succeeded but non-USD currency
  membershipPayments: number;
  matchPayments: number;
  strikePayments: number;
  unmatchedEmails: string[];
  unmatchedCityCodes: string[];
};

// Extract the email the CSV path would write into customer_email.
// Precedence: billing_details.email → receipt_email → metadata.email.
// Lowercased, trimmed, null if all missing.
function extractEmail(charge: Stripe.Charge): string | null {
  const candidates = [
    charge.billing_details?.email,
    charge.receipt_email,
    typeof charge.metadata?.email === "string" ? charge.metadata.email : null,
  ];
  for (const c of candidates) {
    if (c && c.trim()) return c.trim().toLowerCase();
  }
  return null;
}

// Stripe charge.created is unix seconds (UTC). Match the CSV's
// "Created date (UTC)" semantics by formatting the UTC date.
function utcDateFromUnix(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

export async function syncStripeCharges(
  supabase: SupabaseClient,
  opts: StripeSyncOptions,
): Promise<StripeSyncResult> {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  const stripe = new Stripe(apiKey);

  const since = opts.since;
  const until = opts.until ?? new Date();
  const sinceSec = Math.floor(since.getTime() / 1000);
  const untilSec = Math.floor(until.getTime() / 1000);

  // Build email→city + alias maps. Same source-of-truth queries as
  // previewStripe, so the API path can't drift on city allocation.
  // Phase 3b: reads mdapi_subscriptions instead of fin_members; the
  // API stores city as abbr (city_identifier), normalized via
  // cityFromAbbr to the cockpit city name expected downstream.
  const memberRows = await selectAll<{
    member_email: string | null;
    city_identifier: string | null;
  }>(() =>
    supabase
      .from("mdapi_subscriptions")
      .select("member_email, city_identifier")
      .order("membership_id"),
  );
  const emailToCity = new Map<string, string>();
  for (const m of memberRows) {
    if (m.member_email) {
      emailToCity.set(
        m.member_email.toLowerCase().trim(),
        cityFromAbbr(m.city_identifier) ?? DELETED_ACCOUNT_CITY,
      );
    }
  }
  const { data: aliasRows, error: alErr } = await supabase
    .from("fin_venue_aliases")
    .select("alias, canonical_venue");
  if (alErr) throw new Error(`Alias lookup failed: ${alErr.message}`);
  const aliasMap = new Map<string, string>();
  for (const a of (aliasRows ?? []) as {
    alias: string | null;
    canonical_venue: string | null;
  }[]) {
    if (a.alias && a.canonical_venue) {
      aliasMap.set(a.alias.trim(), a.canonical_venue.trim());
    }
  }

  let totalCharges = 0;
  let paidRows = 0;
  let skippedNonPaid = 0;
  let skippedNonUsd = 0;
  let membershipPayments = 0;
  let matchPayments = 0;
  let strikePayments = 0;
  const unmatchedEmailSet = new Set<string>();
  const unmatchedCityCodeSet = new Set<string>();
  const perTxn: StripeAllocatedRow[] = [];
  let earliestDate: string | null = null;
  let latestDate: string | null = null;

  // expand: balance_transaction is required for fees (Stripe API
  // doesn't include the fee on the charge itself). 100 per page is
  // the API max.
  const params: Stripe.ChargeListParams = {
    created: { gte: sinceSec, lte: untilSec },
    limit: 100,
    expand: ["data.balance_transaction"],
  };

  for await (const charge of stripe.charges.list(params)) {
    totalCharges++;

    if (charge.status !== "succeeded") {
      skippedNonPaid++;
      continue;
    }
    if (charge.currency?.toLowerCase() !== "usd") {
      // Surface the count in the response — don't silently coerce, don't
      // hard-fail. MatchDay is US-only; non-USD is an anomaly to flag.
      skippedNonUsd++;
      continue;
    }

    const date = utcDateFromUnix(charge.created);
    const gross = charge.amount / 100;
    const bt = charge.balance_transaction as Stripe.BalanceTransaction | null;
    const fees = bt && typeof bt.fee === "number" ? bt.fee / 100 : 0;
    const description = charge.description?.trim() || null;
    const email = extractEmail(charge);
    const meta = charge.metadata ?? {};
    const stripeType =
      typeof meta.type === "string" && meta.type.trim() ? meta.type.trim() : null;
    const cityIdentifier =
      typeof meta.cityIdentifier === "string" && meta.cityIdentifier.trim()
        ? meta.cityIdentifier.trim()
        : null;
    const explicitVenue =
      (typeof meta.venue === "string" && meta.venue.trim()) ||
      (typeof meta.venueName === "string" && meta.venueName.trim())
        ? ((meta.venue as string) || (meta.venueName as string)).trim()
        : null;
    const matchName =
      typeof meta.matchName === "string" && meta.matchName.trim()
        ? meta.matchName.trim()
        : null;

    paidRows++;
    if (!earliestDate || date < earliestDate) earliestDate = date;
    if (!latestDate || date > latestDate) latestDate = date;

    let allocatedCity: string;
    let type: "DPP" | "Membership" | "Strike";

    if (isStrikeCharge(stripeType)) {
      type = "Strike";
      strikePayments++;
      allocatedCity = cityFromIdentifier(cityIdentifier);
      if (allocatedCity === DELETED_ACCOUNT_CITY && cityIdentifier) {
        unmatchedCityCodeSet.add(cityIdentifier);
      }
    } else if (looksLikeMembership(stripeType, description, cityIdentifier)) {
      type = "Membership";
      membershipPayments++;
      const lookup = email ? emailToCity.get(email) : undefined;
      if (lookup && lookup !== DELETED_ACCOUNT_CITY) {
        allocatedCity = lookup;
      } else {
        allocatedCity = DELETED_ACCOUNT_CITY;
        if (email) unmatchedEmailSet.add(email);
      }
    } else {
      type = "DPP";
      matchPayments++;
      allocatedCity = cityFromIdentifier(cityIdentifier);
      if (allocatedCity === DELETED_ACCOUNT_CITY && cityIdentifier) {
        unmatchedCityCodeSet.add(cityIdentifier);
      }
    }

    let resolvedVenue: string | null = null;
    if (type === "DPP") {
      if (explicitVenue) {
        resolvedVenue = explicitVenue;
      } else if (matchName) {
        const res = normalizeMatchName(matchName, aliasMap);
        resolvedVenue = res.canonical;
      }
    }

    perTxn.push({
      date,
      month: monthLabelFromIsoDate(date) ?? "",
      city: allocatedCity,
      venue: resolvedVenue,
      type,
      gross,
      fees,
      source: "Stripe",
      notes: description,
    });
  }

  const aggregated = aggregateStripeRows(perTxn);

  return {
    rows: aggregated,
    earliestDate,
    latestDate,
    totalCharges,
    paidRows,
    skippedNonPaid,
    skippedNonUsd,
    membershipPayments,
    matchPayments,
    strikePayments,
    unmatchedEmails: [...unmatchedEmailSet].sort(),
    unmatchedCityCodes: [...unmatchedCityCodeSet].sort(),
  };
}
