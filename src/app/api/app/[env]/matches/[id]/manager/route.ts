// Staff app MANAGER SCHEDULE: change a match's managers (Ryan, 2026-10-31), "per the desktop match
// editor". WRITES NOTHING ITSELF:
//
//   GET   the desktop editor's GET /api/matchday/{env}/matches/{id}: the city's managers, every
//         manager (only so an off-city manager ALREADY attached keeps a name), and the current ids.
//         `offered` is the desktop Match editor's own list for each slot (managerAssign.ts
//         pickerOptions, no "show all"): the match city's roster, plus whoever is attached now.
//         `busy` is who already runs another match overlapping this one (busyManagers). A city-scoped
//         account gets every-city names only for the people attached to this match.
//   POST  { managerId?, secondManagerId? }  (null = no manager)  the desktop editor's PUT, so EDIT
//         MATCHES, the city boundary, change_log and the mirror write-through come along unchanged
//
// Then a LIVE read of the match from MatchDay, compared with what was asked. The confirm wording is
// the desktop's (managerAssign.ts confirmLines), returned with the options so the sheet says the
// same thing the desktop panel says.

import { authenticateApp, readRefusal } from "@/lib/appAuth";
import { clearToday } from "@/lib/appTodayCache";
import { fetchDayLive, isEnv } from "@/lib/appLive";
import { cityAllowed } from "@/lib/appModel";
import { apiGet } from "@/lib/matchdayStageApi";
import { callDesktop, passThrough } from "@/lib/appCall";
import { GET as matchGet, PUT as matchPut } from "@/app/api/matchday/[env]/matches/[id]/route";
import { busyManagers, confirmLines, pickerOptions, type DayMatch } from "@/lib/managerAssign";
import { reviewMasked } from "@/lib/reviewAccount";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Row = Record<string, unknown>;
const idOrNull = (v: unknown) => (v == null || v === "" ? null : Number.isInteger(Number(v)) ? Number(v) : undefined);
const nameOf = (u: unknown) => { const r = u as Row | null | undefined; return r ? [r.firstName, r.lastName].filter(Boolean).join(" ").trim() || null : null; };

async function gate(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return { error: Response.json({ error: auth.error }, { status: auth.status }) };
  const refused = readRefusal(auth);
  if (refused) return { error: Response.json({ error: refused.error }, { status: refused.status }) };
  const { env, id } = await ctx.params;
  if (!isEnv(env)) return { error: Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 }) };
  if (!/^\d+$/.test(id)) return { error: Response.json({ error: "match id must be numeric" }, { status: 400 }) };
  return { env, id, auth };
}

