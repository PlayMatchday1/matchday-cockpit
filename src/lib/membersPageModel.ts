/* THE MEMBERS PAGE — every decision the page makes, kept pure so the gate can exercise it.
 *
 * Replaces Retool's MEMBERSHIPS page. The feature list is docs/retool/membership-inventory.md and
 * every backend fact cited here is in docs/matchday-api-facts.md, "Retool MEMBERSHIPS page, read
 * against backend 8965437 (2026-11-13)". Nothing in this file talks to a network or a database.
 *
 * ── WHERE THE ROWS COME FROM ─────────────────────────────────────────────────────────────────
 * Production: our mirror mdapi_subscriptions (synced from GET /admin/subscriptions). Staging: that
 * same list endpoint read directly, because the mirror holds production only. EITHER WAY, SEARCH IS
 * DONE HERE, over rows already loaded — never by sending the search text to MatchDay. The backend's
 * list query pastes `email` straight into $queryRawUnsafe (subscriptions.repository.ts:53-54).
 *
 * ── TIME ─────────────────────────────────────────────────────────────────────────────────────
 * Every instant here is TRUE UTC (activation, canceled_at, Stripe's dates, invoice dates) — none is a
 * match wall clock. They are printed in America/Chicago, never with a fixed offset. */

import { STRIKE_LIMIT } from "./playerLookupModel";

/* ═══ THE ONE SWITCH ════════════════════════════════════════════════════════════════════════════
 * Two things ship with the same backend deploy (Ryan, 2026-11-13), so they share one constant:
 *
 *  1. STRIKE REMOVE. Today removing a strike log while 4 or more points remain RESTARTS the 7-day
 *     suspension (strike.service.ts:51-57 at 8965437). The Remove button is built and stays disabled
 *     until the deploy that stops that is confirmed.
 *  2. THE STRIKE FINE'S TAX. Today the strike invoice carries the city's Stripe tax rate
 *     (createInvoiceForStrike, default_tax_rates). The card says "plus N% tax" until the deploy, then
 *     "no tax".
 *
 * FLIPPED ON 2026-11-13: Ryan confirmed the backend release is live in production (v407/v408) —
 * strike removals no longer restart a suspension, and strike fines carry no tax. Not re-read from
 * the backend source here; the statement is Ryan's. To turn both back off, set this to false: the
 * Members page and Player Lookup disable Remove and the strikes route refuses with 409 again. */
export const STRIKE_BACKEND_FIX_LIVE = true;

export const STRIKE_REMOVE_OFF_REASON =
  "Turned off until the backend deploy that stops a removal from restarting a suspension is confirmed.";

/* ═══ ROWS ═══════════════════════════════════════════════════════════════════════════════════════ */

/** One membership, normalised from either source. Prices: `priceDollars` is WHOLE DOLLARS because
 *  that is all the list endpoint carries — `(us.amount / 100)::INTEGER`, truncated
 *  (subscriptions.repository.ts:80). The exact cents come from the live player read in the panel. */
export type MemberRow = {
  membershipId: number;
  userId: number;
  city: string;               // city_identifier, e.g. "ATX"
  slug: string | null;        // "ATX38" — city_identifier ‖ user_sub_id
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  status: string;             // raw: ACTIVE | ADDED_FROM_ADMIN | CANCELED | PAST_DUE | …
  priceDollars: number | null;
  activationDate: string | null;
  canceledAt: string | null;
  cancelReason: string | null;
  comment: string | null;
  suspendedTo: string | null;
  strikePoints: number;
  absentOwed: number;         // whole dollars, the backend's own figure (repository :84-93)
};

/** Facts joined onto a row from our Stripe tables. All optional: a row the nightly job has not read
 *  yet simply has none, and the cell says so rather than inventing a date. */
export type RowStripe = {
  endStatus?: string | null;          // mdapi_subscription_stripe_end.stripe_status
  endedAt?: string | null;            // stripe_ended_at
  cancelAt?: string | null;           // stripe_cancel_at            (0272)
  cancelAtPeriodEnd?: boolean | null; // stripe_cancel_at_period_end (0272)
  currentPeriodEnd?: string | null;   // stripe_current_period_end   (0272)
  endReadAt?: string | null;          // fetched_at
  failedAt?: string | null;           // latest unpaid invoice created_at_utc
  failedAmountCents?: number | null;  // its amount_due_cents
  nextRetryAt?: string | null;        // its next_payment_attempt_utc
};

const up = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();
export const fullName = (r: Pick<MemberRow, "firstName" | "lastName">): string =>
  [r.firstName, r.lastName].map((x) => (x ?? "").trim()).filter(Boolean).join(" ") || "(no name)";

/* ═══ TABS ═══════════════════════════════════════════════════════════════════════════════════════
 * Current is everyone who has not ended: ACTIVE, ADDED_FROM_ADMIN and PAST_DUE. Cancelling, Past due
 * and Suspended are NARROWER views of Current, not partitions of it — frame 1 lists a cancelling, a
 * past-due and a suspended member inside Current, each with a chip. Past is CANCELED.
 *
 * Any other status MatchDay might return (INCOMPLETE, UNPAID, …) is not hidden: it lands in Current
 * with its raw status as the chip, because a row nobody can see is how a member gets billed by
 * mistake. The mirror holds none today. */
