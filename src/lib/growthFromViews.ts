// Growth analytics rebuilt from the growth_* materialized views instead of the
// 232k-row matches+players fetch. Produces the SAME GrowthData shape as
// computeGrowth (validated deep-equal against it in production), EXCEPT players[]
// is empty — the churn card now reads /api/growth/churn (paginated), the only
// consumer that ever needed it. Everything play-derived is reconstructed from:
//   growth_player_profile   one row/player: first/last, matches, city_counts, ev
//   growth_play_dims        spots + amount by (month, city, field)   [additive]
//   growth_registration     one row/non-fake user: signup_month, declared, lifetime
//   growth_downloads_month  android installs by month
// plus the small mdapi_subscriptions + fin_revenue reads (never the 232k fetch).
//
// The venue/city/attribution RESOLVERS stay identical to computeGrowth's — we
// import them, we do not re-derive them. The views store raw codes/titles; this
// file normalises + canonicalises exactly as computeGrowth does, so raw rows that
// collapse together (venue aliases, city codes) collapse here too.

import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalVenueName, venueCategory } from "./venueResolver";
import {
  type GrowthData,
  type BehaviorPoint,
  type ArppPoint,
  CANONICAL_CITIES,
  UNKNOWN_CITY,
  monthKey,
  normalizeDeclared,
  normalizeMatchCity,
  normalizeRevenueCity,
  revMonthToKey,
  addMonthsToKey,
  monthDiff,
  monthRange,
  type RawSubscription,
  type RawRevenue,
} from "./growthAnalytics";

const DAY_MS = 86_400_000;

// ── view row shapes (raw; this file normalises) ──────────────────────────────
export type ProfileRow = {
  user_id: number;
  first_match_date: string;
  first_match_month: string;
  first_match_city: string | null;
  first_match_field_title: string | null;
  first_match_field_id: number | null;
  last_match_date: string;
  last_match_city: string | null;
  last_match_field_title: string | null;
  last_match_field_id: number | null;
  matches_played: number;
  city_counts: Record<string, number>; // raw code (or '__NULL__') -> count
  ev: string[]; // DISTINCT 'month|code|field_title|field_id'
};
export type PlayDimRow = {
  match_month: string;
  city_identifier: string | null;
  field_title: string | null;
  field_id: number | null;
  spots: number;
  amount: number | string; // numeric may arrive as string
};
export type RegistrationRow = {
  user_id: number;
  completed: boolean;
  signup_month: string | null;
  declared_city_raw: string | null;
  lifetime_matches: number;
};
export type DownloadMonthRow = { month: string; count: number };

export type ViewInput = {
  profiles: ProfileRow[];
  playDims: PlayDimRow[];
  registrations: RegistrationRow[];
  subscriptions: RawSubscription[];
  revenue: RawRevenue[];
  downloadsMonth: DownloadMonthRow[];
  now: string;
  rowCounts: GrowthData["rowCounts"];
};

const fieldOf = (title: string | null, id: number | null): string =>
  canonicalVenueName(title ?? "") || (id != null ? `Field ${id}` : "Unknown field");

// tiny nested-map helpers (same semantics as growthAnalytics)
function inc2(map: Map<string, Map<string, number>>, k1: string, k2: string, v = 1) {
  let inner = map.get(k1);
  if (!inner) map.set(k1, (inner = new Map()));
  inner.set(k2, (inner.get(k2) ?? 0) + v);
}
function addSet(map: Map<string, Set<number>>, k: string, v: number) {
  let s = map.get(k);
  if (!s) map.set(k, (s = new Set()));
  s.add(v);
}
function addSet2(map: Map<string, Map<string, Set<number>>>, k1: string, k2: string, v: number) {
  let inner = map.get(k1);
  if (!inner) map.set(k1, (inner = new Map()));
  let s = inner.get(k2);
  if (!s) inner.set(k2, (s = new Set()));
  s.add(v);
}

