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
 * at all keeps the range as asked (nothing to trim to). Apple uses the same rule when it lands.
 *
 * TWO COMPARISONS (Ryan, 2026-10-06). "month" = the trimmed window moved back a calendar month (the
 * default); "prev" = the same number of days immediately before it (Sep 21–Oct 6 against Sep 5–20), which
 * is what a milestone read wants: before against after. */
export type Window = { since: string; until: string };
export type CompareMode = "month" | "prev";
export type SourceKey = "gsc" | "web" | "app" | "meta" | "apple";
export type SourceWindow = { cur: Window; cmp: Window | null; trimmed: boolean; through: string | null };

export function sourceWindow(range: Window, through: string | null, compare: boolean, mode: CompareMode = "month"): SourceWindow {
  const until = through && through < range.until ? through : range.until;
  const cur = { since: range.since, until };
  return { cur, cmp: compare ? comparisonWindow(mode, cur.since, cur.until) : null, trimmed: until !== range.until, through };
}

export function sourceWindows(range: Window, through: Partial<Record<SourceKey, string | null>>, compare: boolean, mode: CompareMode = "month"): Record<SourceKey, SourceWindow> {
  const keys: SourceKey[] = ["gsc", "web", "app", "meta", "apple"];
  return Object.fromEntries(keys.map((k) => [k, sourceWindow(range, through[k] ?? null, compare, mode)])) as Record<SourceKey, SourceWindow>;
}

/** The same number of days immediately before the window. */
export function previousPeriod(since: string, until: string): Window {
  const n = Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86400000) + 1;
  return { since: addDays(since, -n), until: addDays(since, -1) };
}
export const comparisonWindow = (mode: CompareMode, since: string, until: string): Window =>
  mode === "prev" ? previousPeriod(since, until) : sameDaysLastMonth(since, until);

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

/* ── APPLE DOWNLOADS (Ryan, 2026-10-06; restructured the same day) ───────────────────────────────
 * First-time iPhone downloads only (auto-updates, restores and re-downloads are not new people).
 *
 * TOP-LEVEL ROWS ARE STANDARD'S, ALWAYS COMPLETE: From apps (App referrer), From websites (Web
 * referrer), App Store search, App Store browse, Other (Unavailable and anything else), Total.
 *
 * SUB-ROWS COME FROM DETAILED AND NEVER MIX SPLIT AND UNSPLIT DAYS. They exist only when a stored
 * Detailed file covers EVERY day of the window (coverage = the first..last day of each stored
 * Detailed file, not "a row that day": Detailed drops small rows, so a quiet day can be covered and
 * empty). Otherwise `split` is null and the page says from which day the breakdown exists.
 *   From apps      Instagram and Facebook (com.burbn.instagram, com.facebook.Facebook), Other apps
 *                  = the rest of Standard's App referrer count
 *   From websites  Player share links (page.link), Our website (playmatchday.com), Google
 *                  (google.com / google.<tld>), Other sites = the rest of Standard's Web referrer
 *   Under Instagram and Facebook:
 *     Meta ads (Apple's count)  Detailed rows whose Page Title is a custom product page "Meta ads…"
 *     Meta ads (est.)           Meta-claimed installs (iPhone campaigns) on the days with no such page
 *     Organic (est.)            Instagram and Facebook minus both, floored at 0; null with `metaOver`
 *                               when Meta claims more than Apple counted
 *   Campaign tags (ct=…)        each tag with downloads, under the sub-row its source lands in
 *
 * Every number reads the same days: the Apple window. Meta's spend and installs are summed over
 * exactly those days. */
