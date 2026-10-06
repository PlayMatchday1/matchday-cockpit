// ACQUISITION PAGE — the website table and the page.link split, pure (no Supabase, no React).
//
// WEBSITE BY CITY AND PAGE (Ryan, 2026-10-04). Every page the two sources saw in the range lands in
// exactly one group, by acq_page_map: an exact path wins over a prefix, the longest prefix wins
// among prefixes. A page the map does not cover is NOT dropped — it lands in "Not yet mapped", so a
// new page is visible the day it gets traffic and a row in acq_page_map moves it to its city.
//
//   Avg position   Search Console, impression-weighted: Σ(position × impressions) / Σ impressions
//   Search clicks  Search Console clicks
//   Visits         GA4 sessions (additive across days and pages; unique visitors are not)
//   Store clicks   GA4 outbound clicks to apps.apple.com / play.google.com — the same measure since
//                  April 2025 (lib/acqGoogleSync)
//   Click rate     store clicks ÷ visits
//   Downloads      Apple, by campaign tag — "Waiting for Apple" until Apple's reports are wired in
//
// THE PAGE.LINK SPLIT. dynamic_link_first_open by source bucket over the range: the shares Ryan
// decided split Apple's page.link downloads by (share links / Instagram organic / Meta ads / other).
// The share-link count itself is the "Player shares" floor.

export type PageMapRow = { match_kind: string; pattern: string; market_key: string | null; page_kind: string; label: string; sort_order: number };
export type GscRow = { day: string; page_url: string; clicks: number; impressions: number; position_x_impressions: number };
export type WebRow = { day: string; page_path: string; sessions: number };
export type ClickRow = { day: string; page_path: string; method: string; clicks: number };
export type AppRow = { day: string; event_name: string; platform: string; source_bucket: string; event_count: number };

export const MARKET_LABEL: Record<string, string> = {
  ATX: "Austin", HTX: "Houston", DFW: "Dallas", SATX: "San Antonio", ATL: "Atlanta", OKC: "Oklahoma City",
  STL: "St. Louis", ELP: "El Paso",
};
export const SKEWED_BEFORE = "2026-07-15";   // website traffic before this included Meta ads

export type Measures = { impressions: number; px: number; searchClicks: number; visits: number; storeClicks: number };
export type PageLine = Measures & { path: string; label: string; kind: string };
export type Group = Measures & { key: string; label: string; kind: "site" | "city" | "cities" | "unmapped"; pages: PageLine[] };
export type WebsiteTable = { groups: Group[]; total: Measures; skewed: boolean };

const zero = (): Measures => ({ impressions: 0, px: 0, searchClicks: 0, visits: 0, storeClicks: 0 });
const add = (a: Measures, b: Measures) => { a.impressions += b.impressions; a.px += b.px; a.searchClicks += b.searchClicks; a.visits += b.visits; a.storeClicks += b.storeClicks; };
export const avgPosition = (m: Measures): number | null => (m.impressions > 0 ? m.px / m.impressions : null);
export const clickRate = (m: Measures): number | null => (m.visits > 0 ? m.storeClicks / m.visits : null);

/** The map row a path belongs to: exact first, then the longest prefix. */
export function mapPath(path: string, map: readonly PageMapRow[]): PageMapRow | null {
  const exact = map.find((m) => m.match_kind === "path_exact" && m.pattern.toLowerCase() === path);
  if (exact) return exact;
  let best: PageMapRow | null = null;
  for (const m of map) if (m.match_kind === "path_prefix" && path.startsWith(m.pattern.toLowerCase()) && (!best || m.pattern.length > best.pattern.length)) best = m;
  return best;
}

/** EACH SOURCE IN ITS OWN WINDOW (sourceWindows): Search Console columns read the gsc window, the
 *  website columns the web window — so a source that lags is never compared against more days than
 *  it has. */
