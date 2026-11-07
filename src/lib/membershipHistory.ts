// MEMBERSHIP HISTORY — one player's memberships, renewals, price changes, cancellations and refunds,
// built from what docs/matchday-api-facts.md "Membership history sources" (2026-11-07) proved we hold.
// PURE: no I/O, no clock of its own (`now` is passed), so scripts/membership-history-test.ts can feed
// it fixtures. The read is src/app/api/lookup/[env]/membership-history/route.ts.
//
// THE SOURCES, AND WHAT EACH ONE IS ALLOWED TO SAY
//   mdapi_subscriptions     one row per membership (a rejoin is a NEW row). activation_date and
//                           canceled_at are TRUE UTC (ORM-written) → displayed in America/Chicago.
//                           price is whole dollars and the CURRENT plan only (no price history).
//   stripe_member_invoices  PAID invoices only. amount_paid_cents includes tax. A failed renewal is
//                           not here, so nothing below ever claims a payment failed or was missed for
//                           certain: a month with no invoice is "no charge", nothing more.
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
// END DATES ARE ESTIMATES. MatchDay records no end date. A cancelled membership "ended about" the 1st
// of the month after its last paid month, and every line that says so says "(estimated)".

export type SubRow = {
  membership_id: number;
  status: string | null;
  price: number | null;
  activation_date: string | null;
  canceled_at: string | null;
  cancel_reason: string | null;
};
export type InvoiceRow = {
  md_membership_id: number;
  amount_paid_cents: number;
  billing_reason: string | null;
  created_at_utc: string;
  payment_intent_id: string | null;
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

export type CellKind = "first" | "paid" | "none" | "refunded";
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
  /** The 1st of the estimated end month, YYYY-MM, for ended rows with an invoice; else null. */
  estEndYm: string | null;
  activation: string | null;
};
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

type Built = { block: MembershipBlock; lastPaidYm: string | null; regular: number | null; canceledAt: string | null; reason: string | null };

