/* GET /api/lifecycle/acquisition?since=&until=[&compare=1]
 *
 * The Acquisition page's own payload: the Website table (current and comparison), Apple's first-time
 * downloads by source and per Website row (0210, lib/acquisitionModel.downloadsBySource), how current
 * each source is — and EACH SOURCE'S WINDOW, trimmed
 * to that source's own "data through" day, with its comparison the trimmed window a month earlier
 * (lib/acquisitionModel.sourceWindows). The Ads table comes from /api/lifecycle/ads, given the meta
 * window from here. A server route because every acq_* table is service-role only (0203). Gated on
 * can_access_lifecycle. Read-only.
 */

import { authenticateLifecycle } from "@/lib/lifecycleAuth";
import { selectAll } from "@/lib/supabasePagination";
import {
  LIVE_MARKETS, OTHER_CITIES, FIRST_TIME, addMeasures, downloadsBySource, websiteDownloads, type DlRow, emptyMeasures, emptyOurs, marketLabel, marketOfDeclared, marketOfMatchCity, marketRank, pageRanks,
  sameDaysLastMonth, sourceWindows, webByMarket, websiteTable, type ClickRow, type GscRow, type MarketRowView, type MarketSide,
  type MetaSide, type OursSide, type PageMapRow, type PageRank, type QueryRow, type WebRow, type Window,
} from "@/lib/acquisitionModel";
import { buildAdsOverview, META_REG_FROM, type AcqRow, type DimRow, type FlatRow, type GeoRow } from "@/lib/adsOverview";
import { META_ADSET_FLOOR_YMD } from "@/lib/metaAdSpend";

