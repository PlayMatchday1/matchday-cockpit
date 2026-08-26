// MEMBERSHIP — the pure model. No network, no clock, no Supabase, no DOM.
//
// Every number the page shows and every geometry decision a chart makes is decided here, so the
// suite can assert them against fixtures. Two of the rules below caught real bugs in the mockup and
// neither was visible by eye: an axis that stops below its own maximum, and a tooltip that escapes
// its card.
//
// ── DEFINITIONS, AND WHERE THEY CAME FROM ─────────────────────────────────────────────────────
// Three of the five already existed in our data. Two did not and are decided here, which makes this
// file the place they are argued rather than assumed.
//
//   ACTIVE MEMBER   EXISTS. mdapi_subscriptions.status === 'ACTIVE'. The column carries only two
//                   values in production — ACTIVE 451, CANCELED 2,225 — despite the schema comment
//                   claiming nine.
//   MEMBER SPOT     EXISTS. payment_type === 'MEMBER' on a match registration, derived by
//                   derivePaymentType against the player's membership window.
//   DAILY-PLAY SPOT EXISTS. payment_type === 'DAILY PAID'. The estate calls this DPP.
//   PROMOTION PLAYER EXISTS. payment_type === 'PROMOCODE'.
//   CHURNED         EXISTS AS A PLAYER CONCEPT, NOT A MEMBER ONE. /api/lifecycle/churn already
//                   uses days-since-last-played with a selectable floor of 30/60/90/120, default
//                   90. This page reuses that 90-day default rather than inventing a second
//                   meaning — but note it counts PLAYERS, not members, and a member who stops
//                   playing while still paying is churned by this definition and active by the
//                   membership one. Both readings are defensible; they are NOT the same number.

export type PaymentClass = "MEMBER" | "DAILY PAID" | "PROMOCODE" | "OTHER";

/** The three series the page charts, in their fixed order. Colour is never the only identity. */
export const SERIES = [
  { key: "member", label: "Members", colour: "#1baf7a" },
  { key: "daily", label: "Daily play", colour: "#2a78d6" },
  { key: "promo", label: "Promotions", colour: "#eb6834" },
] as const;
export type SeriesKey = (typeof SERIES)[number]["key"];

/** Brand green belongs to the all-time line and to nothing else. It is a single series and needs
 *  no legend; lending it to a category would make two different things look like one. */
export const ALLTIME_COLOUR = "#0F3323";

export const CHURN_DAYS = 90;

export function classify(paymentType: string | null | undefined): PaymentClass {
  const t = String(paymentType ?? "");
  if (t === "MEMBER") return "MEMBER";
  if (t === "DAILY PAID") return "DAILY PAID";
  if (t === "PROMOCODE") return "PROMOCODE";
  return "OTHER";
}
export const seriesOf = (p: PaymentClass): SeriesKey | null =>
  p === "MEMBER" ? "member" : p === "DAILY PAID" ? "daily" : p === "PROMOCODE" ? "promo" : null;

/* ── AXIS SCALE ────────────────────────────────────────────────────────────────────────────────
 * THE TOP TICK MUST BE >= THE SERIES MAXIMUM.
 *
 * Stopping at the last step BELOW the max puts the tallest bar above its own axis, and with
 * overflow:visible on the svg it silently leaves the chart — no clipping, no warning, just a mark
 * drawn over the card. It is invisible by eye because the bar still looks like a bar.
 */
