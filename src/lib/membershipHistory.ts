// MEMBERSHIP HISTORY — one player's memberships, renewals, price changes, cancellations and refunds,
// built from what docs/matchday-api-facts.md "Membership history sources" (2026-11-07) proved we hold.
// PURE: no I/O, no clock of its own (`now` is passed), so scripts/membership-history-test.ts can feed
// it fixtures. The read is src/app/api/lookup/[env]/membership-history/route.ts.
//
// THE SOURCES, AND WHAT EACH ONE IS ALLOWED TO SAY
//   mdapi_subscriptions     one row per membership (a rejoin is a NEW row). activation_date and
//                           canceled_at are TRUE UTC (ORM-written) → displayed in America/Chicago.
//                           price is whole dollars and the CURRENT plan only (no price history).
//   stripe_member_invoices  PAID invoices. amount_paid_cents includes tax; attempt_count (0262) > 1 means
//                           the renewal failed attempt_count − 1 times before it was paid.
//   stripe_member_unpaid_invoices  (0262) renewals Stripe was NOT paid for: open (still retrying, or
//                           stopped), uncollectible, void — with attempts and the last failure code.
//                           A month with neither a paid nor an unpaid invoice is "no charge".
//   fin_txn refunds         linked to an invoice by charge → payment intent → invoice (all 21
//                           Membership refunds linked that way, 2026-11-07). fin_txn starts
//                           2024-03-01, so a refund of an earlier charge cannot be linked.
//   live profile            GET /admin/players/{id}: current status, price (cents, pre-tax) and the
//                           period end. It returns the CURRENT membership only, never history.
//
// TWO CLOCKS, ON PURPOSE (each is the one the source means):
//   · subscription_cycle invoices are created on the 1st between 05:00 and 06:59 UTC (all 7,715,
//     measured 2026-11-07) — that is the last hour of the previous month in Central half the year.
//     Their billing month is therefore the UTC month, the same boundary currentPeriodEnd names.
//   · everything a person did (joined, asked to cancel, a subscription_create invoice) is an instant,
//     shown in America/Chicago.
//   Match dates' wall-clock-labelled-Z model is NOT used anywhere in this file.
//
// END DATES, in this order (Ryan, 2026-11-07):
//   1. Removed by staff in Retool → the removal date (canceled_at). Retool's unsubscribe cancels the
//      Stripe subscription at once (backend cancelSubscriptionsForAdmin), so it ended that day.
//   2. Stripe's ended_at, where mdapi_subscription_stripe_end (0261) holds it → exact.
//   3. Otherwise "ended about" the 1st of the month after the last paid month, "(estimated)". MatchDay
//      records no end date, so this is only ever a fallback.

export type SubRow = {
  membership_id: number;
  status: string | null;
  price: number | null;
  activation_date: string | null;
  canceled_at: string | null;
  cancel_reason: string | null;
  /** From mdapi_subscription_stripe_end (0261) when Stripe has been asked; absent otherwise. */
  stripe_ended_at?: string | null;
  stripe_status?: string | null;
};
export type InvoiceRow = {
  md_membership_id: number;
  amount_paid_cents: number;
  billing_reason: string | null;
  created_at_utc: string;
  payment_intent_id: string | null;
  /** 0262: Stripe's attempt_count on the paid invoice; null until the sync has read it. */
  attempt_count?: number | null;
};
/** 0262: a membership invoice Stripe has not been paid for. */
export type UnpaidRow = {
  md_membership_id: number;
  amount_due_cents: number;
  status: "open" | "uncollectible" | "void" | string;
  billing_reason: string | null;
  attempt_count: number | null;
  next_payment_attempt_utc: string | null;
  last_failure_code: string | null;
  created_at_utc: string;
};
/** A Membership refund already resolved to the payment intent of the charge it refunds. `cents` is positive. */
export type RefundRow = { payment_intent_id: string; cents: number; created_at_utc: string };
/** From the live profile (playerProfile.ts `membership`). `priceCents` is `amount`, pre-tax. */
export type LiveMembership = {
  id: number | null;
  statusRaw: string | null;
  canceledAt: string | null;
  renews: string | null;
  priceCents: number | null;
} | null;

