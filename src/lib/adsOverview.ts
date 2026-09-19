/* ADS OVERVIEW — the pure shaping behind Player Lifecycle › Ads. No network, no clock, no Supabase.
 *
 * ── THE TWO ATTRIBUTIONS, AND WHY A ROW IS GROUPED THE WAY IT IS ────────────────────────────────
 *
 * Meta returns ZERO app installs under the `comscore_market` breakdown. Measured across nine
 * dimension combinations on 2026-09-18: 766 installs at every grain without it and 0 with it, on
 * rows that carry link clicks and video views perfectly well. So spend has geography and installs
 * do not, and the ad set is the only thing that carries both.
 *
 * A ROW IS THEREFORE AN AD SET'S PARENT MARKET, not a served market. Spend still COMES FROM the
 * comscore rows — it is delivery data — but it is grouped by the market whose ad sets spent it.
 * That is the only grouping under which the three share figures mean anything: "Houston's ad sets
 * put 59.8% of their money into Houston, 39.9% into Unknown, 0.3% elsewhere" is a sentence about
 * one denominator. Grouping by served market instead would make home share 100% by construction
 * and leave Unknown as a market of its own that belongs to nobody.
 *
 * ── THE CENSORING, AND WHICH WAY IT POINTS ─────────────────────────────────────────────────────
 * `becamePlayers` counts registrations that went on to play, DATED BY SIGNUP. Someone who registers
 * today may play next week, so recent days are always short.
 *
 * THE COUNT IS UNDERSTATED, SO THE COST PER NEW PLAYER IS OVERSTATED. spend / players with a small
 * denominator reads EXPENSIVE, not cheap. Getting that backwards on screen would tell a reader the
 * market is doing worse than it is at exactly the moment they are deciding where to put money.
 * playedWithin7d is the settled figure that sits beside it.
 */

import { cityForMarket, UNKNOWN_MARKET } from "./metaAdSpend";

/** Our seven paid markets. Warsaw, NYC and El Paso are deliberately absent: we do not buy there,
 *  so they cannot have a cost per player, and padding the table with them to make the new-player
 *  column tie to the company total would be inventing rows. The page states the gap instead. */
export const PAID_MARKETS = ["ATL", "ATX", "DFW", "HTX", "OKC", "SATX", "STL"] as const;

/** growth_acquisition_daily carries the RAW declared city. The resolver stays in Node, the rule
 *  0096 states — the views group, they do not re-implement the city vocabulary. */
export const DECLARED_CITY_TO_KEY: Readonly<Record<string, string>> = Object.freeze({
  "Atlanta": "ATL", "Austin": "ATX", "Dallas / Fort Worth": "DFW", "Houston": "HTX",
  "Oklahoma City": "OKC", "San Antonio": "SATX", "St. Louis": "STL",
});

export type GeoRow = { spend_date: string; adset_id: string; market_raw: string; market_key: string | null; spend_cents: number; clicks: number | null };
export type FlatRow = { spend_date: string; adset_id: string; spend_cents: number; installs: number | null; clicks: number | null; registrations: number | null };
export type DimRow = { adset_id: string; adset_name: string | null; campaign_name: string | null; market_key: string | null; market_raw: string | null; market_confidence: number | null };
export type AcqRow = { signup_date: string; declared_city_raw: string | null; registrations: number; became_players: number; played_within_7d: number; played_within_30d: number };

export type ServedRow = { marketRaw: string; spendCents: number; rolled: number };
export type AdsetRow = { adsetId: string; adsetName: string | null; campaignName: string | null; spendCents: number; installs: number | null; confidence: number | null };

export type MarketRow = {
  marketKey: string;
  spendCents: number;
  homeCents: number;
  unknownCents: number;
  otherNamedCents: number;
  installs: number | null;
  clicks: number;
  registrations: number;
  becamePlayers: number;
  playedWithin7d: number;
  playedWithin30d: number;
  served: ServedRow[];
  adsets: AdsetRow[];
};

export type NotAttributed = {
  adsetId: string; adsetName: string | null; campaignName: string | null;
  spendCents: number; confidence: number | null;
  topMarkets: { marketRaw: string; spendCents: number }[];
};

export type AdsOverview = {
  rows: MarketRow[];
  notAttributed: NotAttributed[];
  totals: { spendCents: number; installs: number; registrations: number; becamePlayers: number; playedWithin7d: number };
  /** Registrations and players in markets we do not buy in, so the page can state the gap rather
   *  than pad the table. */
  excluded: { registrations: number; becamePlayers: number; cities: string[] };
};