async function getRoute(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  const g = await gate(req, ctx);
  if ("error" in g) return g.error;
  const c = await callDesktop(req, matchGet, `/api/matchday/${g.env}/matches/${g.id}`, {}, { env: g.env, id: g.id });
  if (!c.ok) return passThrough(c);
  const m = (c.json?.match as Row) ?? {};
  /* ?slot=managerId|secondManagerId&to=<id|none>: the desktop's own confirm lines for that change. */
  const url = new URL(req.url);
  const slot = url.searchParams.get("slot");
  let confirm: string[] | null = null;
  if (slot === "managerId" || slot === "secondManagerId") {
    const to = url.searchParams.get("to");
    const toId = to == null || to === "none" ? null : Number(to);
    const all = [...((c.json?.managers as Row[]) ?? []), ...((c.json?.managersAllCities as Row[]) ?? [])];
    const name = (id: unknown) => (id == null ? null : (all.find((o) => Number(o.id) === Number(id))?.name as string | undefined) ?? `Manager ${id}`);
    const cityIds = new Set(((c.json?.managers as Row[]) ?? []).map((o) => Number(o.id)));
    const second = slot === "secondManagerId" ? toId : m.secondManagerId;
    confirm = confirmLines({
      matchName: (m.name as string) ?? null, whenText: typeof m.startDate === "string" ? m.startDate.slice(0, 16).replace("T", " ") : null,
      cityLabel: (m.cityName as string) ?? null, fromName: name(m[slot]), toName: name(toId),
      maxPlayerCount: Number(m.maxPlayerCount) || null, coManaged: second != null,
      offCity: toId != null && !cityIds.has(toId),
    }).map((l) => (slot === "secondManagerId" ? `Second manager: ${l}` : l));
  }
  const city = ((c.json?.managers as { id: number; name: string; deleted?: boolean }[]) ?? []);
  const all = ((c.json?.managersAllCities as { id: number; name: string; deleted?: boolean }[]) ?? []);
  const named = (id: unknown) => (id == null ? null : { id: Number(id), name: all.find((o) => o.id === Number(id))?.name ?? city.find((o) => o.id === Number(id))?.name ?? nameOf(Number(id) === Number(m.managerId) ? m.manager : m.secondManager) ?? `Manager ${id}` });
  const offered = {
    managerId: pickerOptions(city, all, false, named(m.managerId)),
    secondManagerId: pickerOptions(city, all, false, named(m.secondManagerId)),
  };
  const { auth } = g;
  const attached = new Set([m.managerId, m.secondManagerId].filter((x) => x != null).map(Number));
  // Busy is read from the match's own local day, in the caller's city scope.
  let busy: ReturnType<typeof busyManagers> = {};
  if (typeof m.startDate === "string") {
    const day = await fetchDayLive(g.env, m.startDate.slice(0, 10)).catch(() => []);
    const rows: DayMatch[] = day
      .filter((r) => cityAllowed(auth, auth.scopeCityName, ((r.field as Row | undefined)?.city as Row | undefined)?.name as string ?? null))
      .map((r) => ({ id: Number(r.id), managerId: (r.managerId as number | null) ?? null, secondManagerId: (r.secondManagerId as number | null) ?? null,
        isCancelled: r.isCancelled === true, startDate: String(r.startDate), startDateUtc: String(r.startDateUtc), endDateUtc: (r.endDateUtc as string | null) ?? null,
        fieldTitle: ((r.field as Row | undefined)?.title as string | undefined)?.trim() ?? null }));
    const self = day.find((r) => Number(r.id) === Number(g.id));
    if (self) busy = busyManagers({ id: Number(g.id), startDateUtc: String(self.startDateUtc), endDateUtc: (self.endDateUtc as string | null) ?? null }, rows);
  }
  return Response.json({
    confirm, offered, busy, startDate: m.startDate ?? null, confined: auth.confined,
    matchId: Number(g.id), managerId: m.managerId ?? null, secondManagerId: m.secondManagerId ?? null,
    manager: nameOf(m.manager), secondManager: nameOf(m.secondManager), cityName: m.cityName ?? null,
    // The Manager Schedule sheet reads this list as is: deleted accounts out unless attached here.
    managers: city.filter((o) => !o.deleted || attached.has(o.id)), managersAllCities: auth.confined ? all.filter((o) => attached.has(o.id)) : all,
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  const g = await gate(req, ctx);
  if ("error" in g) return g.error;
  const body = (await req.json().catch(() => null)) as Row | null;
  const changes: Row = {};
  for (const k of ["managerId", "secondManagerId"] as const) {
    if (body && k in body) {
      const v = idOrNull(body[k]);
      if (v === undefined) return Response.json({ error: `${k} must be a manager id or null` }, { status: 400 });
      changes[k] = v;
    }
  }
  if (Object.keys(changes).length === 0) return Response.json({ error: "managerId or secondManagerId required" }, { status: 400 });
  try {
    const c = await callDesktop(req, matchPut, `/api/matchday/${g.env}/matches/${g.id}`, { method: "PUT", body: { changes, source: "Staff app · Manager Schedule" } }, { env: g.env, id: g.id });
    if (!c.ok) return passThrough(c);
    clearToday(g.env);
    // THE READ-BACK: the match from MatchDay, now.
    const live = await apiGet<Row>(g.env, `/admin/matches/${g.id}`);
    const readBack = {
      managerId: (live.managerId as number | null) ?? null, secondManagerId: (live.secondManagerId as number | null) ?? null,
      manager: nameOf(live.manager), secondManager: nameOf(live.secondManager), readAt: new Date().toISOString(),
    };
    const disagreements = Object.entries(changes)
      .filter(([k, v]) => (readBack as Row)[k] !== v)
      .map(([k, v]) => `${k === "managerId" ? "Manager" : "Second manager"} reads back as ${(readBack as Row)[k] ?? "none"}, not ${v ?? "none"}.`);
    return Response.json({ outcome: c.json?.outcome ?? null, landed: String(c.json?.outcome ?? "").toLowerCase() === "landed" && disagreements.length === 0, readBack, disagreements, mirrored: c.json?.mirrored ?? null });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

export const GET = reviewMasked(getRoute);
