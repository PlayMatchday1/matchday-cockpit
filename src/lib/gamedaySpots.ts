/* GAMEDAY OPS — WHO HOLDS EACH SPOT: paid, member or promo (Ryan, 2026-10-10). Display only.
 *
 * THE INPUT is the roster the /admin/matches LIST already carries on every row (`players`), so the
 * tiles cost no extra API call. Those embedded rows have NO `user` object — no fake flag, no email —
 * so fakes are identified by user id from mdapi_users (is_fake_player, or an @matchday.com email:
 * excluded whether or not MatchDay flags the account). Membership is the subscription active at
 * kickoff (mdapi_subscriptions), the rule mdapiMatchesRead.hasMembershipAtMatchTime implements.
 *
 * A SPOT IS a roster row that rosterRowCounts() keeps (not cancelled, not refunded, not WAITING —
 * the population _count.players counts) on a match that was not cancelled, held by a real account.
 *
 * THE RULE — the Turf On page's (partnerSimpleDashboard.ts), with Ryan's answers of 2026-10-10:
 *   member  a FREE booking by a member at kickoff, on the member's own spot (not a guest).
 *   paid    a booking charged at the match price for every spot it holds that membership does not
 *           cover. `amount` is the price charged INCLUDING credit (creditAmount is the part paid from
 *           credit), so credit counts as paid: it is the player's own money from a cancelled match.
 *   promo   a promo code; a free booking by a non-member ("Free"); or charged below the match price
 *           with no credit explaining the difference ("Below price").
 * A BOOKING is a PLAYER row plus its GUEST rows (same user). An ADDITIONAL_SPOT row is judged on its
 * own payment as a separate booking (Ryan, 2026-10-10) — not as a guest of the main booking — at the
 * match's additionalSpotPrice when it has one, else the match price.
 * Every spot lands in exactly one of the three; a row in any other paid status is counted in
 * `unclassified` so the board can say so rather than hide it. Measured 2026-10-09: none. */
import { rosterRowCounts } from "./gamedayModel";
import { isFakePlayerEmail } from "./mdapiFakePlayer";

export type RosterApiRow = {
  id: number; userId: number; paidStatus?: string | null; userType?: string | null;
  amount?: number | null; creditAmount?: number | null; promocodeId?: number | null;
  isCancelled?: boolean; canceledAt?: string | null; refunded?: boolean;
  isFakePlayer?: boolean; user?: { isFakePlayer?: boolean; email?: string | null };
};
export type SpotLookups = {
  fakeUsers: Set<number>;
  memberAt: (userId: number, kickoffUtcIso: string) => boolean;
  codeOf: (promocodeId: number) => string;
};
export type BelowBooking = { matchId: number; bookingId: number; amountCents: number; spots: number; priceCents: number };
export type MatchSpots = {
  real: number; fake: number;
  paid: number; member: number; promo: number;
  /** Promo spots by code; uncoded promo spots are `free` and `below`. */
  codes: Record<string, number>; free: number; below: number;
  belowBookings: BelowBooking[];
  unclassified: number;
};

