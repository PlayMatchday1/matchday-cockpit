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
export type SpotRow = {
  month: MonthKey; cls: PaymentClass; city: string | null; fieldId: number | null; amount: number;
  /* THE IDENTITY PAIR. Needed because ONE MATCH IS ONE MATCH: a member who books a spot for a
   * friend gets a second row under their OWN user_id, so counting rows counts the booking, not the
   * playing. Exactly the trap 0147 fixed in player_play_stats, where `plays` was count(*) over
   * spots and 343 players read as having played twice for one match they brought a guest to. */
  userId: string | null; matchApiId: number | null;
  /* BOOKED OR PLAYED. True when the player cancelled their own spot: the match went ahead, this
   * person did not take a place in it, and the venue got nothing from the booking.
   *
   * IT IS A FACT ON THE ROW, NOT A FILTER, because this page legitimately wants BOTH counts. The
   * charts are about demand and a booking is a real demand event; the price is about what was
   * consumed and a cancelled booking bought nothing. Filtering at the source would have moved
   * every chart on the page to answer the price tile's question. */
  playerCanceled?: boolean;
};

export type MonthTotals = {
  month: MonthKey;
  /** BOOKED member spots, cancellations included. What the charts count. */
  member: number;
  daily: number; promo: number; other: number;
  /** DISTINCT (user_id, match_api_id) among MEMBER rows — one match is one match. */
  memberMatches: number;
  /* ── CONSUMED, AND WHY IT IS A SECOND FIELD RATHER THAN A CORRECTION ─────────────────────────
   * MEMBER rows the player did not cancel. This is the only honest denominator for a PRICE: the
   * tile says "what a member actually paid per spot", and a spot they cancelled is not a spot
   * they got. MEASURED Aug 2026: Austin 975 booked against 865 consumed, San Antonio 648 against
   * 551 — an 11 to 15% wedge, and the whole of the gap between this page and memberSpotRateFor.
   *
   * player_spots, the finance-side definition, has always excluded cancelled, refunded, WAITING
   * and deleted rows. This page was the outlier. */
  memberConsumed: number;
  /** The same exclusion at match grain, for the KPI that divides by matches. */
  memberMatchesConsumed: number;
};