export type CellKind = "first" | "paid" | "none" | "refunded" | "failed";
export type StripCell = { ym: string; label: string; kind: CellKind; title: string };
export type Tone = "green" | "amber" | "red" | "grey";
export type HistEvent = { key: string; tone: Tone; title: string; sub?: string; quote?: string };
export type BlockState = "active" | "cancelling" | "ended" | "past_due" | "comp" | "other";
export type MembershipBlock = {
  n: number;
  membershipId: number;
  state: BlockState;
  badge: string;
  range: string;
  strip: StripCell[];
  events: HistEvent[];
  /** How an ended membership ended: an instant, whether it is exact, and the words for it. */
  end: BlockEnd | null;
  activation: string | null;
};
export type BlockEnd = { iso: string; exact: boolean; source: "retool" | "stripe" | "estimate"; label: string };
export type HistItem = { type: "membership"; block: MembershipBlock } | { type: "gap"; text: string };
export type NowTone = "ok" | "warn" | "bad" | "none";
export type History = {
  never: boolean;
  now: { title: string; tone: NowTone; badge: string | null; sub: string; sub2: string | null };
  summary: {
    memberSince: string | null;
    memberships: number;
    monthsPaid: number;
    monthsSinceJoining: number;
    totalPaidCents: number;
    refundedCents: number;
    totalCaption: string;
  };
  /** Newest membership first, with a gap line between two memberships where one ended. */
  items: HistItem[];
  notices: string[];
  footer: string;
};

const TZ = "America/Chicago";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** fin_txn's first row is 2024-03-01T07:01Z: a refund of a charge made before then cannot be linked. */
export const REFUND_LINK_FROM = "2024-03-01T00:00:00Z";
export const RETOOL_REASON = "removed by retool";
/** A first invoice at or under this is the signup promo ($1 plus tax, $1.08 to $1.10 measured). */
export const PROMO_MAX_CENTS = 200;

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
export const money = (cents: number): string =>
  `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function partsIn(iso: string, tz: string): { y: number; m: number; d: number } {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}
const ymOf = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
export const ymChicago = (iso: string) => { const p = partsIn(iso, TZ); return ymOf(p.y, p.m); };
export const ymUtc = (iso: string) => { const d = new Date(iso); return ymOf(d.getUTCFullYear(), d.getUTCMonth() + 1); };
/** The billing month an invoice belongs to (see TWO CLOCKS in the header). */
export const invoiceYm = (inv: InvoiceRow) =>
  inv.billing_reason === "subscription_cycle" ? ymUtc(inv.created_at_utc) : ymChicago(inv.created_at_utc);
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const i = y * 12 + (m - 1) + n;
  return ymOf(Math.floor(i / 12), (i % 12) + 1);
}
const monthsBetween = (a: string, b: string) => {
  const [ya, ma] = a.split("-").map(Number), [yb, mb] = b.split("-").map(Number);
  return (yb - ya) * 12 + (mb - ma);
};
const mon = (ym: string) => MONTHS[Number(ym.slice(5, 7)) - 1];
const monYear = (ym: string) => `${mon(ym)} ${ym.slice(0, 4)}`;
const monthName = (ym: string) => MONTH_NAMES[Number(ym.slice(5, 7)) - 1];
const firstOf = (ym: string) => `${mon(ym)} 1, ${ym.slice(0, 4)}`;
/** A person's action, in Central: "Jan 24, 2026". */
export const dateCT = (iso: string | null) => {
  const t = ms(iso);
  if (t == null) return "—";
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: TZ });
};
/** A billing boundary (currentPeriodEnd), in UTC so it names the day Stripe and the API name: "Dec 1". */
export const boundaryDay = (iso: string | null) => {
  const t = ms(iso);
  if (t == null) return "—";
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
};
/* STRIPE'S ENDED_AT HAS TWO SHAPES (2,604 read 2026-11-07). 938 are a BILLING BOUNDARY, exactly
 * 04:59:59 or 05:59:59 UTC on the 1st: a cancel that ran to the period end. That instant is the last
 * second of the month in Central, so Central prints "Jul 31" for a membership that ran to "Aug 1" — the
 * same trap as currentPeriodEnd, printed the same way (UTC). Every other ended_at is a moment something
 * happened (a renewal Stripe gave up on, an immediate cancel) and prints in Central like canceled_at. */
export const isBillingBoundary = (iso: string | null) => {
  const t = ms(iso);
  if (t == null) return false;
  const d = new Date(t);
  return d.getUTCDate() === 1 && d.getUTCSeconds() === 59 && d.getUTCMinutes() === 59 && (d.getUTCHours() === 4 || d.getUTCHours() === 5);
};
const stripeEndDay = (iso: string) => isBillingBoundary(iso)
  ? new Date(Date.parse(iso)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
  : dateCT(iso);
const stripeEndYm = (iso: string) => (isBillingBoundary(iso) ? ymUtc(iso) : ymChicago(iso));
const FAILURE_WORDS: Record<string, string> = {
  card_declined: "card declined", generic_decline: "card declined", do_not_honor: "card declined by the bank",
  insufficient_funds: "insufficient funds", expired_card: "card expired", incorrect_cvc: "wrong security code",
  lost_card: "card reported lost", stolen_card: "card reported stolen", processing_error: "processing error at the bank",
  authentication_required: "the bank asked for authentication", card_not_supported: "card not supported",
  transaction_not_allowed: "card blocked this payment", try_again_later: "the bank asked to try again later",
};
/** Stripe's failure code in words ("card_declined" → "card declined"); unknown codes keep their own words. */
export const failureWords = (code: string | null | undefined) => (code ? FAILURE_WORDS[code] ?? code.replace(/_/g, " ") : null);
const times = (n: number) => `${n} time${n === 1 ? "" : "s"}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
export const isRetool = (reason: string | null) => (reason ?? "").trim().toLowerCase() === RETOOL_REASON;