export function computeGrowthFromViews(input: ViewInput): GrowthData {
  const { profiles, playDims, registrations, subscriptions, revenue, downloadsMonth, now } = input;
  const nowDate = new Date(now);
  const nowMonth = monthKey(now);

  // ── registrations / declared city (from growth_registration) ────────────────
  const completedUsers = registrations.filter((r) => r.completed && r.signup_month);
  const declaredByUser = new Map<number, string | null>();
  const rawDeclaredByUser = new Map<number, string | null>();
  for (const r of registrations) {
    declaredByUser.set(r.user_id, normalizeDeclared(r.declared_city_raw));
    rawDeclaredByUser.set(r.user_id, r.declared_city_raw?.trim() || null);
  }
  const regByMonth = new Map<string, number>();
  for (const u of completedUsers) regByMonth.set(u.signup_month!, (regByMonth.get(u.signup_month!) ?? 0) + 1);

  // ── per-player reconstruction (replaces agg/playerRows) ─────────────────────
  type Agg = {
    u: number;
    first: string; // first-play month
    last: string; // last-play date
    firstCity: string;
    firstField: string;
    lastField: string;
    lastCity: string;
    count: number;
    cityCount: Map<string, number>; // display city -> count
    activeMonths: Set<string>;
    // distinct (month, displayCity, canonField) triples, re-deduped after resolve
    evCity: Map<string, Set<string>>; // month -> set of display cities
    evField: { month: string; field: string; isEvent: boolean }[]; // distinct field-months
  };
  const aggs: Agg[] = [];
  for (const p of profiles) {
    const cityCount = new Map<string, number>();
    for (const [code, n] of Object.entries(p.city_counts ?? {})) {
      const disp = normalizeMatchCity(code === "__NULL__" ? null : code);
      cityCount.set(disp, (cityCount.get(disp) ?? 0) + n);
    }
    const activeMonths = new Set<string>();
    const evCity = new Map<string, Set<string>>();
    const fieldSeen = new Set<string>();
    const evField: { month: string; field: string; isEvent: boolean }[] = [];
    for (const raw of p.ev ?? []) {
      const [month, code, title, idStr] = raw.split("|");
      activeMonths.add(month);
      const disp = normalizeMatchCity(code === "" ? null : code);
      (evCity.get(month) ?? evCity.set(month, new Set()).get(month)!).add(disp);
      const field = fieldOf(title === "" ? null : title, idStr === "" ? null : Number(idStr));
      const isEvent = venueCategory(title === "" ? null : title) === "event";
      const fk = `${month}|${field}|${isEvent ? 1 : 0}`;
      if (!fieldSeen.has(fk)) {
        fieldSeen.add(fk);
        evField.push({ month, field, isEvent });
      }
    }
    aggs.push({
      u: p.user_id,
      first: p.first_match_month,
      last: p.last_match_date,
      firstCity: normalizeMatchCity(p.first_match_city),
      firstField: fieldOf(p.first_match_field_title, p.first_match_field_id),
      lastField: fieldOf(p.last_match_field_title, p.last_match_field_id),
      lastCity: normalizeMatchCity(p.last_match_city),
      count: p.matches_played,
      cityCount,
      activeMonths,
      evCity,
      evField,
    });
  }

  function mostFrequentCity(a: Agg): string {
    let best = a.lastCity;
    let bestN = -1;
    for (const [c, n] of a.cityCount) if (n > bestN || (n === bestN && c === a.lastCity)) { bestN = n; best = c; }
    return best;
  }
  const attributedCity = (a: Agg): string => declaredByUser.get(a.u) ?? mostFrequentCity(a);

  // ── play months / floor ─────────────────────────────────────────────────────
  const playMonthsSet = new Set<string>();
  for (const d of playDims) playMonthsSet.add(d.match_month);
  const playMonths = [...playMonthsSet].sort();
  const playFloor = playMonths[0] ?? "2026-01";

  const played1 = aggs.length;
  const played5 = aggs.filter((a) => a.count >= 5).length;

  // ── nested cohort funnel (from growth_registration) ─────────────────────────
  const funnelAgg = new Map<string, { registrations: number; played1: number; played3: number; played5: number; played10: number }>();
  for (const u of completedUsers) {
    const m = u.signup_month!;
    let row = funnelAgg.get(m);
    if (!row) funnelAgg.set(m, (row = { registrations: 0, played1: 0, played3: 0, played5: 0, played10: 0 }));
    row.registrations++;
    const lm = u.lifetime_matches ?? 0;
    if (lm >= 1) row.played1++;
    if (lm >= 3) row.played3++;
    if (lm >= 5) row.played5++;
    if (lm >= 10) row.played10++;
  }
  const funnelByMonth = [...funnelAgg.entries()].sort().map(([m, r]) => ({ m, ...r }));
  for (const r of funnelByMonth) {
    if (!(r.registrations >= r.played1 && r.played1 >= r.played3 && r.played3 >= r.played5 && r.played5 >= r.played10))
      throw new Error(`funnel cohort not nested for ${r.m}: ${JSON.stringify(r)}`);
  }

  // ── city + field universe ────────────────────────────────────────────────────
  const declaredCitySet = new Set<string>();
  for (const u of completedUsers) { const c = normalizeDeclared(u.declared_city_raw); if (c) declaredCitySet.add(c); }
  const playLocCitySet = new Set<string>();
  const fieldCityMap = new Map<string, string>();
  for (const d of playDims) {
    const city = normalizeMatchCity(d.city_identifier);
    playLocCitySet.add(city);
    const field = fieldOf(d.field_title, d.field_id);
    if (!fieldCityMap.has(field)) fieldCityMap.set(field, city);
  }
  const cityIndex = (CANONICAL_CITIES as readonly string[]).filter((c) => playLocCitySet.has(c) || declaredCitySet.has(c));
  for (const c of [...playLocCitySet, ...declaredCitySet]) if (!cityIndex.includes(c)) cityIndex.push(c);
  const cityHasMatches = cityIndex.map((c) => playLocCitySet.has(c));
  const fieldList = [...fieldCityMap.keys()];
  const fieldIndex = fieldList.map((f) => ({ label: f, city: fieldCityMap.get(f)! }));

  // cities that appear in play data (attributed) — ordered.
  const playCitySet = new Set<string>();
  for (const a of aggs) playCitySet.add(attributedCity(a));
  const cities = (CANONICAL_CITIES as readonly string[]).filter((c) => playCitySet.has(c)) as string[];
  for (const c of playCitySet) if (!cities.includes(c)) cities.push(c);

  // ── behavior series ───────────────────────────────────────────────────────
  const behaviorAxis = monthRange(
    [...regByMonth.keys()].sort()[0] ?? playFloor,
    [nowMonth, playMonths[playMonths.length - 1] ?? playFloor].sort().pop()!,
  );

  // new = first-play month/city/field
  const newByMonth = new Map<string, number>();
  const newByCity = new Map<string, Map<string, number>>();
  const newByField = new Map<string, Map<string, number>>();
  for (const a of aggs) {
    newByMonth.set(a.first, (newByMonth.get(a.first) ?? 0) + 1);
    inc2(newByCity, a.firstCity, a.first);
    inc2(newByField, a.firstField, a.first);
  }
  // spots (additive, from play_dims); distinct active (from ev)
  const spotsByMonth = new Map<string, number>();
  const spotsByCity = new Map<string, Map<string, number>>();
  const spotsByField = new Map<string, Map<string, number>>();
  const eventSpotsByField = new Map<string, Map<string, number>>();
  const fieldCity = new Map<string, string>();
  for (const d of playDims) {
    const city = normalizeMatchCity(d.city_identifier);
    const field = fieldOf(d.field_title, d.field_id);
    const isEvent = venueCategory(d.field_title) === "event";
    spotsByMonth.set(d.match_month, (spotsByMonth.get(d.match_month) ?? 0) + d.spots);
    inc2(spotsByCity, city, d.match_month, d.spots);
    if (isEvent) inc2(eventSpotsByField, field, d.match_month, d.spots);
    else inc2(spotsByField, field, d.match_month, d.spots);
    if (!fieldCity.has(field)) fieldCity.set(field, city);
  }
  const activeByMonth = new Map<string, Set<number>>();
  const activeByCity = new Map<string, Map<string, Set<number>>>();
  const activeByField = new Map<string, Map<string, Set<number>>>();
  const eventActiveByField = new Map<string, Map<string, Set<number>>>();
  for (const a of aggs) {
    for (const m of a.activeMonths) addSet(activeByMonth, m, a.u);
    for (const [m, citySet] of a.evCity) for (const c of citySet) addSet2(activeByCity, c, m, a.u);
    for (const ef of a.evField) {
      if (ef.isEvent) addSet2(eventActiveByField, ef.field, ef.month, a.u);
      else addSet2(activeByField, ef.field, ef.month, a.u);
    }
  }
  const eventFields = [...eventSpotsByField.keys()]
    .map((f) => {
      let spots = 0;
      for (const v of eventSpotsByField.get(f)?.values() ?? []) spots += v;
      const players = new Set<number>();
      for (const s of eventActiveByField.get(f)?.values() ?? []) for (const u of s) players.add(u);
      return { label: f, city: fieldCity.get(f) ?? UNKNOWN_CITY, spots, players: players.size };
    })
    .filter((e) => e.spots > 0)
    .sort((a, b) => b.spots - a.spots);

  const regByMonthCity = new Map<string, Map<string, number>>();
  for (const u of completedUsers) { const city = normalizeDeclared(u.declared_city_raw); if (city) inc2(regByMonthCity, city, u.signup_month!); }

  const behaviorOverall = behaviorAxis.map<BehaviorPoint>((m) => ({
    m,
    registrations: regByMonth.has(m) ? regByMonth.get(m)! : m < playFloor ? 0 : (regByMonth.get(m) ?? 0),
    newPlayers: m < playFloor ? null : newByMonth.get(m) ?? 0,
    totalPlayers: m < playFloor ? null : activeByMonth.get(m)?.size ?? 0,
    spots: m < playFloor ? null : spotsByMonth.get(m) ?? 0,
  }));
  const regFloorMonth = [...regByMonth.keys()].sort()[0] ?? "2023-03";
  const behaviorByCity: Record<string, BehaviorPoint[]> = {};
  for (const c of cityIndex) {
    behaviorByCity[c] = behaviorAxis.map<BehaviorPoint>((m) => ({
      m,
      registrations: regByMonthCity.get(c)?.get(m) ?? (m < regFloorMonth ? null : 0),
      newPlayers: m < playFloor ? null : newByCity.get(c)?.get(m) ?? 0,
      totalPlayers: m < playFloor ? null : activeByCity.get(c)?.get(m)?.size ?? 0,
      spots: m < playFloor ? null : spotsByCity.get(c)?.get(m) ?? 0,
    }));
  }
  const behaviorByField: GrowthData["behaviorByField"] = {};
  for (const f of spotsByField.keys()) {
    behaviorByField[f] = {
      label: f,
      city: fieldCity.get(f) ?? UNKNOWN_CITY,
      points: playMonths.map<BehaviorPoint>((m) => ({
        m,
        registrations: null,
        newPlayers: newByField.get(f)?.get(m) ?? 0,
        totalPlayers: activeByField.get(f)?.get(m)?.size ?? 0,
        spots: spotsByField.get(f)?.get(m) ?? 0,
      })),
    };
  }

  // ── ARPP ──────────────────────────────────────────────────────────────────
  const netByMonth = new Map<string, number>();
  const netByMonthCity = new Map<string, Map<string, number>>();
  const deletedByMonth = new Map<string, number>();
  const unattribMembByMonth = new Map<string, number>();
  for (const r of revenue) {
    if (!r.month) continue;
    const k = revMonthToKey(r.month);
    if (!k) continue;
    const net = Number(r.net ?? 0);
    netByMonth.set(k, (netByMonth.get(k) ?? 0) + net);
    inc2(netByMonthCity, normalizeRevenueCity(r.city), k, net);
    const cityRaw = (r.city ?? "").trim();
    if (cityRaw === "Deleted Account Revenue") deletedByMonth.set(k, (deletedByMonth.get(k) ?? 0) + net);
    else if (r.type === "Membership" && normalizeRevenueCity(r.city) === UNKNOWN_CITY)
      unattribMembByMonth.set(k, (unattribMembByMonth.get(k) ?? 0) + net);
  }

  const revMonths = [...netByMonth.keys()].sort();
  const arppMonths = [...new Set([...playMonths, ...revMonths])].sort();
  const membersByMonth = new Map<string, Set<number>>();
  const membersByCity = new Map<string, Map<string, Set<number>>>();
  for (const s of subscriptions) {
    if (s.user_id == null || !s.activation_date) continue;
    const act = monthKey(s.activation_date);
    const cancel = s.canceled_at ? monthKey(s.canceled_at) : null;
    const city = normalizeMatchCity(s.city_identifier);
    for (const m of arppMonths) {
      if (m < act) continue;
      if (cancel && m > cancel) continue;
      addSet(membersByMonth, m, s.user_id);
      addSet2(membersByCity, city, m, s.user_id);
    }
  }
  const playedByMonth = activeByMonth;
  const arppSeries = (
    net: (m: string) => number,
    played: (m: string) => Set<number> | undefined,
    members: (m: string) => Set<number> | undefined,
  ): ArppPoint[] =>
    arppMonths.map((m) => {
      const pl = played(m) ?? new Set<number>();
      const me = members(m) ?? new Set<number>();
      let both = 0;
      for (const u of pl) if (me.has(u)) both++;
      const playedOnly = pl.size - both;
      const subOnly = me.size - both;
      const denom = playedOnly + subOnly + both;
      const n = net(m);
      return { m, net: n, denom, playedOnly, subOnly, both, arpp: denom ? n / denom : 0 };
    });
  const arppOverall = arppSeries((m) => netByMonth.get(m) ?? 0, (m) => playedByMonth.get(m), (m) => membersByMonth.get(m));

  // played players attributed to city c, active in month m (any location) — the
  // exact quantity computeGrowth's arppByCity uses (its ev triple only reads the
  // month index; the city filter is the player's attributed city).
  const attributedByCity = new Map<string, Set<number>>(); // month is not the key — see below
  const playersByAttrCity = new Map<string, Agg[]>();
  for (const a of aggs) (playersByAttrCity.get(attributedCity(a)) ?? playersByAttrCity.set(attributedCity(a), []).get(attributedCity(a))!).push(a);
  void attributedByCity;
  const arppByCity: Record<string, ArppPoint[]> = {};
  const arppCitySet = new Set<string>([...cities, ...netByMonthCity.keys(), ...membersByCity.keys()]);
  for (const c of arppCitySet) {
    const members = playersByAttrCity.get(c) ?? [];
    const playedCity = (m: string): Set<number> => {
      const set = new Set<number>();
      for (const a of members) if (a.activeMonths.has(m)) set.add(a.u);
      return set;
    };
    arppByCity[c] = arppSeries((m) => netByMonthCity.get(c)?.get(m) ?? 0, playedCity, (m) => membersByCity.get(c)?.get(m));
  }

  const arppDiagnostics = {
    byMonth: arppMonths.map((m) => ({
      m,
      totalNet: netByMonth.get(m) ?? 0,
      deletedNet: deletedByMonth.get(m) ?? 0,
      unattributedMembership: unattribMembByMonth.get(m) ?? 0,
    })),
    deletedTotal: [...deletedByMonth.values()].reduce((a, v) => a + v, 0),
    unattributedMembershipTotal: [...unattribMembByMonth.values()].reduce((a, v) => a + v, 0),
  };

  // cohorts, retentionCurveOverall/ByCity, reconciliation and attribution are part
  // of the GrowthData type but NOTHING on the client reads them (the retention
  // curve + cohort table now come from /api/growth/retention). Their derivations
  // looped over all ~14k players × cohorts × cities — pure lambda CPU for a payload
  // nobody consumes — so they're intentionally omitted (empty in the return below).
  // If a future card needs them, prefer a dedicated view/endpoint over recomputing
  // here. rawDeclaredByUser is likewise now unused; kept in scope harmlessly.
  void rawDeclaredByUser;

  // ── downloads (android monthly rollup) ──────────────────────────────────────
  const androidByMonth = [...downloadsMonth].sort((a, b) => (a.month < b.month ? -1 : 1)).map((d) => ({ m: d.month, count: Number(d.count) }));
  const androidTotal = androidByMonth.reduce((s, d) => s + d.count, 0);
  const downloads: GrowthData["downloads"] = {
    androidByMonth,
    // earliest/latest are month keys here (the daily grain isn't fetched); null
    // until the Play ingest lands rows, exactly like computeGrowth with no daily.
    android: androidByMonth.length ? { earliest: androidByMonth[0].m, latest: androidByMonth[androidByMonth.length - 1].m, total: androidTotal } : null,
    ios: null,
  };

  return {
    generatedAt: now,
    rowCounts: input.rowCounts,
    downloads,
    floors: { registrations: "2023-03", memberships: "2024-02", play: playFloor, revenue: revMonths[0] ?? "2026-01" },
    playMonths,
    kpis: {
      downloads: null,
      registrations: completedUsers.length,
      accountsCreated: registrations.length,
      onboardingGap: registrations.length - completedUsers.length,
      played1,
      played5,
    },
    registrationsByMonth: [], // unused by the client
    funnelByMonth,
    players: [], // dropped from the payload — churn card reads /api/growth/churn
    behaviorOverall,
    behaviorByCity,
    behaviorByField,
    eventFields: [], // unused by the client
    cityIndex: [], // internal only (drives behaviorByCity); not consumed downstream
    cityHasMatches: [], // unused by the client
    fieldIndex: [], // unused by the client
    arppOverall,
    arppByCity,
    arppDiagnostics,
    cohorts: [], // see note above — not consumed; /api/growth/retention serves cohorts
    retentionCurveOverall: [], // not consumed
    retentionCurveByCity: {}, // not consumed
    cities,
    reconciliation: { rows: [], dppTotal: 0, strictTotal: 0, gapTotal: 0, deletedAccountRevenue: 0 }, // not consumed
    attribution: { declared: [], mostFrequent: [], disagreeRaw: 0, disagreeNormalized: 0, fallbackUsed: 0 }, // not consumed
  };
}

