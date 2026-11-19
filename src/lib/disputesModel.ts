// Disputes page: the pure part. Status buckets, the evidence checklist, the verdict and the plain-text
// evidence packet. No I/O here; disputesServer.ts reads Stripe, the backend and our tables and hands
// this file plain values. (Ryan, 2026-11-18; matching rules in docs/disputes/investigation.md.)
//
// TIME MODELS. Every instant here is TRUE UTC (Stripe epochs, backend ISO strings, mdapi_matches
// start_date_utc), shown in America/Chicago. Match `start_date` (wall clock) is never read by this file.
// Cancel-confirmation endsAt / lastChargeDate are Central CALENDAR DATES (YYYY-MM-DD) as the app showed them.
//
// NEVER FABRICATE. Every line of the checklist and the packet comes from a value passed in; a value
// that is absent is reported as missing, never filled with a default that reads like evidence.

export type DisputeBucket = "needs_response" | "under_review" | "closed";

export function bucketOf(status: string): DisputeBucket {
  if (status === "needs_response" || status === "warning_needs_response") return "needs_response";
  if (status === "under_review" || status === "warning_under_review") return "under_review";
  return "closed"; // won, lost, warning_closed, prevented
}

/** The member a dispute was matched to, or null. `via` says which route found them. */
export type DisputeMember = {
  userId: number;
  name: string | null;
  city: string | null;
  membershipId: number | null;
  via: "invoice" | "customer" | "backend";
};

/** One row of the list. NO IP, NO DEVICE, NO EMAIL: the list never carries them. */
export type DisputeRow = {
  id: string;
  status: string;
  bucket: DisputeBucket;
  amountCents: number;
  currency: string;
  reason: string;
  createdAt: string; // ISO UTC
  dueBy: string | null; // ISO UTC
  pastDue: boolean;
  hasEvidence: boolean;
  chargeId: string | null;
  chargedAt: string | null; // the disputed charge, ISO UTC
  paymentIntentId: string | null;
  customerId: string | null;
  member: DisputeMember | null;
  isMembershipCharge: boolean; // the payment intent is a membership invoice (stripe_member_invoices)
};

export const REASON_LABEL: Record<string, string> = {
  subscription_canceled: "Canceled subscription",
  fraudulent: "Unrecognized",
  product_unacceptable: "Not as described",
  credit_not_processed: "Credit not processed",
  product_not_received: "Not received",
  general: "General",
  debit_not_authorized: "Debit not authorized",
  duplicate: "Duplicate",
  unrecognized: "Unrecognized",
  customer_initiated: "Customer initiated",
  bank_cannot_process: "Bank cannot process",
  incorrect_account_details: "Incorrect account details",
  insufficient_funds: "Insufficient funds",
  noncompliant: "Noncompliant",
};
export const reasonLabel = (r: string) => REASON_LABEL[r] ?? r.replace(/_/g, " ");

export const STATUS_LABEL: Record<string, string> = {
  needs_response: "Needs response", warning_needs_response: "Inquiry · needs response",
  under_review: "Under review", warning_under_review: "Inquiry · under review",
  won: "Won", lost: "Lost", warning_closed: "Inquiry closed", prevented: "Prevented",
};

// ── Central time ──────────────────────────────────────────────────────────────────────────────
const TZ = "America/Chicago";
export const centralYmd = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(iso));
export const centralDay = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" }).format(new Date(iso));
export const centralDate = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
export const centralDateTime = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) + " Central";
/** A Central calendar date (YYYY-MM-DD) as "Nov 30, 2026", without passing through an instant. */
export function ymdLabel(ymd: string, withYear = true): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return withYear ? `${months[m - 1]} ${d}, ${y}` : `${months[m - 1]} ${d}`;
}
export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Whole Central days from today to the due date (0 = due today, negative = past). */
export function daysUntil(dueIso: string, now: Date = new Date()): number {
  const dayNum = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); return Date.UTC(y, m - 1, d) / 86_400_000; };
  return Math.round(dayNum(centralYmd(dueIso)) - dayNum(centralYmd(now.toISOString())));
}