export function classifyMatchSpots(
  m: { id: number; registrationPrice?: number | null; additionalSpotPrice?: number | null; startDateUtc: string; players?: RosterApiRow[] | null },
  L: SpotLookups,
): MatchSpots {
  const out: MatchSpots = { real: 0, fake: 0, paid: 0, member: 0, promo: 0, codes: {}, free: 0, below: 0, belowBookings: [], unclassified: 0 };
  const held = (m.players ?? []).filter((p) => rosterRowCounts(p));
  const isFake = (p: RosterApiRow) => L.fakeUsers.has(Number(p.userId)) || p.isFakePlayer === true
    || p.user?.isFakePlayer === true || isFakePlayerEmail(p.user?.email);
  const rows = held.filter((p) => !isFake(p));
  out.fake = held.length - rows.length;
  out.real = rows.length;
  // An additional spot is charged at the match's additional-spot price when it has one.
  const priceOf = (h: RosterApiRow) =>
    h.userType === "ADDITIONAL_SPOT" && m.additionalSpotPrice != null ? Number(m.additionalSpotPrice) : Number(m.registrationPrice ?? 0);

  const hostOf = new Map<number, RosterApiRow>();
  for (const p of rows) if (p.userType === "PLAYER") hostOf.set(Number(p.userId), p);
  const bookingOf = (p: RosterApiRow) => (p.userType === "GUEST" ? hostOf.get(Number(p.userId)) ?? p : p);
  const spotsOf = (h: RosterApiRow) =>
    h.userType === "PLAYER" ? 1 + rows.filter((g) => g.userType === "GUEST" && Number(g.userId) === Number(h.userId)).length : 1;
  const isMember = (h: RosterApiRow) => h.userType !== "GUEST" && h.paidStatus === "FREE" && L.memberAt(Number(h.userId), m.startDateUtc);

  const verdict = new Map<number, "paid" | "free" | "below" | "code" | "other">();
  const judge = (h: RosterApiRow) => {
    const hit = verdict.get(h.id);
    if (hit) return hit;
    const chargeable = spotsOf(h) - (isMember(h) ? 1 : 0);
    const price = priceOf(h);
    let v: "paid" | "free" | "below" | "code" | "other";
    if (h.paidStatus !== "PAID" && h.paidStatus !== "FREE") v = "other";
    else if (h.promocodeId != null) v = "code";
    else if (h.paidStatus === "FREE" && !isMember(h)) v = "free";
    else {
      // PAID, or a member's booking carrying guests: the guests are charged like any booking.
      const amount = Number(h.amount ?? 0), credit = Number(h.creditAmount ?? 0), need = price * chargeable;
      v = price <= 0 || amount >= need || amount + credit >= need ? "paid" : "below";
    }
    verdict.set(h.id, v);
    if (v === "below") out.belowBookings.push({ matchId: m.id, bookingId: h.id, amountCents: Number(h.amount ?? 0), spots: chargeable, priceCents: price });
    return v;
  };

  for (const p of rows) {
    const h = bookingOf(p);
    if (p === h && isMember(h)) { out.member++; continue; }
    const v = judge(h);
    if (v === "paid") out.paid++;
    else if (v === "other") out.unclassified++;
    else {
      out.promo++;
      if (v === "code") { const c = L.codeOf(Number(h.promocodeId)); out.codes[c] = (out.codes[c] ?? 0) + 1; }
      else if (v === "free") out.free++;
      else out.below++;
    }
  }
  return out;
}

/** The lookups for one day's rosters, read in three queries. Throws on a failed read — a tile built
 *  on a partial fake list would count fakes as real. */
export async function spotLookups(
  sb: { from: (t: string) => any }, // eslint-disable-line @typescript-eslint/no-explicit-any
  players: RosterApiRow[],
): Promise<SpotLookups> {
  const userIds = [...new Set(players.map((p) => Number(p.userId)).filter(Number.isFinite))];
  const codeIds = [...new Set(players.map((p) => p.promocodeId).filter((x): x is number => x != null).map(Number))];
  const fakeUsers = new Set<number>();
  const subs = new Map<number, { a: number; c: number | null }[]>();
  for (let i = 0; i < userIds.length; i += 200) {
    const chunk = userIds.slice(i, i + 200);
    const [u, s] = await Promise.all([
      sb.from("mdapi_users").select("id,email,is_fake_player").in("id", chunk),
      sb.from("mdapi_subscriptions").select("user_id,activation_date,canceled_at").in("user_id", chunk),
    ]);
    if (u.error) throw new Error(`mdapi_users: ${u.error.message}`);
    if (s.error) throw new Error(`mdapi_subscriptions: ${s.error.message}`);
    for (const r of u.data ?? []) if (r.is_fake_player === true || isFakePlayerEmail(r.email)) fakeUsers.add(Number(r.id));
    for (const r of s.data ?? []) {
      const a = Date.parse(String(r.activation_date ?? ""));
      if (!Number.isFinite(a)) continue;
      const c = r.canceled_at ? Date.parse(String(r.canceled_at)) : null;
      const l = subs.get(Number(r.user_id)) ?? [];
      l.push({ a, c: c != null && Number.isFinite(c) ? c : null });
      subs.set(Number(r.user_id), l);
    }
  }
  const codes = new Map<number, string>();
  for (let i = 0; i < codeIds.length; i += 200) {
    const { data, error } = await sb.from("mdapi_promocodes").select("api_id,code").in("api_id", codeIds.slice(i, i + 200));
    if (error) throw new Error(`mdapi_promocodes: ${error.message}`);
    for (const r of data ?? []) codes.set(Number(r.api_id), String(r.code));
  }
  return {
    fakeUsers,
    // Active at kickoff: activated at or before it, and not cancelled at or before it (the
    // hasMembershipAtMatchTime rule), compared as instants — startDateUtc is true UTC.
    memberAt: (uid, iso) => {
      const t = Date.parse(iso);
      return Number.isFinite(t) && (subs.get(uid) ?? []).some((s) => s.a <= t && (s.c == null || s.c > t));
    },
    codeOf: (id) => codes.get(id) ?? `#${id}`,
  };
}