export type Tab = "current" | "cancelling" | "pastdue" | "suspended" | "past";
export const TABS: { tab: Tab; label: string }[] = [
  { tab: "current", label: "Current" },
  { tab: "cancelling", label: "Cancelling" },
  { tab: "pastdue", label: "Past due" },
  { tab: "suspended", label: "Suspended" },
  { tab: "past", label: "Past" },
];

export const isPast = (r: Pick<MemberRow, "status">) => up(r.status) === "CANCELED";
export const isCurrent = (r: Pick<MemberRow, "status">) => !isPast(r);
/** A player who pressed cancel in the app: status stays ACTIVE with canceled_at set
 *  (subscriptions.service.ts:543-559). Only ACTIVE counts — a PAST_DUE row is past due first. */
export const isCancelling = (r: Pick<MemberRow, "status" | "canceledAt">) => up(r.status) === "ACTIVE" && !!r.canceledAt;
export const isPastDue = (r: Pick<MemberRow, "status">) => up(r.status) === "PAST_DUE";
export const isComped = (r: Pick<MemberRow, "status">) => up(r.status) === "ADDED_FROM_ADMIN";
export const isSuspended = (r: Pick<MemberRow, "status" | "suspendedTo">, now: number) =>
  isCurrent(r) && !!r.suspendedTo && Date.parse(r.suspendedTo) > now;

export function inTab(r: MemberRow, tab: Tab, now: number): boolean {
  switch (tab) {
    case "current": return isCurrent(r);
    case "cancelling": return isCancelling(r);
    case "pastdue": return isPastDue(r);
    case "suspended": return isSuspended(r, now);
    case "past": return isPast(r);
  }
}

export function tabCounts(rows: readonly MemberRow[], now: number): Record<Tab, number> {
  const c: Record<Tab, number> = { current: 0, cancelling: 0, pastdue: 0, suspended: 0, past: 0 };
  for (const r of rows) for (const t of TABS) if (inTab(r, t.tab, now)) c[t.tab]++;
  return c;
}

/** The chip beside a name. One chip, the most urgent state first. */
export type Chip = { label: string; tone: "warn" | "bad" | "info" | "muted" } | null;
export function statusChip(r: MemberRow, now: number, planDollars: number | null): Chip {
  if (isPast(r)) return { label: "Past", tone: "muted" };
  if (isPastDue(r)) return { label: "Past due", tone: "bad" };
  if (isSuspended(r, now)) return { label: "Suspended", tone: "bad" };
  if (isCancelling(r)) return { label: "Cancelling", tone: "warn" };
  if (isComped(r)) return { label: "Comped", tone: "info" };
  if (up(r.status) !== "ACTIVE") return { label: up(r.status), tone: "info" };
  if (isCustomPrice(r, planDollars)) return { label: "Custom price", tone: "info" };
  return null;
}

/* ═══ PRICE, WHICH THE LIST ONLY KNOWS IN WHOLE DOLLARS ═════════════════════════════════════════
 * The list endpoint truncates (`(amount/100)::INTEGER`), so a $66.50 member reads 66. When a
 * member's whole dollars equal the city plan's whole dollars, the list shows the PLAN price, exact
 * from GET /admin/subscriptions/cities/{abbr}. Anyone else shows whole dollars and a Custom price
 * chip; the panel shows their exact amount from the live player read. This is an inference for the
 * list only, and the page footnote says so. */
export function isCustomPrice(r: Pick<MemberRow, "priceDollars">, planCents: number | null): boolean {
  if (r.priceDollars == null || planCents == null) return false;
  return r.priceDollars !== Math.trunc(planCents / 100);
}
export function listPriceLabel(r: Pick<MemberRow, "priceDollars">, planCents: number | null): string | null {
  if (r.priceDollars == null) return null;
  if (planCents != null && r.priceDollars === Math.trunc(planCents / 100)) return usd(planCents);
  return `$${r.priceDollars}`;
}
export const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

/* ═══ DATES ══════════════════════════════════════════════════════════════════════════════════════ */
const CT = "America/Chicago";
const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: CT, ...o });
export const dayCT = (iso: string | null | undefined): string =>
  iso && !Number.isNaN(Date.parse(iso)) ? fmt({ month: "short", day: "numeric" }).format(new Date(iso)) : "—";
/** "Dec 10" in the current Chicago year, "Dec 10, 2025" otherwise — a bare month and day from
 *  another year reads as this one. */
export const dayOrDateCT = (iso: string | null | undefined, now: number): string => {
  if (!iso || Number.isNaN(Date.parse(iso))) return "—";
  const y = (t: number) => fmt({ year: "numeric" }).format(new Date(t));
  return y(Date.parse(iso)) === y(now) ? dayCT(iso) : dateCT(iso);
};
export const dateCT = (iso: string | null | undefined): string =>
  iso && !Number.isNaN(Date.parse(iso)) ? fmt({ month: "short", day: "numeric", year: "numeric" }).format(new Date(iso)) : "—";

/** Whole days since the membership row was created — the same counter Retool's Membership Length
 *  shows (repository :79), computed here so it is current to the minute rather than the sync. */
export function daysSince(iso: string | null, now: number): number | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/** The 1st of next month in Chicago, as a Chicago calendar date. THE BILLING RULE, not an estimate
 *  (Ryan, 2026-11-13): every subscription anchors to the end of the month (stripe.service.ts
 *  billingCycleAnchor), so an active member who has not cancelled is next charged on the 1st. */