// ── the view reader ──────────────────────────────────────────────────────────
// Parallel paginator: count once, then fetch every 1000-row page concurrently
// (capped). PostgREST caps a response at 1000 rows, but the pages are independent
// range() slices, so firing them together turns N sequential round-trips into ~2
// — the difference between a 7s and a sub-second read of the 14k/29k views.
const PAGE = 1000;
const CONCURRENCY = 8;
async function selectAll<T>(sb: SupabaseClient, table: string, cols: string, order: string): Promise<T[]> {
  const { count, error: cErr } = await sb.from(table).select("*", { count: "exact", head: true });
  if (cErr) throw new Error(`${table} count: ${cErr.message}`);
  const total = count ?? 0;
  if (total === 0) return [];
  const pageCount = Math.ceil(total / PAGE);
  const out: T[] = new Array(total);
  let next = 0;
  async function worker() {
    for (;;) {
      const p = next++;
      if (p >= pageCount) return;
      const from = p * PAGE;
      const { data, error } = await sb.from(table).select(cols).order(order, { ascending: true }).range(from, from + PAGE - 1);
      if (error) throw new Error(`${table} page ${p}: ${error.message}`);
      const rows = (data ?? []) as unknown as T[];
      for (let i = 0; i < rows.length; i++) out[from + i] = rows[i];
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pageCount) }, worker));
  // trim any tail holes if the count drifted (rows changed between count and read)
  return out.filter((r) => r !== undefined);
}