// ── Evidence, as disputesServer hands it over ─────────────────────────────────────────────────
export type TermsAcceptance = {
  acceptedAt: string; termsVersion: string | null; chargeText: string | null; appVersion: string | null;
  firstChargeCents: number; monthlyChargeCents: number; firstFullChargeAt: string;
  ipAddress: string | null; userAgent: string | null;
};
export type CancelConfirmation = {
  confirmedAt: string; outcome: string; endsAt: string | null; lastChargeDate: string | null;
  lastChargeBeforeTaxCents: number | null; cancelReason: string | null; appVersion: string | null;
  ipAddress: string | null; userAgent: string | null;
};
export type PeriodMatch = { startUtc: string; field: string | null; city: string | null; checkedIn: boolean; status: string | null };
export type ChatSummary = { channel: string | null; createdAt: string; lastMessageAt: string | null };

export type DisputeEvidence = {
  /** Why the backend evidence could not be read, if it could not (404, 409, unreachable). */
  backendNote: string | null;
  membership: {
    id: number; joinedAt: string | null; canceledAt: string | null; cancelReason: string | null;
  } | null;
  terms: TermsAcceptance | null;
  cancel: CancelConfirmation | null;
  /** The period the disputed charge paid for, ISO UTC; null when it could not be read. */
  period: { start: string; end: string; source: "stripe-invoice" } | null;
  billingReason: string | null; // subscription_create | subscription_cycle | …
  periodMatches: PeriodMatch[] | null; // null = not read
  priorPaidCharges: number | null; // paid membership invoices before this one
  refundsOnCharge: number | null; // cents refunded on the disputed charge (fin_txn), null = not read
  chats: ChatSummary[] | null;
  customerName: string | null;
};

const CHARGED_IN_ERROR_NOTICE_DAYS = 25;
/** membership_terms_acceptances exists from the backend release of 2026-11-13 12:48 Central
 *  (docs/disputes/investigation.md, Sources). A member who joined before it cannot have a row. */
const TERMS_RECORDED_FROM = "2026-11-13T18:48:00.000Z";
/** Stripe period ends are exclusive (the next period's first second); the last day served is one second earlier. */
const lastInstant = (endIso: string) => new Date(new Date(endIso).getTime() - 1000).toISOString();
export const CANCELLATION_POLICY =
  "MatchDay memberships renew monthly. To stop the next charge, a member must cancel in the app at least 25 days before it.";

/** Older app: signed up on 1.89 or earlier, so the terms row holds no charge text. */
export const isOlderAppTerms = (t: TermsAcceptance) => !t.chargeText;

export type CheckItem = { key: string; found: boolean; partial?: boolean; title: string; detail: string };

/**
 * Did our own records say this charge should not have happened?
 *  - a cancel confirmation showing NO_MORE_CHARGES, confirmed before the charge;
 *  - a cancel confirmation showing ONE_LAST_CHARGE on a date, and this charge is later than that
 *    (two days' slack: a renewal invoice is created the evening before the date the app shows);
 *  - no confirmation, but the in-app cancel was 25 or more days before a renewal charge (the policy).
 */
export function chargedInError(ev: DisputeEvidence, chargedAt: string | null): string | null {
  if (!chargedAt || !ev.membership) return null;
  const charge = new Date(chargedAt).getTime();
  const c = ev.cancel;
  if (c && new Date(c.confirmedAt).getTime() < charge) {
    if (c.outcome === "NO_MORE_CHARGES") {
      return `The cancel sheet told them "no more charges" on ${centralDate(c.confirmedAt)}, and they were charged on ${centralDate(chargedAt)}.`;
    }
    if (c.outcome === "ONE_LAST_CHARGE" && c.lastChargeDate) {
      const [y, m, d] = c.lastChargeDate.split("-").map(Number);
      if (charge > Date.UTC(y, m - 1, d + 2)) {
        return `The cancel sheet showed one last charge on ${ymdLabel(c.lastChargeDate)}, and this charge came after it, on ${centralDate(chargedAt)}.`;
      }
    }
    return null;
  }
  const canceled = ev.membership.canceledAt ? new Date(ev.membership.canceledAt).getTime() : null;
  if (canceled !== null && canceled < charge && ev.billingReason === "subscription_cycle"
    && charge - canceled >= CHARGED_IN_ERROR_NOTICE_DAYS * 86_400_000) {
    const days = Math.floor((charge - canceled) / 86_400_000);
    return `They cancelled on ${centralDate(ev.membership.canceledAt!)}, ${days} days before this renewal charge, so under the 25-day rule it should not have been taken.`;
  }
  return null;
}