/* ── THE 99% CUMULATIVE RULE ─────────────────────────────────────────────────────────────────────
 * Show served markets in descending order until 99% of the row's spend is covered; roll the rest
 * into one "other markets (N)". Chosen over a flat ">= 1% of the row" threshold because its
 * guarantee is legible — the rolled row is never more than 1% of this market's spend — and it
 * self-tunes. Measured on the Aug 19 to Sep 17 export: a 1% threshold hides between 0.00% and
 * 1.82% depending on the tail's shape; this hides at most 1% by construction, and gives Austin
 * three rows because Austin needs three.
 *
 * UNKNOWN IS NEVER ROLLED UP, whatever its size. At 39.9% it was not a small market, it was the
 * absence of one, and burying it in "other markets" would have hidden the single thing the panel
 * exists to show. It is pulled out first and appended with its own row. */
export const SERVED_COVERAGE = 0.99;

export function servedBreakdown(rows: readonly { marketRaw: string; spendCents: number }[]): ServedRow[] {
  const byMarket = new Map<string, number>();
  for (const r of rows) byMarket.set(r.marketRaw, (byMarket.get(r.marketRaw) ?? 0) + r.spendCents);

  const unknown = byMarket.get(UNKNOWN_MARKET);
  byMarket.delete(UNKNOWN_MARKET);

  const ranked = [...byMarket.entries()]
    .map(([marketRaw, spendCents]) => ({ marketRaw, spendCents }))
    .sort((a, b) => b.spendCents - a.spendCents || a.marketRaw.localeCompare(b.marketRaw));
  const namedTotal = ranked.reduce((a, r) => a + r.spendCents, 0);

  const out: ServedRow[] = [];
  let cum = 0;
  let i = 0;
  for (; i < ranked.length; i++) {
    if (cum >= namedTotal * SERVED_COVERAGE) break;
    out.push({ ...ranked[i], rolled: 0 });
    cum += ranked[i].spendCents;
  }
  const rest = ranked.slice(i);
  if (rest.length) {
    out.push({
      marketRaw: `other markets (${rest.length})`,
      spendCents: rest.reduce((a, r) => a + r.spendCents, 0),
      rolled: rest.length,
    });
  }
  if (unknown != null) out.push({ marketRaw: UNKNOWN_MARKET, spendCents: unknown, rolled: 0 });
  return out;
}