function stateOf(r: SubRow): BlockState {
  const s = (r.status ?? "").toUpperCase();
  if (s === "ADDED_FROM_ADMIN") return "comp";
  if (s === "PAST_DUE") return "past_due";
  if (s === "CANCELED") return "ended";
  if (s === "ACTIVE") return r.canceled_at ? "cancelling" : "active";
  return "other";
}
const BADGE: Record<BlockState, string> = {
  active: "ACTIVE", cancelling: "CANCELLING", ended: "ENDED", past_due: "PAST DUE", comp: "COMPED", other: "",
};

/** "Pays per match. 23 matches played since Mar 2026." — the never-a-member line (frame 20865:285). */
export function neverMemberLine(played: number, firstPlayedWallClock: string | null): string {
  if (played <= 0) return "Pays per match. No matches played yet.";
  // Match dates are WALL CLOCK labelled Z: read the month in UTC so it is the clock the API meant.
  const since = firstPlayedWallClock && ms(firstPlayedWallClock) != null ? ` since ${monYear(ymUtc(firstPlayedWallClock))}` : "";
  return `Pays per match. ${played} ${played === 1 ? "match" : "matches"} played${since}.`;
}

type Built = { block: MembershipBlock; lastPaidYm: string | null; regular: number | null; canceledAt: string | null; reason: string | null; unpaid: UnpaidRow[] };