export function totalsByMonth(rows: readonly SpotRow[], months: readonly MonthKey[]): MonthTotals[] {
  const m = new Map<MonthKey, MonthTotals>();
  const seen = new Map<MonthKey, Set<string>>();
  const seenConsumed = new Map<MonthKey, Set<string>>();
  for (const k of months) {
    m.set(k, { month: k, member: 0, daily: 0, promo: 0, other: 0, memberMatches: 0, memberConsumed: 0, memberMatchesConsumed: 0 });
    seen.set(k, new Set()); seenConsumed.set(k, new Set());
  }
  for (const r of rows) {
    const t = m.get(r.month);
    if (!t) continue;
    if (r.cls === "MEMBER") {
      t.member++;
      /* ONE MATCH IS ONE MATCH. A row with no identity cannot be deduped, so it counts as its own
       * appearance rather than collapsing into someone else's — the safe direction. */
      const id = r.userId != null && r.matchApiId != null ? `${r.userId}|${r.matchApiId}` : null;
      const set = seen.get(r.month)!;
      if (id == null) t.memberMatches++;
      else if (!set.has(id)) { set.add(id); t.memberMatches++; }
      // The consumed pair, counted the same two ways, over the rows the player did not cancel.
      if (r.playerCanceled !== true) {
        t.memberConsumed++;
        const cset = seenConsumed.get(r.month)!;
        if (id == null) t.memberMatchesConsumed++;
        else if (!cset.has(id)) { cset.add(id); t.memberMatchesConsumed++; }
      }
    }
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
  /* ── TWO DENOMINATORS, BECAUSE THEY ANSWER TWO QUESTIONS ────────────────────────────────────
   * `memberSpots` (booked matches) drives AVG MATCHES PER MEMBER: a member who booked is a member
   * who engaged, and that metric is about behaviour.
   *
   * `memberMatchesConsumed` drives AVG PRICE PER MEMBER SPOT: a price divides by what was
   * actually taken. One argument served both and the price tile was dividing by bookings while
   * its own subtitle said spots. */
  memberMatchesConsumed: number;
  membershipRevenue: number;
  churnedNow: number;
  churnedPrior: number;
}): Kpis {
  const { activeMembers, memberSpots, memberMatchesConsumed, membershipRevenue, churnedNow, churnedPrior } = args;
  return {
    activeMembers,
    // NULL, NOT ZERO, when there is nobody to divide by. "0 matches per member" is a claim about
    // behaviour; "—" is the absence of one.
    /* THE NUMERATOR IS MATCHES, NOT SPOTS. `memberSpots` here is the DISTINCT (user, match) count
     * — see MonthTotals.memberMatches. Counting rows counted a member who booked for a friend
     * twice for one match. */
    avgMatchesPerMember: activeMembers > 0 ? memberSpots / activeMembers : null,
    /* AVG PRICE PER MEMBER SPOT = membership GROSS / member matches ACTUALLY PLAYED.
     *
     * The numerator is fin_revenue.type='Membership' — AN EXPLICIT CATEGORY, not a residual. The
     * design deck computes fieldMember = fieldRevenue − fieldDpp, and a residual absorbs every
     * upstream error and returns a plausible wrong number rather than an obvious one. Ours does
     * not; see the report in the commit for the measurement.
     *
     * BOTH HALVES MOVED, 2026-09-21. It was net over BOOKED matches; net is what we kept after
     * Stripe rather than what the member paid, and a booking the member cancelled is not a spot
     * they got. This is NOT memberSpotRateFor, which divides PRE-TAX revenue from the PRIOR month
     * because it joins to pre-tax roster money. Two questions, two numbers, and comparing them
     * cost somebody an afternoon. */
    avgPricePerMemberSpot: memberMatchesConsumed > 0 ? membershipRevenue / memberMatchesConsumed : null,
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


/* ── MEMBER SHARE BY MONTH ──────────────────────────────────────────────────────────────────────
 *
 * One row per month, three ways of asking the same question: what fraction of the business is
 * membership. Revenue, spots and people are three different grains and they do NOT agree, which is
 * the point of showing all three rather than picking one.
 *
 * ── THE TWO GRAINS, AND WHY EACH PAIR IS COMPARABLE ───────────────────────────────────────────
 *
 * SPOTS are bookings. memberSpots is MEMBER rows; bookedSpots is every classified row in the
 * month. BOOKED, NOT PLAYED, and the column label says so: this is the same `member` count the
 * charts above use, NOT memberConsumed. The price tile one card up divides by spots PLAYED and is
 * correct for its own question; both live on the page and the labels are where the difference is
 * stated. They are not reconciled and must not be.
 *
 * PEOPLE are distinct user_ids. members is the number of distinct people who took a MEMBER spot;
 * played is the number of distinct people who took ANY spot. BOTH COME FROM THE SAME ROWS AND ARE
 * COUNTED THE SAME WAY, which is the only reason the share means anything.
 *
 * NOT members_monthly_snapshots FOR THE NUMERATOR, and this is the trap. That table holds ACTIVE
 * SUBSCRIPTIONS per month — people who were paying, whether or not they played. Divided by people
 * who played, it would be a ratio between two different populations: a member who paid and never
 * turned up would raise the share without ever appearing in the denominator. Same source, same
 * filter, same grain, or the number is decoration.
 *
 * A ROW WITH NO user_id CANNOT BE DEDUPED, so it counts as its own person rather than collapsing
 * into someone else's. The safe direction, and the same rule memberMatches already follows.
 */
export type MemberShareRow = {
  month: MonthKey;
  membershipRevenue: number;
  totalRevenue: number;
  memberSpots: number;
  bookedSpots: number;
  members: number;
  played: number;
  /* ── THE PRICE ROW'S DENOMINATOR, AND IT IS NOT bookedSpots ─────────────────────────────────
   * MEMBER spots the player did NOT cancel. The Spots group two rows up divides by BOOKED; this
   * divides by PLAYED, and they differ by 11 to 15%. The booked figure is sitting in the same
   * table, which is exactly how this gets wired to the wrong denominator and still looks
   * plausible: Aug would read $2.22 instead of $8.98. The row label says "played" and that is
   * where the distinction is stated. */
  memberConsumed: number;
};

/* THE MONTH LIST IS DERIVED AND HAS NO GAPS. Every month from the first with membership revenue
 * through the current one, INCLUDING any month that had none: a month with no membership is a
 * real month and renders as zeroes, because skipping it would draw a line straight from the month
 * before to the month after and invent a trend across a gap nobody can see.
 *
 * NEVER HARDCODED. Three figures quoted from comments in this codebase this week turned out to be
 * stale; a launch month written into the source is the same mistake with a longer fuse. */
export function monthsFrom(firstMonth: MonthKey, lastMonth: MonthKey): MonthKey[] {
  const parse = (m: MonthKey) => {
    const [mo, y] = String(m).split(" ");
    const i = MONTHS_SHORT.indexOf(mo);
    return i < 0 ? null : { y: Number(y), i };
  };
  const a = parse(firstMonth), b = parse(lastMonth);
  if (!a || !b) return [];
  const out: MonthKey[] = [];
  let { y, i } = a;
  for (let guard = 0; guard < 600; guard++) {
    out.push(`${MONTHS_SHORT[i]} ${y}` as MonthKey);
    if (y === b.y && i === b.i) break;
    if (y > b.y || (y === b.y && i > b.i)) break;   // lastMonth before firstMonth: one month, not 600
    i++; if (i > 11) { i = 0; y++; }
  }
  return out;
}

export const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Newest first: the month you are looking at is the current one, so it holds column 1 and never
 *  moves. History runs rightward into the scroll. The alternative — chronological, auto-scrolled
 *  to the far end — puts the current month at the end of a scroll that grows every month. */
export function buildMemberShare(input: {
  months: readonly MonthKey[];
  revenueByMonth: ReadonlyMap<MonthKey, { membership: number; total: number }>;
  spotsByMonth: ReadonlyMap<MonthKey, { memberSpots: number; bookedSpots: number; members: number; played: number; memberConsumed: number }>;
}): MemberShareRow[] {
  return [...input.months].reverse().map((month) => {
    const r = input.revenueByMonth.get(month);
    const s = input.spotsByMonth.get(month);
    return {
      month,
      membershipRevenue: r?.membership ?? 0,
      totalRevenue: r?.total ?? 0,
      memberSpots: s?.memberSpots ?? 0,
      bookedSpots: s?.bookedSpots ?? 0,
      members: s?.members ?? 0,
      played: s?.played ?? 0,
      memberConsumed: s?.memberConsumed ?? 0,
    };
  });
}

/** A share, or null when there is no total to be a share of. Never 0.0% for "no denominator". */
export function shareOfPair(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}


/* ── AVERAGE PRICE PER MEMBER SPOT PLAYED ───────────────────────────────────────────────────────
 *
 * The same figure the tile above the table shows, extended to every month: that month's own gross
 * membership revenue over the member spots actually played.
 *
 * NULL, NOT ZERO, WHEN NOBODY PLAYED. "$0.00 per spot" is a claim that members paid nothing;
 * a dash is the absence of one. Null becoming zero has produced three separate defects this week.
 */
export function pricePerSpotPlayed(membershipRevenue: number, memberConsumed: number): number | null {
  return memberConsumed > 0 ? membershipRevenue / memberConsumed : null;
}
