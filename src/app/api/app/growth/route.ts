// Staff app GROWTH TAB, 2026 Daily Matches (Ryan, 2026-10-31). READ ONLY.
//
//   GET ?unit=day|week&sort=gap|city|name&goal=oct|nov|dec&compare=last-full|to-date
//       the overview: hero, cities, footer (lib/appGrowth, the desktop's own functions)
//   GET ...&city=<label>
//       the same view plus that city's fields with each field's cover photo
//
// THE DATA IS THE DESKTOP'S: GET /api/growth/field-goals, called in process with the caller's token,
// so its Growth gate and its city boundary apply unchanged. A city-confined account holding Growth
// receives only its own city's rows from that route; nothing here widens or narrows it, and a city
// outside the payload simply is not found.
//
// COVERS: a venue row uses its FIRST field's cover (lowest MatchDay field id in fin_venue_fields), an
// unmapped field its own, from the live MatchDay /admin/fields `cover`. None is null, and the app
// shows the shared placeholder.

import { authenticateApp } from "@/lib/appAuth";
import { callDesktop, passThrough } from "@/lib/appCall";
import { apiGet } from "@/lib/matchdayStageApi";
import { GOAL_MONTHS, growthView, type GoalMonth, type Payload } from "@/lib/appGrowth";
import type { CompareFrom, GoalSort } from "@/lib/fieldGoals";
import { GET as fieldGoalsGet } from "@/app/api/growth/field-goals/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const pick = <T extends string>(v: string | null, ok: readonly T[], dflt: T): T => (ok.includes(v as T) ? (v as T) : dflt);

export async function GET(req: Request) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (auth.confined && !auth.scopeCity) return Response.json({ error: "Your account's city is not one the Clubhouse recognises. Ask an admin to fix it." }, { status: 403 });
  const q = new URL(req.url).searchParams;
  const opts = {
    unit: pick(q.get("unit"), ["day", "week"] as const, "day"),
    sort: pick<GoalSort>(q.get("sort"), ["gap", "city", "name"], "gap"),
    goal: pick<GoalMonth>(q.get("goal"), GOAL_MONTHS, "dec"),
    compare: (q.get("compare") === "last-full" || q.get("compare") === "to-date" ? q.get("compare") : null) as CompareFrom | null,
  };
  try {
    const c = await callDesktop(req, fieldGoalsGet, "/api/growth/field-goals");
    if (!c.ok || !c.json) return passThrough(c);
    const view = growthView(c.json as unknown as Payload, opts);
    const cityLabel = q.get("city");
    if (cityLabel == null) return Response.json(view, { headers: { "Cache-Control": "no-store" } });

    const city = view.cities.find((x) => x.city === cityLabel);
    if (!city) return Response.json({ error: "That city is not in your view." }, { status: 404 });
    const venueIds = city.fields.map((f) => f.venueId).filter((v): v is number => v != null);
    const firstField = new Map<number, number>();
    if (venueIds.length) {
      const { data, error } = await auth.supabase.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id").in("fin_venue_id", venueIds);
      if (error) throw new Error(`fin_venue_fields: ${error.message}`);
      for (const l of data ?? []) {
        const v = Number(l.fin_venue_id), f = Number(l.mdapi_field_id);
        if (!firstField.has(v) || f < (firstField.get(v) as number)) firstField.set(v, f);
      }
    }
    const fieldOf = (x: { venueId: number | null; fieldId: number | null }) => (x.venueId != null ? firstField.get(x.venueId) ?? null : x.fieldId);
    const live = await apiGet<{ id: number; cover?: string | null }[]>("production", "/admin/fields").catch(() => null);
    const coverById = new Map((live ?? []).map((f) => [Number(f.id), typeof f.cover === "string" && f.cover.trim() ? f.cover : null]));
    const fields = city.fields.map((f) => {
      const id = fieldOf(f);
      return { ...f, coverFieldId: id, coverUrl: id != null ? coverById.get(id) ?? null : null };
    });
    return Response.json({ ...view, city: { ...city, fields }, coversRead: live != null }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
