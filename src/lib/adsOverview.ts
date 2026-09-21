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
export type DimRow = {
  adset_id: string; adset_name: string | null; campaign_name: string | null;
  market_key: string | null; market_raw: string | null; market_confidence: number | null;
  /* WHAT META IS BUYING. APP_INSTALLS for the current cohort; the conversion goals below are what
   * an ad set optimising for an in-app event carries. */
  optimization_goal?: string | null;
  /* THE WINDOWS META WILL CREDIT AGAINST. An array of {event_type, window_days}. Six of the seven
   * live ad sets are 1-day click only; the Atlanta Android one also carries 1-day view and 1-day
   * engaged video view, so its registrations sit on a looser basis than its neighbours'. */
  attribution_spec?: unknown;
};
export type AcqRow = { signup_date: string; declared_city_raw: string | null; registrations: number; became_players: number; played_within_7d: number; played_within_30d: number };

export type ServedRow = { marketRaw: string; spendCents: number; rolled: number };
export type AdsetRow = {
  adsetId: string; adsetName: string | null; campaignName: string | null;
  spendCents: number; installs: number | null; confidence: number | null;
  registrations: number | null;
  /** "1d click" or "1d click, 1d view, 1d video" — shown in the expansion, see attributionLabel. */
  attribution: string | null;
};

export type MarketRow = {
  marketKey: string;
  spendCents: number;
  /* ── THE SPENDING PERIOD, BECAUSE THE WINDOW IS NOT IT ────────────────────────────────────────
   * Spend is bounded by the days a market actually bought; players accrue across the whole window
   * either way. A market that stopped early therefore divides less spend by the same players and
   * looks CHEAPER than it is.
   *
   * MEASURED 2026-09-18 over 2026-08-01..2026-09-18: every market first spent on 2026-08-01, so
   * nothing starts late — but OKC's ad sets last spent on 2026-08-28, and its cost per new player
   * reads $7.45 against $10.26 over its own spending period. 38% understated.
   *
   * THE SPAN IS WHAT DISTORTS, NOT THE DAY COUNT. San Antonio and St. Louis bought on 38 of 49
   * days and are undistorted, because their first and last days are still the window's. Interior
   * gaps do not move the rate; a short span does. */
  firstSpend: string | null;
  lastSpend: string | null;
  /** Distinct days with spend above zero. Reported in the expansion; it is NOT what the flag
   *  keys on, for the reason above. */
  spendDays: number;
  homeCents: number;
  unknownCents: number;
  otherNamedCents: number;
  installs: number | null;
  clicks: number;
  /* META'S OWN REGISTRATION COUNT, from fin_meta_adset_daily (0184). Signups Meta could connect to
   * an ad. ABSENT IS NOT ZERO, same rule installs follows: a day with no figure leaves the total
   * null until a real number arrives. */
  metaRegistrations: number | null;
  /** OUR count, from growth_acquisition_daily. Everyone who signed up, ad or not. */
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
  totals: { spendCents: number; installs: number; metaRegistrations: number; registrations: number; becamePlayers: number; playedWithin7d: number };
  /* THE FIRST DAY A REGISTRATION-OPTIMIZED AD SET SPENT, or null when none has. Drives the "Since
   * rebuild" preset, which does not render until this is non-null. */
  rebuildStart: string | null;
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

  const flatByAdset = new Map<string, { spendCents: number; installs: number | null; clicks: number; registrations: number | null }>();
  for (const f of input.flat) {
    const cur = flatByAdset.get(f.adset_id) ?? { spendCents: 0, installs: null, clicks: 0, registrations: null };
    cur.spendCents += f.spend_cents;
    if (f.registrations != null) cur.registrations = (cur.registrations ?? 0) + f.registrations;
    // ABSENT IS NOT ZERO. A day with no installs figure leaves the total null until a real number
    // arrives; a row with an actions array and no install action contributes a genuine 0.
    if (f.installs != null) cur.installs = (cur.installs ?? 0) + f.installs;
    cur.clicks += f.clicks ?? 0;
    flatByAdset.set(f.adset_id, cur);
  }

  const seed = (): MarketRow => ({
    marketKey: "", spendCents: 0, firstSpend: null, lastSpend: null, spendDays: 0,
    homeCents: 0, unknownCents: 0, otherNamedCents: 0,
    installs: null, clicks: 0, metaRegistrations: null, registrations: 0, becamePlayers: 0, playedWithin7d: 0,
    playedWithin30d: 0, served: [], adsets: [],
  });
  const byMarket = new Map<string, MarketRow>();
  const servedRaw = new Map<string, { marketRaw: string; spendCents: number }[]>();
  const spendDaysOf = new Map<string, Set<string>>();
  for (const k of PAID_MARKETS) {
    const r = seed(); r.marketKey = k; byMarket.set(k, r); servedRaw.set(k, []); spendDaysOf.set(k, new Set());
  }

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
      /* A DAY COUNTS ONLY IF MONEY MOVED. A zero-spend row is a day Meta reported on, not a day
       * the market bought, and counting it would put the last-spend date wherever reporting
       * happened to stop. */
      if (r.spend_cents > 0) {
        spendDaysOf.get(key)!.add(r.spend_date);
        if (!row.firstSpend || r.spend_date < row.firstSpend) row.firstSpend = r.spend_date;
        if (!row.lastSpend || r.spend_date > row.lastSpend) row.lastSpend = r.spend_date;
      }
    }
    if (flat?.installs != null) row.installs = (row.installs ?? 0) + flat.installs;
    if (flat?.registrations != null) row.metaRegistrations = (row.metaRegistrations ?? 0) + flat.registrations;
    row.clicks += flat?.clicks ?? 0;
    row.adsets.push({
      adsetId, adsetName: dim?.adset_name ?? null, campaignName: dim?.campaign_name ?? null,
      spendCents, installs: flat?.installs ?? null, confidence: dim?.market_confidence ?? null,
      registrations: flat?.registrations ?? null,
      attribution: attributionLabel(dim?.attribution_spec),
    });
  }

  for (const k of PAID_MARKETS) {
    const row = byMarket.get(k)!;
    row.served = servedBreakdown(servedRaw.get(k)!);
    row.spendDays = spendDaysOf.get(k)!.size;
    row.adsets = orderAdsets(row.adsets);
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
      metaRegistrations: rows.reduce((a, r) => a + (r.metaRegistrations ?? 0), 0),
      registrations: rows.reduce((a, r) => a + r.registrations, 0),
      becamePlayers: rows.reduce((a, r) => a + r.becamePlayers, 0),
      playedWithin7d: rows.reduce((a, r) => a + r.playedWithin7d, 0),
    },
    excluded: { registrations: exRegs, becamePlayers: exPlayers, cities: [...exCities].sort() },
    rebuildStart: registrationRebuildStart(input.dim, input.flat),
  };
}