function buildBlock(n: number, r: SubRow, invs: InvoiceRow[], refundsByPi: Map<string, number>, live: LiveMembership): Built {
  const state = stateOf(r);
  const sorted = [...invs].sort((a, b) => a.created_at_utc.localeCompare(b.created_at_utc));
  const cycles = sorted.filter((i) => i.billing_reason === "subscription_cycle" && i.amount_paid_cents > 0);
  const regular = cycles.length ? cycles[cycles.length - 1].amount_paid_cents : null;
  const create = sorted.find((i) => i.billing_reason === "subscription_create") ?? null;
  const paidYms = sorted.filter((i) => i.amount_paid_cents > 0).map(invoiceYm);
  const lastPaidYm = paidYms.length ? paidYms.reduce((a, b) => (a > b ? a : b)) : null;
  const isLive = live != null && live.id != null && live.id === r.membership_id;

  // ── the month strip: first to last invoice month ──
  const strip: StripCell[] = [];
  if (sorted.length) {
    const yms = sorted.map(invoiceYm);
    const lo = yms.reduce((a, b) => (a < b ? a : b)), hi = yms.reduce((a, b) => (a > b ? a : b));
    for (let ym = lo; ym <= hi; ym = addMonths(ym, 1)) {
      const here = sorted.filter((i) => invoiceYm(i) === ym);
      const paid = here.filter((i) => i.amount_paid_cents > 0);
      const refunded = here.reduce((s, i) => s + (i.payment_intent_id ? refundsByPi.get(i.payment_intent_id) ?? 0 : 0), 0);
      const charged = paid.reduce((s, i) => s + i.amount_paid_cents, 0);
      const first = paid.some((i) => i.billing_reason === "subscription_create");
      const kind: CellKind = refunded > 0 ? "refunded" : first ? "first" : paid.length ? "paid" : "none";
      const title = kind === "none" ? `${monYear(ym)}: no charge`
        : kind === "refunded" ? `${monYear(ym)}: paid ${money(charged)}, refunded ${money(refunded)}`
        : `${monYear(ym)}: ${first ? "first charge" : "paid"} ${money(charged)}`;
      strip.push({ ym, label: mon(ym), kind, title });
    }
  }
  const noCharge = strip.filter((c) => c.kind === "none").length;

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
  // 3. Renewals, on a membership still running
  if (state === "active" || state === "cancelling" || state === "past_due") {
    const next = isLive && state === "active" && live?.renews ? ` · next ${boundaryDay(live.renews)}` : "";
    const missed = noCharge ? `${plural(noCharge, "month")} with no charge` : "none missed";
    if (regular != null) {
      events.push({ key: "renews", tone: "green", title: `Renews monthly at ${money(regular)}`, sub: `${plural(cycles.length, "renewal")} paid, ${missed}${next}` });
    } else if (state === "active") {
      events.push({ key: "renews", tone: "green", title: "Renews monthly", sub: `No renewal paid yet${next}` });
    }
  }
  // 4. Cancellation
  if (r.canceled_at) {
    if (isRetool(r.cancel_reason)) {
      events.push({ key: "cancel", tone: "red", title: `Removed by staff in Retool · ${dateCT(r.canceled_at)}`, sub: "No reason was recorded." });
    } else {
      const reason = (r.cancel_reason ?? "").trim();
      events.push(reason
        ? { key: "cancel", tone: "red", title: `Asked to cancel · ${dateCT(r.canceled_at)}`, quote: reason }
        : { key: "cancel", tone: "red", title: `Asked to cancel · ${dateCT(r.canceled_at)}`, sub: "No reason given." });
    }
  } else if (state === "ended") {
    events.push({ key: "cancel", tone: "grey", title: "Cancelled, with no date on record", sub: "MatchDay records no cancel date or reason when Stripe ends a membership." });
  }
  // 5. How it stands now
  let estEndYm: string | null = null;
  if (state === "ended") {
    if (lastPaidYm) {
      estEndYm = addMonths(lastPaidYm, 1);
      events.push({
        key: "ended", tone: "grey", title: `Ended about ${firstOf(estEndYm)} (estimated)`,
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
    const due = lastPaidYm ? `The ${monthName(addMonths(lastPaidYm, 1))} renewal hasn't been paid.` : "A renewal hasn't been paid.";
    events.push({ key: "pastdue", tone: "red", title: "Payment overdue", sub: `${due} Failed payment attempts aren't shown.` });
  } else if (state === "comp") {
    events.push({ key: "comp", tone: "grey", title: "Added by staff as a comp", sub: "Never charged: there is no Stripe subscription behind it." });
  }

  const start = dateCT(r.activation_date);
  const range = state === "ended"
    ? `${start} to ${estEndYm ? `about ${firstOf(estEndYm)}` : "an unknown date"}`
    : `${start} to now`;
  return {
    block: { n, membershipId: r.membership_id, state, badge: BADGE[state] || (r.status ?? "").toUpperCase(), range, strip, events, estEndYm, activation: r.activation_date },
    lastPaidYm, regular, canceledAt: r.canceled_at, reason: r.cancel_reason,
  };
}

function gapText(prev: Built, cur: Built): string | null {
  if (prev.block.state !== "ended" || !prev.block.estEndYm) return null;
  const curT = ms(cur.block.activation);
  if (curT == null) return null;
  const endT = Date.UTC(Number(prev.block.estEndYm.slice(0, 4)), Number(prev.block.estEndYm.slice(5, 7)) - 1, 1);
  const days = (curT - endT) / 86_400_000;
  if (days < 0) return "Joined again before the last membership's estimated end";
  const months = Math.round(days / 30.44);
  if (months < 1) return "Joined again within a month of the last membership ending";
  const p = partsIn(cur.block.activation as string, TZ);
  const curYm = ymOf(p.y, p.m);
  const part = p.d <= 10 ? "early" : p.d <= 20 ? "mid" : "late";
  const from = prev.block.estEndYm.slice(0, 4) === curYm.slice(0, 4) ? mon(prev.block.estEndYm) : monYear(prev.block.estEndYm);
  return `Not a member for about ${plural(months, "month")} (${from} to ${part}-${monYear(curYm)})`;
}

export function buildMembershipHistory(input: {
  rows: SubRow[];
  invoices: InvoiceRow[];
  refunds: RefundRow[];
  live: LiveMembership;
  now: Date;
  syncedAt: string | null;
}): History {
  const { invoices, refunds, live, now } = input;
  const rows = [...input.rows].sort((a, b) =>
    (ms(a.activation_date) ?? 0) - (ms(b.activation_date) ?? 0) || a.membership_id - b.membership_id);
  const refundsByPi = new Map<string, number>();
  for (const f of refunds) refundsByPi.set(f.payment_intent_id, (refundsByPi.get(f.payment_intent_id) ?? 0) + Math.abs(f.cents));

  const built = rows.map((r, i) => buildBlock(i + 1, r, invoices.filter((v) => Number(v.md_membership_id) === Number(r.membership_id)), refundsByPi, live));

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
    const cancelLine = !newest.canceledAt ? "No cancel date or reason on record."
      : isRetool(newest.reason) ? `Removed by staff in Retool on ${dateCT(newest.canceledAt)}. No reason was recorded.`
      : (newest.reason ?? "").trim() ? `Asked to cancel on ${dateCT(newest.canceledAt)}: “${(newest.reason ?? "").trim()}”`
      : `Asked to cancel on ${dateCT(newest.canceledAt)}. No reason given.`;
    const paidHere = b.strip.filter((c) => c.kind !== "none").length;
    nowLine = {
      title: b.estEndYm ? `Ended about ${firstOf(b.estEndYm)}` : "Ended", tone: "none", badge: "ENDED", sub: cancelLine,
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
    footer: `From MatchDay's membership records and paid Stripe invoices. Failed payments aren't shown yet, and end dates are estimated from the last paid month.${asOf}`,
  };
}

function pastDueSub(b: Built | null): string {
  const due = b?.lastPaidYm ? `The ${monthName(addMonths(b.lastPaidYm, 1))} renewal hasn't been paid.` : "A renewal hasn't been paid.";
  return `${due} Failed payment attempts aren't shown.`;
}