export type DlRow = {
  day: string; report: "standard" | "detailed"; download_type: string; source_type: string; source_info: string; campaign: string; territory: string; counts: number;
  page_type?: string; page_title?: string;
};
export const FIRST_TIME = "First-time download";
export type DlTop = "apps" | "web" | "search" | "browse" | "other";
export type DlSub = "igfb" | "otherApps" | "share" | "site" | "google" | "otherSites";
export type DlTag = { tag: string; under: DlSub | DlTop; n: number };
/** Meta, per day, iPhone campaigns only: installs (null = Meta did not say) and spend. */
export type MetaDay = { installs: number | null; spendCents: number };
/** One app Apple names under Other apps (Detailed Source Info), and the label shown for it. */
export type DlApp = { info: string; label: string; n: number };
export type DlSplit = {
  sub: Record<DlSub, number>; tags: DlTag[];
  apps: DlApp[];              // each app Apple names inside Other apps, most downloads first
  unnamedApps: number;        // the rest of Other apps: Apple's App referrer count it does not name
  metaApple: number | null;   // Apple's count through a "Meta ads" custom product page; null = no such page in the window
  metaEst: number | null;     // Meta's installs on the other days; null = none of those days, or unknown
  organic: number | null;     // null when unknown, or when Meta claims more than Apple counted
  metaOver: boolean;
  metaAppleSpendCents: number | null;   // Meta spend on the days Apple's count is used
  metaEstSpendCents: number | null;     // Meta spend on the days Meta's count is used
};
export type DownloadsTable = {
  top: Record<DlTop, number>; total: number; outsideUS: number; poland: number;
  split: DlSplit | null;
  splitFrom: string | null;   // the first day of the covered run reaching the window's end
  spendCents: number | null;  // Meta iPhone spend over the same days; null when Meta has no data for some of them
};
const hostOf = (s: string) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
/** The sub-row a Detailed row lands in, from its source type and Source Info. */
export function subOf(sourceType: string, info: string): DlSub | null {
  const h = hostOf(info);
  if (sourceType === "App referrer") return h === "com.burbn.instagram" || h === "com.facebook.facebook" ? "igfb" : "otherApps";
  if (sourceType === "Web referrer") {
    if (h === "page.link" || h.endsWith(".page.link")) return "share";
    if (h === "playmatchday.com") return "site";
    if (/^google\.[a-z.]+$/.test(h)) return "google";
    return "otherSites";
  }
  return null;
}
export const topOf = (sourceType: string): DlTop =>
  sourceType === "App referrer" ? "apps" : sourceType === "Web referrer" ? "web" : sourceType === "App Store search" ? "search" : sourceType === "App Store browse" ? "browse" : "other";
/* APP NAMES FOR APPLE'S SOURCE INFO (bundle ids), Ryan 2026-10-06. A bundle id not listed here is
 * shown as Apple wrote it, so a new app is visible the day it appears rather than folded away. */
const APP_LABEL: Record<string, string> = {
  "net.whatsapp.whatsapp": "WhatsApp", "net.whatsapp.whatsappsmb": "WhatsApp Business",
  "com.apple.mobilesms": "Messages", "com.apple.mobilemail": "Mail", "com.apple.sharingd": "AirDrop",
  "com.apple.spotlight": "Spotlight search", "com.apple.camera": "QR code / Camera", "com.apple.barcodesupport.qrcode": "QR code / Camera",
  "com.apple.askpermissionui": "Ask to Buy", "com.apple.mobilesafari": "Safari",
  "com.zhiliaoapp.musically": "TikTok", "com.toyopagroup.picaboo": "Snapchat", "com.facebook.messenger": "Messenger",
  "com.google.googlemobile": "Google app", "com.google.gmail": "Gmail", "com.google.chrome.ios": "Chrome", "com.google.chrome": "Chrome",
  "com.google.gemini": "Gemini", "com.groupme.iphone-app": "GroupMe", "com.tinyspeck.chatlyio": "Slack",
  "com.brave.ios.browser": "Brave", "com.microsoft.msedge": "Edge", "org.mozilla.ios.firefox": "Firefox",
  "com.duckduckgo.mobile.ios": "DuckDuckGo", "com.ecosia.ecosiaapp": "Ecosia", "com.opera.operatouch": "Opera",
  "company.thebrowser.arcmobile2": "Arc", "com.linkedin.linkedin": "LinkedIn", "ph.telegra.telegraph": "Telegram",
  "ai.x.grokapp": "Grok", "com.burbn.threads": "Threads", "com.atebits.tweetie2": "X", "com.reddit.reddit": "Reddit",
  "com.hammerandchisel.discord": "Discord", "com.matchday-app": "MatchDay",
};
export const appLabel = (info: string) => APP_LABEL[info.trim().toLowerCase()] ?? info.trim();
export const isMetaAdsPage = (title: string | undefined) => !!title && /^meta ads\b/i.test(title.trim());