/* ── DUPLICATE NAMES SIT TOGETHER ────────────────────────────────────────────────────────────────
 * Two ad sets are called "New Engagement Ad Set" and two are called "TOMBALL - App Not Installed",
 * separated only by their campaign. Sorted by spend alone they scatter, and two rows with the same
 * name in different places read as one row rendered twice.
 *
 * GROUPED BY NAME, GROUPS ORDERED BY THEIR COMBINED SPEND, and spend order kept inside each group.
 * So the biggest spenders are still at the top and a repeated name is always adjacent to itself. */
export function orderAdsets(rows: readonly AdsetRow[]): AdsetRow[] {
  const groups = new Map<string, AdsetRow[]>();
  for (const r of rows) {
    const k = r.adsetName ?? r.adsetId;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  return [...groups.entries()]
    .map(([name, rs]) => ({ name, rs: [...rs].sort((a, b) => b.spendCents - a.spendCents), total: rs.reduce((a, r) => a + r.spendCents, 0) }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
    .flatMap((g) => g.rs);
}

/** How many ad sets in this list share a name with another. Drives the duplicate marker. */
export function duplicateNames(rows: readonly AdsetRow[]): Set<string> {
  const seen = new Map<string, number>();
  for (const r of rows) { const k = r.adsetName ?? r.adsetId; seen.set(k, (seen.get(k) ?? 0) + 1); }
  return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
}

/* ── CONFIDENCE IS ONLY WORTH PRINTING WHEN IT IS LOW ───────────────────────────────────────────
 * It read 98.7% or 100.0% on every row of the Houston expansion, which is a column of noise. The
 * exception is what matters, so the column is gone and the exception is flagged.
 *
 * 0.90, not the 0.60 attribution floor. The floor decides whether an ad set gets a market at all;
 * this decides whether a reader should know its money was not all in one place. A tenth of the
 * budget landing elsewhere is worth a mark. */
export const CONFIDENCE_WORTH_FLAGGING = 0.9;

/* ── THE COLOUR BANDS, AND WHY THEY ARE RELATIVE ────────────────────────────────────────────────
 *
 * The mockup eyeballed them against today's seven markets. Fixed dollar thresholds would need
 * re-tuning every time the account's efficiency moved, and would be wrong the first time it did.
 *
 * THE BLENDED RATE IS THE ONLY NON-ARBITRARY REFERENCE ON THE PAGE: total spend over total new
 * players, which is what a market would cost if budget were spread perfectly evenly. So:
 *
 *     GOOD   at or below the blended rate   — this market beats the account average
 *     MID    up to twice it
 *     BAD    more than twice it             — it costs more than double the average
 *
 * At today's $5.69 blended that is <= $5.69 / $5.69-$11.38 / > $11.38, which reproduces the
 * mockup's bands except for St. Louis at $11.53 — fifteen cents the wrong side of the line, drawn
 * amber and banded red. The rule is not bent to match the picture; a threshold chosen to reproduce
 * a drawing is a threshold that has to be redrawn.
 *
 * A DARK MARKET IS NEUTRAL, NOT GOOD. OKC's $7.45 divides 28 days of spend by 49 days of players
 * and is 38% understated, so colouring it as though it were comparable would recommend the market
 * on the strength of its having stopped. It is greyed and badged instead. */
export type Band = "good" | "mid" | "bad" | "dark";

export const BAND_MID_AT = 1;
export const BAND_BAD_AT = 2;

export function costBand(value: number | null, blended: number | null, dark: boolean): Band | null {
  if (dark) return "dark";
  if (value == null || blended == null || blended <= 0) return null;
  const ratio = value / blended;
  if (ratio <= BAND_MID_AT) return "good";
  if (ratio <= BAND_BAD_AT) return "mid";
  return "bad";
}

/* ── FAIR SHARE, AND WHY IT IS IN DOLLARS ───────────────────────────────────────────────────────
 *
 * This was share-of-players minus share-of-spend, in points. Same arithmetic, but a reader had to
 * convert "−15.0 points" into a budget before it meant anything, and nobody moves points. The
 * money version states the thing you would act on: Dallas is carrying $1,175 more budget than its
 * players justify, and Austin $1,031 less.
 *
 * FAIR SHARE IS A COUNTERFACTUAL, NOT A TARGET. It is what this market's spend would be if every
 * dollar in the account followed new players in proportion. It assumes nothing about diminishing
 * returns, market size or what a market would do with more money; moving budget to the cheapest
 * market until the rates equalise is not what it says. It says where the money is now against
 * where the players are now, which is the question the page is for.
 *
 * IT SUMS TO ZERO ACROSS THE PAID MARKETS BY CONSTRUCTION — the fair shares are a partition of the
 * same total the actual spends partition — so there is no total row figure worth printing. */

/** This market's share of new players applied to total paid spend. Null when nobody has become a
 *  player anywhere, because a share of zero players is not a share of anything. */
export function fairShareCents(becamePlayers: number, totalPlayers: number, totalSpendCents: number): number | null {
  const share = shareOf(becamePlayers, totalPlayers);
  return share == null ? null : share * totalSpendCents;
}

/** Actual spend minus fair share. POSITIVE MEANS OVER: this market takes more budget than its
 *  players justify. Negative means under. */
export function overUnderCents(spendCents: number, fairCents: number | null): number | null {
  return fairCents == null ? null : spendCents - fairCents;
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


/* ── META'S REGISTRATION COLUMNS ONLY MEAN SOMETHING FROM 2026-09-12 ────────────────────────────
 *
 * The in-app SDK event went live around 2026-09-11 and the FIRST DAY IT PRODUCED A NUMBER WAS
 * 2026-09-12. Measured: 2026-09-11 carries seven ad sets spending $181 and zero registrations,
 * then 8 on the 12th, 17 on the 13th, and every day since.
 *
 * SO THE DATE IS THE 12TH, NOT THE 11TH, and the difference is not pedantry. Including the 11th
 * puts a real $181 of spend against a real zero, and "$181 for no registrations" reads as terrible
 * performance rather than as an event that did not exist yet. The same argument, at a month's
 * scale, is why a window starting before this shows the columns blank instead of dividing weeks of
 * spend by days of registrations.
 */
export const META_REG_FROM = "2026-09-12";

/** Do Meta's registration columns mean anything over this window? */
export function metaRegistrationsUsable(since: string): boolean {
  return since >= META_REG_FROM;
}

/* ── WHICH AD SETS ARE OPTIMISING FOR A REGISTRATION ────────────────────────────────────────────
 *
 * THE GOAL ALONE DOES NOT ANSWER IT, and the data proves it: the OLD cohort ("ATL - App Not
 * Installed - August 2026" and its siblings) carries optimization_goal OFFSITE_CONVERSIONS and
 * recorded ZERO registrations across its whole life. A conversion goal says Meta is optimising
 * toward some event; it does not say which one.
 *
 * WHAT WOULD ANSWER IT EXACTLY is promoted_object.custom_event_type, which reads
 * COMPLETE_REGISTRATION on an ad set optimising for signup. fin_meta_adset does not store it
 * today, so until it does this uses the one thing that cannot be faked by an old ad set:
 *
 *     A REGISTRATION-OPTIMIZED AD SET CANNOT HAVE RUN BEFORE THE EVENT IT OPTIMISES FOR EXISTED.
 *
 * So it is a conversion goal AND spend on or after META_REG_FROM. The old cohort stopped on
 * 2026-08-28 and is excluded by construction; the current cohort is APP_INSTALLS and is excluded
 * by goal. Nothing in the table today satisfies both, which is why the preset stays hidden.
 */
export const REGISTRATION_GOALS: ReadonlySet<string> = new Set([
  "OFFSITE_CONVERSIONS",
  "APP_INSTALLS_AND_OFFSITE_CONVERSIONS",
  "VALUE",
]);

export function registrationRebuildStart(
  dim: readonly DimRow[],
  flat: readonly FlatRow[],
): string | null {
  const wanted = new Set(
    dim.filter((d) => REGISTRATION_GOALS.has(String(d.optimization_goal ?? "").toUpperCase()))
      .map((d) => d.adset_id),
  );
  if (wanted.size === 0) return null;
  let first: string | null = null;
  for (const f of flat) {
    if (!wanted.has(f.adset_id)) continue;
    if (f.spend_cents <= 0) continue;              // a day Meta reported on, not a day it bought
    if (f.spend_date < META_REG_FROM) continue;    // predates the event, so not optimising for it
    if (!first || f.spend_date < first) first = f.spend_date;
  }
  return first;
}

/* ── SPEND VS. AVERAGE ──────────────────────────────────────────────────────────────────────────
 *
 * RENAMED FROM "Over / under", SAME ARITHMETIC. What this market's new players would cost at the
 * company-wide blended rate, against what it actually spent. Positive means it spent more.
 *
 * `fairShareCents` already computed exactly this: a market's share of players applied to total
 * spend IS its player count times total-spend-over-total-players, which is the blended rate. The
 * name changes because "over / under" described a verdict and this describes a comparison, and a
 * reader asked what it was under.
 */
export function atAverageCents(becamePlayers: number, blendedCentsPerPlayer: number | null): number | null {
  if (blendedCentsPerPlayer == null || !Number.isFinite(blendedCentsPerPlayer)) return null;
  return becamePlayers * blendedCentsPerPlayer;
}

/** The worked example under the Spend vs. average tooltip, built from the row it names. */
export type SpendVsAverageExample = {
  market: string; players: number; atAverageCents: number; spendCents: number; deltaCents: number;
};

export function spendVsAverageExample(
  rows: readonly { marketKey: string; becamePlayers: number; spendCents: number }[],
  blendedCentsPerPlayer: number | null,
  preferMarketKey = "HTX",
): SpendVsAverageExample | null {
  if (blendedCentsPerPlayer == null || rows.length === 0) return null;
  /* HOUSTON UNLESS IT IS NOT IN THE WINDOW, then the first row — which is the biggest spender,
   * because the rows arrive sorted by spend. NEVER HARDCODED: every figure in the sentence is
   * computed from the row it names, so a window change cannot leave the example describing a
   * month nobody is looking at. */
  const row = rows.find((r) => r.marketKey === preferMarketKey) ?? rows[0];
  const at = row.becamePlayers * blendedCentsPerPlayer;
  return {
    market: row.marketKey, players: row.becamePlayers,
    atAverageCents: at, spendCents: row.spendCents, deltaCents: row.spendCents - at,
  };
}


/* ── THE ATTRIBUTION WINDOW, IN WORDS ───────────────────────────────────────────────────────────
 *
 * Six of the seven live ad sets are 1-day click-through only. The seventh, Atlanta's Android ad
 * set, also carries 1-day view and 1-day engaged video view, so Meta can credit it for a signup
 * that followed a view nobody clicked. Its cost per registration is therefore computed on a
 * LOOSER basis than its neighbours' and must not be compared with them as though it were the same
 * measurement. The label is shown on the ad-set line in the expansion for exactly that reason.
 *
 * SHORTENED, NOT SUMMARISED. CLICK_THROUGH becomes "click" and the day count is kept, because a
 * 7-day click window and a 1-day click window are different instruments and the number is the
 * whole difference.
 */
const ATTRIBUTION_WORD: Readonly<Record<string, string>> = {
  CLICK_THROUGH: "click", VIEW_THROUGH: "view", ENGAGED_VIDEO_VIEW: "video",
};

export function attributionLabel(spec: unknown): string | null {
  if (!Array.isArray(spec) || spec.length === 0) return null;
  const parts: string[] = [];
  for (const e of spec) {
    if (!e || typeof e !== "object") continue;
    const t = String((e as { event_type?: unknown }).event_type ?? "").toUpperCase();
    const d = Number((e as { window_days?: unknown }).window_days);
    const word = ATTRIBUTION_WORD[t];
    if (!word || !Number.isFinite(d)) continue;
    parts.push(`${d}d ${word}`);
  }
  return parts.length ? parts.join(", ") : null;
}