export function nextFirstLabel(now: number): string {
  const p = fmt({ year: "numeric", month: "numeric" }).formatToParts(new Date(now));
  const y = Number(p.find((x) => x.type === "year")?.value);
  const m = Number(p.find((x) => x.type === "month")?.value); // 1-12
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${MON[nm - 1]} 1${ny !== y ? `, ${ny}` : ""}`;
}
/** The same 1st as an instant, for sorting only: 6 AM UTC is the 1st in Chicago in any season. */
export function nextFirstIso(now: number): string {
  const p = fmt({ year: "numeric", month: "numeric" }).formatToParts(new Date(now));
  const y = Number(p.find((x) => x.type === "year")?.value);
  const m = Number(p.find((x) => x.type === "month")?.value);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01T06:00:00Z`;
}

/* ═══ THE NEXT PAYMENT COLUMN ═══════════════════════════════════════════════════════════════════
 * The date of the next charge, or what replaces it, from evidence only (Ryan, 2026-11-16: the date
 * only; the price has its own column now):
 *   Past        "Ended" + Stripe's ended_at (0261), else MatchDay's canceled_at, else just "Ended".
 *   Past due    "Retries" + Stripe's next attempt (stripe_member_unpaid_invoices); the failed charge
 *               underneath. No attempt scheduled says so.
 *   Cancelling  "Ends" + Stripe's scheduled end (0272: cancel_at, or current_period_end when
 *               cancel_at_period_end). If Stripe is not scheduled, it says so instead of a date.
 *               Since the Nov 13 2026 backend release an in-app cancel reaches Stripe at once (Ryan);
 *               before it, Stripe was told only after the next paid invoice.
 *   Comped, $0  "No charge".
 *   Current     the 1st of next month.
 * `at` is the instant the cell names, for sorting; null when it names none. */
export type NextCell = { main: string; sub: string | null; tone: "plain" | "warn" | "bad" | "muted"; at: string | null };
export function nextCell(r: MemberRow, s: RowStripe | undefined, now: number, _planCents?: number | null): NextCell {
  if (isPast(r)) {
    const at = s?.endedAt ?? r.canceledAt;
    return { main: at ? `Ended ${dayOrDateCT(at, now)}` : "Ended", sub: null, tone: "muted", at: at ?? null };
  }
  if (isPastDue(r)) {
    const failed = s?.failedAt ? `Failed ${dayCT(s.failedAt)}${s.failedAmountCents != null ? ` · ${usd(s.failedAmountCents)}` : ""}` : "failed charge not synced";
    return s?.nextRetryAt
      ? { main: `Retries ${dayCT(s.nextRetryAt)}`, sub: failed, tone: "bad", at: s.nextRetryAt }
      : { main: "No retry scheduled", sub: failed, tone: "bad", at: null };
  }
  if (isCancelling(r)) {
    const end = scheduledEnd(s);
    if (end) return { main: `Ends ${dayCT(end)}`, sub: null, tone: "warn", at: end };
    if (s?.endReadAt) return { main: "Cancelling", sub: "Stripe not scheduled", tone: "warn", at: null };
    return { main: "Cancelling", sub: "end not read from Stripe yet", tone: "warn", at: null };
  }
  if (isComped(r)) return { main: "No charge", sub: "added by staff", tone: "muted", at: null };
  if (r.priceDollars === 0) return { main: "No charge", sub: null, tone: "muted", at: null };
  return { main: nextFirstLabel(now), sub: null, tone: "plain", at: nextFirstIso(now) };
}

/* ═══ DURATION ═══════════════════════════════════════════════════════════════════════════════════
 * How long the membership has run: to now, or for a Past one to its end (the same end the Next
 * payment column names). Short (Ryan, 2026-11-16): days up to 60, then months, then years and months
 * from two years. A month is 30.4375 days, so the label never claims a month that has not passed. */
export function durationDays(r: MemberRow, s: RowStripe | undefined, now: number): number | null {
  const start = r.activationDate ? Date.parse(r.activationDate) : NaN;
  if (Number.isNaN(start)) return null;
  const endIso = isPast(r) ? (s?.endedAt ?? r.canceledAt) : null;
  const end = endIso && !Number.isNaN(Date.parse(endIso)) ? Date.parse(endIso) : now;
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}
export function durationLabel(days: number | null): string {
  if (days == null) return "—";
  if (days < 60) return `${days} day${days === 1 ? "" : "s"}`;
  const months = Math.floor(days / 30.4375);
  if (months < 24) return `${months} mo`;
  return `${Math.floor(months / 12)} yr${months % 12 ? ` ${months % 12} mo` : ""}`;
}

/* ═══ STAFF AND TEST ACCOUNTS ═══════════════════════════════════════════════════════════════════
 * Staff (@playmatchday.com) are shown in every list with a tag and stay out of the paying count
 * (membershipStats INTERNAL_EMAIL_RX). @matchday.com accounts are fake players, not members, and
 * never reach this page: loadMemberRows drops them (Ryan, 2026-11-16), so there is no Test tag. */
export type PersonTag = "Staff" | null;
export function personTag(email: string | null | undefined): PersonTag {
  return /@playmatchday\./i.test((email ?? "").trim()) ? "Staff" : null;
}