/** Every day of a window, in order. */
export function daysOf(w: Window): string[] { const out: string[] = []; for (let d = w.since; d <= w.until; d = addDays(d, 1)) out.push(d); return out; }
/** Detailed coverage: the days inside any stored Detailed file's first..last day. */
export type Coverage = readonly { first_day: string | null; last_day: string | null }[];
const covers = (cov: Coverage, day: string) => cov.some((c) => !!c.first_day && !!c.last_day && day >= c.first_day && day <= c.last_day);
/** The first day of the covered run that reaches `until` (null when `until` itself is not covered). */
export function coveredFrom(cov: Coverage, until: string): string | null {
  if (!covers(cov, until)) return null;
  let d = until;
  for (let i = 0; i < 5000 && covers(cov, addDays(d, -1)); i++) d = addDays(d, -1);
  return d;
}

export function downloadsTable(rows: readonly DlRow[], win: Window, cov: Coverage, meta: { floor: string; byDay: Map<string, MetaDay> }): DownloadsTable {
  const top: Record<DlTop, number> = { apps: 0, web: 0, search: 0, browse: 0, other: 0 };
  let total = 0, outsideUS = 0, poland = 0;
  const named: Record<DlSub, number> = { igfb: 0, otherApps: 0, share: 0, site: 0, google: 0, otherSites: 0 };
  const tags = new Map<string, DlTag>();
  const cppByDay = new Map<string, number>();
  const appN = new Map<string, number>();     // Other apps, by the app Apple names
  for (const r of rows) {
    if (r.download_type !== FIRST_TIME || r.day < win.since || r.day > win.until) continue;
    if (r.report === "standard") {
      top[topOf(r.source_type)] += r.counts; total += r.counts;
      if (r.territory !== "US") outsideUS += r.counts;
      if (r.territory === "PL") poland += r.counts;
      continue;
    }
    const sub = subOf(r.source_type, r.source_info);
    if (sub && sub !== "otherApps" && sub !== "otherSites") named[sub] += r.counts;
    if (sub === "otherApps" && r.source_info.trim()) { const k = appLabel(r.source_info); appN.set(k, (appN.get(k) ?? 0) + r.counts); }
    if (isMetaAdsPage(r.page_title)) cppByDay.set(r.day, (cppByDay.get(r.day) ?? 0) + r.counts);
    const tag = r.campaign.trim().toLowerCase();
    if (tag) {
      const under = sub ?? topOf(r.source_type), k = `${under}\u0001${tag}`;
      const e = tags.get(k) ?? (tags.set(k, { tag, under, n: 0 }), tags.get(k)!);
      e.n += r.counts;
    }
  }
  const days = daysOf(win);
  const metaKnown = win.since >= meta.floor;
  const spendCents = metaKnown ? days.reduce((a, d) => a + (meta.byDay.get(d)?.spendCents ?? 0), 0) : null;
  const splitFrom = coveredFrom(cov, win.until);
  let split: DlSplit | null = null;
  if (splitFrom && splitFrom <= win.since) {
    const sub: Record<DlSub, number> = {
      ...named,
      otherApps: Math.max(0, top.apps - named.igfb),
      otherSites: Math.max(0, top.web - named.share - named.site - named.google),
    };
    let metaApple: number | null = null, metaEst: number | null = null, estUnknown = false, appleSpend = 0, estSpend = 0;
    for (const d of days) {
      const cpp = cppByDay.get(d) ?? 0, spend = meta.byDay.get(d)?.spendCents ?? 0;
      if (cpp > 0) { metaApple = (metaApple ?? 0) + cpp; appleSpend += spend; continue; }
      estSpend += spend;
      if (d < meta.floor) { estUnknown = true; continue; }
      const m = meta.byDay.get(d);
      if (m && m.installs == null) { estUnknown = true; continue; }
      metaEst = (metaEst ?? 0) + (m?.installs ?? 0);
    }
    if (estUnknown) metaEst = null;
    const claimed = (metaApple ?? 0) + (metaEst ?? 0);
    const left = named.igfb - claimed;
    const metaOver = !estUnknown && left < 0;
    /* Each named app under Other apps, by label (two bundle ids with one label are one row); what Apple
     * does not name is the rest of Standard's App referrer count. Never negative. */
    const apps = [...appN].map(([label, n]) => ({ info: label, label, n })).filter((a) => a.n > 0).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
    const unnamedApps = Math.max(0, sub.otherApps - apps.reduce((x, a) => x + a.n, 0));
    split = {
      sub, apps, unnamedApps, tags: [...tags.values()].filter((t) => t.n > 0).sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)),
      metaApple, metaEst, organic: estUnknown || metaOver ? null : left, metaOver,
      metaAppleSpendCents: metaKnown ? appleSpend : null, metaEstSpendCents: metaKnown ? estSpend : null,
    };
  }
  return { top, total, outsideUS, poland, split, splitFrom, spendCents };
}

