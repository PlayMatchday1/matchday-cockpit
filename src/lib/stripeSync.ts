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
import { resolveVenue, venueCategory, type VenueCategory } from "./venueResolver";
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
  // DIAGNOSTIC ONLY — the category-split net per (month × venue × type ×
  // category), derived from metadata.matchName BEFORE normalizeMatchName
  // collapses it. Consumed by the dry-run diff on the sync route to run the
  // restatement gate; NOT part of `rows`, so the committed rollups and the
  // cron write path are byte-identical to before this field existed.
  categoryNet: { month: string; venue: string; type: string; category: VenueCategory; net: number }[];
  // DPP venue strings that resolved to NO city — the "loud" exception list so an
  // onboarded-but-unmapped venue surfaces instead of leaking cityless revenue.
  unresolvedVenues: { venue: string; net: number; count: number }[];
  // Metadata coverage over paid charges (see counters above).
  matchNamePresent: number;
  cityIdentifierPresent: number;
  // Of the charges with NO metadata.matchName, how many fall in each resolved
  // type. Membership rows have no match to name (expected, harmless); DPP rows
  // without a matchName are per-match revenue that metadata cannot venue-resolve
  // — only the roster's fieldId bridge can place them.
  matchNameAbsentByType: Record<string, number>;
  // Backfill boundary diagnostics.
  earliestDppDate: string | null;
  earliestCityIdentifierDate: string | null;
  matchNameByMonth: { month: string; present: number; total: number }[];
};