export const runtime = "nodejs";
export const maxDuration = 60;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const auth = await authenticateLifecycle(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const url = new URL(req.url);
  const q = (k: string) => { const v = url.searchParams.get(k); return v && YMD.test(v) ? v : null; };
  const since = q("since"), until = q("until");
  if (!since || !until || until < since) return Response.json({ error: "since and until (YYYY-MM-DD) are required" }, { status: 400 });
  const compare = url.searchParams.get("compare") === "1";

  try {
    const sb = auth.supabase;
    const latest = async (table: string, col: string) => {
      const { data, error } = await sb.from(table).select(col).order(col, { ascending: false }).limit(1);
      if (error) throw new Error(`${table}: ${error.message}`);
      return ((data?.[0] as unknown as Record<string, string> | undefined)?.[col]) ?? null;
    };
    // 1 — how current each source is, then every window from it
    const [gscThrough, webThrough, appThrough, metaThrough] = await Promise.all([
      latest("acq_gsc_page_daily", "day"), latest("acq_web_page_daily", "day"), latest("acq_app_event_daily", "day"), latest("fin_meta_adset_daily", "spend_date"),
    ]);
    /* Apple: the newest STANDARD day stored (Detailed only splits, so it never sets "through"). */
    const appleDay = async (report: string, asc: boolean) => {
      const { data, error } = await sb.from("acq_asc_downloads_daily").select("day").eq("report", report).order("day", { ascending: asc }).limit(1);
      if (error) throw new Error(`acq_asc_downloads_daily: ${error.message}`);
      return (data?.[0]?.day as string | undefined) ?? null;
    };
    const [appleThrough, splitFrom] = await Promise.all([appleDay("standard", false), appleDay("detailed", true)]);
    const freshness = { gsc: gscThrough, web: webThrough, app: appThrough, meta: metaThrough, apple: appleThrough };
    const windows = sourceWindows({ since, until }, freshness, compare);

    // 2 — the rows, from the earliest window any source needs
    const starts = Object.values(windows).flatMap((w) => [w.cur.since, ...(w.cmp ? [w.cmp.since] : [])]).sort();
    const from = starts[0], to = until;
    // Our own counts: the range through today, against the same days last month.
    const oursCur: Window = { since, until }, oursCmp: Window | null = compare ? sameDaysLastMonth(since, until) : null;
    // Meta never reaches before the Aug 1 rebuild (a different account structure, not an empty month).
    const clampMeta = (w: Window | null): Window | null => {
      if (!w) return null;
      const s2 = w.since > META_ADSET_FLOOR_YMD ? w.since : META_ADSET_FLOOR_YMD;
      return w.until >= s2 ? { since: s2, until: w.until } : null;
    };
    const metaCur = clampMeta(windows.meta.cur), metaCmp = clampMeta(windows.meta.cmp);
    const metaFrom = [metaCur?.since, metaCmp?.since].filter(Boolean).sort()[0] as string | undefined;
    const oursFrom = oursCmp && oursCmp.since < since ? oursCmp.since : since;
    const none = <T,>() => Promise.resolve([] as T[]);
    const [map, gsc, web, clicks, geo, flat, dim, acq, gscQ, dl] = await Promise.all([
      selectAll<PageMapRow>(() => sb.from("acq_page_map").select("match_kind, pattern, market_key, page_kind, label, sort_order").order("id")),
      selectAll<GscRow>(() => sb.from("acq_gsc_page_daily").select("day, page_url, clicks, impressions, position_x_impressions").gte("day", from).lte("day", to).order("day").order("page_url")),
      selectAll<WebRow>(() => sb.from("acq_web_page_daily").select("day, page_path, sessions").gte("day", from).lte("day", to).order("day").order("page_path")),
      selectAll<ClickRow>(() => sb.from("acq_web_store_click_daily").select("day, page_path, method, clicks").eq("method", "outbound_link").gte("day", from).lte("day", to).order("day").order("page_path")),
      metaFrom ? selectAll<GeoRow>(() => sb.from("fin_meta_adset_market_daily").select("spend_date, adset_id, market_raw, market_key, spend_cents, clicks").gte("spend_date", metaFrom).lte("spend_date", until).order("spend_date")) : none<GeoRow>(),
      metaFrom ? selectAll<FlatRow>(() => sb.from("fin_meta_adset_daily").select("spend_date, adset_id, spend_cents, installs, clicks, registrations").gte("spend_date", metaFrom).lte("spend_date", until).order("spend_date")) : none<FlatRow>(),
      selectAll<DimRow>(() => sb.from("fin_meta_adset").select("adset_id, adset_name, campaign_name, market_key, market_raw, market_confidence, optimization_goal, attribution_spec").order("adset_id")),
      selectAll<AcqRow>(() => sb.from("growth_acquisition_daily").select("signup_date, declared_city_raw, registrations, became_players, played_within_7d, played_within_30d").gte("signup_date", oursFrom).lte("signup_date", until).order("signup_date")),
      // GOOGLE RANK (0209): only the "pickup soccer …" / "pick up soccer …" queries are read; the
      // model picks each market's exact set out of them (lib/acquisitionModel.rankQueriesFor).
      /* BEFORE 0209 IS APPLIED the table does not exist: that ONE read falls back to no ranks
       * ("—"), because code can deploy before a migration does. Any other failure still throws. */
      selectAll<QueryRow>(() => sb.from("acq_gsc_query_daily").select("day, page_url, query, impressions, position_x_impressions")
        .gte("day", from).lte("day", to).or("query.ilike.pickup soccer%,query.ilike.pick up soccer%")
        .order("day").order("page_url").order("query"))
        .catch((e: unknown) => { if (/acq_gsc_query_daily/.test(String((e as Error)?.message)) && /schema cache|does not exist/.test(String((e as Error)?.message))) return [] as QueryRow[]; throw e; }),
      // APPLE (0210): first-time downloads only, both reports; nothing until the first file is stored.
      appleThrough ? selectAll<DlRow>(() => sb.from("acq_asc_downloads_daily").select("day, report, download_type, source_type, source_info, campaign, territory, counts")
        .eq("download_type", FIRST_TIME).gte("day", from).lte("day", to).order("day").order("report").order("source_type").order("source_info").order("campaign").order("territory")) : none<DlRow>(),
    ]);
    const ranksC = pageRanks(gscQ, windows.gsc.cur, map);
    const ranksP = windows.gsc.cmp ? pageRanks(gscQ, windows.gsc.cmp, map) : new Map<string, PageRank>();

    /* ── META, PER MARKET, OVER ONE WINDOW ─────────────────────────────────────────────────────
     * Spend / installs / cost per new player over the window; Meta's registrations only from Sep 12
     * (the day it could see them) — a window starting earlier counts from Sep 12, and says so. */
    const metaSide = (w: Window | null) => {
      if (!w) return { by: new Map<string, MetaSide>(), notAttributedCents: 0, regSince: null as string | null };
      const inW = <T extends { spend_date: string }>(xs: T[], a: string) => xs.filter((x) => x.spend_date >= a && x.spend_date <= w.until);
      const acqW = acq.filter((a) => a.signup_date >= w.since && a.signup_date <= w.until);
      const main = buildAdsOverview({ geo: inW(geo, w.since), flat: inW(flat, w.since), dim, acq: acqW });
      const regFrom = w.since >= META_REG_FROM ? w.since : w.until >= META_REG_FROM ? META_REG_FROM : null;
      const reg = regFrom && regFrom !== w.since
        ? new Map(buildAdsOverview({ geo: inW(geo, regFrom), flat: inW(flat, regFrom), dim, acq: acqW.filter((a) => a.signup_date >= regFrom) }).rows.map((r) => [r.marketKey, r]))
        : null;
      const by = new Map<string, MetaSide>(main.rows.map((r) => {
        const rr = reg ? reg.get(r.marketKey) : r;
        return [r.marketKey, { spendCents: r.spendCents, installs: r.installs, metaRegs: regFrom ? rr?.metaRegistrations ?? null : null,
          regSpendCents: regFrom ? rr?.spendCents ?? 0 : 0, metaPlayers: r.becamePlayers }];
      }));
      return { by, notAttributedCents: main.notAttributed.reduce((a, n) => a + n.spendCents, 0), regSince: regFrom && regFrom !== w.since ? regFrom : null };
    };
    /* FIRST-TIME PLAYERS, PLAYER ACTIVITY'S OWN ROWS (Ryan, 2026-10-05): growth_player_profile, a
     * person in the day of their first match ever and that match's city. first_match_date is already
     * a wall-clock DAY (growth_participation slices start_date), so it is compared as-is. */
    const firsts = await selectAll<{ user_id: number; first_match_date: string; first_match_city: string | null }>(() =>
      sb.from("growth_player_profile").select("user_id, first_match_date, first_match_city")
        .gte("first_match_date", oursFrom).lte("first_match_date", until).order("user_id"));
    const oursSide = (w: Window | null) => {
      const by = new Map<string, OursSide>();
      if (!w) return by;
      const at = (k: string) => { const e = by.get(k) ?? emptyOurs(); by.set(k, e); return e; };
      for (const r of acq) {
        if (r.signup_date < w.since || r.signup_date > w.until) continue;
        at(marketOfDeclared(r.declared_city_raw)).registrations += Number(r.registrations);
      }
      for (const f of firsts) {
        const d = String(f.first_match_date).slice(0, 10);
        if (d < w.since || d > w.until) continue;
        at(marketOfMatchCity(f.first_match_city)).firstTime += 1;
      }
      return by;
    };

    /* ── WHAT THE SHARED RULE LEFT OUT OF THIS RANGE (0208), so the exclusion is visible ────────
     * Accounts that completed signup in the range and are not counted: staff, @matchday.com and fake
     * accounts ('internal'), and a re-registered player's second account ('re_registration'). A few
     * hundred rows in all, so they are read whole and dated here on the same Chicago clock the
     * registrations use. */
    const notCounted = await selectAll<{ account_id: number; status: string; completed_sign_up_at: string | null }>(() =>
      sb.from("growth_account").select("account_id, status, completed_sign_up_at").neq("status", "counted").order("account_id"));
    const excludedIn = (w: Window) => {
      const out = { internal: 0, reRegistrations: 0 };
      for (const a of notCounted) {
        if (!a.completed_sign_up_at) continue;
        const d = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(a.completed_sign_up_at));
        if (d < w.since || d > w.until) continue;
        if (a.status === "internal") out.internal += 1; else out.reRegistrations += 1;
      }
      return out;
    };

    const current = {
      website: websiteTable({ win: { gsc: windows.gsc.cur, web: windows.web.cur }, map, gsc, web, clicks }),
    };
    const cmp = compare && windows.gsc.cmp && windows.web.cmp && windows.app.cmp ? {
      website: websiteTable({ win: { gsc: windows.gsc.cmp, web: windows.web.cmp }, map, gsc, web, clicks }),
    } : null;
    /* ── THE MARKET ROWS ──────────────────────────────────────────────────────────────────────── */
    const mC = metaSide(metaCur), mP = compare ? metaSide(metaCmp) : null;
    const oC = oursSide(oursCur), oP = compare ? oursSide(oursCmp) : null;
    const wC = webByMarket(current.website), wP = cmp ? webByMarket(cmp.website) : null;
    const keys = [...LIVE_MARKETS, OTHER_CITIES];
    const side = (k: string, m: ReturnType<typeof metaSide> | null, metaWin: Window | null, o: Map<string, OursSide>, w: ReturnType<typeof webByMarket>): MarketSide => ({
      meta: metaWin && m ? m.by.get(k) ?? (k === OTHER_CITIES ? null : { spendCents: 0, installs: null, metaRegs: null, regSpendCents: 0, metaPlayers: 0 }) : null,
      ours: o.get(k) ?? emptyOurs(),
      web: w.get(k)?.m ?? emptyMeasures(),
      rank: null,
    });
    const markets: MarketRowView[] = keys.map((k) => ({
      key: k, label: marketLabel(k),
      pages: (wC.get(k)?.pages ?? []).map((p) => ({ ...p, ...(ranksC.get(p.path) ?? { rank: null, queries: [] }) })),
      cur: { ...side(k, mC, metaCur, oC, wC), rank: k === OTHER_CITIES ? null : marketRank(k, ranksC, map) },
      prev: compare && oP && wP ? { ...side(k, mP, metaCmp, oP, wP), rank: k === OTHER_CITIES ? null : marketRank(k, ranksP, map) } : null,
    })).filter((r) => LIVE_MARKETS.includes(r.key as never) || r.cur.ours.registrations > 0 || r.cur.ours.firstTime > 0 || r.cur.web.visits > 0);
    const sum = (sideOf: (r: MarketRowView) => MarketSide | null, notAttr: number) => {
      const web = emptyMeasures(); let spend = notAttr, anyMeta = false; const ours = emptyOurs();
      /* META'S OWN COUNTS, TOTALLED for the Meta ads table. null stays null — a market Meta reported
       * nothing for adds nothing, and a column with no market reporting reads "—", not 0. */
      let installs: number | null = null, metaRegs: number | null = null, regSpendCents = 0;
      for (const r of markets) {
        const s2 = sideOf(r); if (!s2) continue; addMeasures(web, s2.web);
        ours.registrations += s2.ours.registrations; ours.firstTime += s2.ours.firstTime;
        if (s2.meta) {
          anyMeta = true; spend += s2.meta.spendCents; regSpendCents += s2.meta.regSpendCents;
          if (s2.meta.installs != null) installs = (installs ?? 0) + s2.meta.installs;
          if (s2.meta.metaRegs != null) metaRegs = (metaRegs ?? 0) + s2.meta.metaRegs;
        }
      }
      return { spendCents: anyMeta || notAttr ? spend : null, installs, metaRegs, regSpendCents, ...ours, web };
    };
    /* THE TOTAL ROW'S WEBSITE COLUMNS ARE THE WHOLE SITE (Ryan, 2026-10-04): the markets plus
     * Homepage and site-wide plus Other pages, so they match the Website store clicks tile. */
    const totals = {
      cur: { ...sum((r) => r.cur, mC.notAttributedCents), web: current.website.total },
      prev: compare ? { ...sum((r) => r.prev, mP?.notAttributedCents ?? 0), web: cmp?.website.total ?? emptyMeasures() } : null,
    };
    const webDl = (w: Window) => { const r = websiteDownloads(dl, w, map); return { byRow: Object.fromEntries(r.byRow), site: r.site }; };
    const siteGroup = (w: typeof current.website, key: string) => w.groups.find((g) => g.key === key) ?? null;

    return Response.json({
      since, until, windows, current, compare: cmp, freshness, mappedRows: map.length, generatedAt: new Date().toISOString(),
      markets, totals,
      notAttributed: { cur: mC.notAttributedCents, prev: mP?.notAttributedCents ?? null },
      excluded: excludedIn(oursCur),
      metaWindow: { cur: metaCur, regSince: mC.regSince },
      site: { cur: siteGroup(current.website, "site"), prev: cmp ? siteGroup(cmp.website, "site") : null },
      otherPages: { cur: siteGroup(current.website, "unmapped"), prev: cmp ? siteGroup(cmp.website, "unmapped") : null },
      cities: { cur: siteGroup(current.website, "cities"), prev: cmp ? siteGroup(cmp.website, "cities") : null },
      // Apple, over Apple's own window (its "data through" day); null until the first file is stored.
      downloads: appleThrough ? {
        window: windows.apple.cur,
        cur: downloadsBySource(dl, windows.apple.cur, splitFrom),
        prev: windows.apple.cmp ? downloadsBySource(dl, windows.apple.cmp, splitFrom) : null,
        web: { cur: webDl(windows.apple.cur), prev: windows.apple.cmp ? webDl(windows.apple.cmp) : null },
      } : null,
    }, { headers: { "Cache-Control": "private, max-age=60" } });
  } catch (e) {
    console.error("[api/lifecycle/acquisition] failed", e);
    return Response.json({ error: e instanceof Error ? e.message : "Failed to build the acquisition payload" }, { status: 500 });
  }
}