export function checklist(ev: DisputeEvidence): CheckItem[] {
  const items: CheckItem[] = [];
  const t = ev.terms;
  items.push(t
    ? isOlderAppTerms(t)
      ? { key: "terms", found: true, partial: true, title: "Agreed to terms at signup",
          detail: `${centralDay(t.acceptedAt)} · Agreed at signup (older app, no charge text saved)${t.appVersion ? ` · app ${t.appVersion}` : ""}${t.ipAddress ? " · IP saved" : ""}` }
      : { key: "terms", found: true, title: "Agreed to terms at signup",
          detail: `${centralDay(t.acceptedAt)} · "${t.chargeText}"${t.appVersion ? ` · app ${t.appVersion}` : ""}${t.ipAddress ? " · IP saved" : ""}` }
    : { key: "terms", found: false, title: "Agreed to terms at signup",
        detail: ev.membership?.joinedAt && ev.membership.joinedAt < TERMS_RECORDED_FROM
          ? `No signup agreement on file (joined ${centralDate(ev.membership.joinedAt)}, before signups were recorded)`
          : "No signup agreement on file" });

  const c = ev.cancel;
  const canceledAt = ev.membership?.canceledAt ?? null;
  if (c) {
    const shown = c.outcome === "NO_MORE_CHARGES"
      ? `shown "No more charges"${c.endsAt ? `, ends ${ymdLabel(c.endsAt, false)}` : ""}`
      : `shown "One last charge${c.lastChargeBeforeTaxCents != null ? ` ${money(c.lastChargeBeforeTaxCents)} + tax` : ""}${c.lastChargeDate ? ` on ${ymdLabel(c.lastChargeDate, false)}` : ""}${c.endsAt ? `, ends ${ymdLabel(c.endsAt, false)}` : ""}"`;
    items.push({ key: "cancel", found: true, title: "Cancel confirmation",
      detail: `${centralDay(c.confirmedAt)} · ${shown}${c.cancelReason ? ` · reason "${c.cancelReason}"` : ""}` });
  } else if (canceledAt) {
    items.push({ key: "cancel", found: false, title: "Cancel confirmation",
      detail: `No cancel confirmation (older app) · cancelled ${centralDay(canceledAt)}${ev.membership?.cancelReason ? ` · reason "${ev.membership.cancelReason}"` : ""}` });
  } else {
    items.push({ key: "cancel", found: false, title: "Cancel confirmation", detail: "No cancel on file for this membership" });
  }

  const pm = ev.periodMatches;
  if (pm === null || !ev.period) {
    items.push({ key: "usage", found: false, title: "Used the membership",
      detail: ev.period ? "Could not read matches for the charged period" : "Charged period unknown, so usage was not counted" });
  } else {
    const checked = pm.filter((m) => m.checkedIn).length;
    items.push({ key: "usage", found: pm.length > 0, title: "Used the membership",
      detail: pm.length > 0
        ? `${pm.length} ${pm.length === 1 ? "match" : "matches"} booked, ${checked} checked in during the charged period`
        : `No matches booked in the charged period (${centralDay(ev.period.start)} – ${centralDay(lastInstant(ev.period.end))})` });
  }

  const policyAtSignup = !!t && !!t.termsVersion;
  items.push({ key: "policy", found: policyAtSignup || !!c, title: "Cancellation policy",
    detail: policyAtSignup || c
      ? `Cancel at least 25 days before the next charge, shown ${[policyAtSignup && "at signup", c && "in the cancel sheet"].filter(Boolean).join(" and ")}`
      : "No record that the policy was shown to this member" });

  const chats = ev.chats;
  items.push(chats === null
    ? { key: "chats", found: false, title: "Support chats", detail: "Could not read support chats" }
    : chats.length > 0
      ? { key: "chats", found: true, title: "Support chats",
          detail: `${chats.length} ${chats.length === 1 ? "thread" : "threads"} · last message ${chats.map((x) => x.lastMessageAt).filter(Boolean).sort().reverse()[0] ? centralDay(chats.map((x) => x.lastMessageAt).filter(Boolean).sort().reverse()[0]!) : "none"}` }
      : { key: "chats", found: false, title: "Support chats", detail: "None on file" });
  return items;
}