function buildBlock(n: number, r: SubRow, invs: InvoiceRow[], refundsByPi: Map<string, number>, live: LiveMembership, unpaidIn: UnpaidRow[] = []): Built {
  const state = stateOf(r);
  const sorted = [...invs].sort((a, b) => a.created_at_utc.localeCompare(b.created_at_utc));
  const cycles = sorted.filter((i) => i.billing_reason === "subscription_cycle" && i.amount_paid_cents > 0);
  const regular = cycles.length ? cycles[cycles.length - 1].amount_paid_cents : null;
  const create = sorted.find((i) => i.billing_reason === "subscription_create") ?? null;
  const paidYms = sorted.filter((i) => i.amount_paid_cents > 0).map(invoiceYm);
  const lastPaidYm = paidYms.length ? paidYms.reduce((a, b) => (a > b ? a : b)) : null;
  const isLive = live != null && live.id != null && live.id === r.membership_id;
  // Unpaid renewals that count as failed: open ones, and uncollectible/void ones Stripe attempted.
  const unpaid = [...unpaidIn].filter((u) => u.status === "open" || (u.attempt_count ?? 0) > 0)
    .sort((a, b) => a.created_at_utc.localeCompare(b.created_at_utc));
  const unpaidYm = (u: UnpaidRow) => (u.billing_reason === "subscription_cycle" ? ymUtc(u.created_at_utc) : ymChicago(u.created_at_utc));

  // ── the month strip: first to last invoice month ──
  const strip: StripCell[] = [];
  if (sorted.length || unpaid.length) {
    const yms = [...sorted.map(invoiceYm), ...unpaid.map(unpaidYm)];
    const lo = yms.reduce((a, b) => (a < b ? a : b)), hi = yms.reduce((a, b) => (a > b ? a : b));
    for (let ym = lo; ym <= hi; ym = addMonths(ym, 1)) {
      const here = sorted.filter((i) => invoiceYm(i) === ym);
      const paid = here.filter((i) => i.amount_paid_cents > 0);
      const refunded = here.reduce((s, i) => s + (i.payment_intent_id ? refundsByPi.get(i.payment_intent_id) ?? 0 : 0), 0);
      const charged = paid.reduce((s, i) => s + i.amount_paid_cents, 0);
      const first = paid.some((i) => i.billing_reason === "subscription_create");
      const failedHere = unpaid.filter((u) => unpaidYm(u) === ym);
      const kind: CellKind = refunded > 0 ? "refunded" : first ? "first" : paid.length ? "paid" : failedHere.length ? "failed" : "none";
      const title = kind === "none" ? `${monYear(ym)}: no charge`
        : kind === "failed" ? `${monYear(ym)}: not paid (${money(failedHere[0].amount_due_cents)} due)`
        : kind === "refunded" ? `${monYear(ym)}: paid ${money(charged)}, refunded ${money(refunded)}`
        : `${monYear(ym)}: ${first ? "first charge" : "paid"} ${money(charged)}`;
      strip.push({ ym, label: mon(ym), kind, title });
    }
  }
  const noCharge = strip.filter((c) => c.kind === "none").length;
  const notPaid = strip.filter((c) => c.kind === "failed").length;

  const events: HistEvent[] = [];
  // 1. Joined
  {
    const again = n > 1 ? "Joined again" : "Joined";
    const subParts = [dateCT(r.activation_date)];
    let title = again;
    if (create) {
      title = `${again} · first charge ${money(create.amount_paid_cents)}`;
      if (create.amount_paid_cents === 0) subParts.push("no charge for the first invoice");
      // Against the regular charge AT THE TIME (the first renewal), never the latest one: a full-price
      // signup at $53.04 before a rise to $71.99 is not a discount (production, player 60178).
      else if (cycles.length && create.amount_paid_cents < cycles[0].amount_paid_cents) {
        subParts.push(create.amount_paid_cents <= PROMO_MAX_CENTS ? "signup promo" : "first month discounted");
      }
    } else if (!sorted.length) {
      subParts.push(state === "comp" ? "added by staff" : "no paid invoice on record");
    }
    events.push({ key: "joined", tone: "green", title, sub: subParts.join(" · ") });
  }
  // 2. Price changes: the regular (cycle) charge moving between consecutive renewals
  for (let i = 1; i < cycles.length; i++) {
    const a = cycles[i - 1].amount_paid_cents, b = cycles[i].amount_paid_cents;
    if (a === b) continue;
    events.push({
      key: `price-${i}`, tone: "amber",
      title: `Price went ${b > a ? "up" : "down"}: ${money(a)} → ${money(b)} a month`,
      sub: `From the ${monYear(invoiceYm(cycles[i]))} charge (includes tax)`,
    });
  }
  // 2b. Failed payments (0262): retried then paid, and not paid
  for (const v of sorted) {
    const a = v.attempt_count ?? 0;
    if (a <= 1 || v.amount_paid_cents <= 0) continue;
    const what = v.billing_reason === "subscription_create" ? "First charge" : "Renewal";
    events.push({ key: `retried-${v.created_at_utc}`, tone: "amber", title: `${what} failed ${times(a - 1)}, then paid`, sub: `${monYear(invoiceYm(v))} · ${money(v.amount_paid_cents)}` });
  }
  for (const u of unpaid) {
    const a = u.attempt_count ?? 0;
    const what = u.billing_reason === "subscription_create" ? "First charge" : `${monthName(unpaidYm(u))} renewal`;
    const why = failureWords(u.last_failure_code);
    const state = u.status === "open"
      ? (ms(u.next_payment_attempt_utc) != null ? `Stripe retries next on ${dateCT(u.next_payment_attempt_utc)}` : "Stripe has stopped retrying")
      : u.status === "uncollectible" ? "Stripe marked it uncollectible" : "The invoice was voided";
    events.push({
      key: `unpaid-${u.created_at_utc}`, tone: "red",
      title: a > 0 ? `${what} failed ${times(a)}, not paid` : `${what} not paid yet`,
      sub: [`${money(u.amount_due_cents)} due`, why ? `last: ${why}` : null, state].filter(Boolean).join(" · "),
    });
  }
  // 3. Renewals, on a membership still running
  if (state === "active" || state === "cancelling" || state === "past_due") {
    const next = isLive && state === "active" && live?.renews ? ` · next ${boundaryDay(live.renews)}` : "";
    const missed = [noCharge ? `${plural(noCharge, "month")} with no charge` : null, notPaid ? `${plural(notPaid, "month")} not paid` : null].filter(Boolean).join(", ") || "none missed";
    if (regular != null) {
      events.push({ key: "renews", tone: "green", title: `Renews monthly at ${money(regular)}`, sub: `${plural(cycles.length, "renewal")} paid, ${missed}${next}` });
    } else if (state === "active") {
      events.push({ key: "renews", tone: "green", title: "Renews monthly", sub: `No renewal paid yet${next}` });
    }
  }
  // 4. How it ended (see END DATES in the header)
  const retool = state === "ended" && !!r.canceled_at && isRetool(r.cancel_reason);
  const stripeEnd = state === "ended" && !retool && ms(r.stripe_ended_at) != null ? (r.stripe_ended_at as string) : null;
  let end: BlockEnd | null = null;
  if (retool) end = { iso: r.canceled_at as string, exact: true, source: "retool", label: `Removed by staff in Retool on ${dateCT(r.canceled_at)}` };
  else if (stripeEnd) end = { iso: stripeEnd, exact: true, source: "stripe", label: `Ended ${stripeEndDay(stripeEnd)}` };
  else if (state === "ended" && lastPaidYm) {
    const ym = addMonths(lastPaidYm, 1);
    end = { iso: `${ym}-01T12:00:00.000Z`, exact: false, source: "estimate", label: `Ended about ${firstOf(ym)}` };
  }

  // 5. Cancellation
  if (retool) {
    events.push({ key: "cancel", tone: "red", title: end!.label, sub: "No reason was recorded." });
  } else if (r.canceled_at) {
    const reason = (r.cancel_reason ?? "").trim();
    events.push(reason
      ? { key: "cancel", tone: "red", title: `Asked to cancel · ${dateCT(r.canceled_at)}`, quote: reason }
      : { key: "cancel", tone: "red", title: `Asked to cancel · ${dateCT(r.canceled_at)}`, sub: "No reason given." });
  } else if (state === "ended" && !stripeEnd) {
    events.push({ key: "cancel", tone: "grey", title: "Cancelled, with no date on record", sub: "MatchDay records no cancel date or reason when Stripe ends a membership." });
  }
  // 6. How it stands now
  if (state === "ended" && !retool) {
    if (end?.source === "stripe") {
      events.push({
        key: "ended", tone: "grey", title: end.label,
        sub: r.canceled_at ? "Date from Stripe" : "Date from Stripe. MatchDay has no cancel date or reason for this membership.",
      });
    } else if (end && lastPaidYm) {
      events.push({
        key: "ended", tone: "grey", title: `${end.label} (estimated)`,
        sub: r.canceled_at
          ? `Last paid month was ${monthName(lastPaidYm)}; MatchDay doesn't record the end date`
          : `No cancel date on record, so this is estimated the same way: last paid month was ${monthName(lastPaidYm)} ${lastPaidYm.slice(0, 4)}`,
      });
    } else {
      events.push({ key: "ended", tone: "grey", title: "End date unknown", sub: "There is no paid invoice to estimate it from." });
    }
  } else if (state === "cancelling") {
    events.push(isLive && live?.renews
      ? { key: "ending", tone: "grey", title: `Runs to ${boundaryDay(live.renews)}`, sub: "Still active at MatchDay until the end of the paid period." }
      : { key: "ending", tone: "grey", title: "Runs to the end of the paid period", sub: "Still active at MatchDay; the period end isn't in our records." });
  } else if (state === "past_due") {
    // With Stripe's open invoice on record the line above already says it, attempts and all.
    if (!unpaid.some((u) => u.status === "open")) events.push({ key: "pastdue", tone: "red", title: "Payment overdue", sub: pastDueLine(lastPaidYm, unpaid) });
  } else if (state === "comp") {
    events.push({ key: "comp", tone: "grey", title: "Added by staff as a comp", sub: "Never charged: there is no Stripe subscription behind it." });
  }

  const start = dateCT(r.activation_date);
  const range = state === "ended"
    ? `${start} to ${end ? (end.source === "stripe" ? stripeEndDay(end.iso) : end.exact ? dateCT(end.iso) : `about ${firstOf(ymUtc(end.iso))}`) : "an unknown date"}`
    : `${start} to now`;
  return {
    unpaid,
    block: { n, membershipId: r.membership_id, state, badge: BADGE[state] || (r.status ?? "").toUpperCase(), range, strip, events, end, activation: r.activation_date },
    lastPaidYm, regular, canceledAt: r.canceled_at, reason: r.cancel_reason,
  };
}