/** ATTACH EACH MATCH'S SPOT SUMMARY to the trimmed rows the route returns, from the raw list rows
 *  (which carry `players`). Call AFTER the city scope: it reads lookups only for the rosters that
 *  survived it. The roster itself never reaches the client — only the counts and code names.
 *  A failed lookup leaves `spots` null and says why in `spotsError`; the board then shows "—". */
export async function withSpots<T extends { id: number; startDateUtc: string; registrationPrice?: number | null; additionalSpotPrice?: number | null }>(
  sb: Parameters<typeof spotLookups>[0],
  trimmed: T[],
  raw: readonly object[],
): Promise<{ matches: (T & { spots: MatchSpots | null })[]; spotsError: string | null }> {
  const rosterOf = new Map<number, RosterApiRow[]>();
  for (const r of raw as { id?: unknown; players?: unknown }[]) rosterOf.set(Number(r.id), Array.isArray(r.players) ? (r.players as RosterApiRow[]) : []);
  try {
    const L = await spotLookups(sb, trimmed.flatMap((m) => rosterOf.get(m.id) ?? []));
    return { matches: trimmed.map((m) => ({ ...m, spots: classifyMatchSpots({ ...m, players: rosterOf.get(m.id) ?? [] }, L) })), spotsError: null };
  } catch (e) {
    return { matches: trimmed.map((m) => ({ ...m, spots: null })), spotsError: e instanceof Error ? e.message : String(e) };
  }
}

/* ── THE TILES (Ryan, 2026-10-10) ────────────────────────────────────────────────────────────────
 * CANCELLED MATCHES COUNT NOWHERE: not in Matches, not in the MD Standard, not in the spot tiles,
 * not in Real spots filled (whose field spots drop them too). Paid, Member, Promo and Real spots
 * filled are taken over ONE set of matches — not cancelled, with field spots — so the three add up
 * to the real figure exactly, on every day and every city selection. */
export const MD_STANDARD_SPOTS = 18;
export type SpotTiles = {
  matches: number; cancelled: number; mdStandard: number | null;
  fill: { pct: number | null; real: number; cap: number; fake: number };
  paid: number; member: number; promo: number;
  /** Promo spots by code, most used first; then the uncoded ones. */
  codes: [string, number][]; free: number; below: number;
  unclassified: number;
  /** A counted match has no spot summary (its lookups failed): the spot tiles cannot be stated. */
  missing: boolean;
};
export function spotTiles<M extends ApiMatchLike>(ms: readonly M[], fieldSpotsOf: (m: M) => number | null): SpotTiles {
  const live = ms.filter((m) => !m.isCancelled);
  const t: SpotTiles = {
    matches: live.length, cancelled: ms.length - live.length, mdStandard: null,
    fill: { pct: null, real: 0, cap: 0, fake: 0 }, paid: 0, member: 0, promo: 0, codes: [], free: 0, below: 0, unclassified: 0, missing: false,
  };
  const codes = new Map<string, number>();
  let spotsAll = 0;
  for (const m of live) {
    const c = fieldSpotsOf(m);
    if (c == null || c <= 0) continue;
    spotsAll += c;
    if (!m.spots) { t.missing = true; continue; }
    t.fill.cap += c; t.fill.real += m.spots.real; t.fill.fake += m.spots.fake;
    t.paid += m.spots.paid; t.member += m.spots.member; t.promo += m.spots.promo;
    t.free += m.spots.free; t.below += m.spots.below; t.unclassified += m.spots.unclassified;
    for (const [k, n] of Object.entries(m.spots.codes)) codes.set(k, (codes.get(k) ?? 0) + n);
  }
  t.mdStandard = spotsAll > 0 ? Math.round((spotsAll / MD_STANDARD_SPOTS) * 10) / 10 : null;
  t.fill.pct = !t.missing && t.fill.cap > 0 ? (t.fill.real / t.fill.cap) * 100 : null;
  t.codes = [...codes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return t;
}
type ApiMatchLike = { isCancelled?: boolean; spots?: MatchSpots | null };