/* ═══ PAID SINCE START ═══════════════════════════════════════════════════════════════════════════
 * What this membership has actually been charged, net (Ryan, 2026-11-16): every paid membership
 * invoice for THIS membership id (stripe_member_invoices, tax included, as charged), minus refunds and
 * chargebacks on those charges (fin_txn refund and dispute rows, signed as Stripe signs them, so a
 * won dispute adds back). A rejoined member's earlier memberships are not counted, to match Since.
 * null where we hold no Stripe data (staging). */
export type PaidParts = { invoices: readonly { membershipId: number; cents: number; paymentIntent: string | null }[]; reversals: readonly { paymentIntent: string | null; cents: number }[] };
export function paidByMembership(p: PaidParts): Map<number, number> {
  const out = new Map<number, number>();
  const byPi = new Map<string, number>();
  for (const i of p.invoices) {
    out.set(i.membershipId, (out.get(i.membershipId) ?? 0) + i.cents);
    if (i.paymentIntent) byPi.set(i.paymentIntent, i.membershipId);
  }
  for (const r of p.reversals) {
    const m = r.paymentIntent ? byPi.get(r.paymentIntent) : undefined;
    if (m != null) out.set(m, (out.get(m) ?? 0) + r.cents);
  }
  return out;
}

/* ═══ ONE ROW AS THE TABLE SHOWS IT ═════════════════════════════════════════════════════════════ */
export type RowView = {
  name: string; tag: PersonTag; chip: Chip; next: NextCell; days: number | null; duration: string;
  listPrice: string | null; paidCents: number | null; hasComment: boolean;
  /** Priced off the city plan. Shown as its own chip beside the name whatever the status chip says. */
  custom: boolean;
};
export function rowView(r: MemberRow, s: RowStripe | undefined, paidCents: number | null, now: number, planCents: number | null): RowView {
  const days = durationDays(r, s, now);
  return {
    name: fullName(r), tag: personTag(r.email), chip: statusChip(r, now, planCents), next: nextCell(r, s, now, planCents),
    days, duration: durationLabel(days), listPrice: listPriceLabel(r, planCents), paidCents, hasComment: !!(r.comment ?? "").trim(),
    custom: isCustomPrice(r, planCents),
  };
}

/* ═══ SORTING — EVERY COLUMN, ACROSS EVERY PAGE ══════════════════════════════════════════════════
 * Done on the server over the whole tab (or the whole search), then paged. Empty values sort last
 * in either direction; ties fall back to the membership id so a page boundary never moves. */
export const SORT_KEYS = ["member", "city", "phone", "since", "duration", "price", "next", "paid", "strikes", "canceled", "reason", "comment"] as const;
/** The tabs that show Cancel date, Cancel reason and Comment, with Phone dropped to make room (Ryan, 2026-11-16). */
export const CANCEL_COL_TABS: readonly Tab[] = ["cancelling", "past"];
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = "asc" | "desc";
export type Sort = { key: SortKey; dir: SortDir };
export const isSortKey = (x: unknown): x is SortKey => SORT_KEYS.includes(x as SortKey);
/** The order a tab opens in: Since, oldest first; Past opens on its most recent ends. */
export const defaultSort = (tab: Tab): Sort => (tab === "past" ? { key: "next", dir: "desc" } : { key: "since", dir: "asc" });

type Sortable = MemberRow & Pick<RowView, "name" | "days" | "next" | "paidCents"> & { cityName?: string };
export function sortValue(v: Sortable, k: SortKey): string | number | null {
  switch (k) {
    case "member": return v.name.toLowerCase();
    case "city": return (v.cityName ?? v.city).toLowerCase();
    case "phone": { const d = (v.phone ?? "").replace(/\D/g, ""); return d || null; }
    case "since": { const t = Date.parse(v.activationDate ?? ""); return Number.isNaN(t) ? null : t; }
    case "duration": return v.days;
    case "price": return v.priceDollars;
    case "next": { const t = v.next.at ? Date.parse(v.next.at) : NaN; return Number.isNaN(t) ? null : t; }
    case "paid": return v.paidCents;
    case "strikes": return v.strikePoints;
    case "canceled": { const t = Date.parse(v.canceledAt ?? ""); return Number.isNaN(t) ? null : t; }
    case "reason": return (v.cancelReason ?? "").trim().toLowerCase() || null;
    case "comment": return (v.comment ?? "").trim().toLowerCase() || null;
  }
}
export function sortRows<T extends Sortable>(rows: readonly T[], sort: Sort): T[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const x = sortValue(a, sort.key), y = sortValue(b, sort.key);
    if (x == null || y == null) return x == null && y == null ? a.membershipId - b.membershipId : x == null ? 1 : -1;
    const c = typeof x === "string" && typeof y === "string" ? x.localeCompare(y) : (x as number) - (y as number);
    return c !== 0 ? sign * c : a.membershipId - b.membershipId;
  });
}

/** Stripe's own end for a cancelling subscription, or null when Stripe has not been told. */
export function scheduledEnd(s: RowStripe | undefined): string | null {
  if (!s) return null;
  if (s.cancelAt) return s.cancelAt;
  if (s.cancelAtPeriodEnd && s.currentPeriodEnd) return s.currentPeriodEnd;
  return null;
}

