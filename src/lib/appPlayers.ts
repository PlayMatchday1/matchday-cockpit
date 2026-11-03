import "server-only"; // no-op under --conditions=react-server
// STAFF APP PLAYERS TAB (Ryan, 2026-11-01): Player activity and Acquisition for a month, a Monday to
// Sunday week or a day, with the five periods before it. READ ONLY. Every number is the desktop's:
//
//   PLAYER ACTIVITY   Month: the desktop's monthly rows (GET /api/lifecycle, behaviorOverall /
//                     behaviorByCity / behaviorByField), the October column of the Monthly view.
//                     Week, Day: the desktop's weekly route body (behaviorWeeklyCompute), the same
//                     week or day bucket the Weekly and Daily views show. Returning = total players
//                     minus first-time players for that bucket (metricValue), its % over total.
//   ACQUISITION       GET /api/lifecycle/acquisition?since&until for the period, the desktop's Meta
//                     table per market and its total (cost per registration = regSpend / Meta regs).
//   DOWNLOADS         iPhone: the same route's Apple first-time downloads (App Store Analytics),
//                     over Apple's own "data through" window. Android: app_downloads (Play Console),
//                     daily, through its last stored day. Not available by city.
//
// CITY SCOPE: a city-confined account gets its own city's rows only; its totals are that city's row
// (an Acquisition market, a Player activity city), never the company figure; downloads are company
// wide and are not given to it. Cached per source and period: 6 hours once ended, 5 minutes current.

import { unstable_cache } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { behaviorWeeklyResponse } from "./behaviorWeeklyCompute";
import { marketLabel } from "./acquisitionModel";
import { addDays, addMonths, monthStart, mondayOf } from "./healthModel";
import { readGrowthFromViews } from "./growthFromViews";
import { acquisitionResponse } from "./acquisitionCompute";
import { ttlFor } from "./healthLoad";
import { todayBusinessDate } from "./goalPace";

export type Kind = "month" | "week" | "day";
export type Period = { kind: Kind; from: string; to: string };
type Row = Record<string, unknown>;

/** The confined city identifier as an Acquisition market key and as a Player activity city name. */
const MARKET_OF: Record<string, string> = { ATX: "ATX", DFW: "DFW", HOU: "HTX", SATX: "SATX", STL: "STL", OKC: "OKC", ATL: "ATL", WAW: "WAW" };
export const scopeNames = (id: string | null) => (id ? { market: MARKET_OF[id] ?? id, city: marketLabel(MARKET_OF[id] ?? id) } : null);

/* The cities the desktop's Player Activity lists by default (PlayerActivityPanel ACTIVE_CITIES). */
export const ACTIVE_CITIES = ["Atlanta", "Austin", "Dallas", "Houston", "OKC", "San Antonio", "St. Louis"];

export function periodOf(kind: Kind, start: string): Period {
  if (kind === "day") return { kind, from: start, to: start };
  const from = kind === "week" ? mondayOf(start) : monthStart(start);
  return { kind, from, to: kind === "week" ? addDays(from, 6) : addDays(addMonths(from, 1), -1) };
}
export const stepOf = (p: Period, by: number): Period =>
  periodOf(p.kind, p.kind === "day" ? addDays(p.from, by) : p.kind === "week" ? addDays(p.from, 7 * by) : addMonths(p.from, by));

/* CACHE LIFE (2026-11-02), as Health: current 5 minutes (stale-while-revalidate, kept warm by
 * /api/app/cron/warm), ended in the last 2 days 1 hour, older 7 days. `to` is the last day covered. */
const cached = <T,>(key: string[], current: boolean, fn: () => Promise<T>, to?: string) =>
  unstable_cache(fn, ["app-players-v2", ...key], { revalidate: to ? ttlFor(to, current, todayBusinessDate(new Date())) : current ? 300 : 6 * 3600, tags: ["app-players"] })();
const monthEnd = (ym: string) => addDays(addMonths(`${ym}-01`, 1), -1);

