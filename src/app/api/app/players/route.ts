// Staff app PLAYERS TAB (Ryan, 2026-11-01): Player activity and Acquisition. READ ONLY. The numbers
// are the desktop's, read through src/lib/appPlayers.ts.
//
//   GET ?page=activity|acquisition&kind=month|week|day&start=YYYY-MM-DD[&city=<name>]
//       the chosen period and the five before it (the chart), each with its total and its cities
//       (and fields, on activity). city: just that city, 404 when it is not in the caller's view.
//
// ACCESS: the desktop Player Lifecycle permission (is_admin or can_access_lifecycle). A city-confined
// account holding it gets its own city only, filtered here on the server (Ryan, 2026-11-01); the
// desktop lifecycle routes refuse a confined account (2026-11-02), so this route runs their computations
// directly (src/lib/appPlayers.ts) and nothing unfiltered leaves it.
//
// DATA THROUGH: each response says the last day each source has (iphone, android, meta); the app
// stops Downloads and Acquisition's Day at the last synced day and labels a period that runs past it.

import { loadActiveCities } from "@/lib/activeCities";
import { authenticateApp } from "@/lib/appAuth";
import { todayBusinessDate } from "@/lib/goalPace";
import { acquisitionPeriod, activityPeriods, androidPeriod, downloadSyncStale, periodOf, scopeNames, stepOf, type Kind, type Period } from "@/lib/appPlayers";
import { reviewMasked } from "@/lib/reviewAccount";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TREND = 6;

async function getRoute(req: Request) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!(auth.row.is_admin === true || auth.row.can_access_lifecycle === true)) {
    return Response.json({ error: "Your account does not include Player Lifecycle. Ask an admin to grant it." }, { status: 403 });
  }
  if (auth.confined && !auth.scopeCity) return Response.json({ error: "Your account's city is not one the Clubhouse recognises. Ask an admin to fix it." }, { status: 403 });
  const scope = scopeNames(auth.confined ? auth.scopeCity : null);

  const q = new URL(req.url).searchParams;
  const page = q.get("page") === "acquisition" ? "acquisition" : "activity";
  const kind: Kind = q.get("kind") === "week" ? "week" : q.get("kind") === "day" ? "day" : "month";
  const today = todayBusinessDate(new Date());
  const start = q.get("start");
  let p: Period = periodOf(kind, start && /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : today);
  if (p.from > today) p = periodOf(kind, today);
  const periods: Period[] = [p];
  for (let i = 1; i < TREND; i++) periods.unshift(stepOf(periods[0], -1));
  /* THE PERIOD AFTER THE CHOSEN ONE, when it has begun: the chart draws it dashed, "so far" (Figma
   * 20695:62 shows October chosen and November so far). It never feeds the change figures. */
  const next = stepOf(p, 1);
  if (next.from <= today) periods.push(next);
  const SEL = TREND - 1;
  const current = (x: Period) => x.to >= today && x.from <= today;

  try {
    const t0 = Date.now();
    // Downloads (both pages) and Meta: the Acquisition route per period; Android from app_downloads.
    // TIMING (2026-11-02): each read is timed and a slow answer is logged with the breakdown.
    const timed = async <T,>(label: string, p: Promise<T>) => { const s = Date.now(); const r = await p; parts.push(`${label} ${Date.now() - s}ms`); return r; };
    const parts: string[] = [];
    const [acq, android, stale] = await Promise.all([
      timed("acquisition", Promise.all(periods.map((x) => acquisitionPeriod(auth.supabase, x, current(x))))),
      timed("android", Promise.all(periods.map((x) => androidPeriod(auth.supabase, x, current(x))))),
      timed("sync-stale", downloadSyncStale(auth.supabase)),
    ]);
    const through = { iphone: acq[SEL].iphoneThrough, android: android[SEL].androidThrough, meta: acq[SEL].metaThrough };
    const downloads = (i: number) => (scope ? null : { iphone: acq[i].iphone, android: android[i].android, total: acq[i].iphone == null ? null : acq[i].iphone! + android[i].android });

    let out: Record<string, unknown>[];
    if (page === "activity") {
      const [act, activeCities] = await Promise.all([
        timed("activity", activityPeriods(auth.supabase, periods, today)),
        loadActiveCities(auth.supabase), // growth_cities: the one active-city list (lib/activeCities)
      ]);
      const activeNames = activeCities.map((c) => c.name);
      out = periods.map((x, i) => {
        const a = act[i];
        const cityNames = scope ? [scope.city] : [...new Set([...activeNames, ...Object.keys(a.cities).filter((c) => (a.cities[c].spots ?? 0) > 0 && c !== "Unassigned")])];
        const cities = cityNames.map((c) => ({
          city: c, v: a.cities[c] ?? null,
          fields: Object.entries(a.fields).filter(([, f]) => f.city === c && ((f.v.spots ?? 0) > 0 || (f.v.totalPlayers ?? 0) > 0)).map(([k, f]) => ({ key: k, name: f.label, v: f.v })),
        }));
        return { ...x, total: scope ? a.cities[scope.city] ?? null : a.overall, downloads: downloads(i), cities };
      });
    } else {
      out = periods.map((x, i) => {
        const names = scope ? [scope.city] : Object.keys(acq[i].markets);
        return { ...x, total: scope ? acq[i].markets[scope.city] ?? null : acq[i].total, downloads: downloads(i), cities: names.map((c) => ({ city: c, v: acq[i].markets[c] ?? null })) };
      });
    }
    const cityQ = q.get("city");
    if (cityQ != null) {
      const last = out[SEL].cities as { city: string }[];
      if (!last.some((c) => c.city === cityQ)) return Response.json({ error: "That city is not in your view." }, { status: 404 });
      for (const o of out) o.cities = (o.cities as { city: string }[]).filter((c) => c.city === cityQ);
    }
    const ms = Date.now() - t0;
    if (ms > 1500) console.warn(`[app-players] slow ${ms}ms page=${page} kind=${kind} from=${p.from}: ${parts.join(", ")}`);
    return Response.json({
      page, kind, today, scopeCity: scope?.city ?? null, through,
      // A download source with no clean sync in 3 days: the Downloads tile names its last day.
      stale,
      period: { ...p, current: current(p), canForward: next.from <= today },
      // periods[selected] is the chosen period; periods[selected + 1], when present, is the one after it.
      selected: SEL,
      periods: out,
      timing: { ms: Date.now() - t0 },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

export const GET = reviewMasked(getRoute);