/* ═══ THE FINAL CHARGE OF A CANCELLING MEMBERSHIP ═════════════════════════════════════════════════
 * "Last charge" in the cancel callout means the LAST ONE THERE WILL BE, not the last one paid (Ryan,
 * 2026-11-13). Derived from Stripe's own dates, never from the cancel day:
 *   - Stripe's end is AFTER the current period end → the period end is a renewal still to come, and it
 *     is the final charge, at the price Stripe will charge (the item's unit amount) plus tax.
 *     (Cancels from Nov 6 on: cancel_at one month past the period end — facts doc, 2026-11-13.)
 *   - Otherwise (end at or before the period end: cancel_at_period_end) → no renewal remains, and the
 *     final charge is the last one paid.
 * A minute of slack absorbs the two boundary instants (04:59:59Z / 05:59:59Z) never being compared to
 * themselves wrongly; real gaps are a month. */
export type FinalCharge =
  | { kind: "upcoming"; at: string; cents: number | null }
  | { kind: "paid"; at: string; cents: number }
  | { kind: "unknown" };
export function finalCharge(end: string | null, periodEnd: string | null, upcomingCents: number | null, lastPaid: { cents: number; at: string } | null): FinalCharge {
  const e = end ? Date.parse(end) : NaN, p = periodEnd ? Date.parse(periodEnd) : NaN;
  if (!Number.isNaN(e) && !Number.isNaN(p) && e > p + 60_000) return { kind: "upcoming", at: periodEnd as string, cents: upcomingCents };
  if (!Number.isNaN(e) && lastPaid) return { kind: "paid", at: lastPaid.at, cents: lastPaid.cents };
  return { kind: "unknown" };
}
/** The renewal instant is the last second of the month in Central, so the charge lands on the 1st:
 *  the UTC date of that instant, which is how Stripe and the API name it ("Dec 1"). */
export function finalChargeLine(f: FinalCharge): string {
  if (f.kind === "upcoming") {
    const day = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(Date.parse(f.at) + 1000));
    return `Last charge ${f.cents != null ? `${usd(f.cents)} + tax` : "the current price + tax"} on ${day}, still to come`;
  }
  if (f.kind === "paid") return `Last charge ${usd(f.cents)} (incl. tax) on ${dayCT(f.at)}`;
  return "Last charge unknown";
}

export const strikesLabel = (points: number): string => (points > 0 ? `${points} of ${STRIKE_LIMIT}` : "0");

/* ═══ SEARCH ═════════════════════════════════════════════════════════════════════════════════════
 * EVERY CITY AND EVERY STATUS, whatever the picker says (frame 6). Each word must match the name, the
 * email or the phone; a word made of digits also matches the phone's digits, so "512 555" finds
 * "(512) 555-0142" and "+15125550142" alike. Done in memory over loaded rows: the text never leaves
 * this process.
 *
 * ONE ROW PER PERSON. A player who rejoined has a CANCELED row and a newer one; the newest live
 * membership wins, else the newest ended one. */
export const SEARCH_MIN = 2;
export function searchMembers(rows: readonly MemberRow[], q: string, limit = Infinity): MemberRow[] {
  const words = q.toLowerCase().split(/\s+/).map((w) => w.trim()).filter(Boolean);
  if (!words.length || q.trim().length < SEARCH_MIN) return [];
  const hits = rows.filter((r) => {
    const hay = `${r.firstName ?? ""} ${r.lastName ?? ""} ${r.email ?? ""} ${r.phone ?? ""} ${r.slug ?? ""}`.toLowerCase();
    const digits = (r.phone ?? "").replace(/\D/g, "");
    return words.every((w) => {
      if (hay.includes(w)) return true;
      // A word with no letters and three or more digits is a phone fragment: "(512)", "555-0142".
      if (/[a-z]/.test(w)) return false;
      const wd = w.replace(/\D/g, "");
      return wd.length >= 3 && digits.includes(wd);
    });
  });
  const best = new Map<number, MemberRow>();
  for (const r of hits) {
    const b = best.get(r.userId);
    if (!b || rank(r) > rank(b)) best.set(r.userId, r);
  }
  return [...best.values()].sort((a, b) => rank(b) - rank(a) || fullName(a).localeCompare(fullName(b))).slice(0, limit);
}
const rank = (r: MemberRow) => (isCurrent(r) ? 2e13 : 0) + (Date.parse(r.activationDate ?? "") || 0);

/** "3 members in 2 cities · Austin selected" — frame 6's summary line. */
export function searchSummary(hits: readonly MemberRow[], pickedCityName: string | null): string {
  const cities = new Set(hits.map((h) => h.city)).size;
  return `${hits.length} member${hits.length === 1 ? "" : "s"} in ${cities} cit${cities === 1 ? "y" : "ies"}${pickedCityName ? ` · ${pickedCityName} selected` : ""}`;
}

/* ═══ THE CITY PILLS (Ryan, 2026-11-16) ═════════════════════════════════════════════════════════
 * "All cities" first, then every city with Current members, biggest first. Each count IS that
 * city's Current tab count (tabCounts over the same rows), so a pill and its tab cannot disagree.
 * Cities come from the rows the route passes: MatchDay cities only (cityMap), so NYC and WAW members
 * have no pill and are not in All cities (Ryan, 2026-11-17). A confined account's own city is passed
 * as it is. Rows reaching here already exclude @matchday.com (loadMemberRows). */