/* ── PLAYER ACTIVITY ──────────────────────────────────────────────────────────────────────────── */
export type Activity = { registrations: number | null; newPlayers: number | null; totalPlayers: number | null; spots: number | null; returning: number | null; returningPct: number | null };
type Point = { registrations: number | null; newPlayers: number | null; totalPlayers: number | null; spots: number | null };
const act = (p: Point | undefined): Activity => {
  const t = p?.totalPlayers ?? null, nw = p?.newPlayers ?? null;
  const ret = t == null || nw == null || nw > t ? null : t - nw;   // metricValue("recurring")
  return { registrations: p?.registrations ?? null, newPlayers: nw, totalPlayers: t, spots: p?.spots ?? null, returning: ret, returningPct: ret == null || !t ? null : (ret / t) * 100 };
};
export type ActivityPeriod = { overall: Activity; cities: Record<string, Activity>; fields: Record<string, { label: string; city: string; v: Activity }> };

/** The desktop's monthly rows for every month (one read, cached 5 minutes as the monthly payload is live). */
/* THE DESKTOP'S OWN COMPUTATIONS, CALLED DIRECTLY (2026-11-02): the desktop lifecycle routes now refuse
 * a city-confined account, so this module runs what they run (readGrowthFromViews, acquisitionResponse)
 * after the app route's own gate, and the app route filters to the account's city. */
async function monthly(sb: SupabaseClient): Promise<Row> {
  return cached(["lifecycle-monthly"], true, async () => {
    const j = (await readGrowthFromViews(sb, new Date().toISOString(), {})) as unknown as Row;
    return { behaviorOverall: j.behaviorOverall, behaviorByCity: j.behaviorByCity, behaviorByField: j.behaviorByField };
  });
}

/** The desktop weekly route body for months [start..end] at a grain. */
async function weekly(sb: SupabaseClient, grain: "weekly" | "daily", start: string, end: string, current: boolean): Promise<Row> {
  return cached(["behavior", grain, start, end], current, async () => {
    const res = await behaviorWeeklyResponse(sb, new URLSearchParams({ grain, start, end }));
    const j = (await res.json()) as Row;
    if (!res.ok) throw new Error(`behavior-weekly: ${res.status} ${String(j.error ?? "")}`);
    return { overall: j.overall, byCity: j.byCity, byField: j.byField };
  }, monthEnd(end));
}

export async function activityPeriods(sb: SupabaseClient, periods: Period[], today: string): Promise<ActivityPeriod[]> {
  const kind = periods[0].kind;
  if (kind === "month") {
    const m = await monthly(sb);
    const pick = (ps: unknown, key: string) => ((ps as (Point & { m: string })[]) ?? []).find((x) => x.m === key);
    return periods.map((p) => {
      const key = p.from.slice(0, 7);
      const cities: Record<string, Activity> = {};
      for (const [c, ps] of Object.entries((m.behaviorByCity as Row) ?? {})) cities[c] = act(pick(ps, key));
      const fields: ActivityPeriod["fields"] = {};
      for (const [f, v] of Object.entries((m.behaviorByField as Record<string, { label: string; city: string; points: unknown }>) ?? {})) {
        // Registrations have no field dimension (a dash on the desktop).
        fields[f] = { label: v.label, city: v.city, v: { ...act(pick(v.points, key)), registrations: null } };
      }
      return { overall: act(pick(m.behaviorOverall, key)), cities, fields };
    });
  }
  // WEEK / DAY: one call per span of months the periods touch (a day call is one month at most).
  const grain = kind === "week" ? "weekly" : "daily";
  const months = [...new Set(periods.map((p) => (kind === "week" ? p.from : p.from).slice(0, 7)))].sort();
  const spans: [string, string][] = kind === "week" ? [[months[0], months[months.length - 1]]] : months.map((x) => [x, x]);
  const payloads = await Promise.all(spans.map(([a, b]) => weekly(sb, grain, a, b, b >= today.slice(0, 7))));
  const pick = (ps: unknown, key: string) => ((ps as (Point & { w: string })[]) ?? []).find((x) => x.w === key);
  return periods.map((p) => {
    const j = payloads[spans.findIndex(([a, b]) => p.from.slice(0, 7) >= a && p.from.slice(0, 7) <= b)] ?? {};
    const cities: Record<string, Activity> = {};
    for (const [c, ps] of Object.entries((j.byCity as Row) ?? {})) cities[c] = act(pick(ps, p.from));
    const fields: ActivityPeriod["fields"] = {};
    for (const [f, v] of Object.entries((j.byField as Record<string, { label: string; city: string; points: unknown }>) ?? {})) {
      fields[f] = { label: v.label, city: v.city, v: { ...act(pick(v.points, p.from)), registrations: null } };
    }
    return { overall: act(pick(j.overall, p.from)), cities, fields };
  });
}