export async function readGrowthFromViews(
  sb: SupabaseClient,
  now: string,
  timing?: { fetchMs?: number; computeMs?: number },
): Promise<GrowthData> {
  const tFetch = Date.now();
  const [profiles, playDims, registrations, subscriptions, revenue, downloadsMonth, rowCounts] = await Promise.all([
    selectAll<ProfileRow>(
      sb,
      "growth_player_profile",
      "user_id, first_match_date, first_match_month, first_match_city, first_match_field_title, first_match_field_id, last_match_date, last_match_city, last_match_field_title, last_match_field_id, matches_played, city_counts, ev",
      "user_id",
    ),
    selectAll<PlayDimRow>(sb, "growth_play_dims", "match_month, city_identifier, field_title, field_id, spots, amount", "match_month"),
    selectAll<RegistrationRow>(sb, "growth_registration", "user_id, completed, signup_month, declared_city_raw, lifetime_matches", "user_id"),
    selectAll<RawSubscription>(sb, "mdapi_subscriptions", "user_id, city_identifier, activation_date, canceled_at", "membership_id"),
    selectAll<RawRevenue>(sb, "fin_revenue", "month, city, type, net", "id"),
    selectAll<DownloadMonthRow>(sb, "growth_downloads_month", "month, count", "month"),
    readRowCounts(sb),
  ]);
  if (timing) timing.fetchMs = Date.now() - tFetch;
  const tCompute = Date.now();
  const out = computeGrowthFromViews({ profiles, playDims, registrations, subscriptions, revenue, downloadsMonth, now, rowCounts });
  if (timing) timing.computeMs = Date.now() - tCompute;
  return out;
}