export function websiteTable(input: { win: { gsc: Window; web: Window }; map: readonly PageMapRow[]; gsc: readonly GscRow[]; web: readonly WebRow[]; clicks: readonly ClickRow[] }): WebsiteTable {
  const { win, map } = input;
  const inW = (d: string, w: Window) => d >= w.since && d <= w.until;
  const perPage = new Map<string, Measures>();
  const at = (p: string) => perPage.get(p) ?? (perPage.set(p, zero()), perPage.get(p)!);
  for (const r of input.gsc) if (inW(r.day, win.gsc)) { const m = at(r.page_url); m.impressions += r.impressions; m.px += Number(r.position_x_impressions); m.searchClicks += r.clicks; }
  for (const r of input.web) if (inW(r.day, win.web)) at(r.page_path).visits += r.sessions;
  for (const r of input.clicks) if (inW(r.day, win.web) && r.method === "outbound_link") at(r.page_path).storeClicks += r.clicks;
  const since = win.web.since < win.gsc.since ? win.web.since : win.gsc.since;

  const groups = new Map<string, Group>();
  const group = (key: string, label: string, kind: Group["kind"]) =>
    groups.get(key) ?? (groups.set(key, { key, label, kind, pages: [], ...zero() }), groups.get(key)!);
  for (const [path, m] of perPage) {
    if (m.visits === 0 && m.searchClicks === 0 && m.storeClicks === 0 && m.impressions === 0) continue;
    const row = mapPath(path, map);
    const g = !row ? group("unmapped", "Not yet mapped", "unmapped")
      : row.page_kind === "home" || row.page_kind === "sitewide" ? group("site", "Homepage and site-wide", "site")
      : row.page_kind === "cities" ? group("cities", "Cities page", "cities")
      : row.market_key ? group(`city:${row.market_key}`, MARKET_LABEL[row.market_key] ?? row.market_key, "city")
      : group("site", "Homepage and site-wide", "site");
    g.pages.push({ path, label: row?.label ?? path, kind: row?.page_kind ?? "other", ...m });
    add(g, m);
  }
  const order = (g: Group) => (g.kind === "site" ? 0 : g.kind === "city" ? 1 : g.kind === "cities" ? 2 : 3);
  const list = [...groups.values()]
    .map((g) => ({ ...g, pages: g.pages.sort((a, b) => b.visits - a.visits || b.searchClicks - a.searchClicks || a.path.localeCompare(b.path)) }))
    .sort((a, b) => order(a) - order(b) || b.visits - a.visits || a.label.localeCompare(b.label));
  const total = zero(); for (const g of list) add(total, g);
  return { groups: list, total, skewed: since < SKEWED_BEFORE };
}

/* ── GOOGLE RANK (Ryan, 2026-10-05) ──────────────────────────────────────────────────────────────
 * The average Google position of a market's CITY page for "pickup soccer [city]", plus "pick up
 * soccer [city]" and "pickup soccer near me" where Search Console has them for that page.
 * Impression-weighted, like Avg position: Σ(position × impressions) / Σ impressions over the
 * matching queries in the Search Console window. Lower is better. Venue and blog pages get the same
 * figure over the same queries, for the expansion. A page with no impressions on any of them has no
 * rank ("—"), never a zero. */
export type QueryRow = { day: string; page_url: string; query: string; impressions: number; position_x_impressions: number };
export type RankQuery = { query: string; position: number; impressions: number };
export type PageRank = { rank: number | null; queries: RankQuery[] };

const RANK_CITY_NAMES: Record<string, string[]> = {
  ATX: ["austin"], HTX: ["houston"], DFW: ["dallas"], ATL: ["atlanta"], SATX: ["san antonio"],
  STL: ["st louis", "st. louis", "saint louis"], OKC: ["okc", "oklahoma city"], ELP: ["el paso"],
};
/** The exact queries behind a market's rank, lower-cased. */
export function rankQueriesFor(market: string): Set<string> {
  const out = new Set<string>(["pickup soccer near me"]);
  for (const c of RANK_CITY_NAMES[market] ?? []) { out.add(`pickup soccer ${c}`); out.add(`pick up soccer ${c}`); }
  return out;
}