export function buildAdsOverview(input: {
  geo: readonly GeoRow[]; flat: readonly FlatRow[]; dim: readonly DimRow[]; acq: readonly AcqRow[];
}): AdsOverview {
  // THE PARENT IS READ, NEVER RE-DERIVED. fin_meta_adset holds it; recomputing here would be a
  // second implementation of the vote, and the two would disagree the first time either changed.
  const parentOf = new Map<string, DimRow>();
  for (const d of input.dim) parentOf.set(d.adset_id, d);

  const geoByAdset = new Map<string, GeoRow[]>();
  for (const g of input.geo) (geoByAdset.get(g.adset_id) ?? geoByAdset.set(g.adset_id, []).get(g.adset_id)!).push(g);

  const flatByAdset = new Map<string, { spendCents: number; installs: number | null; clicks: number }>();
  for (const f of input.flat) {
    const cur = flatByAdset.get(f.adset_id) ?? { spendCents: 0, installs: null, clicks: 0 };
    cur.spendCents += f.spend_cents;
    // ABSENT IS NOT ZERO. A day with no installs figure leaves the total null until a real number
    // arrives; a row with an actions array and no install action contributes a genuine 0.
    if (f.installs != null) cur.installs = (cur.installs ?? 0) + f.installs;
    cur.clicks += f.clicks ?? 0;
    flatByAdset.set(f.adset_id, cur);
  }

  const seed = (): MarketRow => ({
    marketKey: "", spendCents: 0, homeCents: 0, unknownCents: 0, otherNamedCents: 0,
    installs: null, clicks: 0, registrations: 0, becamePlayers: 0, playedWithin7d: 0,
    playedWithin30d: 0, served: [], adsets: [],
  });
  const byMarket = new Map<string, MarketRow>();
  const servedRaw = new Map<string, { marketRaw: string; spendCents: number }[]>();
  for (const k of PAID_MARKETS) { const r = seed(); r.marketKey = k; byMarket.set(k, r); servedRaw.set(k, []); }

  const notAttributed: NotAttributed[] = [];

  for (const [adsetId, rows] of geoByAdset) {
    const dim = parentOf.get(adsetId);
    const key = dim?.market_key ?? null;
    const spendCents = rows.reduce((a, r) => a + r.spend_cents, 0);
    const flat = flatByAdset.get(adsetId);

    if (!key || !byMarket.has(key)) {
      // NAMED, NEVER SILENT, AND NEVER DEFAULTED INTO UNALLOCATED. Below the confidence floor, or a
      // dominant market we do not map — either way an operator has something to act on.
      const top = [...rows.reduce((m, r) => m.set(r.market_raw, (m.get(r.market_raw) ?? 0) + r.spend_cents), new Map<string, number>())]
        .map(([marketRaw, c]) => ({ marketRaw, spendCents: c }))
        .sort((a, b) => b.spendCents - a.spendCents).slice(0, 3);
      notAttributed.push({
        adsetId, adsetName: dim?.adset_name ?? null, campaignName: dim?.campaign_name ?? null,
        spendCents, confidence: dim?.market_confidence ?? null, topMarkets: top,
      });
      continue;
    }

    const row = byMarket.get(key)!;
    const home = cityForMarket(dim?.market_raw ?? "") === key ? dim?.market_raw : null;
    row.spendCents += spendCents;
    for (const r of rows) {
      if (r.market_raw === UNKNOWN_MARKET) row.unknownCents += r.spend_cents;
      else if (home && r.market_raw === home) row.homeCents += r.spend_cents;
      else if (r.market_key === key) row.homeCents += r.spend_cents;
      else row.otherNamedCents += r.spend_cents;
      servedRaw.get(key)!.push({ marketRaw: r.market_raw, spendCents: r.spend_cents });
    }
    if (flat?.installs != null) row.installs = (row.installs ?? 0) + flat.installs;
    row.clicks += flat?.clicks ?? 0;
    row.adsets.push({
      adsetId, adsetName: dim?.adset_name ?? null, campaignName: dim?.campaign_name ?? null,
      spendCents, installs: flat?.installs ?? null, confidence: dim?.market_confidence ?? null,
    });
  }

  for (const k of PAID_MARKETS) {
    const row = byMarket.get(k)!;
    row.served = servedBreakdown(servedRaw.get(k)!);
    row.adsets.sort((a, b) => b.spendCents - a.spendCents);
  }

  // ── the player side ──────────────────────────────────────────────────────────────────────────
  let exRegs = 0, exPlayers = 0; const exCities = new Set<string>();
  for (const a of input.acq) {
    const key = DECLARED_CITY_TO_KEY[a.declared_city_raw ?? ""] ?? null;
    if (!key || !byMarket.has(key)) {
      exRegs += a.registrations; exPlayers += a.became_players;
      if (a.declared_city_raw) exCities.add(a.declared_city_raw);
      continue;
    }
    const row = byMarket.get(key)!;
    row.registrations += a.registrations;
    row.becamePlayers += a.became_players;
    row.playedWithin7d += a.played_within_7d;
    row.playedWithin30d += a.played_within_30d;
  }

  const rows = [...byMarket.values()].sort((a, b) => b.spendCents - a.spendCents);
  return {
    rows,
    notAttributed: notAttributed.sort((a, b) => b.spendCents - a.spendCents),
    totals: {
      spendCents: rows.reduce((a, r) => a + r.spendCents, 0),
      installs: rows.reduce((a, r) => a + (r.installs ?? 0), 0),
      registrations: rows.reduce((a, r) => a + r.registrations, 0),
      becamePlayers: rows.reduce((a, r) => a + r.becamePlayers, 0),
      playedWithin7d: rows.reduce((a, r) => a + r.playedWithin7d, 0),
    },
    excluded: { registrations: exRegs, becamePlayers: exPlayers, cities: [...exCities].sort() },
  };
}

/** A share of a total, or null when the total is zero. Never 0-for-unknown: a market with no
 *  spend has no share of spend, and printing 0.0% would read as a measurement. */
export function shareOf(part: number, total: number): number | null {
  return total > 0 ? part / total : null;
}

/** spend / installs, null when there are no installs. A CPI with a zero denominator is not
 *  infinity on screen, it is a dash. */
export function perUnit(cents: number, units: number | null): number | null {
  return units != null && units > 0 ? cents / units : null;
}