// rowCounts from the growth_row_counts materialized view (migration 0099): a
// single pre-computed row, so the request never scans the 232k mdapi_match_players
// (a ~2s seq scan that mdapi_*'s read-only rule forbids indexing away). The counts
// are footnote diagnostics refreshed with the other growth_* views. Falls back to
// per-metric head counts if the matview is absent (pre-0099) so nothing breaks.
async function readRowCounts(sb: SupabaseClient): Promise<GrowthData["rowCounts"]> {
  const { data, error } = await sb.from("growth_row_counts").select("*").maybeSingle();
  if (!error && data) {
    const d = data as Record<string, number>;
    return {
      matchesTotal: d.matches_total, matchesLive: d.matches_live,
      playersTotal: d.players_total, playersLive: d.players_live,
      fakeLiveRows: d.fake_live_rows, fakeLivePct: d.players_live > 0 ? d.fake_live_rows / d.players_live : 0,
      waitingLiveNonFake: d.waiting_live_nonfake,
      usersTotal: d.users_total, usersNonFake: d.users_nonfake, usersFake: d.users_total - d.users_nonfake,
      usersCompletedNonFake: d.users_completed_nonfake,
      subscriptions: d.subscriptions, finRevenue: d.fin_revenue,
    };
  }
  console.warn("[growth] growth_row_counts matview unavailable, falling back to head counts:", error?.message);
  const headCount = async (table: string, apply?: (q: any) => any): Promise<number> => {
    let q = sb.from(table).select("*", { count: "exact", head: true });
    if (apply) q = apply(q);
    return (await q).count ?? 0;
  };
  const [matchesTotal, matchesLive, playersTotal, playersLive, fakeLiveRows, waitingLiveNonFake, usersTotal, usersNonFake, usersCompletedNonFake, subscriptions, finRevenue] = await Promise.all([
    headCount("mdapi_matches"),
    headCount("mdapi_matches", (q) => q.is("deleted_at", null)),
    headCount("mdapi_match_players"),
    headCount("mdapi_match_players", (q) => q.is("deleted_at", null)),
    headCount("mdapi_match_players", (q) => q.is("deleted_at", null).eq("user_is_fake_player", true)),
    headCount("mdapi_match_players", (q) => q.is("deleted_at", null).neq("user_is_fake_player", true).eq("paid_status", "WAITING")),
    headCount("mdapi_users"),
    headCount("mdapi_users", (q) => q.neq("is_fake_player", true)),
    headCount("mdapi_users", (q) => q.neq("is_fake_player", true).not("completed_sign_up_at", "is", null)),
    headCount("mdapi_subscriptions"),
    headCount("fin_revenue"),
  ]);
  return {
    matchesTotal, matchesLive, playersTotal, playersLive,
    fakeLiveRows, fakeLivePct: playersLive > 0 ? fakeLiveRows / playersLive : 0, waitingLiveNonFake,
    usersTotal, usersNonFake, usersFake: usersTotal - usersNonFake, usersCompletedNonFake,
    subscriptions, finRevenue,
  };
}