/** Rank per page path over one Search Console window; only mapped pages of a market are ranked. */
export function pageRanks(rows: readonly QueryRow[], win: Window, map: readonly PageMapRow[]): Map<string, PageRank> {
  const acc = new Map<string, Map<string, { impressions: number; px: number }>>();
  const want = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.day < win.since || r.day > win.until) continue;
    const m = mapPath(r.page_url, map);
    if (!m?.market_key) continue;
    const set = want.get(m.market_key) ?? (want.set(m.market_key, rankQueriesFor(m.market_key)), want.get(m.market_key)!);
    const q = r.query.trim().toLowerCase();
    if (!set.has(q)) continue;
    const byQ = acc.get(r.page_url) ?? (acc.set(r.page_url, new Map()), acc.get(r.page_url)!);
    const a = byQ.get(q) ?? { impressions: 0, px: 0 };
    a.impressions += Number(r.impressions); a.px += Number(r.position_x_impressions);
    byQ.set(q, a);
  }
  const out = new Map<string, PageRank>();
  for (const [path, byQ] of acc) {
    let imp = 0, px = 0; const queries: RankQuery[] = [];
    for (const [query, a] of byQ) {
      if (a.impressions <= 0) continue;
      imp += a.impressions; px += a.px;
      queries.push({ query, position: a.px / a.impressions, impressions: a.impressions });
    }
    out.set(path, { rank: imp > 0 ? px / imp : null, queries: queries.sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query)) });
  }
  return out;
}

/** A market's rank is its CITY page's. */
export function marketRank(market: string, ranks: Map<string, PageRank>, map: readonly PageMapRow[]): number | null {
  const city = map.find((m) => m.market_key === market && m.page_kind === "city");
  return city ? ranks.get(city.pattern.toLowerCase())?.rank ?? null : null;
}

/* ── EACH SOURCE'S WINDOW, TRIMMED TO ITS OWN "DATA THROUGH" ─────────────────────────────────────
 * Ryan, 2026-10-04: Search Console runs ~2 days behind, so MTD on Oct 4 has search data for Oct 1-2
 * only, and comparing that with all of Sep 1-4 read as a 44% fall that was really two missing days.
 * So every source's CURRENT window ends at min(range end, that source's latest day), and its
 * COMPARISON is that trimmed window moved back a month (Oct 1-2 vs Sep 1-2). A source with no data
 * at all keeps the range as asked (nothing to trim to). Apple uses the same rule when it lands. */
export type Window = { since: string; until: string };
export type SourceKey = "gsc" | "web" | "app" | "meta" | "apple";
export type SourceWindow = { cur: Window; cmp: Window | null; trimmed: boolean; through: string | null };

export function sourceWindow(range: Window, through: string | null, compare: boolean): SourceWindow {
  const until = through && through < range.until ? through : range.until;
  const cur = { since: range.since, until };
  return { cur, cmp: compare ? sameDaysLastMonth(cur.since, cur.until) : null, trimmed: until !== range.until, through };
}

export function sourceWindows(range: Window, through: Partial<Record<SourceKey, string | null>>, compare: boolean): Record<SourceKey, SourceWindow> {
  const keys: SourceKey[] = ["gsc", "web", "app", "meta", "apple"];
  return Object.fromEntries(keys.map((k) => [k, sourceWindow(range, through[k] ?? null, compare)])) as Record<SourceKey, SourceWindow>;
}

export type LinkSplit = { share: number; ig_social: number; paid: number; other: number; total: number };
/** dynamic_link_first_open by source bucket (iPhone and Android) over the range. */
export function linkSplit(rows: readonly AppRow[], since: string, until: string): LinkSplit {
  const s: LinkSplit = { share: 0, ig_social: 0, paid: 0, other: 0, total: 0 };
  for (const r of rows) {
    if (r.day < since || r.day > until || r.event_name !== "dynamic_link_first_open") continue;
    const k = (["share", "ig_social", "paid"].includes(r.source_bucket) ? r.source_bucket : "other") as keyof Omit<LinkSplit, "total">;
    s[k] += r.event_count; s.total += r.event_count;
  }
  return s;
}

