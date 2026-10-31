// Staff app MANAGER SCHEDULE (Ryan, 2026-10-31). The desktop Manager Pay routes, called in process
// with the caller's token and left exactly as they are (Ryan: "no permission changes"):
//
//   GET  ?week=YYYY-MM-DD   GET /api/manager-pay/week       the same mirror-based week the desktop
//                           pays from, plus the desktop's own computeTiles for "all" and each city,
//                           and the Gusto names from GET /api/manager-pay/aliases where the caller
//                           holds Match Ops (null otherwise)
//   GET  ?directory=1       GET /api/manager-pay/directory  people for "someone not on the schedule"
//   POST { op: "adjustment", managerEmail, weekStart, amount, notes }  POST /api/manager-pay/adjustments
//   POST { op: "added", managerEmail, weekStart, cityIdentifier, amount, reason }  POST /api/manager-pay/added
//
// THE APP'S OWN GATE, in front of the desktop's: the staff app read gate, and a city-confined account
// sees only its own city's section and makes no pay change (the desktop never shows this ledger to a
// confined account). An adjustment needs an amount AND a reason here (Ryan, 2026-10-31), though the
// desktop route takes a bare amount. After a write the week is read again and the manager's row is
// compared with what was asked.

import { authenticateApp, readRefusal } from "@/lib/appAuth";
import { computeTiles } from "@/lib/managerPayView";
import type { ManagerPayWeekPayload } from "@/lib/managerPayCompute";
import { callDesktop, passThrough } from "@/lib/appCall";
import { GET as weekGet } from "@/app/api/manager-pay/week/route";
import { GET as aliasesGet } from "@/app/api/manager-pay/aliases/route";
import { GET as directoryGet } from "@/app/api/manager-pay/directory/route";
import { POST as adjustmentsPost } from "@/app/api/manager-pay/adjustments/route";
import { POST as addedPost } from "@/app/api/manager-pay/added/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Row = Record<string, unknown>;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

async function week(req: Request, weekStart: string, scopeCity: string | null) {
  const c = await callDesktop(req, weekGet, `/api/manager-pay/week?week=${weekStart}`);
  if (!c.ok || !c.json) return { error: c };
  const payload = c.json as unknown as ManagerPayWeekPayload & Row;
  const cities = scopeCity ? payload.cities.filter((x) => x.cityIdentifier === scopeCity) : payload.cities;
  const scoped = { ...payload, cities } as ManagerPayWeekPayload;
  const tiles: Record<string, ReturnType<typeof computeTiles>> = { all: computeTiles(scoped, null, true) };
  for (const x of cities) tiles[x.cityIdentifier] = computeTiles(scoped, x.cityIdentifier, true);
  return { payload: { ...payload, cities, network: scopeCity ? null : payload.network }, tiles };
}

export async function GET(req: Request) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const refused = readRefusal(auth);
  if (refused) return Response.json({ error: refused.error }, { status: refused.status });
  const url = new URL(req.url);
  try {
    if (url.searchParams.get("directory")) {
      if (auth.confined) return Response.json({ error: "Manager pay changes need an account without a city boundary." }, { status: 403 });
      return passThrough(await callDesktop(req, directoryGet, `/api/manager-pay/directory`));
    }
    const w = url.searchParams.get("week") ?? "";
    if (!ISO.test(w)) return Response.json({ error: "week must be YYYY-MM-DD" }, { status: 400 });
    const r = await week(req, w, auth.confined ? auth.scopeCity : null);
    if ("error" in r && r.error) return passThrough(r.error);
    const al = auth.confined ? null : await callDesktop(req, aliasesGet, `/api/manager-pay/aliases`);
    return Response.json({ ...r.payload, tiles: r.tiles, aliases: al?.ok ? al.json?.aliases ?? null : null, confined: auth.confined, scopeCity: auth.scopeCity, readAt: new Date().toISOString() });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const refused = readRefusal(auth);
  if (refused) return Response.json({ error: refused.error }, { status: refused.status });
  if (auth.confined) return Response.json({ error: "Manager pay changes need an account without a city boundary." }, { status: 403 });
  const body = (await req.json().catch(() => null)) as Row | null;
  const email = typeof body?.managerEmail === "string" ? body.managerEmail.trim().toLowerCase() : "";
  const weekStart = typeof body?.weekStart === "string" ? body.weekStart : "";
  const amount = Number(body?.amount);
  const reason = typeof body?.reason === "string" ? body.reason.trim() : typeof body?.notes === "string" ? body.notes.trim() : "";
  if (!email || !ISO.test(weekStart)) return Response.json({ error: "managerEmail and weekStart required" }, { status: 400 });
  if (!Number.isFinite(amount) || amount === 0) return Response.json({ error: "Enter an amount other than zero." }, { status: 400 });
  if (!reason) return Response.json({ error: "A reason is required." }, { status: 400 });

  try {
    let call;
    if (body?.op === "adjustment") {
      call = await callDesktop(req, adjustmentsPost, `/api/manager-pay/adjustments`, { method: "POST", body: { managerEmail: email, weekStart, amount, notes: reason, managerId: body?.managerId ?? null } });
    } else if (body?.op === "added") {
      const city = typeof body?.cityIdentifier === "string" ? body.cityIdentifier : "";
      if (!city) return Response.json({ error: "cityIdentifier required" }, { status: 400 });
      call = await callDesktop(req, addedPost, `/api/manager-pay/added`, { method: "POST", body: { managerEmail: email, weekStart, cityIdentifier: city, amount, reason, managerId: body?.managerId ?? null } });
    } else {
      return Response.json({ error: "op must be adjustment or added" }, { status: 400 });
    }
    if (!call.ok && call.status < 500) return passThrough(call);

    const r = await week(req, weekStart, null);
    const row = "payload" in r && r.payload ? r.payload.cities.flatMap((x) => x.managers).find((m) => m.managerEmail?.toLowerCase() === email) ?? null : null;
    const disagreements: string[] = [];
    if (!row) disagreements.push("The manager has no row for that week when read back.");
    else if (Number(row.adjustment) !== amount) disagreements.push(`The adjustment reads back as ${row.adjustment}, not ${amount}.`);
    return Response.json({ op: body.op, status: call.status, desktop: call.json, landed: call.ok && disagreements.length === 0, readBack: { row, readAt: new Date().toISOString() }, disagreements });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