function gapText(prev: Built, cur: Built): string | null {
  const end = prev.block.end;
  if (prev.block.state !== "ended" || !end) return null;
  const curT = ms(cur.block.activation);
  if (curT == null) return null;
  const endT = Date.parse(end.iso);
  const days = (curT - endT) / 86_400_000;
  if (days < 0) return end.exact ? "Joined again before the last membership ended" : "Joined again before the last membership's estimated end";
  // Two exact dates under 60 days apart: say the days, not "about 1 month (Oct to late-Oct)".
  if (end.exact && days < 60) {
    const d = Math.round(days);
    const short = (iso: string) => new Date(Date.parse(iso)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: end.source === "stripe" && isBillingBoundary(iso) ? "UTC" : TZ });
    return d < 1 ? "Joined again the day the last membership ended"
      : `Not a member for ${d} day${d === 1 ? "" : "s"} (${short(end.iso)} to ${dateCT(cur.block.activation)})`;
  }
  const months = Math.round(days / 30.44);
  if (months < 1) return "Joined again within a month of the last membership ending";
  const p = partsIn(cur.block.activation as string, TZ);
  const curYm = ymOf(p.y, p.m);
  const part = p.d <= 10 ? "early" : p.d <= 20 ? "mid" : "late";
  const endYm = end.source === "stripe" ? stripeEndYm(end.iso) : end.exact ? ymChicago(end.iso) : ymUtc(end.iso);
  const from = endYm.slice(0, 4) === curYm.slice(0, 4) ? mon(endYm) : monYear(endYm);
  return `Not a member for about ${plural(months, "month")} (${from} to ${part}-${monYear(curYm)})`;
}