export const ALL_CITIES = "ALL";
export type CityPill = { identifier: string; name: string; count: number };
/** A display name for any city identifier: the scope list's name, else the id. */
export function memberCityName(id: string, scopeName: (id: string) => string | null): string {
  return scopeName(id) ?? id;
}
export function cityPills(rows: readonly MemberRow[], now: number, nameOf: (id: string) => string): { all: number; cities: CityPill[] } {
  const by = new Map<string, MemberRow[]>();
  for (const r of rows) { const a = by.get(r.city); if (a) a.push(r); else by.set(r.city, [r]); }
  const cities = [...by.entries()]
    .map(([id, rs]) => ({ identifier: id, name: nameOf(id), count: tabCounts(rs, now).current }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { all: cities.reduce((n, c) => n + c.count, 0), cities };
}

/* ═══ ONE PAGE OF ONE TAB ═══════════════════════════════════════════════════════════════════════ */
export const PAGE_SIZE = 50;
export function tabRows(rows: readonly MemberRow[], city: string, tab: Tab, now: number): MemberRow[] {
  return rows
    .filter((r) => (city === ALL_CITIES || r.city === city) && inTab(r, tab, now))
    .sort((a, b) =>
      tab === "past"
        ? (Date.parse(b.canceledAt ?? "") || 0) - (Date.parse(a.canceledAt ?? "") || 0)
        : (Date.parse(a.activationDate ?? "") || 0) - (Date.parse(b.activationDate ?? "") || 0) || a.membershipId - b.membershipId);
}
export function pageOf<T>(rows: readonly T[], page: number, size = PAGE_SIZE): { rows: T[]; page: number; pages: number; total: number } {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  return { rows: rows.slice((p - 1) * size, p * size), page: p, pages, total: rows.length };
}

/** The page buttons: first, last, and two either side of the current one, with null for a gap. */
export function pageList(page: number, pages: number): (number | null)[] {
  const keep = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2].filter((n) => n >= 1 && n <= pages));
  const out: (number | null)[] = [];
  let last = 0;
  for (const n of [...keep].sort((a, b) => a - b)) { if (n - last > 1) out.push(null); out.push(n); last = n; }
  return out;
}
/** "1–50 of 167". */
export const rangeLabel = (page: number, total: number, size = PAGE_SIZE): string =>
  total ? `${((page - 1) * size + 1).toLocaleString()}–${Math.min(page * size, total).toLocaleString()} of ${total.toLocaleString()}` : "0 of 0";

/* ═══ CSV — THE CURRENT FILTER, EVERY PAGE OF IT ════════════════════════════════════════════════ */
/** The table's columns (Ryan, 2026-11-16), with the Member cell split into its parts so a sheet can
 *  filter on them, and the member id first so a row can be found again. Cancel date, Cancel reason and
 *  Comment go on the end (Ryan, 2026-11-16); the last two were in the export before the redesign.
 *  Cancel date is when the member cancelled (canceledAt), blank if they have not. */