export type Verdict = { tone: "strong" | "weak" | "error" | "none"; label: string; title: string; body: string };

export function verdictOf(row: DisputeRow, ev: DisputeEvidence | null): Verdict {
  if (!row.member) return { tone: "none", label: "Not matched", title: "Not matched to a member", body: "No member was found for this charge. Respond from Stripe." };
  if (!row.isMembershipCharge || !ev) {
    return { tone: "none", label: "Not a membership charge", title: "Not a membership charge",
      body: "This charge is not a membership invoice, so the membership checklist does not apply. Respond from Stripe." };
  }
  const err = chargedInError(ev, row.chargedAt);
  if (err) return { tone: "error", label: "Weak · charged in error", title: "Weak · charged in error: consider accepting", body: `${err} Our own records say this charge should not have happened.` };
  const terms = !!ev.terms;
  const cancelOutcome = !!ev.cancel;
  const used = (ev.periodMatches?.length ?? 0) > 0;
  if (terms && (cancelOutcome || used)) {
    const parts = [
      ev.terms && !isOlderAppTerms(ev.terms) ? "They agreed to the charge text at signup" : "They agreed to the terms at signup (older app, no charge text saved)",
      cancelOutcome && ev.cancel ? `the app showed "${ev.cancel.outcome === "NO_MORE_CHARGES" ? "no more charges" : "one last charge"}" and they confirmed it` : null,
      used ? `they booked ${ev.periodMatches!.length} ${ev.periodMatches!.length === 1 ? "match" : "matches"} in the charged period` : null,
    ].filter(Boolean);
    return { tone: "strong", label: "Strong", title: "Strong case: fight it", body: parts.join("; ") + "." };
  }
  const why: string[] = [];
  if (!terms) why.push("no signup agreement on file");
  if (!cancelOutcome && !used) why.push(ev.periodMatches === null ? "usage in the charged period could not be read" : "no confirmed cancel outcome and no matches in the charged period");
  return { tone: "weak", label: "Weak", title: "Weak case", body: `Weak because there is ${why.join(", and ")}.` };
}

