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
 * Flip to true only when Ryan confirms that deploy is live. Nothing else needs to change. */
export const STRIKE_BACKEND_FIX_LIVE = false;

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

/* ═══ THE NEXT COLUMN ═══════════════════════════════════════════════════════════════════════════
 * What happens next to this membership, from evidence only:
 *   Past        Stripe's ended_at (0261), else MatchDay's canceled_at, else just "Ended".
 *   Past due    the failed invoice's date and amount (stripe_member_unpaid_invoices).
 *   Cancelling  Stripe's scheduled end (0272: cancel_at, or current_period_end when
 *               cancel_at_period_end). If Stripe is not scheduled yet — the next invoice has not
 *               been paid, so the backend has not told Stripe — it says so instead of a date.
 *   Comped      not joined: no Stripe subscription exists until the player checks out.
 *   Current     the 1st of next month at the member's price. */
export type NextCell = { main: string; sub: string | null; tone: "plain" | "warn" | "bad" | "muted" };
export function nextCell(r: MemberRow, s: RowStripe | undefined, now: number, planCents: number | null): NextCell {
  const price = listPriceLabel(r, planCents);
  if (isPast(r)) {
    const at = s?.endedAt ?? r.canceledAt;
    return { main: at ? `Ended ${dayOrDateCT(at, now)}` : "Ended", sub: null, tone: "muted" };
  }
  if (isPastDue(r)) {
    return s?.failedAt
      ? { main: `Failed ${dayCT(s.failedAt)}`, sub: s.failedAmountCents != null ? usd(s.failedAmountCents) : price, tone: "bad" }
      : { main: "Payment failed", sub: "date not synced", tone: "bad" };
  }
  if (isCancelling(r)) {
    const end = scheduledEnd(s);
    if (end) return { main: `Ends ${dayCT(end)}`, sub: null, tone: "warn" };
    if (s?.endReadAt) return { main: "Cancelling", sub: "Stripe not scheduled yet", tone: "warn" };
    return { main: "Cancelling", sub: "end not read from Stripe yet", tone: "warn" };
  }
  if (isComped(r)) return { main: "Not joined", sub: "no Stripe subscription", tone: "muted" };
  return { main: nextFirstLabel(now), sub: price, tone: "plain" };
}

/** Stripe's own end for a cancelling subscription, or null when Stripe has not been told. */
export function scheduledEnd(s: RowStripe | undefined): string | null {
  if (!s) return null;
  if (s.cancelAt) return s.cancelAt;
  if (s.cancelAtPeriodEnd && s.currentPeriodEnd) return s.currentPeriodEnd;
  return null;
}

export const strikesLabel = (points: number): string => (points > 0 ? `${points} of ${STRIKE_LIMIT}` : "0");
export const owedLabel = (dollars: number): string => (dollars > 0 ? `$${dollars}` : "—");

/* ═══ SEARCH ═════════════════════════════════════════════════════════════════════════════════════
 * EVERY CITY AND EVERY STATUS, whatever the picker says (frame 6). Each word must match the name, the
 * email or the phone; a word made of digits also matches the phone's digits, so "512 555" finds
 * "(512) 555-0142" and "+15125550142" alike. Done in memory over loaded rows: the text never leaves
 * this process.
 *
 * ONE ROW PER PERSON. A player who rejoined has a CANCELED row and a newer one; the newest live
 * membership wins, else the newest ended one. */
export const SEARCH_MIN = 2;
export function searchMembers(rows: readonly MemberRow[], q: string, limit = 50): MemberRow[] {
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
export function searchSummary(hits: readonly MemberRow[], pickedCityName: string): string {
  const cities = new Set(hits.map((h) => h.city)).size;
  return `${hits.length} member${hits.length === 1 ? "" : "s"} in ${cities} cit${cities === 1 ? "y" : "ies"} · ${pickedCityName} selected`;
}

/* ═══ ONE PAGE OF ONE TAB ═══════════════════════════════════════════════════════════════════════ */
export const PAGE_SIZE = 25;
export function tabRows(rows: readonly MemberRow[], city: string, tab: Tab, now: number): MemberRow[] {
  return rows
    .filter((r) => r.city === city && inTab(r, tab, now))
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

/* ═══ CSV — THE CURRENT FILTER, EVERY PAGE OF IT ════════════════════════════════════════════════ */
export const CSV_HEADERS = [
  "Member ID", "First name", "Last name", "Email", "Phone", "City", "Status", "Since", "Days",
  "Next", "Price", "Strike points", "Suspended to", "Absent owed", "Cancelled at", "Cancel reason", "Comment",
];
const cell = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  // Formula-injection guard: a cell starting with = + - @ is read as a formula by spreadsheets.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export function membersCsv(rows: readonly MemberRow[], stripe: ReadonlyMap<number, RowStripe>, now: number, planCents: number | null): string {
  const lines = [CSV_HEADERS.map(cell).join(",")];
  for (const r of rows) {
    const n = nextCell(r, stripe.get(r.membershipId), now, planCents);
    lines.push([
      r.slug, r.firstName, r.lastName, r.email, r.phone, r.city, r.status, dateCT(r.activationDate),
      daysSince(r.activationDate, now), [n.main, n.sub].filter(Boolean).join(" · "),
      listPriceLabel(r, planCents), r.strikePoints, r.suspendedTo ? dateCT(r.suspendedTo) : "", r.absentOwed,
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
export function strikeFineTaxLine(taxRatePct: number | null): string {
  if (STRIKE_BACKEND_FIX_LIVE) return "no tax · clears strikes and suspension";
  return taxRatePct && taxRatePct > 0
    ? `plus ${trimPct(taxRatePct)}% tax · clears strikes and suspension`
    : "no tax rate set · clears strikes and suspension";
}
export const trimPct = (n: number): string => String(Math.round(n * 1000) / 1000);

/* ═══ STRIKE REMOVE — BUILT, AND OFF UNTIL THE SWITCH ═══════════════════════════════════════════
 * Wraps Player Lookup's own rule (strikeControl) so a strike that would be refused there reads the
 * same here. With the switch off, every Remove is disabled and says why. */
export function membersStrikeControl(base: { label: string; enabled: boolean; why: string }): { label: string; enabled: boolean; why: string } {
  if (!STRIKE_BACKEND_FIX_LIVE) return { label: base.label.replace(/^Remove \d+$/, "Remove"), enabled: false, why: STRIKE_REMOVE_OFF_REASON };
  return base;
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