export const CSV_HEADERS = [
  "Member ID", "Name", "Email", "Tag", "Status", "City", "Phone", "Since", "Duration", "Price",
  "Next payment", "Paid since start", "Strikes", "Cancel date", "Cancel reason", "Comment",
];
const cell = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  // Formula-injection guard: a cell starting with = + - @ is read as a formula by spreadsheets.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
/** Rows already viewed (rowView) and sorted, exactly as the table shows them, every page. */
export function membersCsv(rows: readonly (MemberRow & RowView & { cityName?: string })[]): string {
  const lines = [CSV_HEADERS.map(cell).join(",")];
  for (const r of rows) {
    lines.push([
      r.slug, r.name, r.email, r.tag ?? "", r.chip?.label ?? "", r.cityName ?? r.city, r.phone, dateCT(r.activationDate),
      r.duration, r.listPrice ?? "", [r.next.main, r.next.sub].filter(Boolean).join(" · "),
      r.paidCents != null ? usd(r.paidCents) : "", r.strikePoints,
      r.canceledAt ? dateCT(r.canceledAt) : "", r.cancelReason, r.comment,
    ].map(cell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/* ═══ CITY SETTINGS — THE REFUSALS ARE OURS ═════════════════════════════════════════════════════
 * MEMBER PRICE: POST /admin/subscriptions { name, price, cityAbbr } — the path Retool's Change Master
 * Price uses. New signups only; no existing Stripe subscription is touched
 * (createOrUpdateSubscription, subscriptions.service.ts:64-104). The API checks @IsNumber @Min(50)
 * and nothing about whole cents; a no-op returns early without a Stripe call, so we refuse it before
 * sending rather than log a write that did nothing. The ceiling is a typo guard ($4,900 for $49). */
export const PLAN_MIN_CENTS = 500;
export const PLAN_MAX_CENTS = 30000;
export function planPriceRefusal(cents: number | null, currentCents: number | null): string | null {
  if (cents == null || !Number.isFinite(cents)) return "Enter a price in dollars and cents, like 69.00.";
  if (!Number.isInteger(cents)) return "The price must be a whole number of cents.";
  if (cents < PLAN_MIN_CENTS) return `The price must be at least ${usd(PLAN_MIN_CENTS)}.`;
  if (cents > PLAN_MAX_CENTS) return `The price must be at most ${usd(PLAN_MAX_CENTS)}. Check for a typo.`;
  if (currentCents != null && cents === currentCents) return "That is already the price.";
  return null;
}
/** The Stripe Product name Retool sends: "<M/D/YYYY> <dollars>$". Kept so plans read the same in
 *  the Stripe dashboard whichever tool made them. */
export function planName(now: Date, cents: number): string {
  const d = new Intl.DateTimeFormat("en-US", { timeZone: CT }).format(now);
  const dollars = cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
  return `${d} ${dollars}$`;
}

/* STRIKE FINE: POST /admin/strikes/cities/{abbr} { price }. The backend validates NOTHING — the body
 * is an inline type with no DTO class (admin-strike.controller.ts:35-38). Ryan's rule: whole dollars,
 * $1 to $100. Sent as cents. */
export const FINE_MIN_DOLLARS = 1;
export const FINE_MAX_DOLLARS = 100;
export function strikeFineRefusal(input: string, currentCents: number | null): { cents: number | null; why: string | null } {
  const t = input.trim().replace(/^\$/, "");
  if (!/^\d+$/.test(t)) return { cents: null, why: "Enter whole dollars, like 20." };
  const dollars = Number(t);
  if (dollars < FINE_MIN_DOLLARS || dollars > FINE_MAX_DOLLARS) return { cents: null, why: `The fine must be between $${FINE_MIN_DOLLARS} and $${FINE_MAX_DOLLARS}.` };
  const cents = dollars * 100;
  if (currentCents != null && cents === currentCents) return { cents, why: "That is already the fine." };
  return { cents, why: null };
}

/** The strike fine's tax line — the second half of the one switch. */
export function strikeFineTaxLine(taxRatePct: number | null, live: boolean = STRIKE_BACKEND_FIX_LIVE): string {
  if (live) return "no tax · clears strikes and suspension";
  return taxRatePct && taxRatePct > 0
    ? `plus ${trimPct(taxRatePct)}% tax · clears strikes and suspension`
    : "no tax rate set · clears strikes and suspension";
}
export const trimPct = (n: number): string => String(Math.round(n * 1000) / 1000);

/* ═══ STRIKE REMOVE ═════════════════════════════════════════════════════════════════════════════
 * Wraps Player Lookup's own rule (strikeControl) so a strike that would be refused there reads the
 * same here. With the switch off, every Remove is disabled and says why. The Members row shows the
 * points as "+N" beside it (frame 1), so its label is just "Remove". */
export function membersStrikeControl(base: { label: string; enabled: boolean; why: string }, live: boolean = STRIKE_BACKEND_FIX_LIVE): { label: string; enabled: boolean; why: string } {
  const g = gateStrikeRemove(base, live);
  return { ...g, label: g.label.replace(/^Remove \d+$/, "Remove") };
}
/** THE SAME SWITCH FOR PLAYER LOOKUP (Ryan, 2026-11-13): its label is kept, only enabled/why change.
 *  The strikes route refuses too while the switch is off, so the button is not the only guard. */
export function gateStrikeRemove<T extends { enabled: boolean; why: string }>(base: T, live: boolean = STRIKE_BACKEND_FIX_LIVE): T {
  return live ? base : { ...base, enabled: false, why: STRIKE_REMOVE_OFF_REASON };
}

/** The strikes route's answer as the frame-5 result. One fact: MatchDay. A strike has no Stripe
 *  object. "Landed" is the route's own read-back (the log gone, or carrying zero points). */
export function strikeRemoveFacts(ok: boolean, res: {
  status?: string; error?: string; ambiguous?: boolean;
  before?: { activeStrikes: number; isSuspended: boolean }; after?: { activeStrikes: number; isSuspended: boolean };
}): { title: string; facts: Fact[]; allGood: boolean } {
  if (!ok) return { title: "Strike not removed", facts: [{ who: "MatchDay", state: res.ambiguous ? "unknown" : "bad", text: res.error ?? "The request failed." }], allGood: false };
  const b = res.before, a = res.after;
  const pts = b && a ? `${b.activeStrikes} → ${a.activeStrikes} of 4 points` : "points not read back";
  const susp = b && a ? (b.isSuspended && !a.isSuspended ? " · suspension lifted" : a.isSuspended ? " · still suspended" : "") : "";
  if (res.status === "LANDED") return { title: "Strike removed", facts: [{ who: "MatchDay", state: "ok", text: `${pts}${susp}` }], allGood: true };
  if (res.status === "NOT APPLIED") return { title: "Strike not removed", facts: [{ who: "MatchDay", state: "bad", text: "Reported success, but the strike is still there. Nothing was applied." }], allGood: false };
  return { title: "Strike removal unconfirmed", facts: [{ who: "MatchDay", state: "unknown", text: `Could not confirm from the player record (${pts}). Check before trying again.` }], allGood: false };
}

/* ═══ COMMENT ════════════════════════════════════════════════════════════════════════════════════
 * Stored in user_subscriptions.comment (TEXT). Written by PUT /api/v1/admin/user-subscriptions/{id}
 * { comment }. TWO RULES OF OURS:
 *   - CLEARING IS NOT A CHANGE. An empty box is refused, never sent — Retool's box opens empty for a
 *     member the player read drops and then wipes the stored comment on save.
 *   - A NO-OP IS NOT SENT. */
export const COMMENT_MAX = 1000;
export function commentRefusal(next: string, stored: string | null): string | null {
  const t = next.trim();
  if (!t) return "A comment can't be cleared from here. Type the new comment instead.";
  if (t.length > COMMENT_MAX) return `Keep it under ${COMMENT_MAX} characters.`;
  if ((stored ?? "").trim() === t) return "That is already the comment.";
  return null;
}

/* ═══ THE RESULT AFTER ANY WRITE (frame 5) — TWO FACTS, NEVER ONE VERDICT ═══════════════════════
 * MatchDay's row and Stripe are read separately. A row that moved proves nothing about billing:
 * the admin END path swallows a Stripe failure and marks the row anyway (cancelSubscriptionsForAdmin).
 * `absent` is not a failure — there is no Stripe object to check (a comp, a strike fine, a comment). */
export type FactState = "ok" | "bad" | "unknown" | "absent";
export type Fact = { who: "MatchDay" | "Stripe"; state: FactState; text: string };
export type StripeVerdict = "moved" | "unchanged" | "absent" | "unreadable";

export function twoFacts(
  action: "end" | "price" | "plan" | "fine" | "comment",
  row: "moved" | "unchanged" | "unknown",
  stripe: StripeVerdict,
  subscriptionId: string | null,
  detail: { reason?: string; cents?: number } = {},
): { title: string; facts: Fact[]; allGood: boolean } {
  const id = subscriptionId ?? "the subscription";
  const titles = { end: "Membership ended", price: "Price changed", plan: "Member price changed", fine: "Strike fine changed", comment: "Comment saved" } as const;
  const failTitles = { end: "Membership not ended", price: "Price not changed", plan: "Member price not changed", fine: "Strike fine not changed", comment: "Comment not saved" } as const;

  const md: Fact = row === "moved"
    ? { who: "MatchDay", state: "ok", text:
        action === "end" ? `Status CANCELED${detail.reason ? " · reason saved" : ""}`
        : action === "price" ? `Amount now ${detail.cents != null ? usd(detail.cents) : "the new price"}`
        : action === "plan" ? `City plan now ${detail.cents != null ? usd(detail.cents) : "the new price"} · new signups only`
        : action === "fine" ? `Strike fine now ${detail.cents != null ? usd(detail.cents) : "the new amount"}`
        : "Comment stored" }
    : row === "unchanged"
      ? { who: "MatchDay", state: "bad", text: "Reported success, but the record did not change. Nothing was applied." }
      : { who: "MatchDay", state: "unknown", text: "Could not read the record back, so whether it changed is UNKNOWN. Check before trying again." };

  const st: Fact =
    stripe === "absent"
      ? { who: "Stripe", state: "absent", text:
          action === "fine" ? "No Stripe object: the fine is charged at the price current when a player pays"
          : action === "comment" ? "Nothing in Stripe"
          : "No Stripe subscription behind this membership" }
      : stripe === "moved"
        ? { who: "Stripe", state: "ok", text:
            action === "end" ? `${id} canceled · no more charges`
            : action === "plan" ? `New monthly price ${id} at the new amount · existing subscriptions untouched`
            : `${id} now charges the new amount` }
        : stripe === "unchanged"
          ? { who: "Stripe", state: "bad", text:
              action === "end" ? `${id} is STILL LIVE and still billing. Cancel it in Stripe by hand.`
              : action === "plan" ? `The new price was not found on ${id}. Check the plan in Stripe.`
              : `${id} still carries the old amount. Fix it in Stripe by hand.` }
          : { who: "Stripe", state: "unknown", text: `Could not read ${id}. Check it in Stripe.` };

  const facts = action === "comment" || action === "fine" ? [md] : [md, st];
  const allGood = facts.every((f) => f.state === "ok" || f.state === "absent");
  return { title: row === "moved" ? (allGood ? titles[action] : `${titles[action]}, with a problem`) : failTitles[action], facts, allGood };
}

/** The verdict routes return ({ row, stripe, subscriptionId }) mapped to the frame-5 facts. */
export function factsFromVerdict(
  action: "end" | "price",
  res: { status?: string; verdict?: { row?: string; stripe?: string; subscriptionId?: string | null } | null },
  detail: { reason?: string; cents?: number } = {},
) {
  const v = res.verdict ?? null;
  const row = !v ? "unknown" : v.row === "moved" ? "moved" : "unchanged";
  const s = (v?.stripe ?? "unreadable") as StripeVerdict;
  return twoFacts(action, res.status === "UNKNOWN" && !v ? "unknown" : row, s, v?.subscriptionId ?? null, detail);
}

/** End is immediate and refunds nothing — the confirm says so in words (frame 4). A player who has
 *  already cancelled is told their own end date, so ending now is a choice, not a formality. */
export function endConfirmCopy(name: string, cancelledInApp: boolean, cancellingEnd: string | null): string {
  const base = "Cancels in Stripe immediately. No refund, and member pricing stops today.";
  if (!cancelledInApp) return base;
  const first = name.split(" ")[0] || "This member";
  return cancellingEnd
    ? `${base} ${first} already cancelled in the app, so the membership ends ${dayCT(cancellingEnd)} on its own.`
    : `${base} ${first} already cancelled in the app; Stripe has not scheduled the end yet.`;
}