export function niceStep(rough: number): number {
  if (!(rough > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(rough)));
  const f = rough / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

export function scaleTicks(max: number, n = 5): number[] {
  if (!(max > 0)) return [0, 1];
  const step = niceStep(max / n);
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}
export const axisTop = (max: number, n = 5): number => {
  const t = scaleTicks(max, n);
  return t[t.length - 1];
};

/* ── TOOLTIP CLAMP ─────────────────────────────────────────────────────────────────────────────
 * A tooltip that leaves its card is the same as no tooltip. Both ends of a series are the cases
 * that break: the first point pins to the left edge, the last to the right, and a point near the
 * top has no room above it — so near the top it FLIPS BELOW rather than escaping.
 *
 * Pure geometry, in rendered pixels, so the suite can assert it without a browser. */
export type TipBox = { left: number; top: number; flipped: boolean };
export function clampTip(
  cx: number, cy: number,
  tip: { w: number; h: number },
  card: { w: number; h: number },
  pad = 8,
): TipBox {
  const half = tip.w / 2;
  // A tip wider than its card cannot be centred inside it; pin it rather than let it hang out.
  const left = card.w >= tip.w + pad * 2
    ? Math.max(half + pad, Math.min(card.w - half - pad, cx))
    : card.w / 2;
  const wantsAbove = cy - tip.h - 10;
  const flipped = wantsAbove < 0;
  const top = flipped ? cy + tip.h + 26 : cy;
  return { left, top, flipped };
}

/** Does a mark's bounding box sit inside the plot area? Used by the suite over every rect/circle. */
export type Box = { x: number; y: number; w: number; h: number };
export const insideBox = (m: Box, plot: Box, eps = 1e-6): boolean =>
  m.x >= plot.x - eps && m.y >= plot.y - eps &&
  m.x + m.w <= plot.x + plot.w + eps && m.y + m.h <= plot.y + plot.h + eps;

/* ── THE MONTH SERIES ──────────────────────────────────────────────────────────────────────────*/
export type MonthKey = string;             // "Aug 2026"
export type SpotRow = { month: MonthKey; cls: PaymentClass; city: string | null; fieldId: number | null; amount: number };

export type MonthTotals = { month: MonthKey; member: number; daily: number; promo: number; other: number };

export function totalsByMonth(rows: readonly SpotRow[], months: readonly MonthKey[]): MonthTotals[] {
  const m = new Map<MonthKey, MonthTotals>();
  for (const k of months) m.set(k, { month: k, member: 0, daily: 0, promo: 0, other: 0 });
  for (const r of rows) {
    const t = m.get(r.month);
    if (!t) continue;
    if (r.cls === "MEMBER") t.member++;
    else if (r.cls === "DAILY PAID") t.daily++;
    else if (r.cls === "PROMOCODE") t.promo++;
    else t.other++;
  }
  return months.map((k) => m.get(k)!);
}

/* ── THE ALL-TIME LINE ─────────────────────────────────────────────────────────────────────────
 * ONE TARGET PER MONTH — hover, click AND keyboard focus land on the same point, because a chart
 * only reachable by mouse is a chart half the operators cannot read.
 *
 * THE FIRST MONTH HAS NO DELTA. There is nothing before it, and rendering 0 or "+0" would assert a
 * flat month that was never measured. */
export type ActivePoint = { month: MonthKey; value: number; delta: number | null };

export function activeSeries(raw: readonly { month: MonthKey; value: number }[]): ActivePoint[] {
  return raw.map((p, i) => ({
    month: p.month,
    value: p.value,
    delta: i === 0 ? null : p.value - raw[i - 1].value,
  }));
}

/* ── THE FOUR KPIs ─────────────────────────────────────────────────────────────────────────────
 * COMPUTED FROM THE SAME ARRAYS THE CHARTS DRAW. The Expenses page shipped with a chip, a column
 * total and a footer that summed three different windows and nothing caught it; the suite here
 * asserts the KPI, the chart total and the visible columns agree for the same month. */
export type Kpis = {
  activeMembers: number;
  avgMatchesPerMember: number | null;
  avgPricePerMemberSpot: number | null;
  churnedMoMPct: number | null;
  churnedNow: number;
  churnedPrior: number;
};

export function buildKpis(args: {
  activeMembers: number;
  memberSpots: number;
  membershipRevenue: number;
  churnedNow: number;
  churnedPrior: number;
}): Kpis {
  const { activeMembers, memberSpots, membershipRevenue, churnedNow, churnedPrior } = args;
  return {
    activeMembers,
    // NULL, NOT ZERO, when there is nobody to divide by. "0 matches per member" is a claim about
    // behaviour; "—" is the absence of one.
    avgMatchesPerMember: activeMembers > 0 ? memberSpots / activeMembers : null,
    /* AVG PRICE PER MEMBER SPOT = membership revenue / member spots.
     *
     * The numerator is fin_revenue.type='Membership' — AN EXPLICIT CATEGORY, not a residual. The
     * design deck computes fieldMember = fieldRevenue − fieldDpp, and a residual absorbs every
     * upstream error and returns a plausible wrong number rather than an obvious one. Ours does
     * not; see the report in the commit for the measurement. */
    avgPricePerMemberSpot: memberSpots > 0 ? membershipRevenue / memberSpots : null,
    churnedMoMPct: churnedPrior > 0 ? ((churnedNow - churnedPrior) / churnedPrior) * 100 : null,
    churnedNow,
    churnedPrior,
  };
}

/* ── 100% STACKED MIX ──────────────────────────────────────────────────────────────────────────
 * Shares, not counts. A day with no play has no composition — it is NOT three zeroes, and drawing
 * it as an empty column is honest where drawing it as 33/33/33 is not. */
export type DayMix = { day: string; member: number; daily: number; promo: number; total: number };
export type DayShare = { day: string; member: number; daily: number; promo: number; empty: boolean };

export function shares(rows: readonly DayMix[]): DayShare[] {
  return rows.map((r) => {
    const t = r.member + r.daily + r.promo;
    if (t <= 0) return { day: r.day, member: 0, daily: 0, promo: 0, empty: true };
    return { day: r.day, member: r.member / t, daily: r.daily / t, promo: r.promo / t, empty: false };
  });
}

/** Shares of a breakdown row, as percentages that sum to 100 (or all zero for an empty row). */
export function pctShares(member: number, daily: number, promo: number): { member: number; daily: number; promo: number } {
  const t = member + daily + promo;
  if (t <= 0) return { member: 0, daily: 0, promo: 0 };
  return { member: (member / t) * 100, daily: (daily / t) * 100, promo: (promo / t) * 100 };
}

/** The scope sentence each chart restates, so a filtered chart never reads as the whole estate. */
export function scopeLabel(city: string | null, field: string | null, cityName?: string | null): string {
  if (field) return `${field}${cityName ? ` · ${cityName}` : ""}`;
  if (city) return cityName ?? city;
  return "All Matchday";
}