// Extract the email the CSV path would write into customer_email.
// Precedence: billing_details.email → receipt_email → metadata.email
// → charge.customer.email (only when the customer field is expanded
// — see the `expand` list on the charges.list call below).
// Lowercased, trimmed, null if all missing.
//
// The customer.email fallback is critical for invoice-based
// subscription charges (which is how MatchDay memberships bill):
// for those charges, billing_details.email and receipt_email are
// typically null because Stripe attaches the email to the customer
// record rather than to each per-invoice charge. Without this
// fallback, ~99% of subscription charges resolved to null email →
// failed the emailToCity lookup → silently routed to Deleted
// Account Revenue.
function extractEmail(charge: Stripe.Charge): string | null {
  const candidates: (string | null | undefined)[] = [
    charge.billing_details?.email,
    charge.receipt_email,
    typeof charge.metadata?.email === "string" ? charge.metadata.email : null,
  ];
  // charge.customer is `string | Customer | DeletedCustomer | null`.
  // Only an expanded, non-deleted Customer carries .email; the
  // string form is just an ID and DeletedCustomer has no .email.
  if (
    charge.customer &&
    typeof charge.customer === "object" &&
    !("deleted" in charge.customer && charge.customer.deleted)
  ) {
    candidates.push(charge.customer.email);
  }
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
  // Optional service-role-keyed client. Used ONLY for the
  // mdapi_users read that builds the email→city fallback map.
  // mdapi_users has RLS that blocks the authenticated user role
  // even when the calling user is admin — so passing the user's
  // JWT client returns 0 rows and the fallback silently fails.
  // mdapi_subscriptions has more permissive RLS so the primary
  // map build (still on `supabase`) works as-is. Other writes
  // (commitStripe, etc.) also stay on `supabase` so audit / RLS
  // attribution to the calling user is preserved.
  //
  // If omitted, defaults to `supabase` — backwards-compatible with
  // cron mode (where supabase IS already service-role) and CLI
  // scripts that pass a single service-role client.
  serviceClient?: SupabaseClient,
): Promise<StripeSyncResult> {
  const usersClient = serviceClient ?? supabase;
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
  // PRIMARY: mdapi_subscriptions. Authoritative for any email it
  // covers. Same logic as before.
  let primaryCount = 0;
  for (const m of memberRows) {
    if (m.member_email) {
      emailToCity.set(
        m.member_email.toLowerCase().trim(),
        cityFromAbbr(m.city_identifier) ?? DELETED_ACCOUNT_CITY,
      );
      primaryCount++;
    }
  }
  // FALLBACK: mdapi_users for emails the subscription table doesn't
  // cover. Background: mdapi_subscriptions is fed by MatchDay's
  // admin /subscriptions endpoint, which only returns records the
  // admin view still surfaces — hard-deleted / very-stale rows are
  // gone. The Q1 2026 Stripe backfill exposed this: ~1,200 charges
  // (~$51K) had emails that don't exist in subscriptions despite
  // being clearly real member payments. mdapi_users covers a
  // superset (~24k emails vs ~1.6k) with preferable_city_normalized
  // populated for 84% of rows, and 100% of subscription emails are
  // already in mdapi_users — so this is purely additive.
  //
  // The `if (!emailToCity.has(email))` guard preserves the primary's
  // authority: an email in BOTH sources keeps the subscriptions
  // mapping, even if the user's preferable city differs.
  const userRows = await selectAll<{
    email: string | null;
    preferable_city_normalized: string | null;
  }>(() =>
    usersClient
      .from("mdapi_users")
      .select("email, preferable_city_normalized")
      .not("email", "is", null)
      .not("preferable_city_normalized", "is", null)
      .order("id"),
  );
  let fallbackCount = 0;
  for (const u of userRows) {
    if (!u.email) continue;
    const email = u.email.toLowerCase().trim();
    if (emailToCity.has(email)) continue;
    emailToCity.set(
      email,
      cityFromAbbr(u.preferable_city_normalized) ?? DELETED_ACCOUNT_CITY,
    );
    fallbackCount++;
  }
  console.log(
    `[stripe-sync] Membership email→city map built: ${primaryCount} from subscriptions, ${fallbackCount} from users fallback (total ${emailToCity.size})`,
  );
  // Venue derivation now goes through the single canonical resolver
  // (resolveVenue) — retiring the fin_venue_aliases lookup and normalizeMatchName.
  // Unrecognised venues: DPP rows whose canonical resolves to NO city (a field
  // with no resolver rule). Recorded loudly (count + net) so an onboarded venue
  // can't silently produce cityless revenue for months again (see the WestLake /
  // LBJ / Hill Country / Parmer leak that ran Jun–Jul unremarked).
  const unresolvedVenues = new Map<string, { venue: string; net: number; count: number }>();

  let totalCharges = 0;
  let paidRows = 0;
  let skippedNonPaid = 0;
  let skippedNonUsd = 0;
  let membershipPayments = 0;
  let matchPayments = 0;
  let strikePayments = 0;
  // Metadata coverage — how many paid charges carry the fields the venue/city
  // resolution depends on. Surfaced so a backfill can be judged before it runs.
  let matchNamePresent = 0;
  let cityIdentifierPresent = 0;
  const matchNameAbsentByType: Record<string, number> = {};
  // Backfill boundary diagnostics: when paid DPP + city metadata first appear.
  let earliestDppDate: string | null = null;
  let earliestCityIdentifierDate: string | null = null;
  const matchNameByMonth = new Map<string, { present: number; total: number }>();
  const unmatchedEmailSet = new Set<string>();
  const unmatchedCityCodeSet = new Set<string>();
  const perTxn: StripeAllocatedRow[] = [];
  // Category-split net accumulator (diagnostic; see StripeSyncResult.categoryNet).
  // Keyed on the SAME (month, committed-venue, type) as the write path, plus the
  // event/regular category read from matchName. Never feeds `rows`.
  const catAgg = new Map<string, { month: string; venue: string; type: string; category: VenueCategory; net: number }>();
  let earliestDate: string | null = null;
  let latestDate: string | null = null;

  // expand: balance_transaction is required for fees (Stripe API
  // doesn't include the fee on the charge itself). customer is
  // required so extractEmail can fall back to customer.email for
  // invoice-based subscription charges where billing_details.email
  // and receipt_email are null. 100 per page is the API max.
  const params: Stripe.ChargeListParams = {
    created: { gte: sinceSec, lte: untilSec },
    limit: 100,
    expand: ["data.balance_transaction", "data.customer"],
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
    if (matchName) matchNamePresent++;
    if (cityIdentifier) cityIdentifierPresent++;
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

    if (!matchName) matchNameAbsentByType[type] = (matchNameAbsentByType[type] ?? 0) + 1;
    if (type === "DPP" && (!earliestDppDate || date < earliestDppDate)) earliestDppDate = date;
    if (cityIdentifier && (!earliestCityIdentifierDate || date < earliestCityIdentifierDate)) earliestCityIdentifierDate = date;
    const mk = date.slice(0, 7);
    const mm = matchNameByMonth.get(mk) ?? { present: 0, total: 0 };
    mm.total++;
    if (matchName) mm.present++;
    matchNameByMonth.set(mk, mm);

    let resolvedVenue: string | null = null;
    if (type === "DPP") {
      // Prefer metadata.venue / metadata.venueName (operator override) else
      // matchName, then the single canonical resolver — a substring/rule matcher,
      // so a new field spelling like "WestLake - Field 3 - Match 1" collapses to
      // "Westlake" without a hand-added alias per string. If it resolves to no
      // city, it's an unrecognised venue — record it loudly rather than write a
      // stale display name that no downstream view can attribute.
      const rawVenue = explicitVenue ?? matchName;
      if (rawVenue) {
        const res = resolveVenue(rawVenue);
        resolvedVenue = res.canonicalVenue;
        if (!res.city) {
          const u = unresolvedVenues.get(resolvedVenue) ?? { venue: resolvedVenue, net: 0, count: 0 };
          u.net += gross - fees;
          u.count += 1;
          unresolvedVenues.set(resolvedVenue, u);
        }
      }
    }

    const month = monthLabelFromIsoDate(date) ?? "";
    perTxn.push({
      date,
      month,
      city: allocatedCity,
      venue: resolvedVenue,
      type,
      gross,
      fees,
      source: "Stripe",
      notes: description,
    });

    // Category from the event's OWN identity (matchName), never the pitch.
    // Only DPP can be an event (tournament/combine entries); membership &
    // strike are always regular. Uses the same fields the venue derivation
    // reads, before normalizeMatchName flattens the tournament name away.
    const category: VenueCategory =
      type === "DPP" ? venueCategory(matchName ?? explicitVenue ?? description) : "regular";
    const ck = `${month}|${resolvedVenue ?? ""}|${type}|${category}`;
    const prev = catAgg.get(ck);
    if (prev) prev.net += gross - fees;
    else catAgg.set(ck, { month, venue: resolvedVenue ?? "", type, category, net: gross - fees });
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
    categoryNet: [...catAgg.values()],
    unresolvedVenues: [...unresolvedVenues.values()].sort((a, b) => b.net - a.net),
    matchNamePresent,
    cityIdentifierPresent,
    matchNameAbsentByType,
    earliestDppDate,
    earliestCityIdentifierDate,
    matchNameByMonth: [...matchNameByMonth.entries()].map(([month, v]) => ({ month, ...v })).sort((a, b) => a.month.localeCompare(b.month)),
  };
}

