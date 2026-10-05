/* GET /api/lifecycle/acquisition?since=&until=[&compare=1]
 *
 * The Acquisition page's own payload: the Website table (current and comparison), the page.link
 * split and the player-shares floor, how current each source is — and EACH SOURCE'S WINDOW, trimmed
 * to that source's own "data through" day, with its comparison the trimmed window a month earlier
 * (lib/acquisitionModel.sourceWindows). The Ads table comes from /api/lifecycle/ads, given the meta
 * window from here. A server route because every acq_* table is service-role only (0203). Gated on
 * can_access_lifecycle. Read-only.
 */

import { authenticateLifecycle } from "@/lib/lifecycleAuth";
import { selectAll } from "@/lib/supabasePagination";
import {
  LIVE_MARKETS, OTHER_CITIES, addMeasures, emptyMeasures, linkSplit, marketLabel, marketOfDeclared, sameDaysLastMonth, sourceWindows,
  webByMarket, websiteTable, type AppRow, type ClickRow, type GscRow, type MarketRowView, type MarketSide, type MetaSide,
  type PageMapRow, type WebRow, type Window,
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
    const freshness = { gsc: gscThrough, web: webThrough, app: appThrough, meta: metaThrough, apple: null as string | null };
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
    const [map, gsc, web, clicks, app, geo, flat, dim, acq] = await Promise.all([
      selectAll<PageMapRow>(() => sb.from("acq_page_map").select("match_kind, pattern, market_key, page_kind, label, sort_order").order("id")),
      selectAll<GscRow>(() => sb.from("acq_gsc_page_daily").select("day, page_url, clicks, impressions, position_x_impressions").gte("day", from).lte("day", to).order("day").order("page_url")),
      selectAll<WebRow>(() => sb.from("acq_web_page_daily").select("day, page_path, sessions").gte("day", from).lte("day", to).order("day").order("page_path")),
      selectAll<ClickRow>(() => sb.from("acq_web_store_click_daily").select("day, page_path, method, clicks").eq("method", "outbound_link").gte("day", from).lte("day", to).order("day").order("page_path")),
      selectAll<AppRow>(() => sb.from("acq_app_event_daily").select("day, event_name, platform, source_bucket, event_count").gte("day", from).lte("day", to).order("day")),
      metaFrom ? selectAll<GeoRow>(() => sb.from("fin_meta_adset_market_daily").select("spend_date, adset_id, market_raw, market_key, spend_cents, clicks").gte("spend_date", metaFrom).lte("spend_date", until).order("spend_date")) : none<GeoRow>(),
      metaFrom ? selectAll<FlatRow>(() => sb.from("fin_meta_adset_daily").select("spend_date, adset_id, spend_cents, installs, clicks, registrations").gte("spend_date", metaFrom).lte("spend_date", until).order("spend_date")) : none<FlatRow>(),
      selectAll<DimRow>(() => sb.from("fin_meta_adset").select("adset_id, adset_name, campaign_name, market_key, market_raw, market_confidence, optimization_goal, attribution_spec").order("adset_id")),
      selectAll<AcqRow>(() => sb.from("growth_acquisition_daily").select("signup_date, declared_city_raw, registrations, became_players, played_within_7d, played_within_30d").gte("signup_date", oursFrom).lte("signup_date", until).order("signup_date")),
    ]);

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
    const oursSide = (w: Window | null) => {
      const by = new Map<string, { registrations: number; newPlayers: number }>();
      if (!w) return by;
      for (const r of acq) {
        if (r.signup_date < w.since || r.signup_date > w.until) continue;
        const k = marketOfDeclared(r.declared_city_raw);
        const e = by.get(k) ?? { registrations: 0, newPlayers: 0 };
        e.registrations += Number(r.registrations); e.newPlayers += Number(r.became_players); by.set(k, e);
      }
      return by;
    };

    const current = {
      website: websiteTable({ win: { gsc: windows.gsc.cur, web: windows.web.cur }, map, gsc, web, clicks }),
      links: linkSplit(app, windows.app.cur.since, windows.app.cur.until),
    };
    const cmp = compare && windows.gsc.cmp && windows.web.cmp && windows.app.cmp ? {
      website: websiteTable({ win: { gsc: windows.gsc.cmp, web: windows.web.cmp }, map, gsc, web, clicks }),
      links: linkSplit(app, windows.app.cmp.since, windows.app.cmp.until),
    } : null;
    /* ── THE MARKET ROWS ──────────────────────────────────────────────────────────────────────── */
    const mC = metaSide(metaCur), mP = compare ? metaSide(metaCmp) : null;
    const oC = oursSide(oursCur), oP = compare ? oursSide(oursCmp) : null;
    const wC = webByMarket(current.website), wP = cmp ? webByMarket(cmp.website) : null;
    const keys = [...LIVE_MARKETS, OTHER_CITIES];
    const side = (k: string, m: ReturnType<typeof metaSide> | null, metaWin: Window | null, o: Map<string, { registrations: number; newPlayers: number }>, w: ReturnType<typeof webByMarket>): MarketSide => ({
      meta: metaWin && m ? m.by.get(k) ?? (k === OTHER_CITIES ? null : { spendCents: 0, installs: null, metaRegs: null, regSpendCents: 0, metaPlayers: 0 }) : null,
      ours: o.get(k) ?? { registrations: 0, newPlayers: 0 },
      web: w.get(k)?.m ?? emptyMeasures(),
    });
    const markets: MarketRowView[] = keys.map((k) => ({
      key: k, label: marketLabel(k), pages: wC.get(k)?.pages ?? [],
      cur: side(k, mC, metaCur, oC, wC),
      prev: compare && oP && wP ? side(k, mP, metaCmp, oP, wP) : null,
    })).filter((r) => LIVE_MARKETS.includes(r.key as never) || r.cur.ours.registrations > 0 || r.cur.web.visits > 0);
    const sum = (sideOf: (r: MarketRowView) => MarketSide | null, notAttr: number) => {
      const web = emptyMeasures(); let spend = notAttr, regs = 0, players = 0, anyMeta = false;
      for (const r of markets) { const s2 = sideOf(r); if (!s2) continue; addMeasures(web, s2.web); regs += s2.ours.registrations; players += s2.ours.newPlayers; if (s2.meta) { anyMeta = true; spend += s2.meta.spendCents; } }
      return { spendCents: anyMeta || notAttr ? spend : null, registrations: regs, newPlayers: players, web };
    };
    /* THE TOTAL ROW'S WEBSITE COLUMNS ARE THE WHOLE SITE (Ryan, 2026-10-04): the markets plus
     * Homepage and site-wide plus Other pages, so they match the Website store clicks tile. */
    const totals = {
      cur: { ...sum((r) => r.cur, mC.notAttributedCents), web: current.website.total },
      prev: compare ? { ...sum((r) => r.prev, mP?.notAttributedCents ?? 0), web: cmp?.website.total ?? emptyMeasures() } : null,
    };
    const siteGroup = (w: typeof current.website, key: string) => w.groups.find((g) => g.key === key) ?? null;

    return Response.json({
      since, until, windows, current, compare: cmp, freshness, mappedRows: map.length, generatedAt: new Date().toISOString(),
      markets, totals,
      notAttributed: { cur: mC.notAttributedCents, prev: mP?.notAttributedCents ?? null },
      metaWindow: { cur: metaCur, regSince: mC.regSince },
      site: { cur: siteGroup(current.website, "site"), prev: cmp ? siteGroup(cmp.website, "site") : null },
      otherPages: { cur: siteGroup(current.website, "unmapped"), prev: cmp ? siteGroup(cmp.website, "unmapped") : null },
      cities: { cur: siteGroup(current.website, "cities"), prev: cmp ? siteGroup(cmp.website, "cities") : null },
    }, { headers: { "Cache-Control": "private, max-age=60" } });
  } catch (e) {
    console.error("[api/lifecycle/acquisition] failed", e);
    return Response.json({ error: e instanceof Error ? e.message : "Failed to build the acquisition payload" }, { status: 500 });
  }
}