/** Meta's iPhone days: installs and spend per day from fin_meta_adset_daily, leaving out every Android
 *  ad set (`isAndroid`). */
export function metaIphoneDays<R extends { spend_date: string; adset_id: string; campaign_id?: string | null; spend_cents: number; installs: number | null }>(
  flat: readonly R[], isAndroid: (r: R) => boolean,
): Map<string, MetaDay> {
  const out = new Map<string, MetaDay>();
  for (const r of flat) {
    if (isAndroid(r)) continue;
    const e = out.get(r.spend_date) ?? (out.set(r.spend_date, { installs: null, spendCents: 0 }), out.get(r.spend_date)!);
    e.spendCents += Number(r.spend_cents);
    if (r.installs != null) e.installs = (e.installs ?? 0) + Number(r.installs);
  }
  return out;
}

/* WHICH AD SETS ARE ANDROID (Ryan, 2026-10-06). Every ad set in a campaign whose name contains
 * "Android", plus any ad set whose own name does. The campaign is the one ON THE SPEND ROW
 * (fin_meta_adset_daily.campaign_id), and its name is looked up BY CAMPAIGN ID across every ad set in
 * fin_meta_adset — an ad set can carry a null campaign_name of its own: 120249622094930381 ($286.97 /
 * 66 installs in Sep) has null names while its sibling in campaign 120249622094940381 carries
 * "MD / ATL / Android App Promotion - September 2026". Names are the latest Meta reported (fin_meta_adset
 * keeps no history). Targeting is not stored, so it cannot be read here. */
export function androidAdsets(dims: readonly { adset_id: string; campaign_id: string | null; adset_name: string | null; campaign_name: string | null }[]) {
  const campaignName = new Map<string, string>();
  for (const d of dims) if (d.campaign_id && d.campaign_name && !campaignName.has(d.campaign_id)) campaignName.set(d.campaign_id, d.campaign_name);
  const byAdset = new Map(dims.map((d) => [d.adset_id, d]));
  return (r: { adset_id: string; campaign_id?: string | null }) => {
    const d = byAdset.get(r.adset_id);
    const camp = (r.campaign_id && campaignName.get(r.campaign_id)) || (d?.campaign_id && campaignName.get(d.campaign_id)) || d?.campaign_name || "";
    return /android/i.test(camp) || /android/i.test(d?.adset_name ?? "");
  };
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
    if (subOf(r.source_type, r.source_info) === "site") site += r.counts;
    if (!r.campaign) continue;
    let row = marketOfTag(r.campaign, map);
    if (!row) continue;
    if (r.territory === "PL") row = OTHER_CITIES;
    byRow.set(row, (byRow.get(row) ?? 0) + r.counts);
  }
  return { byRow, site };
}

/* WEBSITE DOWNLOADS FALLBACK (Ryan, 2026-10-06). If Apple's daily Detailed feed (from Oct 4) still has
 * not named playmatchday.com by Oct 13, the Website total switches to an estimate: Standard's Web
 * referrer total minus Player share links and Google, labelled "est.". Before Oct 13, or once Apple
 * names the site, the total is Apple's own playmatchday.com count. */
export const WEB_FALLBACK_FROM = "2026-10-13";
export const WEB_FEED_FROM = "2026-10-04";
export function websiteFallbackOn(today: string, siteNamedInFeed: boolean): boolean {
  return today >= WEB_FALLBACK_FROM && !siteNamedInFeed;
}
export const websiteEstimate = (t: DownloadsTable): number | null => (t.split ? Math.max(0, t.top.web - t.split.sub.share - t.split.sub.google) : null);
