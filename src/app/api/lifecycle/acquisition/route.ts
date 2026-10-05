/* GET /api/lifecycle/acquisition?since=&until=[&cmpSince=&cmpUntil=]
 *
 * The Acquisition page's own payload: the Website table (current and comparison ranges), the
 * page.link split and the player-shares floor, and how current each source is. The Ads table
 * comes from /api/lifecycle/ads. A server route because every acq_* table is service-role only
 * (0203). Gated on can_access_lifecycle. Read-only.
 */

import { authenticateLifecycle } from "@/lib/lifecycleAuth";
import { selectAll } from "@/lib/supabasePagination";
import {
  linkSplit, websiteTable, type AppRow, type ClickRow, type GscRow, type PageMapRow, type WebRow,
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
  const cmpSince = q("cmpSince"), cmpUntil = q("cmpUntil");
  const from = cmpSince && cmpSince < since ? cmpSince : since;
  const to = until;

  try {
    const sb = auth.supabase;
    const latest = async (table: string, col: string) => {
      const { data, error } = await sb.from(table).select(col).order(col, { ascending: false }).limit(1);
      if (error) throw new Error(`${table}: ${error.message}`);
      return ((data?.[0] as unknown as Record<string, string> | undefined)?.[col]) ?? null;
    };
    const [map, gsc, web, clicks, app, fresh] = await Promise.all([
      selectAll<PageMapRow>(() => sb.from("acq_page_map").select("match_kind, pattern, market_key, page_kind, label, sort_order").order("id")),
      selectAll<GscRow>(() => sb.from("acq_gsc_page_daily").select("day, page_url, clicks, impressions, position_x_impressions").gte("day", from).lte("day", to).order("day").order("page_url")),
      selectAll<WebRow>(() => sb.from("acq_web_page_daily").select("day, page_path, sessions").gte("day", from).lte("day", to).order("day").order("page_path")),
      selectAll<ClickRow>(() => sb.from("acq_web_store_click_daily").select("day, page_path, method, clicks").eq("method", "outbound_link").gte("day", from).lte("day", to).order("day").order("page_path")),
      selectAll<AppRow>(() => sb.from("acq_app_event_daily").select("day, event_name, platform, source_bucket, event_count").gte("day", from).lte("day", to).order("day")),
      Promise.all([latest("acq_gsc_page_daily", "day"), latest("acq_web_page_daily", "day"), latest("acq_app_event_daily", "day"), latest("fin_meta_adset_daily", "spend_date")]),
    ]);
    const build = (s: string, u: string) => ({ website: websiteTable({ since: s, until: u, map, gsc, web, clicks }), links: linkSplit(app, s, u) });
    return Response.json({
      since, until, current: build(since, until),
      compare: cmpSince && cmpUntil ? { since: cmpSince, until: cmpUntil, ...build(cmpSince, cmpUntil) } : null,
      freshness: { gsc: fresh[0], web: fresh[1], app: fresh[2], meta: fresh[3], apple: null },
      mappedRows: map.length,
      generatedAt: new Date().toISOString(),
    }, { headers: { "Cache-Control": "private, max-age=60" } });
  } catch (e) {
    console.error("[api/lifecycle/acquisition] failed", e);
    return Response.json({ error: e instanceof Error ? e.message : "Failed to build the acquisition payload" }, { status: 500 });
  }
}