// ── Read-only classifier probe ───────────────────────────────────────────────
// Independent of the write path (never touches fin_revenue or fin_sync_log). It
// classifies each succeeded USD charge two ways and compares:
//   current    = the shipped rule (isStrikeCharge → looksLikeMembership → DPP),
//                which mis-types pre-metadata charges as Membership because
//                looksLikeMembership returns true when cityIdentifier is absent.
//   historical = subscription-invoice discriminator: a charge carries
//                charge.invoice IFF it was billed from a subscription invoice
//                (membership); a one-off per-match PaymentIntent has none. Strike
//                still keyed off metadata.type (one-offs, no invoice) — flagged.
// Present across all history, so it can classify eras with no type/city metadata.
export type ClassifierProbeResult = {
  since: string;
  until: string;
  fetched: number;
  succeeded: number;
  skippedNonPaid: number;
  skippedNonUsd: number;
  current: Record<"DPP" | "Membership" | "Strike", number>;
  historical: Record<"DPP" | "Membership" | "Strike", number>;
  invoicePresent: number;
  invoiceByCurrentType: Record<string, { withInvoice: number; without: number }>;
  agree: number;
  disagree: number;
  agreementPct: number;
  // Candidate discriminator #2: metadata.matchId / userMatchId presence.
  matchIdPresent: number;
  userMatchIdPresent: number;
  histMatchId: Record<"DPP" | "Membership" | "Strike", number>;
  agreeMatchId: number;
  disagreeMatchId: number;
  agreeMatchIdPct: number;
  disagreementsMatchId: {
    date: string; amount: number; description: string | null;
    current: string; histMatchId: string; hasMatchId: boolean; stripeType: string | null;
  }[];
  disagreements: {
    date: string; amount: number; description: string | null;
    current: string; historical: string; hasInvoice: boolean; stripeType: string | null;
  }[];
  matchNamePresent: number;
  cityIdentifierPresent: number;
  // Positive-membership design: characterise the matchId-absent, non-strike
  // population so "membership" can be a positive test, not a catch-all default.
  noMatchIdNonStrike: number;
  membershipPositive: number; // explicit subscription/membership signal (type or description)
  rentalPositive: number;     // explicit rental/private signal
  flagged: number;            // matches nothing → must be surfaced, not typed membership
  flaggedSamples: { date: string; amount: number; description: string | null; stripeType: string | null; metaKeys: string }[];
  noMatchIdMetaKeySets: { keys: string; count: number }[];
  // Full shipped-rule outcome (Strike → matchId-DPP → PrivateRental → Membership
  // → Unclassified) and the per-charge move vs the current rule — for the
  // amended byte-identical gate and the Oct-2024 before/after.
  newRule: Record<"DPP" | "Membership" | "Strike" | "PrivateRental" | "Unclassified", number>;
  moves: { from: string; to: string; count: number; gross: number }[];
  flaggedByType: { stripeType: string; count: number; gross: number }[];
  // metadata.type values on matchId-present (DPP) charges — is type a structured
  // event marker on per-match charges too? (check #1)
  dppTypeValues: { type: string; count: number }[];
  // captain_division (league) charges: distinct division, size, cities, period (check #2)
  captainDivisions: { id: string; count: number; gross: number; cityIds: string[]; firstDate: string; lastDate: string }[];
  // Distinct matchName on historical-DPP charges (for the local matchName→match
  // →field→city join). Bounded to the top ~600 by count.
  dppMatchNames: { name: string; count: number }[];
  // Distinct metadata.matchId on matchId-rule-DPP charges (for the DIRECT
  // matchId→mdapi api_id→city join — works in eras with no matchName). Top ~1500.
  dppMatchIds: { matchId: string; count: number }[];
  samples?: {
    date: string; amount: number; description: string | null;
    invoice: string | null; priceId: string | null; productId: string | null;
    paymentMethod: string | null; metadata: Record<string, string>;
    current: string; historical: string;
  }[];
};

