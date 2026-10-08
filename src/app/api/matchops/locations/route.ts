// GET /api/matchops/locations — the Locations page's data. READ ONLY, Supabase only.
//
// Never calls MatchDay on a page load (Ryan, 2026-10-08): /api/sync/player-areas refreshes
// player_area_seen hourly and this route reads what it wrote. no-store, so Refresh is a
// real re-read. Aggregation happens here (src/lib/locationsReport.ts); the browser gets totals and
// groups, not player rows — except the 100 most recent, which the page lists by name.

import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { selectAll } from "@/lib/supabasePagination";
import { buildLocationsReport, type SeenRow } from "@/lib/locationsReport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const sb = auth.supabase;

  try {
    const [rows, lastRun, okRun, firstRun] = await Promise.all([
      selectAll<SeenRow>(() => sb.from("player_area_seen")
        .select("player_id,first_seen_at,seeded,has_area,zip,area_label,area_source,is_internal,verdict,verdict_city_id,nearest_city_id,nearest_city_mi")
        .order("player_id")),
      sb.from("player_area_sync_runs").select("started_at,finished_at,ok,error,complete")
        .order("started_at", { ascending: false }).limit(1).maybeSingle(),
      sb.from("player_area_sync_runs").select("finished_at,players_total,players_internal,cities")
        .eq("ok", true).order("finished_at", { ascending: false }).limit(1).maybeSingle(),
      sb.from("player_area_sync_runs").select("finished_at")
        .eq("ok", true).order("finished_at", { ascending: true }).limit(1).maybeSingle(),
    ]);
    for (const r of [lastRun, okRun, firstRun]) if (r.error) throw new Error(r.error.message);

    // Names for the recent table only. mdapi_users can lag a brand-new signup by up to an hour;
    // those rows render the player id instead of a name.
    const recentIds = rows.filter((r) => r.has_area && !r.is_internal)
      .sort((a, b) => b.first_seen_at.localeCompare(a.first_seen_at) || b.player_id - a.player_id)
      .slice(0, 100).map((r) => r.player_id);
    const names = new Map<number, string>();
    if (recentIds.length > 0) {
      const users = await selectAll<{ id: number; first_name: string | null; last_name: string | null }>(() =>
        sb.from("mdapi_users").select("id,first_name,last_name").in("id", recentIds).order("id"));
      for (const u of users) {
        const n = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
        if (n) names.set(u.id, n);
      }
    }

    const report = buildLocationsReport({
      rows, names,
      run: lastRun.data ?? null,
      okRun: okRun.data ?? null,
      firstRunAt: firstRun.data?.finished_at ?? null,
      now: new Date(),
    });
    return Response.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    // LOUD. An empty page and a failed read must never look the same.
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