export function buildMembershipHistory(input: {
  rows: SubRow[];
  invoices: InvoiceRow[];
  refunds: RefundRow[];
  /** 0262; omitted = none on record. */
  unpaid?: UnpaidRow[];
  live: LiveMembership;
  now: Date;
  syncedAt: string | null;
}): History {
  const { invoices, refunds, live, now } = input;
  const unpaidAll = input.unpaid ?? [];
  const rows = [...input.rows].sort((a, b) =>
    (ms(a.activation_date) ?? 0) - (ms(b.activation_date) ?? 0) || a.membership_id - b.membership_id);
  const refundsByPi = new Map<string, number>();
  for (const f of refunds) refundsByPi.set(f.payment_intent_id, (refundsByPi.get(f.payment_intent_id) ?? 0) + Math.abs(f.cents));

  const built = rows.map((r, i) => buildBlock(i + 1, r, invoices.filter((v) => Number(v.md_membership_id) === Number(r.membership_id)), refundsByPi, live,
    unpaidAll.filter((u) => Number(u.md_membership_id) === Number(r.membership_id))));

  // ── summary ──
  const mine = new Set(rows.map((r) => Number(r.membership_id)));
  const myInvoices = invoices.filter((v) => mine.has(Number(v.md_membership_id)));
  const paidMonths = new Set(myInvoices.filter((v) => v.amount_paid_cents > 0).map(invoiceYm));
  const gross = myInvoices.reduce((s, v) => s + v.amount_paid_cents, 0);
  const refunded = myInvoices.reduce((s, v) => s + (v.payment_intent_id ? refundsByPi.get(v.payment_intent_id) ?? 0 : 0), 0);
  const firstAct = rows.map((r) => r.activation_date).find((a) => ms(a) != null) ?? null;
  const nowYm = ymChicago(now.toISOString());
  const sinceYm = firstAct ? ymChicago(firstAct) : null;
  const earlyInvoice = myInvoices.some((v) => v.created_at_utc < REFUND_LINK_FROM);

  const never = rows.length === 0 && live == null;

  // ── now ──
  const liveBlock = live?.id != null ? built.find((b) => b.block.membershipId === live.id) ?? null : null;
  const newest = built.length ? built[built.length - 1] : null;
  let nowLine: History["now"];
  const plan = live?.priceCents != null ? `${money(live.priceCents)} plan` : null;
  if (never) {
    nowLine = { title: "Never been a member", tone: "none", badge: null, sub: "", sub2: null };
  } else if (live) {
    const s = (live.statusRaw ?? "").toUpperCase();
    if (s === "ADDED_FROM_ADMIN") nowLine = { title: "Comped", tone: "ok", badge: "COMPED", sub: "Added by staff · never charged", sub2: null };
    else if (s === "PAST_DUE") nowLine = { title: "Payment overdue", tone: "bad", badge: "PAST DUE", sub: pastDueSub(liveBlock ?? newest), sub2: null };
    else if (live.canceledAt) nowLine = { title: "Cancelling", tone: "warn", badge: "CANCELLING", sub: [plan, live.renews ? `runs to ${boundaryDay(live.renews)}` : null].filter(Boolean).join(" · "), sub2: `Asked to cancel ${dateCT(live.canceledAt)}` };
    else nowLine = { title: "Active", tone: "ok", badge: null, sub: [plan, live.renews ? `renews ${boundaryDay(live.renews)}` : null].filter(Boolean).join(" · "), sub2: null };
  } else if (newest && newest.block.state === "past_due") {
    nowLine = { title: "Payment overdue", tone: "bad", badge: "PAST DUE", sub: pastDueSub(newest), sub2: null };
  } else if (newest && (newest.block.state === "active" || newest.block.state === "cancelling")) {
    nowLine = { title: "Active in our records", tone: "warn", badge: null, sub: "MatchDay's live record shows no current membership.", sub2: null };
  } else if (newest) {
    const b = newest.block;
    const cancelLine = b.end?.source === "retool" ? "No reason was recorded."
      : !newest.canceledAt ? (b.end?.source === "stripe" ? "Ended in Stripe. MatchDay has no cancel date or reason." : "No cancel date or reason on record.")
      : (newest.reason ?? "").trim() ? `Asked to cancel on ${dateCT(newest.canceledAt)}: “${(newest.reason ?? "").trim()}”`
      : `Asked to cancel on ${dateCT(newest.canceledAt)}. No reason given.`;
    const paidHere = b.strip.filter((c) => c.kind !== "none").length;
    nowLine = {
      title: b.end?.label ?? "Ended", tone: "none", badge: "ENDED", sub: cancelLine,
      sub2: paidHere ? `${plural(paidHere, "month")} paid${newest.regular != null ? ` at ${money(newest.regular)}` : ""}` : null,
    };
  } else {
    nowLine = { title: "No membership", tone: "none", badge: null, sub: "", sub2: null };
  }

  // ── items, newest first, with gap lines ──
  const items: HistItem[] = [];
  for (let i = built.length - 1; i >= 0; i--) {
    items.push({ type: "membership", block: built[i].block });
    if (i > 0) { const g = gapText(built[i - 1], built[i]); if (g) items.push({ type: "gap", text: g }); }
  }

  const notices: string[] = [];
  if (live?.id != null && !liveBlock) {
    notices.push((live.statusRaw ?? "").toUpperCase() === "ADDED_FROM_ADMIN"
      ? `The current comp (#${live.id}) isn't in our membership records, so it has no history here.`
      : `The current membership (#${live.id}) isn't in our membership records yet, so it has no history here. They sync nightly.`);
  }

  const asOf = ms(input.syncedAt) != null
    ? ` Records as of ${new Date(ms(input.syncedAt) as number).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ })} Central.`
    : "";
  return {
    never,
    now: nowLine,
    summary: {
      memberSince: sinceYm ? monYear(sinceYm) : null,
      memberships: rows.length,
      monthsPaid: paidMonths.size,
      monthsSinceJoining: sinceYm ? Math.max(1, monthsBetween(sinceYm, nowYm) + 1) : 0,
      totalPaidCents: gross - refunded,
      refundedCents: refunded,
      totalCaption: earlyInvoice ? "incl. tax, refunds since Mar 2024 taken off" : "incl. tax, refunds taken off",
    },
    items,
    notices,
    footer: `From MatchDay's membership records and Stripe's invoices, paid and unpaid. End dates come from Stripe; where Stripe's isn't on record, they are estimated from the last paid month.${asOf}`,
  };
}

/** Past due: the open renewal's attempts and next retry when Stripe's invoice is on record. */
function pastDueLine(lastPaidYm: string | null, unpaid: UnpaidRow[]): string {
  const open = [...unpaid].reverse().find((u) => u.status === "open") ?? null;
  const month = open ? monthName(open.billing_reason === "subscription_cycle" ? ymUtc(open.created_at_utc) : ymChicago(open.created_at_utc))
    : lastPaidYm ? monthName(addMonths(lastPaidYm, 1)) : null;
  const head = month ? `The ${month} renewal` : "A renewal";
  if (!open) return `${head} hasn't been paid. No failed attempt is on record yet.`;
  const a = open.attempt_count ?? 0;
  const why = failureWords(open.last_failure_code);
  const next = ms(open.next_payment_attempt_utc) != null ? `Stripe retries next on ${dateCT(open.next_payment_attempt_utc)}.` : "Stripe has stopped retrying.";
  return `${head} failed ${times(a)}${why ? ` (last: ${why})` : ""}. ${next}`;
}

function pastDueSub(b: Built | null): string {
  return pastDueLine(b?.lastPaidYm ?? null, b?.unpaid ?? []);
}