export async function stripeClassifierProbe(opts: {
  since: Date;
  until: Date;
  sample?: number;
}): Promise<ClassifierProbeResult> {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) throw new Error("STRIPE_SECRET_KEY is not set");
  const stripe = new Stripe(apiKey);
  const sinceSec = Math.floor(opts.since.getTime() / 1000);
  const untilSec = Math.floor(opts.until.getTime() / 1000);

  let fetched = 0, succeeded = 0, skippedNonPaid = 0, skippedNonUsd = 0;
  let invoicePresent = 0, agree = 0, disagree = 0, matchNamePresent = 0, cityIdentifierPresent = 0;
  let matchIdPresent = 0, userMatchIdPresent = 0, agreeMatchId = 0, disagreeMatchId = 0;
  const current: Record<string, number> = { DPP: 0, Membership: 0, Strike: 0 };
  const historical: Record<string, number> = { DPP: 0, Membership: 0, Strike: 0 };
  const histMatchId: Record<string, number> = { DPP: 0, Membership: 0, Strike: 0 };
  const invoiceByCurrentType: Record<string, { withInvoice: number; without: number }> = {
    DPP: { withInvoice: 0, without: 0 },
    Membership: { withInvoice: 0, without: 0 },
    Strike: { withInvoice: 0, without: 0 },
  };
  const disagreements: ClassifierProbeResult["disagreements"] = [];
  const disagreementsMatchId: ClassifierProbeResult["disagreementsMatchId"] = [];
  const dppMatchNameCounts = new Map<string, number>();
  const dppMatchIdCounts = new Map<string, number>();
  let noMatchIdNonStrike = 0, membershipPositive = 0, rentalPositive = 0, flagged = 0;
  const flaggedSamples: ClassifierProbeResult["flaggedSamples"] = [];
  const noMatchIdMetaKeySets = new Map<string, number>();
  const membSig = (t: string | null, d: string | null) => (!!t && /subscription|membership|plan|renew/i.test(t)) || (!!d && /subscription|membership|renew|plan/i.test(d));
  const rentSig = (t: string | null, d: string | null) => (!!t && /rental|private/i.test(t)) || (!!d && /rental|private\s*rent/i.test(d));
  const newRule: Record<string, number> = { DPP: 0, Membership: 0, Strike: 0, PrivateRental: 0, Unclassified: 0 };
  const movesMap = new Map<string, { count: number; gross: number }>();
  const flaggedByTypeMap = new Map<string, { count: number; gross: number }>();
  const dppTypeValuesMap = new Map<string, number>();
  const capDivMap = new Map<string, { count: number; gross: number; cityIds: Set<string>; firstDate: string; lastDate: string }>();

  for await (const charge of stripe.charges.list({ created: { gte: sinceSec, lte: untilSec }, limit: 100 })) {
    fetched++;
    if (charge.status !== "succeeded") { skippedNonPaid++; continue; }
    if (charge.currency?.toLowerCase() !== "usd") { skippedNonUsd++; continue; }
    succeeded++;
    const meta = charge.metadata ?? {};
    const stripeType = typeof meta.type === "string" && meta.type.trim() ? meta.type.trim() : null;
    const cityIdentifier = typeof meta.cityIdentifier === "string" && meta.cityIdentifier.trim() ? meta.cityIdentifier.trim() : null;
    const description = charge.description?.trim() || null;
    const matchName = typeof meta.matchName === "string" && meta.matchName.trim() ? meta.matchName.trim() : null;
    const hasInvoice = (charge as unknown as { invoice?: string | Stripe.Invoice | null }).invoice != null;
    const hasMatchId = (typeof meta.matchId === "string" && meta.matchId.trim() !== "") || (typeof meta.userMatchId === "string" && meta.userMatchId.trim() !== "");
    if (hasInvoice) invoicePresent++;
    if (typeof meta.matchId === "string" && meta.matchId.trim() !== "") matchIdPresent++;
    if (typeof meta.userMatchId === "string" && meta.userMatchId.trim() !== "") userMatchIdPresent++;
    if (matchName) matchNamePresent++;
    if (cityIdentifier) cityIdentifierPresent++;

    const cur = isStrikeCharge(stripeType) ? "Strike" : looksLikeMembership(stripeType, description, cityIdentifier) ? "Membership" : "DPP";
    const hist = isStrikeCharge(stripeType) ? "Strike" : hasInvoice ? "Membership" : "DPP";
    const hMid = isStrikeCharge(stripeType) ? "Strike" : hasMatchId ? "DPP" : "Membership";
    current[cur]++; historical[hist]++; histMatchId[hMid]++;
    invoiceByCurrentType[cur][hasInvoice ? "withInvoice" : "without"]++;
    if (hMid === "DPP" && matchName) dppMatchNameCounts.set(matchName, (dppMatchNameCounts.get(matchName) ?? 0) + 1);
    if (hMid === "DPP") { const mid = (typeof meta.matchId === "string" && meta.matchId.trim()) || (typeof meta.userMatchId === "string" && meta.userMatchId.trim()) || null; if (mid) dppMatchIdCounts.set(mid, (dppMatchIdCounts.get(mid) ?? 0) + 1); }
    if (cur === hist) agree++;
    else {
      disagree++;
      if (disagreements.length < 100) disagreements.push({ date: utcDateFromUnix(charge.created), amount: charge.amount / 100, description, current: cur, historical: hist, hasInvoice, stripeType });
    }
    if (cur === hMid) agreeMatchId++;
    else {
      disagreeMatchId++;
      if (disagreementsMatchId.length < 100) disagreementsMatchId.push({ date: utcDateFromUnix(charge.created), amount: charge.amount / 100, description, current: cur, histMatchId: hMid, hasMatchId, stripeType });
    }

    // Characterise the matchId-absent, non-strike population for the positive
    // membership test — this is where "default to membership" hides rentals and
    // one-offs. Strike and matchId-DPP are already positively identified above.
    if (!isStrikeCharge(stripeType) && !hasMatchId) {
      noMatchIdNonStrike++;
      const keys = Object.keys(meta).sort().join(",") || "(none)";
      noMatchIdMetaKeySets.set(keys, (noMatchIdMetaKeySets.get(keys) ?? 0) + 1);
      if (membSig(stripeType, description)) membershipPositive++;
      else if (rentSig(stripeType, description)) rentalPositive++;
      else {
        flagged++;
        if (flaggedSamples.length < 60) flaggedSamples.push({ date: utcDateFromUnix(charge.created), amount: charge.amount / 100, description, stripeType, metaKeys: keys });
      }
    }

    // ── Full shipped-rule outcome + move vs current, plus the check-#1/#2 data ──
    const amt = charge.amount / 100;
    const nt = isStrikeCharge(stripeType) ? "Strike" : hasMatchId ? "DPP" : rentSig(stripeType, description) ? "PrivateRental" : membSig(stripeType, description) ? "Membership" : "Unclassified";
    newRule[nt]++;
    if (cur !== nt) { const k = `${cur}→${nt}`; const g = movesMap.get(k) ?? { count: 0, gross: 0 }; g.count++; g.gross += amt; movesMap.set(k, g); }
    if (nt === "Unclassified") { const st = stripeType ?? "(none)"; const g = flaggedByTypeMap.get(st) ?? { count: 0, gross: 0 }; g.count++; g.gross += amt; flaggedByTypeMap.set(st, g); }
    if (hasMatchId) dppTypeValuesMap.set(stripeType ?? "(none)", (dppTypeValuesMap.get(stripeType ?? "(none)") ?? 0) + 1);
    if (stripeType === "captain_division") {
      const id = (typeof meta.captainDivisionId === "string" && meta.captainDivisionId) || "(none)";
      const d = utcDateFromUnix(charge.created);
      const g = capDivMap.get(id) ?? { count: 0, gross: 0, cityIds: new Set<string>(), firstDate: d, lastDate: d };
      g.count++; g.gross += amt; if (cityIdentifier) g.cityIds.add(cityIdentifier); if (d < g.firstDate) g.firstDate = d; if (d > g.lastDate) g.lastDate = d;
      capDivMap.set(id, g);
    }
  }

  let samples: ClassifierProbeResult["samples"];
  if (opts.sample && opts.sample > 0) {
    samples = [];
    for await (const charge of stripe.charges.list({ created: { gte: sinceSec, lte: untilSec }, limit: 100, expand: ["data.invoice"] })) {
      if (charge.status !== "succeeded" || charge.currency?.toLowerCase() !== "usd") continue;
      if (samples.length >= opts.sample) break;
      const meta = charge.metadata ?? {};
      const inv = (charge as unknown as { invoice?: string | Stripe.Invoice | null }).invoice ?? null;
      const invId = typeof inv === "string" ? inv : inv?.id ?? null;
      let priceId: string | null = null, productId: string | null = null;
      if (inv && typeof inv === "object") {
        const line = inv.lines?.data?.[0] as unknown as { price?: { id?: string; product?: string }; plan?: { id?: string; product?: string } } | undefined;
        priceId = line?.price?.id ?? line?.plan?.id ?? null;
        productId = (typeof line?.price?.product === "string" ? line.price.product : null) ?? (typeof line?.plan?.product === "string" ? line.plan.product : null);
      }
      const stripeType = typeof meta.type === "string" ? meta.type : null;
      const cityIdentifier = typeof meta.cityIdentifier === "string" ? meta.cityIdentifier : null;
      const description = charge.description?.trim() || null;
      const cur = isStrikeCharge(stripeType) ? "Strike" : looksLikeMembership(stripeType, description, cityIdentifier) ? "Membership" : "DPP";
      const hist = isStrikeCharge(stripeType) ? "Strike" : invId ? "Membership" : "DPP";
      samples.push({ date: utcDateFromUnix(charge.created), amount: charge.amount / 100, description, invoice: invId, priceId, productId, paymentMethod: charge.payment_method_details?.type ?? null, metadata: { ...meta }, current: cur, historical: hist });
    }
  }

  return {
    since: opts.since.toISOString(), until: opts.until.toISOString(),
    fetched, succeeded, skippedNonPaid, skippedNonUsd,
    current: current as ClassifierProbeResult["current"],
    historical: historical as ClassifierProbeResult["historical"],
    invoicePresent, invoiceByCurrentType, agree, disagree,
    agreementPct: agree + disagree ? +((100 * agree) / (agree + disagree)).toFixed(3) : 0,
    matchIdPresent, userMatchIdPresent,
    histMatchId: histMatchId as ClassifierProbeResult["histMatchId"],
    agreeMatchId, disagreeMatchId,
    agreeMatchIdPct: agreeMatchId + disagreeMatchId ? +((100 * agreeMatchId) / (agreeMatchId + disagreeMatchId)).toFixed(3) : 0,
    disagreementsMatchId,
    disagreements, matchNamePresent, cityIdentifierPresent,
    noMatchIdNonStrike, membershipPositive, rentalPositive, flagged, flaggedSamples,
    noMatchIdMetaKeySets: [...noMatchIdMetaKeySets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([keys, count]) => ({ keys, count })),
    newRule: newRule as ClassifierProbeResult["newRule"],
    moves: [...movesMap.entries()].map(([k, v]) => ({ from: k.split("→")[0], to: k.split("→")[1], count: v.count, gross: +v.gross.toFixed(2) })).sort((a, b) => b.count - a.count),
    flaggedByType: [...flaggedByTypeMap.entries()].map(([stripeType, v]) => ({ stripeType, count: v.count, gross: +v.gross.toFixed(2) })).sort((a, b) => b.gross - a.gross),
    dppTypeValues: [...dppTypeValuesMap.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    captainDivisions: [...capDivMap.entries()].map(([id, v]) => ({ id, count: v.count, gross: +v.gross.toFixed(2), cityIds: [...v.cityIds], firstDate: v.firstDate, lastDate: v.lastDate })).sort((a, b) => b.gross - a.gross),
    dppMatchNames: [...dppMatchNameCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 600).map(([name, count]) => ({ name, count })),
    dppMatchIds: [...dppMatchIdCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 1500).map(([matchId, count]) => ({ matchId, count })),
    samples,
  };
}