/** The packet for Stripe's evidence form, grouped by Stripe evidence field. Plain text, dates in Central. */
export function evidenceText(row: DisputeRow, ev: DisputeEvidence): string {
  const out: string[] = [];
  const section = (field: string, lines: (string | null | false | undefined)[]) => {
    const body = lines.filter(Boolean) as string[];
    if (body.length) out.push(`== ${field} ==\n${body.join("\n")}`);
  };
  const t = ev.terms;
  section("cancellation_policy_disclosure", [
    CANCELLATION_POLICY,
    t && !isOlderAppTerms(t) && `The member accepted the membership terms in the MatchDay app on ${centralDateTime(t.acceptedAt)}${t.termsVersion ? ` (terms version ${t.termsVersion})` : ""}${t.appVersion ? `, app version ${t.appVersion}` : ""}. The charge text shown and agreed to: "${t.chargeText}".`,
    t && isOlderAppTerms(t) && `The member agreed to the membership at signup in the MatchDay app on ${centralDateTime(t.acceptedAt)}${t.appVersion ? ` (app version ${t.appVersion})` : ""}. That app version did not save the charge text shown. Amounts agreed: ${money(t.firstChargeCents)} first charge, then ${money(t.monthlyChargeCents)} a month from ${centralDate(t.firstFullChargeAt)}, tax included.`,
    t && t.ipAddress && `Signup IP address: ${t.ipAddress}`,
    t && t.userAgent && `Signup device (user agent): ${t.userAgent}`,
  ]);

  const c = ev.cancel;
  const m = ev.membership;
  section("cancellation_rebuttal", [
    c && `The member cancelled in the app on ${centralDateTime(c.confirmedAt)}${c.cancelReason ? ` (reason given: "${c.cancelReason}")` : ""}. Before confirming, the app showed: ${c.outcome === "NO_MORE_CHARGES" ? "no more charges" : `one last charge${c.lastChargeBeforeTaxCents != null ? ` of ${money(c.lastChargeBeforeTaxCents)} plus tax` : ""}${c.lastChargeDate ? ` on ${ymdLabel(c.lastChargeDate)}` : ""}`}${c.endsAt ? `, membership ends ${ymdLabel(c.endsAt)}` : ""}. The member confirmed it${c.appVersion ? ` (app version ${c.appVersion})` : ""}.`,
    c && c.ipAddress && `Cancel IP address: ${c.ipAddress}`,
    c && c.userAgent && `Cancel device (user agent): ${c.userAgent}`,
    !c && m?.canceledAt && `The member cancelled in the app on ${centralDateTime(m.canceledAt)}${m.cancelReason ? ` (reason given: "${m.cancelReason}")` : ""}.`,
    !c && !m?.canceledAt && "The member did not cancel the membership before this charge.",
    row.chargedAt && `The disputed charge of ${money(row.amountCents)} was made on ${centralDate(row.chargedAt)}${ev.billingReason === "subscription_cycle" ? " as a monthly renewal" : ev.billingReason === "subscription_create" ? " as the first membership charge" : ""}.`,
    ev.refundsOnCharge !== null && (ev.refundsOnCharge > 0 ? `${money(ev.refundsOnCharge)} of this charge has been refunded.` : "No refund has been made on this charge."),
  ]);

  section("customer_communication", [
    ev.chats === null ? null
      : ev.chats.length === 0 ? "No support messages from this member on file."
      : `${ev.chats.length} support ${ev.chats.length === 1 ? "thread" : "threads"} with this member on file (${ev.chats.map((x) => `${x.channel ?? "message"} thread opened ${centralDate(x.createdAt)}${x.lastMessageAt ? `, last message ${centralDate(x.lastMessageAt)}` : ""}`).join("; ")}). Transcripts available on request.`,
  ]);

  section("service_date", [ev.period && `${centralDate(ev.period.start)} to ${centralDate(lastInstant(ev.period.end))}`]);

  section("uncategorized_text", [
    m?.joinedAt && `Membership started ${centralDate(m.joinedAt)}.`,
    ev.priorPaidCharges !== null && `${ev.priorPaidCharges} earlier membership ${ev.priorPaidCharges === 1 ? "charge was" : "charges were"} paid on this membership.`,
  ]);

  const pm = ev.periodMatches;
  section("access_activity_log", [
    pm && pm.length === 0 && ev.period && `No matches were booked between ${centralDate(ev.period.start)} and ${centralDate(lastInstant(ev.period.end))}.`,
    pm && pm.length > 0 && `Matches booked during the charged period:`,
    ...(pm ?? []).map((x) => `${centralDateTime(x.startUtc)} · ${x.field ?? "field"}${x.city ? `, ${x.city}` : ""} · ${x.checkedIn ? `checked in (${x.status === "LATE" ? "late" : "on time"})` : x.status === "NO_SHOW" ? "no-show" : "booked, not checked in"}`),
  ]);
  return out.join("\n\n");
}