/* ── ACQUISITION AND DOWNLOADS ────────────────────────────────────────────────────────────────── */
export type Acq = { spendCents: number | null; installs: number | null; metaRegs: number | null; cprCents: number | null; allRegs: number; firstTime: number };
export type AcqPeriod = { total: Acq; markets: Record<string, Acq>; iphone: number | null; iphoneThrough: string | null; metaThrough: string | null };
const acqOf = (m: Row | null, ours: Row | null): Acq => ({
  spendCents: (m?.spendCents as number | null) ?? null, installs: (m?.installs as number | null) ?? null, metaRegs: (m?.metaRegs as number | null) ?? null,
  cprCents: m && Number(m.metaRegs) > 0 ? Number(m.regSpendCents) / Number(m.metaRegs) : null,   // costPer, as the desktop
  allRegs: Number(ours?.registrations ?? 0), firstTime: Number(ours?.firstTime ?? 0),
});

export async function acquisitionPeriod(sb: SupabaseClient, p: Period, current: boolean): Promise<AcqPeriod> {
  return cached(["acq", p.from, p.to], current, async () => {
    const res = await acquisitionResponse({ supabase: sb }, new URL(`http://app.local/api/lifecycle/acquisition?since=${p.from}&until=${p.to}`));
    const j = (await res.json()) as Row;
    if (!res.ok) throw new Error(`acquisition: ${res.status} ${String(j.error ?? "")}`);
    const markets: Record<string, Acq> = {};
    for (const r of (j.markets as Row[]) ?? []) {
      const cur = r.cur as Row;
      markets[marketLabel(String(r.key))] = acqOf(cur.meta as Row | null, cur.ours as Row);
    }
    const t = ((j.totals as Row)?.cur as Row) ?? {};
    const dl = j.downloads as Row | null;
    return {
      total: acqOf(t, t), markets,
      iphone: dl ? Number(((dl.cur as Row)?.total as number) ?? 0) : null,
      iphoneThrough: ((j.freshness as Row)?.apple as string | null) ?? null,
      metaThrough: ((j.freshness as Row)?.meta as string | null) ?? null,
    };
  });   // no `to`: it carries the sources' last synced day, which a long cache would freeze
}

/** Android first installs (Play Console, app_downloads) over the period, and its last stored day. */
export async function androidPeriod(sb: SupabaseClient, p: Period, current: boolean): Promise<{ android: number; androidThrough: string | null }> {
  return cached(["android", p.from, p.to], current, async () => {
    const last = await sb.from("app_downloads").select("period_date").eq("platform", "android").eq("period_grain", "day").order("period_date", { ascending: false }).limit(1);
    if (last.error) throw new Error(`app_downloads: ${last.error.message}`);
    const r = await sb.from("app_downloads").select("count").eq("platform", "android").eq("period_grain", "day").gte("period_date", p.from).lte("period_date", p.to);
    if (r.error) throw new Error(`app_downloads: ${r.error.message}`);
    return { android: (r.data ?? []).reduce((a, x) => a + Number(x.count), 0), androidThrough: (last.data?.[0]?.period_date as string | undefined) ?? null };
  });
}

/* DOWNLOAD SYNC FRESHNESS: a source is stale when its last clean run in fin_sync_log (completed, no
 * error, an ADVISORY note counts as clean) is more than 3 days old, or it has none. iPhone is the App
 * Store Analytics files (asc-analytics), Android the Play Console reports (play-installs). */
const DOWNLOAD_SOURCES = { iphone: "asc-analytics", android: "play-installs" } as const;
export async function downloadSyncStale(sb: SupabaseClient, now = new Date()): Promise<{ iphone: boolean; android: boolean }> {
  const cutoff = now.getTime() - 3 * 24 * 60 * 60 * 1000;
  const one = async (source: string) => {
    const r = await sb.from("fin_sync_log").select("completed_at, error_message").eq("source", source)
      .not("completed_at", "is", null).order("started_at", { ascending: false }).limit(20);
    if (r.error) throw new Error(`fin_sync_log: ${r.error.message}`);
    const ok = (r.data ?? []).find((x) => !x.error_message || String(x.error_message).startsWith("ADVISORY"));
    return !ok || new Date(String(ok.completed_at)).getTime() < cutoff;
  };
  const [iphone, android] = await Promise.all([one(DOWNLOAD_SOURCES.iphone), one(DOWNLOAD_SOURCES.android)]);
  return { iphone, android };
}
