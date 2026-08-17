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
  iosDownloadsMonth?: DownloadMonthRow[];
  now: string;
  rowCounts: GrowthData["rowCounts"];
  // Per-platform ingest health, computed by the async loader (env + fin_sync_log)
  // and passed through. Optional so pure callers/tests can omit (→ not_configured).
  playSync?: GrowthData["playSync"];
  appleSync?: GrowthData["appleSync"];
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

  // THE SAME COHORT FUNNEL, SPLIT BY THE CITY DECLARED AT REGISTRATION — mirrors computeGrowth so
  // both producers of GrowthData agree. Downloads are absent by definition (the stores report
  // country/region, never city), and registrations with no usable declared city are counted
  // separately rather than folded into a city, so the cities do not sum to the national row.
  const funnelCityAgg = new Map<string, { registrations: number; played1: number; played3: number; played5: number; played10: number }>();
  const funnelUnattributedAgg = new Map<string, number>();
  for (const u of completedUsers) {
    const m = u.signup_month!;
    const city = declaredByUser.get(u.user_id) ?? null;
    if (!city) {
      funnelUnattributedAgg.set(m, (funnelUnattributedAgg.get(m) ?? 0) + 1);
      continue;
    }
    const key = `${m}\u0000${city}`;
    let row = funnelCityAgg.get(key);
    if (!row) funnelCityAgg.set(key, (row = { registrations: 0, played1: 0, played3: 0, played5: 0, played10: 0 }));
    row.registrations++;
    const lm = u.lifetime_matches ?? 0;
    if (lm >= 1) row.played1++;
    if (lm >= 3) row.played3++;
    if (lm >= 5) row.played5++;
    if (lm >= 10) row.played10++;
  }
  const funnelByMonthCity = [...funnelCityAgg.entries()].sort()
    .map(([k, r]) => { const [m, city] = k.split("\u0000"); return { m, city, ...r }; });
  const funnelUnattributed = [...funnelUnattributedAgg.entries()].sort().map(([m, registrations]) => ({ m, registrations }));
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
  // NEW AT A FIELD = the month of that player's FIRST MATCH AT THAT FIELD, events included.
  //
  // a.firstField is the field of the player's FIRST-EVER MatchDay match, which can only attribute a
  // player to ONE field for life. Measured on PARMER Stadium, Aug 2026: that rule counts 28 while
  // "first match at this field" counts 116 — and the second is what the partner dashboard means by
  // "new to PARMER Stadium". partnerRentalDashboard has NO event filter at all, so this must not
  // have one either: one population, one filter, or the two pages disagree.
  const newAtFieldByField = new Map<string, Map<string, number>>();
  for (const a of aggs) {
    newByMonth.set(a.first, (newByMonth.get(a.first) ?? 0) + 1);
    inc2(newByCity, a.firstCity, a.first);
    inc2(newByField, a.firstField, a.first);
    // evField is this player's distinct (month, field) appearances — event rows included.
    const firstAt = new Map<string, string>();
    for (const ef of a.evField) {
      const cur = firstAt.get(ef.field);
      if (cur == null || ef.month < cur) firstAt.set(ef.field, ef.month);
    }
    for (const [field, month] of firstAt) inc2(newAtFieldByField, field, month);
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
    // EVENTS COUNT ON BOTH SIDES. Excluding them from totals while counting them nowhere else made
    // ATH Pearland read 0 players in April 2026 — a month in which 75 people played there for the
    // first time. The event share is still tracked, for MARKING a spike as a tournament rather than
    // for removing it.
    inc2(spotsByField, field, d.match_month, d.spots);
    if (isEvent) inc2(eventSpotsByField, field, d.match_month, d.spots);
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
      addSet2(activeByField, ef.field, ef.month, a.u);
      if (ef.isEvent) addSet2(eventActiveByField, ef.field, ef.month, a.u);
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
        // FIRST MATCH AT THIS FIELD — newByField (first-EVER match here) is deliberately not used;
        // it disagrees with the partner dashboard by 4x.
        newPlayers: newAtFieldByField.get(f)?.get(m) ?? 0,
        totalPlayers: activeByField.get(f)?.get(m)?.size ?? 0,
        spots: spotsByField.get(f)?.get(m) ?? 0,
        // Informational: how much of this month was a tournament. Already inside the totals above.
        eventSpots: eventSpotsByField.get(f)?.get(m) ?? 0,
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
  const iosByMonth = [...(input.iosDownloadsMonth ?? [])].sort((a, b) => (a.month < b.month ? -1 : 1)).map((d) => ({ m: d.month, count: Number(d.count) }));
  const iosTotal = iosByMonth.reduce((s, d) => s + d.count, 0);
  const downloads: GrowthData["downloads"] = {
    androidByMonth,
    // earliest/latest are month keys here (the daily grain isn't fetched); null
    // until the ingest lands rows, exactly like computeGrowth with no daily.
    android: androidByMonth.length ? { earliest: androidByMonth[0].m, latest: androidByMonth[androidByMonth.length - 1].m, total: androidTotal } : null,
    iosByMonth,
    ios: iosByMonth.length ? { earliest: iosByMonth[0].m, latest: iosByMonth[iosByMonth.length - 1].m, total: iosTotal } : null,
  };

  // Finalize per-platform ingest health: any rows for a platform = "synced";
  // otherwise keep the loader-supplied no-data state. Mirrors computeGrowth.
  const playSyncBase: GrowthData["playSync"] =
    input.playSync ?? { state: "not_configured", lastRunAt: null, error: null, lastSyncedDate: null };
  const playSync: GrowthData["playSync"] = androidByMonth.length
    ? { ...playSyncBase, state: "synced", lastSyncedDate: androidByMonth[androidByMonth.length - 1].m }
    : { ...playSyncBase, lastSyncedDate: null };
  const appleSyncBase: GrowthData["appleSync"] =
    input.appleSync ?? { state: "not_configured", lastRunAt: null, error: null, lastSyncedDate: null };
  const appleSync: GrowthData["appleSync"] = iosByMonth.length
    ? { ...appleSyncBase, state: "synced", lastSyncedDate: iosByMonth[iosByMonth.length - 1].m }
    : { ...appleSyncBase, lastSyncedDate: null };

  return {
    generatedAt: now,
    rowCounts: input.rowCounts,
    downloads,
    playSync,
    appleSync,
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
    funnelByMonthCity,
    funnelUnattributed,
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

// ── ARPP card (v2): selected-month + annual ARPP per entity ──────────────────
// Deleted-account revenue is dropped from BOTH sides (its rows are gone from the
// denominator; here we drop its revenue from the numerator too). A period with no
// denominator yields null → the card renders an em-dash, never $0.00. Field-level
// membership = each member's subs.price split evenly across the distinct fields
// they played that month; zero-match members go to a city-level unallocated bucket.
import type { ArppCard, ArppEntity, ArppTriple } from "./growthAnalytics";

const DELETED_CITY = "Deleted Account Revenue";
const yearOf = (m: string) => m.slice(0, 4);

export function computeArppCard(
  profiles: ProfileRow[],
  subscriptions: (RawSubscription & { price?: number | null })[],
  revenue: (RawRevenue & { venue?: string | null })[],
  now: string,
): ArppCard {
  // ── per-user play activity from ev (month → distinct cities / fields) ────────
  const evByUser = new Map<number, { month: string; city: string; field: string }[]>();
  for (const p of profiles) {
    const list: { month: string; city: string; field: string }[] = [];
    for (const raw of p.ev ?? []) {
      const [month, code, title, idStr] = raw.split("|");
      list.push({
        month,
        city: normalizeMatchCity(code === "" ? null : code),
        field: fieldOf(title === "" ? null : title, idStr === "" ? null : Number(idStr)),
      });
    }
    evByUser.set(p.user_id, list);
  }
  // played distinct-user sets, indexed by month and by year, at network/city/field grain.
  const playedM = new Map<string, Set<number>>();
  const playedMCity = new Map<string, Map<string, Set<number>>>();
  const playedMField = new Map<string, Map<string, Set<number>>>();
  const playedY = new Map<string, Set<number>>();
  const playedYCity = new Map<string, Map<string, Set<number>>>();
  const playedYField = new Map<string, Map<string, Set<number>>>();
  const add = (m: Map<string, Set<number>>, k: string, u: number) => (m.get(k) ?? m.set(k, new Set()).get(k)!).add(u);
  const add2 = (m: Map<string, Map<string, Set<number>>>, k1: string, k2: string, u: number) => {
    let inner = m.get(k1);
    if (!inner) m.set(k1, (inner = new Map()));
    (inner.get(k2) ?? inner.set(k2, new Set()).get(k2)!).add(u);
  };
  for (const [u, list] of evByUser) {
    for (const e of list) {
      const y = yearOf(e.month);
      add(playedM, e.month, u); add(playedY, y, u);
      add2(playedMCity, e.city, e.month, u); add2(playedYCity, e.city, y, u);
      add2(playedMField, e.field, e.month, u); add2(playedYField, e.field, y, u);
    }
  }

  // ── revenue: clean (deleted excluded) net by month / city / field ────────────
  const netCleanM = new Map<string, number>();
  const deletedM = new Map<string, number>();
  const netMCity = new Map<string, Map<string, number>>();
  const netMFieldNonMember = new Map<string, Map<string, number>>(); // non-membership venue revenue by field
  const inc = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  const inc2 = (m: Map<string, Map<string, number>>, k1: string, k2: string, v: number) => {
    let inner = m.get(k1);
    if (!inner) m.set(k1, (inner = new Map()));
    inner.set(k2, (inner.get(k2) ?? 0) + v);
  };
  for (const r of revenue) {
    if (!r.month) continue;
    const k = revMonthToKey(r.month);
    if (!k) continue;
    const net = Number(r.net ?? 0);
    if ((r.city ?? "").trim() === DELETED_CITY) { inc(deletedM, k, net); continue; } // both sides
    inc(netCleanM, k, net);
    inc2(netMCity, normalizeRevenueCity(r.city), k, net);
    if (r.venue && r.type !== "Membership") inc2(netMFieldNonMember, canonicalVenueName(r.venue) || r.venue, k, net);
  }

  // ── members active by month (subs.price), + membership field allocation ──────
  const memberActive = (s: RawSubscription, month: string): boolean => {
    if (!s.activation_date) return false;
    const act = monthKey(s.activation_date);
    if (month < act) return false;
    if (s.canceled_at && month > monthKey(s.canceled_at)) return false;
    return true;
  };
  const membersM = new Map<string, Set<number>>();
  const membersMCity = new Map<string, Map<string, Set<number>>>();
  const membersY = new Map<string, Set<number>>();
  const membersYCity = new Map<string, Map<string, Set<number>>>();
  // membership fee allocated to (field, month); + unallocated + zero-match per month.
  const memFieldAllocM = new Map<string, Map<string, number>>();
  const memAllocatedM = new Map<string, number>();
  const memUnallocatedM = new Map<string, number>();
  const memZeroMatchM = new Map<string, number>();
  const memTotalM = new Map<string, number>();

  // which months do we need members for? every revenue-clean month + a full year
  // on either side so annual/py are covered. Cheap to just span the union.
  const revMonths = [...netCleanM.keys()].filter((m) => (netCleanM.get(m) ?? 0) !== 0 || true);
  const monthUniverse = new Set<string>([...netCleanM.keys(), ...playedM.keys()]);
  // extend one year back from the earliest so py lookups resolve
  const allMonths = [...monthUniverse].sort();
  for (const s of subscriptions) {
    if (s.user_id == null) continue;
    const price = Number(s.price ?? 0);
    for (const month of allMonths) {
      if (!memberActive(s, month)) continue;
      const y = yearOf(month);
      add(membersM, month, s.user_id); add(membersY, y, s.user_id);
      const city = normalizeMatchCity(s.city_identifier);
      add2(membersMCity, city, month, s.user_id); add2(membersYCity, city, y, s.user_id);
      // field allocation of this member's fee for this month
      inc(memTotalM, month, price);
      const fields = [...new Set((evByUser.get(s.user_id) ?? []).filter((e) => e.month === month).map((e) => e.field))];
      if (fields.length === 0) {
        inc(memUnallocatedM, month, price);
        memZeroMatchM.set(month, (memZeroMatchM.get(month) ?? 0) + 1);
      } else {
        inc(memAllocatedM, month, price);
        for (const f of fields) inc2(memFieldAllocM, f, month, price / fields.length);
      }
    }
  }

  // ── ARPP resolvers ──────────────────────────────────────────────────────────
  const unionSize = (a: Set<number> | undefined, b: Set<number> | undefined): number => {
    if (!a && !b) return 0;
    const s = new Set<number>(a ?? []);
    if (b) for (const u of b) s.add(u);
    return s.size;
  };
  // null (→ em-dash) when the entity had no denominator that period (didn't exist)
  // OR no revenue to divide (a $0.00 would read as a real figure — forbidden).
  const arppNetwork = (m: string): number | null => {
    const den = unionSize(playedM.get(m), membersM.get(m));
    const net = netCleanM.get(m) ?? 0;
    return den > 0 && net > 0 ? net / den : null;
  };
  const arppCity = (c: string, m: string): number | null => {
    const den = unionSize(playedMCity.get(c)?.get(m), membersMCity.get(c)?.get(m));
    const net = netMCity.get(c)?.get(m) ?? 0;
    return den > 0 && net > 0 ? net / den : null;
  };
  const arppField = (f: string, m: string): number | null => {
    const den = playedMField.get(f)?.get(m)?.size ?? 0; // non-playing members have no field
    const num = (netMFieldNonMember.get(f)?.get(m) ?? 0) + (memFieldAllocM.get(f)?.get(m) ?? 0);
    return den > 0 && num > 0 ? num / den : null;
  };
  // annual: revenue over the year / distinct players active that year
  const yearMonths = (y: string) => allMonths.filter((m) => yearOf(m) === y);
  const arppNetworkY = (y: string): number | null => {
    const den = unionSize(playedY.get(y), membersY.get(y));
    const rev = yearMonths(y).reduce((a, m) => a + (netCleanM.get(m) ?? 0), 0);
    return den > 0 && rev > 0 ? rev / den : null;
  };
  const arppCityY = (c: string, y: string): number | null => {
    const den = unionSize(playedYCity.get(c)?.get(y), membersYCity.get(c)?.get(y));
    const rev = yearMonths(y).reduce((a, m) => a + (netMCity.get(c)?.get(m) ?? 0), 0);
    return den > 0 && rev > 0 ? rev / den : null;
  };
  const arppFieldY = (f: string, y: string): number | null => {
    const den = playedYField.get(f)?.get(y)?.size ?? 0;
    const rev = yearMonths(y).reduce((a, m) => a + (netMFieldNonMember.get(f)?.get(m) ?? 0) + (memFieldAllocM.get(f)?.get(m) ?? 0), 0);
    return den > 0 && rev > 0 ? rev / den : null;
  };

  // ── periods: current month = latest COMPLETE month with clean revenue ────────
  // Exclude the running month (members are billed on the 1st but play is only days
  // in, so its ARPP is understated) — the card compares settled months.
  const nowM = monthKey(now);
  const revenueMonths = [...netCleanM.keys()].filter((m) => (netCleanM.get(m) ?? 0) > 0).sort();
  const completedRev = revenueMonths.filter((m) => m < nowM);
  const curMonth = completedRev[completedRev.length - 1] ?? revenueMonths[revenueMonths.length - 1] ?? nowM;
  const prevMonth = addMonthsToKey(curMonth, -1);
  const pyMonth = addMonthsToKey(curMonth, -12);
  const curYear = yearOf(curMonth);
  const prevYear = String(Number(curYear) - 1);
  const pyYear = String(Number(curYear) - 2);

  // entity lists: the ACTIVE markets/fields — those with play in the current month.
  // Scoping to curMonth play (not all-time) drops declared-only markets (El Paso),
  // one-off historical markets (a single NYC match in 2025-10), and retired pitches,
  // matching the behavior card's live-market scope and the mockup's seven cities.
  const cityNames = [...playedMCity.keys()].filter((c) => c !== UNKNOWN_CITY && (playedMCity.get(c)?.has(curMonth) ?? false));
  const fieldNames = [...playedMField.keys()].filter((f) => playedMField.get(f)?.has(curMonth) ?? false);
  const fieldCity = new Map<string, string>();
  for (const [u, list] of evByUser) { void u; for (const e of list) if (!fieldCity.has(e.field)) fieldCity.set(e.field, e.city); }

  const cityRowsM: ArppEntity[] = cityNames.map((c) => ({ name: c, city: null, cur: arppCity(c, curMonth), prev: arppCity(c, prevMonth), py: arppCity(c, pyMonth) }))
    .filter((r) => r.cur != null || r.prev != null || r.py != null);
  const fieldRowsM: ArppEntity[] = fieldNames.map((f) => ({ name: f, city: fieldCity.get(f) ?? null, cur: arppField(f, curMonth), prev: arppField(f, prevMonth), py: arppField(f, pyMonth) }))
    .filter((r) => r.cur != null || r.prev != null || r.py != null);
  const cityRowsA: ArppEntity[] = cityNames.map((c) => ({ name: c, city: null, cur: arppCityY(c, curYear), prev: arppCityY(c, prevYear), py: arppCityY(c, pyYear) }))
    .filter((r) => r.cur != null || r.prev != null || r.py != null);
  const fieldRowsA: ArppEntity[] = fieldNames.map((f) => ({ name: f, city: fieldCity.get(f) ?? null, cur: arppFieldY(f, curYear), prev: arppFieldY(f, prevYear), py: arppFieldY(f, pyYear) }))
    .filter((r) => r.cur != null || r.prev != null || r.py != null);

  const mdM: ArppTriple = { cur: arppNetwork(curMonth), prev: arppNetwork(prevMonth), py: arppNetwork(pyMonth) };
  const mdA: ArppTriple = { cur: arppNetworkY(curYear), prev: arppNetworkY(prevYear), py: arppNetworkY(pyYear) };

  const citySum = cityNames.reduce((a, c) => a + unionSize(playedMCity.get(c)?.get(curMonth), membersMCity.get(c)?.get(curMonth)), 0);

  const last6 = revenueMonths.slice(-6);
  const diag = {
    deleted: last6.map((m) => {
      const den = unionSize(playedM.get(m), membersM.get(m));
      const withDel = den > 0 ? ((netCleanM.get(m) ?? 0) + (deletedM.get(m) ?? 0)) / den : null;
      const without = den > 0 ? (netCleanM.get(m) ?? 0) / den : null;
      return { m, deletedNet: deletedM.get(m) ?? 0, arppWith: withDel, arppWithout: without };
    }),
    membership: last6.map((m) => ({
      m, total: memTotalM.get(m) ?? 0, allocated: memAllocatedM.get(m) ?? 0,
      unallocated: memUnallocatedM.get(m) ?? 0, zeroMatchMembers: memZeroMatchM.get(m) ?? 0,
    })),
  };

  void revMonths;
  return {
    curMonth, prevMonth, pyMonth, curYear: Number(curYear), prevYear: Number(prevYear), pyYear: Number(pyYear),
    monthly: { matchday: mdM, cities: cityRowsM, fields: fieldRowsM },
    annual: { matchday: mdA, cities: cityRowsA, fields: fieldRowsA },
    membership: {
      total: memTotalM.get(curMonth) ?? 0, allocated: memAllocatedM.get(curMonth) ?? 0,
      unallocated: memUnallocatedM.get(curMonth) ?? 0, zeroMatchMembers: memZeroMatchM.get(curMonth) ?? 0,
    },
    denom: { network: unionSize(playedM.get(curMonth), membersM.get(curMonth)), citySum },
    diag,
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
    selectAll<RawSubscription>(sb, "mdapi_subscriptions", "user_id, city_identifier, activation_date, canceled_at, price", "membership_id"),
    selectAll<RawRevenue>(sb, "fin_revenue", "month, city, type, net, venue", "id"),
    selectAll<DownloadMonthRow>(sb, "growth_downloads_month", "month, count", "month"),
    readRowCounts(sb),
  ]);
  // iOS view (0105) — defensive: if it doesn't exist yet (pre-migration) the read
  // errors and we treat iOS as having no rows, so nothing breaks.
  let iosDownloadsMonth: DownloadMonthRow[] = [];
  try {
    const { data } = await sb.from("growth_downloads_month_ios").select("month, count").order("month");
    iosDownloadsMonth = (data ?? []) as DownloadMonthRow[];
  } catch {
    iosDownloadsMonth = [];
  }
  const [playSync, appleSync] = await Promise.all([readPlaySyncStatus(sb), readAppleSyncStatus(sb)]);
  if (timing) timing.fetchMs = Date.now() - tFetch;
  const tCompute = Date.now();
  const out = computeGrowthFromViews({ profiles, playDims, registrations, subscriptions, revenue, downloadsMonth, iosDownloadsMonth, playSync, appleSync, now, rowCounts });
  out.arppCard = computeArppCard(profiles, subscriptions, revenue, now);
  if (timing) timing.computeMs = Date.now() - tCompute;
  return out;
}

// Play-ingest health for the App downloads KPI. Determines the no-data states —
// the pure engine upgrades to "synced" when the downloads matview has rows:
//   not_configured — the runtime SA key (GOOGLE_PLAY_SA_KEY_B64) is absent/empty
//   never_run      — key present, but no play-installs run has ever been logged
//   failed         — the latest logged run recorded an error_message (shown verbatim)
//   no_data        — the latest logged run completed but wrote nothing
// The SA key value is never read here beyond a presence/blank check.
async function readPlaySyncStatus(sb: SupabaseClient): Promise<GrowthData["playSync"]> {
  const rawKey = process.env.GOOGLE_PLAY_SA_KEY_B64;
  const keyConfigured = !!(rawKey && rawKey.trim().length > 0);
  if (!keyConfigured) return { state: "not_configured", lastRunAt: null, error: null, lastSyncedDate: null };
  const { data } = await sb
    .from("fin_sync_log")
    .select("started_at, error_message")
    .eq("source", "play-installs")
    .order("started_at", { ascending: false })
    .limit(1);
  const run = data?.[0] as { started_at: string; error_message: string | null } | undefined;
  if (!run) return { state: "never_run", lastRunAt: null, error: null, lastSyncedDate: null };
  if (run.error_message) return { state: "failed", lastRunAt: run.started_at, error: run.error_message, lastSyncedDate: null };
  return { state: "no_data", lastRunAt: run.started_at, error: null, lastSyncedDate: null };
}

// Apple ingest health — same states as Play, keyed on the four APP_STORE_CONNECT_*
// vars (all must be present) + the latest 'app-store-installs' fin_sync_log row.
// None of the credential VALUES are read here beyond a presence/blank check.
async function readAppleSyncStatus(sb: SupabaseClient): Promise<GrowthData["appleSync"]> {
  const need = [
    process.env.APP_STORE_CONNECT_ISSUER_ID,
    process.env.APP_STORE_CONNECT_KEY_ID,
    process.env.APP_STORE_CONNECT_P8_B64,
    process.env.APP_STORE_CONNECT_VENDOR_NUMBER,
  ];
  const configured = need.every((v) => !!(v && v.trim().length > 0));
  if (!configured) return { state: "not_configured", lastRunAt: null, error: null, lastSyncedDate: null };
  const { data } = await sb
    .from("fin_sync_log")
    .select("started_at, error_message")
    .eq("source", "app-store-installs")
    .order("started_at", { ascending: false })
    .limit(1);
  const run = data?.[0] as { started_at: string; error_message: string | null } | undefined;
  if (!run) return { state: "never_run", lastRunAt: null, error: null, lastSyncedDate: null };
  if (run.error_message) return { state: "failed", lastRunAt: run.started_at, error: run.error_message, lastSyncedDate: null };
  return { state: "no_data", lastRunAt: run.started_at, error: null, lastSyncedDate: null };
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
