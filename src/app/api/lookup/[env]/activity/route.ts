// GET /api/lookup/{env}/activity?id=<playerId>&since=<ISO>&until=<ISO>
// A player's app activity: rows of app_request_log (0257) for one user and env, newest first, plus
// field / day / time for any match id the rows carry. READ ONLY.
//
// GATE: Match Ops read, then can_view_activity read FRESH from app_users on every request (no JWT
// caching), then confined accounts refused outright — the column is never granted to one and the
// guard trigger refuses it, so this is belt and braces. `ip` is returned to admins only.
//
// MATCHES: production from our copy (mdapi_matches, synced daily). Staging has no copy, so up to
// MAX_STAGING_LOOKUPS single staff lookups of GET /admin/matches/{id}, one at a time — never
// production. A 404 is an answer (the match does not exist: the row keeps "Match #id") and the next
// id is read; any other error stops the lookups.

import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { apiGet, type MatchdayEnv } from "@/lib/matchdayStageApi";
import { matchIdOf, type ActivityRow, type BackgroundHour, type MatchInfo } from "@/lib/appActivity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_ROWS = 3000;
const PAGE = 1000;
const MAX_STAGING_LOOKUPS = 10;
const isEnv = (x: string): x is MatchdayEnv => x === "staging" || x === "production";

type DbRow = {
  id: number; ts: string; req_id: string; method: string; path: string; route: string | null; status: number;
  duration_ms: number; error_code: string | null; ip: string | null; match_id: number | null;
};

export async function GET(req: Request, ctx: { params: Promise<{ env: string }> }) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: "unknown environment" }, { status: 400 });
  if (auth.confined) return Response.json({ error: "App activity is not available to city accounts." }, { status: 403 });

  const fresh = await auth.supabase.from("app_users").select("*").eq("id", auth.appUserId).maybeSingle();
  if (fresh.error || !fresh.data) return Response.json({ error: "Not a cockpit user" }, { status: 403 });
  const me = fresh.data as Record<string, unknown>;
  if (me.can_view_activity !== true || me.is_service_account === true) {
    return Response.json({ error: "App activity needs VIEW ACTIVITY. Ask an admin." }, { status: 403 });
  }
  const isAdmin = me.is_admin === true;

  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "";
  if (!/^\d+$/.test(id)) return Response.json({ error: "id must be numeric" }, { status: 400 });
  const until = url.searchParams.get("until");
  const since = url.searchParams.get("since") ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
  if (!Number.isFinite(Date.parse(since)) || (until && !Number.isFinite(Date.parse(until)))) {
    return Response.json({ error: "since/until must be ISO timestamps" }, { status: 400 });
  }

  const rows: DbRow[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    let q = auth.supabase.from("app_request_log")
      .select("id, ts, req_id, method, path, route, status, duration_ms, error_code, ip, match_id")
      .eq("env", env).eq("user_id", Number(id)).gte("ts", since);
    if (until) q = q.lt("ts", until);
    const page = await q.order("ts", { ascending: false }).order("id", { ascending: false }).range(from, from + PAGE - 1);
    if (page.error) return Response.json({ error: `app_request_log read failed: ${page.error.message}` }, { status: 500 });
    rows.push(...((page.data ?? []) as DbRow[]));
    if ((page.data ?? []).length < PAGE) break;
  }
  const truncated = rows.length >= MAX_ROWS;

  // SUCCESSFUL BACKGROUND REQUESTS ARE NOT ROWS (0258): one rollup row per player per hour. The card's
  // "last seen in the app" and its folded background counts read these.
  let bgq = auth.supabase.from("app_request_bg_hourly").select("hour, bg_count, last_seen_at")
    .eq("env", env).eq("user_id", Number(id)).gte("last_seen_at", since);
  if (until) bgq = bgq.lt("hour", until);
  const bgr = await bgq.order("hour", { ascending: false }).limit(90 * 24);
  if (bgr.error) return Response.json({ error: `app_request_bg_hourly read failed: ${bgr.error.message}` }, { status: 500 });
  const background: BackgroundHour[] = ((bgr.data ?? []) as { hour: string; bg_count: number; last_seen_at: string }[])
    .map((b) => ({ hour: b.hour, count: b.bg_count, lastSeen: b.last_seen_at }));

  const out: ActivityRow[] = rows.map((r) => ({
    id: r.id, ts: r.ts, reqId: r.req_id, method: r.method, path: r.path, route: r.route, status: r.status,
    durationMs: r.duration_ms, errorCode: r.error_code, matchId: r.match_id,
    ...(isAdmin ? { ip: r.ip } : {}),
  }));

  // Match ids the rows carry, most recent first.
  const ids: number[] = [];
  for (const r of out) { const m = matchIdOf(r); if (m != null && !ids.includes(m)) ids.push(m); }
  const matches: Record<number, MatchInfo> = {};
  const notes: string[] = [];
  if (ids.length && env === "production") {
    const m = await auth.supabase.from("mdapi_matches").select("api_id, field_title, name, start_date, city_name").in("api_id", ids.slice(0, 500));
    if (m.error) notes.push(`Match details unavailable: ${m.error.message}`);
    for (const x of (m.data ?? []) as { api_id: number; field_title: string | null; name: string | null; start_date: string | null; city_name: string | null }[]) {
      matches[x.api_id] = { field: x.field_title ?? x.name, start: x.start_date, city: x.city_name };
    }
  } else if (ids.length) {
    for (const mid of ids.slice(0, MAX_STAGING_LOOKUPS)) {
      try {
        const m = await apiGet<Record<string, unknown>>("staging", `/admin/matches/${mid}`);
        const field = (m.field ?? null) as Record<string, unknown> | null;
        const city = (field?.city ?? null) as Record<string, unknown> | null;
        matches[mid] = { field: typeof field?.title === "string" ? field.title : null, start: typeof m.startDate === "string" ? m.startDate : null, city: typeof city?.name === "string" ? city.name : null };
      } catch (e) {
        if (/HTTP 404\b/.test((e as Error).message)) continue;
        notes.push(`Match details stopped at staging match #${mid}; the rest show their number only.`);
        break;
      }
    }
  }

  return Response.json({ env, playerId: Number(id), since, until, rows: out, background, truncated, matches, isAdmin, notes });
}