/* ── THE DATE BAR ─────────────────────────────────────────────────────────────────────────────── */
const pad = (n: number) => String(n).padStart(2, "0");
export const ymdOf = (y: number, m0: number, d: number) => `${y}-${pad(m0 + 1)}-${pad(d)}`;
const dim = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
export function addDays(ymd: string, n: number): string { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

/** "vs same days last month": each end moved back one calendar month, the day clamped to that
 *  month's length; a range that is a whole month compares with the whole previous month. */
export function sameDaysLastMonth(since: string, until: string): { since: string; until: string } {
  const back = (ymd: string) => {
    const [y, m, d] = ymd.split("-").map(Number);
    const py = m === 1 ? y - 1 : y, pm0 = m === 1 ? 11 : m - 2;
    return ymdOf(py, pm0, Math.min(d, dim(py, pm0)));
  };
  const [sy, sm, sd] = since.split("-").map(Number), [uy, um, ud] = until.split("-").map(Number);
  if (sd === 1 && sy === uy && sm === um && ud === dim(uy, um - 1)) {
    const py = sm === 1 ? sy - 1 : sy, pm0 = sm === 1 ? 11 : sm - 2;
    return { since: ymdOf(py, pm0, 1), until: ymdOf(py, pm0, dim(py, pm0)) };
  }
  return { since: back(since), until: back(until) };
}

export type Preset = "mtd" | "last" | "d7" | "d30" | "custom";
export function presetRange(p: Exclude<Preset, "custom">, today: string): { since: string; until: string } {
  const [y, m] = today.split("-").map(Number);
  if (p === "mtd") return { since: ymdOf(y, m - 1, 1), until: today };
  if (p === "last") { const py = m === 1 ? y - 1 : y, pm0 = m === 1 ? 11 : m - 2; return { since: ymdOf(py, pm0, 1), until: ymdOf(py, pm0, dim(py, pm0)) }; }
  return { since: addDays(today, p === "d7" ? -6 : -29), until: today };
}

export const MILESTONES: { day: string; label: string }[] = [
  { day: "2026-07-15", label: "Jul 15 · no ads" },
  { day: "2026-09-12", label: "Sep 12 · Meta tracking fixed" },
  { day: "2026-09-21", label: "Sep 21 · ads rebuild" },
  { day: "2026-10-01", label: "Oct 1 · SEO changes" },
];

/* ── THE MAIN TABLE: ONE ROW PER MARKET (Ryan, 2026-10-04 redesign) ───────────────────────────────
 * Ad spend and the Meta detail come from lib/adsOverview over Meta's own window (from Aug 1, the
 * rebuild); registrations and new players are ours over the range; website numbers are the city's
 * mapped pages (city page + venue pages) over each Google source's own window. Markets are the seven
 * active cities — the Player Funnel's grouping: New York, Warsaw (not a MatchDay market, Ryan
 * 2026-10-04) and El Paso (a fleet city not yet running) are one "Other cities" row, with every other
 * declared city, so the rows always add up to the tiles. */
export const LIVE_MARKETS = ["ATL", "ATX", "DFW", "HTX", "OKC", "SATX", "STL"] as const;
export const OTHER_CITIES = "OTHER";
const LIVE_LABEL: Record<string, string> = { ATL: "Atlanta", ATX: "Austin", DFW: "Dallas", HTX: "Houston", OKC: "OKC", SATX: "San Antonio", STL: "St. Louis", WAW: "Warsaw", OTHER: "Other cities" };
export const marketLabel = (k: string) => LIVE_LABEL[k] ?? k;
const DECLARED: Record<string, string> = {
  "Atlanta": "ATL", "Austin": "ATX", "Dallas / Fort Worth": "DFW", "Houston": "HTX", "Oklahoma City": "OKC",
  "San Antonio": "SATX", "St. Louis": "STL",
};
export const marketOfDeclared = (city: string | null) => (city && DECLARED[city]) || OTHER_CITIES;
export const marketOfPageKey = (k: string | null) => (k && (LIVE_MARKETS as readonly string[]).includes(k) ? k : OTHER_CITIES);

export type MetaSide = { spendCents: number; installs: number | null; metaRegs: number | null; regSpendCents: number; metaPlayers: number };
/* OURS (0208). firstTime is "First-time players" — Player Activity's definition and source
 * (growth_player_profile): people whose first MatchDay match EVER was in the window, from any
 * source, in that match's city (Ryan, 2026-10-05; it replaced "Registrants who played", which
 * counted by signup and so never tied to Player Activity). */
export type OursSide = { registrations: number; firstTime: number };
export const emptyOurs = (): OursSide => ({ registrations: 0, firstTime: 0 });
/* A first match's city is an mdapi city code (HOU, ATX, …), not a declared city name. Warsaw, El
 * Paso and anything unknown fall into "Other cities", as declared cities do. */
const MATCH_CITY: Record<string, string> = { ATL: "ATL", ATX: "ATX", DFW: "DFW", HOU: "HTX", OKC: "OKC", SATX: "SATX", STL: "STL" };
export const marketOfMatchCity = (code: string | null) => (code && MATCH_CITY[code]) || OTHER_CITIES;
export type MarketSide = { meta: MetaSide | null; ours: OursSide; web: Measures; rank: number | null };
export type RankedPage = PageLine & PageRank;
export type MarketRowView = { key: string; label: string; cur: MarketSide; prev: MarketSide | null; pages: RankedPage[] };

/** Group the website table's city groups and the "Other cities" fold into one Measures per market. */
export function webByMarket(w: WebsiteTable): Map<string, { m: Measures; pages: PageLine[] }> {
  const out = new Map<string, { m: Measures; pages: PageLine[] }>();
  for (const g of w.groups) {
    if (g.kind !== "city") continue;
    const k = marketOfPageKey(g.key.replace(/^city:/, ""));
    const e = out.get(k) ?? { m: zero(), pages: [] };
    add(e.m, g); e.pages.push(...g.pages); out.set(k, e);
  }
  return out;
}
export const emptyMeasures = zero;
export const addMeasures = add;
export const costPer = (cents: number, n: number | null) => (n && n > 0 ? cents / n : null);

/* ── APPLE DOWNLOADS (Ryan, 2026-10-06) ────────────────────────────────────────────────────────────
 * First-time iPhone downloads only (auto-updates, restores and re-downloads are not new people).
 *
 * TOTALS ARE STANDARD'S; DETAILED ONLY SPLITS. Detailed leaves small rows out (23 rows against
 * Standard's 181 for Oct 4–5), so it never sets a total. Per day:
 *   App Store search / browse   straight from Standard's source type
 *   every other source type     Detailed's NAMED sources inside it (Instagram + Facebook, page.link,
 *                               playmatchday.com, google.com); the rest of Standard's count → Other
 *   a day Detailed does not cover  Standard's App referrer / Web referrer rows, "not split"
 *   Unavailable (and anything else) → Other
 * so every table adds up to Standard's total.
 *
 * WEBSITE BY CITY. Apple knows the site, not the page: a download reaches a city only through the
 * store link's Campaign tag (ct=web-austin …), read from Detailed. No tag for a city = "—", never 0.
 * A download from Poland goes to "Other cities" whatever its tag (Warsaw is the licensee). The
 * Website total is Detailed's playmatchday.com — the same figure as the Website source row. */
export type DlRow = { day: string; report: "standard" | "detailed"; download_type: string; source_type: string; source_info: string; campaign: string; territory: string; counts: number };
export const FIRST_TIME = "First-time download";
export type DlKey = "meta" | "share" | "web" | "google" | "search" | "browse" | "appref" | "webref" | "other";
const hostOf = (s: string) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
export function namedSource(info: string): DlKey | null {
  const h = hostOf(info);
  if (h === "com.burbn.instagram" || h === "com.facebook.facebook") return "meta";
  if (h === "page.link" || h.endsWith(".page.link")) return "share";
  if (h === "playmatchday.com") return "web";
  if (h === "google.com") return "google";
  return null;
}
export type DownloadsBySource = {
  by: Record<DlKey, number>; total: number; outsideUS: number; poland: number;
  splitFrom: string | null;            // the first day Detailed covers, over all stored data
  unsplitDays: number;                 // days in the window Detailed does not cover
  overNamed: number;                   // named > Standard inside a source type (should stay 0)
};
const emptyBy = (): Record<DlKey, number> => ({ meta: 0, share: 0, web: 0, google: 0, search: 0, browse: 0, appref: 0, webref: 0, other: 0 });
export function downloadsBySource(rows: readonly DlRow[], win: Window, splitFrom: string | null): DownloadsBySource {
  const std = new Map<string, Map<string, number>>(), det = new Map<string, Map<string, Map<DlKey, number>>>();
  let outsideUS = 0, poland = 0;
  for (const r of rows) {
    if (r.download_type !== FIRST_TIME || r.day < win.since || r.day > win.until) continue;
    if (r.report === "standard") {
      const m = std.get(r.day) ?? (std.set(r.day, new Map()), std.get(r.day)!);
      m.set(r.source_type, (m.get(r.source_type) ?? 0) + r.counts);
      if (r.territory !== "US") outsideUS += r.counts;
      if (r.territory === "PL") poland += r.counts;
    } else {
      const k = namedSource(r.source_info);
      const d = det.get(r.day) ?? (det.set(r.day, new Map()), det.get(r.day)!);
      const t = d.get(r.source_type) ?? (d.set(r.source_type, new Map()), d.get(r.source_type)!);
      if (k) t.set(k, (t.get(k) ?? 0) + r.counts);
    }
  }
  const by = emptyBy(); let total = 0, unsplitDays = 0, overNamed = 0;
  for (const [day, types] of std) {
    const d = det.get(day);
    if (!d) unsplitDays += 1;
    for (const [t, n] of types) {
      total += n;
      if (t === "App Store search") { by.search += n; continue; }
      if (t === "App Store browse") { by.browse += n; continue; }
      if (!d) { if (t === "App referrer") by.appref += n; else if (t === "Web referrer") by.webref += n; else by.other += n; continue; }
      /* Detailed is a subset of Standard, so named ≤ Standard. If a day ever says otherwise, the named
       * counts are scaled down to Standard's (largest remainder) so the rows still add to the total,
       * and the excess is reported in overNamed rather than shown. */
      const parts = [...(d.get(t) ?? [])];
      const named = parts.reduce((x, [, c]) => x + c, 0);
      if (named > n) {
        overNamed += named - n;
        const scaled = parts.map(([k, c]) => ({ k, exact: (c * n) / named }));
        const fl = scaled.map((x) => ({ k: x.k, v: Math.floor(x.exact), r: x.exact - Math.floor(x.exact) }));
        let left = n - fl.reduce((x, y) => x + y.v, 0);
        for (const x of [...fl].sort((p, q) => q.r - p.r)) { if (left <= 0) break; x.v += 1; left -= 1; }
        for (const x of fl) by[x.k] += x.v;
      } else {
        for (const [k, c] of parts) by[k] += c;
        by.other += n - named;
      }
    }
  }
  return { by, total, outsideUS, poland, splitFrom, unsplitDays, overNamed };
}

/* A store-link tag → the Website table row it belongs to: a market key, "site" (Homepage and
 * site-wide), "other" (Other pages), or null (not ours / unreadable). Venue tags are cut short at
 * the source (web-venue-hammond-par), so a venue tag matches the ONE venue page whose slug starts
 * with it; two or none → Other pages. */
export function marketOfTag(tag: string, map: readonly PageMapRow[]): string | null {
  const t = tag.trim().toLowerCase();
  if (!t.startsWith("web-")) return null;
  const rest = t.slice(4);
  if (["home", "header", "footer", "home-popup"].includes(rest)) return "site";
  if (rest === "blog" || rest.startsWith("blog-")) return "other";
  const key = (m: PageMapRow) => (m.market_key && (LIVE_MARKETS as readonly string[]).includes(m.market_key) ? m.market_key : OTHER_CITIES);
  if (rest.startsWith("venue-")) {
    const slug = rest.slice(6);
    const hits = map.filter((m) => m.page_kind === "venue" && m.pattern.toLowerCase().replace(/^\/pickup-soccer-/, "").startsWith(slug));
    return slug && hits.length === 1 ? key(hits[0]) : "other";
  }
  const city = map.find((m) => m.page_kind === "city" && m.pattern.toLowerCase() === `/pickup-soccer-in-${rest}/`);
  return city ? key(city) : "other";
}
/** First-time downloads per Website row from Detailed's campaign tags, and the playmatchday.com total. */
export function websiteDownloads(rows: readonly DlRow[], win: Window, map: readonly PageMapRow[]): { byRow: Map<string, number>; site: number } {
  const byRow = new Map<string, number>(); let site = 0;
  for (const r of rows) {
    if (r.report !== "detailed" || r.download_type !== FIRST_TIME || r.day < win.since || r.day > win.until) continue;
    if (namedSource(r.source_info) === "web") site += r.counts;
    if (!r.campaign) continue;
    let row = marketOfTag(r.campaign, map);
    if (!row) continue;
    if (r.territory === "PL") row = OTHER_CITIES;
    byRow.set(row, (byRow.get(row) ?? 0) + r.counts);
  }
  return { byRow, site };
}
