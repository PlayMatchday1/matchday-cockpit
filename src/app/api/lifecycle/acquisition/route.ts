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
  linkSplit, sourceWindows, websiteTable, type AppRow, type ClickRow, type GscRow, type PageMapRow, type WebRow,
} from "@/lib/acquisitionModel";

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
    const [map, gsc, web, clicks, app] = await Promise.all([
      selectAll<PageMapRow>(() => sb.from("acq_page_map").select("match_kind, pattern, market_key, page_kind, label, sort_order").order("id")),
      selectAll<GscRow>(() => sb.from("acq_gsc_page_daily").select("day, page_url, clicks, impressions, position_x_impressions").gte("day", from).lte("day", to).order("day").order("page_url")),
      selectAll<WebRow>(() => sb.from("acq_web_page_daily").select("day, page_path, sessions").gte("day", from).lte("day", to).order("day").order("page_path")),
      selectAll<ClickRow>(() => sb.from("acq_web_store_click_daily").select("day, page_path, method, clicks").eq("method", "outbound_link").gte("day", from).lte("day", to).order("day").order("page_path")),
      selectAll<AppRow>(() => sb.from("acq_app_event_daily").select("day, event_name, platform, source_bucket, event_count").gte("day", from).lte("day", to).order("day")),
    ]);

    const current = {
      website: websiteTable({ win: { gsc: windows.gsc.cur, web: windows.web.cur }, map, gsc, web, clicks }),
      links: linkSplit(app, windows.app.cur.since, windows.app.cur.until),
    };
    const cmp = compare && windows.gsc.cmp && windows.web.cmp && windows.app.cmp ? {
      website: websiteTable({ win: { gsc: windows.gsc.cmp, web: windows.web.cmp }, map, gsc, web, clicks }),
      links: linkSplit(app, windows.app.cmp.since, windows.app.cmp.until),
    } : null;
    return Response.json({
      since, until, windows, current, compare: cmp, freshness, mappedRows: map.length, generatedAt: new Date().toISOString(),
    }, { headers: { "Cache-Control": "private, max-age=60" } });
  } catch (e) {
    console.error("[api/lifecycle/acquisition] failed", e);
    return Response.json({ error: e instanceof Error ? e.message : "Failed to build the acquisition payload" }, { status: 500 });
  }
}
